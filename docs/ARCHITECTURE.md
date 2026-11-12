# Architecture

This document has four diagrams, and a section on how the code is layered:

1. [System overview](#1-system-overview): the components and how they connect.
2. [Request lifecycle](#2-request-lifecycle): one support request from start to finish, including fallback.
3. [Routing decision](#3-routing-decision): how the router picks the order of backends.
4. [Data model](#4-data-model): the database tables used for metering and quota.
5. [Code layers](#5-code-layers): the clean-architecture layout of the gateway and its dependency rule.

GitHub renders these diagrams natively. The design reasoning behind them is in [REPORT.md](REPORT.md).

## 1. System overview

```mermaid
flowchart LR
    subgraph Clients
        C1["Product teams<br/>(any HTTP client)"]
        C2["Console<br/>React + Vite"]
        C3["Eval harness<br/>tools/eval"]
    end

    subgraph GW["apps/gateway · Node 24 + Express 5"]
        direction TB
        A["Auth<br/>API key → tenant"] --> V["Validate<br/>zod, strict"]
        V --> CAP{"Capability"}
        CAP -->|"/v1/support/answer"| S["Support assistant<br/>retrieve → prompt → validate"]
        CAP -->|"/v1/chat/completions"| CH["Raw chat<br/>OpenAI-compatible"]
        S --> Q
        CH --> Q
        Q["Quota admission<br/>reserve tokens · fail closed"] --> P["Route planner<br/>plan · signals · hint"]
        P --> X["Executor<br/>timeouts · breaker · fallback"]
        X --> M["Metering<br/>requests + attempts"]
        R[("BM25 index<br/>2,160 KB entries")] -.-> S
        CHAOS["Fault injection<br/>error · hang · garbage"] -.-> X
    end

    subgraph Backends
        B1["groq-fast<br/>gpt-oss-20b"]
        B2["groq-strong<br/>gpt-oss-120b"]
        B3["local-qwen<br/>Qwen3.5-4B · MLX"]
        B4["mock<br/>extractive KB answer"]
    end

    DB[("SQLite<br/>tenants · requests<br/>attempts · reservations")]

    C1 & C2 & C3 -->|"HTTPS + SSE"| A
    X -->|"stream"| B1 & B2 & B3 & B4
    Q <--> DB
    M --> DB
    C2 -->|"/admin/*"| DB
```

## 2. Request lifecycle

This is one `POST /v1/support/answer` call. In this example the first backend times out and the router falls back to the second.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant G as Gateway
    participant K as BM25 index
    participant Q as Quota (SQLite)
    participant B1 as groq-fast
    participant B2 as groq-strong
    participant M as Metering

    C->>G: POST /v1/support/answer (Bearer key)
    G->>G: auth → 401 if unknown key<br/>validate → 400 if bad input
    G->>K: search(message)
    K-->>G: top hits · intent votes · coverage
    G->>G: planRoute(plan, signals) → chain [fast, strong, local, mock]<br/>403 if pinned tier not in plan
    G->>Q: BEGIN IMMEDIATE · usage + reservations
    alt quota exhausted
        Q-->>G: deny
        G-->>C: 429 quota_exceeded (+ Retry-After)
    else DB error
        G-->>C: 503 quota_unavailable (fail closed)
    end
    Q-->>G: admitted · max_tokens capped · reservation held
    G-->>C: SSE: meta · route · retrieval
    alt short message, coverage < 0.3
        G-->>C: SSE: refusal (out_of_scope), no model call, $0
    end
    G->>B1: stream(prompt)
    Note over G,B1: no first token within 6 s
    G->>G: attempt #1 = timeout_first_token · breaker.failure()
    G-->>C: SSE: attempt (fast failed)
    G->>B2: stream(prompt)
    B2-->>G: {"intent":"cancel_order","confidence":0.9} ###
    G->>G: validate header · confidence = 0.45·vote + 0.35·coverage + 0.2·model
    alt unusable header / empty answer
        G->>G: next backend in chain
    else confidence < 0.5 or intent = unknown
        G-->>C: SSE: refusal (hand-off to human)
    end
    G-->>C: SSE: intent ← commit point (no fallback after this)
    loop answer tokens
        B2-->>G: text
        G-->>C: SSE: token
    end
    B2-->>G: usage (provider-reported)
    G->>M: request row + 2 attempt rows, release reservation (1 txn)
    G-->>C: SSE: done · backend · fallbackUsed · tokens · latency · cost · quota left
```

## 3. Routing decision

```mermaid
flowchart TD
    START([request]) --> ENT["candidates = enabled backends<br/>whose tier ∈ tenant plan"]
    ENT --> HINT{"model hint?"}
    HINT -->|"tier or backend id"| ALLOWED{"in plan?"}
    ALLOWED -->|no| E403["403 model_not_allowed"]
    ALLOWED -->|yes| PIN["primary = pinned<br/>rest = default order"]
    HINT -->|"auto"| CX["assessComplexity: length, ambiguity,<br/>questions, reasoning, steps, code, math"]
    CX --> SIG{"complexity score ≥ 0.5?"}
    SIG -->|no| FAST["rule: auto_default_fast<br/>fast → strong → local → degraded"]
    SIG -->|yes| HAS{"strong tier in plan<br/>and enabled?"}
    HAS -->|yes| STRONG["rule: auto_escalate_strong<br/>strong → fast → local → degraded"]
    HAS -->|"not in plan"| DEN["rule: auto_escalate_denied_by_plan<br/>fast → local → degraded"]
    HAS -->|"not enabled"| UNA["rule: auto_escalate_unavailable"]
    PIN & FAST & STRONG & DEN & UNA --> EXEC["executor walks the chain<br/>skip if circuit open · fallback until commit"]
```

## 4. Data model

```mermaid
erDiagram
    TENANTS ||--o{ REQUESTS : makes
    REQUESTS ||--o{ ATTEMPTS : "tried on"
    TENANTS ||--o{ RESERVATIONS : holds
    TENANTS {
        text id PK
        text plan
        text api_key_hash "sha256, never the key"
        text allowed_tiers "JSON"
        int token_quota "per UTC month"
        int request_quota
        int quota_reset_at
    }
    REQUESTS {
        text id PK
        text tenant_id FK
        text endpoint
        text outcome "success, refused_*, quota_exceeded, failed_all_backends, partial, ..."
        text backend
        text route_reason "JSON: rule, reason, chain, signals"
        int fallback_used
        int prompt_tokens "sum over attempts"
        int completion_tokens
        text usage_source "provider, estimated, mixed, none"
        int latency_ms
        int ttft_ms
        real cost_usd
        text intent
        real confidence
    }
    ATTEMPTS {
        int id PK
        text request_id FK
        int seq
        text backend
        text outcome "ok, error, timeout_first_token, timeout_total, unusable_output, skipped_circuit_open, refused"
        text error
        int latency_ms
        int prompt_tokens
        int completion_tokens
        real cost_usd
    }
    RESERVATIONS {
        text request_id PK
        text tenant_id
        int tokens "pre-authorised budget"
    }
```

Quota usage is always calculated from the `REQUESTS` table plus any live `RESERVATIONS`. There is no separate counter that could drift.

## 5. Code layers

The gateway (`apps/gateway/src`) follows the clean architecture. Dependencies point inward only, and `tests/architecture.test.ts` fails the build if one doesn't.

```mermaid
flowchart LR
    ROOT["composition root<br/>config.ts · gateway.ts · index.ts"] --> IF & INF
    IF["interfaces/http<br/>Express routes, schemas (zod),<br/>SSE / OpenAI wire formats"] --> APP
    INF["infrastructure<br/>SQLite stores, model backends,<br/>health probes, auth stores"] --> APP
    APP["application<br/>use cases + ports:<br/>capability path, support, chat,<br/>fallback executor"] --> DOM
    DOM["domain<br/>routing policy + complexity, breaker,<br/>quota rule, metering math, PII,<br/>retrieval, parser, placeholders, errors"]
```

| layer | holds | may import |
|---|---|---|
| `domain/` | business rules and vocabulary, pure functions: `planRoute`, `assessComplexity`, `decideAdmission`, `summarize`, PII detectors, BM25, the support header parser, the error catalog | `domain/` only; no Node I/O, Express, SQLite or zod |
| `application/` | use cases: `runCapability` (prepare → admit → run → meter → respond), `prepareSupport`/`runSupport`, `prepareChat`/`runChat`, `executeWithFallback`; and the ports they need: `Backend`, `EventSink`, `QuotaStore`, `MeteringStore`, `AppDeps` | `domain/`, `application/` |
| `infrastructure/` | adapters for the ports: SQLite (`sqliteQuotaStore`, `sqliteMeteringStore`, tenants, keys, sessions, metrics), the OpenAI-compatible and mock backends, chaos, health probes | `domain/`, `application/` |
| `interfaces/http/` | delivery: routes, request schemas, the Express transport for `runCapability`, the support SSE and OpenAI wire formats, the error handler | `domain/`, `application/`; `infrastructure/` only for read-only reporting queries (metrics, logs, keys) that have no rules to put in a use case |
| root | `config.ts` (env → settings), `gateway.ts` (builds the adapters and wires them into `AppDeps`), `index.ts` (HTTP server, shutdown) | everything |

What this buys: the use cases run against any store or provider that satisfies a port (tests use in-memory SQLite and scripted backends). Moving to Postgres means a new `QuotaStore` and `MeteringStore` adapter, with no change to quota rules or use cases. The routing and quota rules are unit-tested as plain functions.
