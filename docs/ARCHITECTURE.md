# Architecture

This document has four diagrams, and a section on how the code is layered:

1. [System overview](#1-system-overview): the components and how they connect.
2. [Request lifecycle](#2-request-lifecycle): one support request from start to finish, including fallback.
3. [Routing decision](#3-routing-decision): how the router picks the order of backends.
4. [Data model](#4-data-model): the database tables used for metering and quota.
5. [Code layers](#5-code-layers): the gateway and the console follow Uncle Bob's Clean Architecture; the four circles, the Dependency Rule, and how it is enforced.

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
        B3["local-qwen3.5-4b<br/>Qwen3.5-4B · MLX"]
        B4["mock<br/>extractive KB answer"]
    end

    DB[("SQLite<br/>tenants · requests<br/>attempts · reservations")]

    C1 & C2 & C3 -->|"HTTPS + SSE"| A
    X -->|"stream"| B1 & B2 & B3 & B4
    Q <--> DB
    M --> DB
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
    HINT -->|"auto-smart"| CLS["after admission: classifier call on the fast model<br/>(metered as attempt 0, outcome classified)"]
    CLS --> CLSOK{"verdict ok and<br/>confidence ≥ 0.6?"}
    CLSOK -->|"no: failed, timed out, unsure"| CX
    CLSOK -->|yes| CLSV{"complex, or<br/>retrieval ambiguous?"}
    CLSV -->|no| SFAST["rule: smart_default_fast"]
    CLSV -->|yes| SSTRONG["rule: smart_escalate_strong"]
    HINT -->|"auto-cascade (support)"| CAS["rule: cascade_start_fast<br/>fast → strong → local → degraded"]
    CAS --> CEIL{"could any model pass?<br/>best case ≥ refuse threshold"}
    CEIL -->|no| KEEP["keep the fast model's decision<br/>(answer or refusal)"]
    CEIL -->|yes| HDR{"fast header: unknown, self-confidence < 0.7,<br/>or disagrees with retrieval and would be refused?"}
    HDR -->|no| KEEP
    HDR -->|"yes (before commit)"| ESC["attempt outcome escalated<br/>→ next backend: strong"]
    CX --> SIG{"complexity score ≥ 0.5?"}
    SIG -->|no| FAST["rule: auto_default_fast<br/>fast → strong → local → degraded"]
    SIG -->|yes| HAS{"strong tier in plan<br/>and enabled?"}
    HAS -->|yes| STRONG["rule: auto_escalate_strong<br/>strong → fast → local → degraded"]
    HAS -->|"not in plan"| DEN["rule: auto_escalate_denied_by_plan<br/>fast → local → degraded"]
    HAS -->|"not enabled"| UNA["rule: auto_escalate_unavailable"]
    PIN & FAST & STRONG & DEN & UNA & SFAST & SSTRONG & KEEP & ESC --> EXEC["executor walks the chain<br/>skip if circuit open · fallback until commit"]
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
        text outcome "ok, error, timeout_first_token, timeout_total, unusable_output, skipped_circuit_open, aborted, refused, escalated, classified"
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

Both apps follow Robert C. Martin's **Clean Architecture** ("The Clean Architecture", 2012; *Clean Architecture*, 2017). The folders are named after its four circles, so the rule can be read off the tree. The **Dependency Rule** says source code dependencies point inward only: an inner circle never names anything in an outer one. Each app has a `tests/architecture.test.ts` that fails the build when an import breaks the rule.

```mermaid
flowchart TB
    subgraph FW["Frameworks & Drivers · frameworks/"]
        subgraph IA["Interface Adapters · interface-adapters/"]
            subgraph UC["Application Business Rules · use-cases/"]
                EN["Enterprise Business Rules<br/>entities/"]
            end
        end
    end
    MAIN["Main · main/<br/>config, composition root, process"] -.->|builds and wires| FW
```

Control flows outward and back: a controller calls a use case, the use case calls a port, and a gateway implements that port. The use case only ever sees the port, which is an interface it owns, so the source code dependency still points inward (Dependency Inversion).

```mermaid
flowchart LR
    REQ(["HTTP request"]) --> CTRL["Controller<br/>interface-adapters/controllers/http"]
    CTRL --> UCASE["Use case<br/>use-cases/"]
    UCASE --> PORT{{"Port (interface)<br/>use-cases/ports"}}
    GW["Gateway<br/>interface-adapters/gateways"] -. implements .-> PORT
    GW --> EXT[("SQLite · LLM providers · files")]
    UCASE --> ENT["Entities<br/>entities/"]
    UCASE --> SINK{{"EventSink port"}}
    PRES["Presenter<br/>interface-adapters/presenters"] -. implements .-> SINK
    PRES --> RES(["SSE / JSON response"])
```

### Gateway (`apps/gateway/src`)

| circle | folder | holds | may import |
|---|---|---|---|
| Enterprise Business Rules | `entities/` | pure rules and vocabulary: `planRoute`, `assessComplexity`, the auto-smart classifier prompt and parser, the cascade rule, `CircuitBreaker`, `decideAdmission`, metering `summarize`, PII detectors, BM25 retrieval, the support header parser, placeholders, RBAC grants, API key and session rules, the sign-in `FailureLimiter`, the error catalog | `entities/` only |
| Application Business Rules | `use-cases/` | the interactors: `runCapability` (prepare → admit → run → meter → respond), `prepareSupport`/`runSupport`, `prepareChat`/`runChat`, `executeWithFallback`, `resolveRoute`; console and key management (`signIn`, `scopeTenant`, `redactRequest`, `createApiKey`/`revokeApiKey`, `quotaOverview`, `updatePiiPolicy`, `requestDetailFor`, `setFaultInjection`, …). `ports/` holds the interfaces they call: `Backend`, `EventSink`, `QuotaStore`, `MeteringStore`, `TenantRepository`, `ApiKeyRepository`, `UserDirectory`, `SessionStore`, `PasswordVerifier`, `AuditLog`, `Reporting`, `FaultInjection`, `HealthReader`, `EvalResults`. `deps.ts` gathers them as `AppDeps` / `GatewayDeps`. | `entities/`, `use-cases/` |
| Interface Adapters | `interface-adapters/` | **controllers/http**: the `/v1`, console and admin routes, zod request schemas, session/CSRF/API-key middleware. **presenters**: support SSE, the OpenAI chat wire format (SSE and JSON), the error presenter. **gateways**: SQLite repositories (`sqliteQuotaStore`, `sqliteApiKeyRepository`, `sqliteReporting`, …), the OpenAI-compatible and mock LLM backends, fault injection, health probes, scrypt passwords, eval result files | the three inner folders; Express and `node:sqlite` as **types only** |
| Frameworks & Drivers | `frameworks/` | `web/app.ts` builds the Express app (hardening headers, body parser, mounting the controllers, static console, error presenter); `sqlite/db.ts` opens the database, applies schema and migrations, and seeds demo data | everything except `main/` |
| Main | `main/` | `config.ts` (env → settings), `container.ts` (builds every adapter and wires `GatewayDeps`), `index.ts` (HTTP server, graceful shutdown) | everything |

The architecture test checks three things: no import points outward, `entities/` and `use-cases/` import no Express, zod, SQLite, `node:fs`, `node:http` or `node:net`, and `interface-adapters/` uses Express and `node:sqlite` only through `import type`.

What this buys:
- **Swappable storage and providers.** Use cases run against anything that satisfies a port. Tests use in-memory SQLite and scripted backends. Moving to Postgres means new gateways for the ports, with no change to quota rules, routing or use cases.
- **Thin controllers.** A controller parses, checks the permission and calls one use case. Tenant scoping, redaction, sign-in lockout and key-revocation rights are use cases, so the console routes, the admin routes and the `/v1` routes can't apply them differently.
- **Rules tested as plain functions.** Routing, quota, PII and complexity are unit-tested without HTTP or a database.

Two pragmatic choices, stated plainly:
- Controllers and presenters use Express's `Request`/`Response` types rather than a hand-rolled request model. The Express app itself is created only in `frameworks/web`.
- `GatewayError` (in `entities/errors.ts`) carries an HTTP status. The error catalog is part of the product's contract (`docs/ERRORS.md`), so the status is treated as a business fact, not a delivery detail.

### Console (`apps/console/src`)

The console uses the same circles. Its architecture test also checks that React appears only in `frameworks/` and `main.tsx`, and that only the HTTP gateway calls `fetch` or builds a console API URL.

```mermaid
flowchart LR
    MAIN["main.tsx<br/>composition root"] --> FWK & IAD
    FWK["frameworks/ui<br/>React: app shell, pages,<br/>components, hooks"] --> UCS
    IAD["interface-adapters/gateways/http<br/>fetch, CSRF, SSE parsing"] --> UCS
    UCS["use-cases<br/>ConsoleApi port"] --> ENT
    ENT["entities<br/>types, formatting, access,<br/>quota standing, playground reducer"]
```

| circle | folder | holds |
|---|---|---|
| Enterprise Business Rules | `entities/` | the API's types (`models.ts`) and pure rules: number/money formatting, role grants and the page map, quota standing (`levelOf`), backend status, outcome groups, the playground's `applyEvent` reducer and trace text, code snippets. No React. |
| Application Business Rules | `use-cases/` | `ConsoleApi`, the one port: every console operation, typed. The console is mostly view, so this circle is thin. |
| Interface Adapters | `interface-adapters/gateways/http/` | `createHttpConsoleApi()`: fetch with the session cookie and CSRF token, error mapping to `ApiError`, and the playground stream adapter that turns support SSE, OpenAI chunks or a JSON body into one event sequence |
| Frameworks & Drivers | `frameworks/ui/` | React: the app shell, pages, components, styles, and the hooks (`ApiProvider`/`useApi()`, session context, `useMetrics`, `useBackendStatus`) |
| Main | `main.tsx` | builds the HTTP gateway and renders the app with it |

One deliberate deviation: `frameworks/ui` may not import `interface-adapters/`. Martin's rule would allow it, but forbidding it keeps the guarantee that pages reach the gateway only through `useApi()`, so a page can be tested or reused with a fake `ConsoleApi`. The quota rule behind the Quotas page and the notification bell is one function, so the two can't disagree.
