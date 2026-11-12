import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * All tunables live here so routing/pricing decisions are reviewable in one place.
 * Prices are USD per 1M tokens. They are list prices at build time and are only
 * used for *estimated* cost; change them here, not in code.
 */
export type { BackendConfig, Tier } from "./domain/types.js";
import type { BackendConfig } from "./domain/types.js";

// apps/gateway/{src,dist}/config.* → repo root is three levels up
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
// local convenience: load the repo-root .env if present (on Render, env vars come from the dashboard)
const envFile = resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && !isNaN(Number(v)) ? Number(v) : d);

export const config = {
  port: num(env.PORT, 3000),
  dbPath: env.DB_PATH ?? resolve(REPO_ROOT, "apps/gateway/var/router.db"),
  dataDir: env.DATA_DIR ?? resolve(REPO_ROOT, "data"),
  consoleDist: env.CONSOLE_DIST ?? resolve(REPO_ROOT, "apps/console/dist"),
  evalResultsDir: env.EVAL_RESULTS_DIR ?? resolve(REPO_ROOT, "tools/eval/results"),
  /** exposes demo tenant keys + admin token to the console. Never on in a real deployment. */
  demoMode: (env.DEMO_MODE ?? "true") === "true",
  adminToken: env.ADMIN_TOKEN ?? "admin-demo-token",

  auth: {
    /** behind Render's proxy: trust one hop so req.ip and req.secure are the client's */
    trustProxy: env.TRUST_PROXY ?? (env.RENDER ? "1" : "loopback"),
    /** Secure cookies + HSTS. Auto-on when the request arrived over HTTPS. Force with SECURE_COOKIES=true. */
    forceSecureCookies: env.SECURE_COOKIES === "true",
    /** failed sign-ins allowed per (email) and per (client IP) inside the window */
    maxFailuresPerAccount: num(env.AUTH_MAX_FAILURES_ACCOUNT, 5),
    maxFailuresPerIp: num(env.AUTH_MAX_FAILURES_IP, 20),
    failureWindowMs: num(env.AUTH_FAILURE_WINDOW_MS, 15 * 60_000),
    /** creates one operator account at boot (outside demo mode this is the only way in) */
    bootstrapOperator:
      env.BOOTSTRAP_OPERATOR_EMAIL && env.BOOTSTRAP_OPERATOR_PASSWORD
        ? { email: env.BOOTSTRAP_OPERATOR_EMAIL, password: env.BOOTSTRAP_OPERATOR_PASSWORD, tenantId: env.BOOTSTRAP_OPERATOR_TENANT ?? "eval" }
        : null,
  },

  routing: {
    /** queries longer than this (estimated tokens) go to the strong tier */
    longQueryTokens: num(env.ROUTE_LONG_QUERY_TOKENS, 60),
    /** retrieval vote share below this = ambiguous → strong tier */
    ambiguousVoteShare: num(env.ROUTE_AMBIGUOUS_VOTE_SHARE, 0.6),
    /** complexity score (domain/routing/complexity.ts) at or above which auto routing starts at the strong tier */
    complexityThreshold: num(env.ROUTE_COMPLEXITY_THRESHOLD, 0.5),
    /** auto-smart: a classifier verdict below this confidence is ignored and the heuristic decides */
    classifierMinConfidence: num(env.ROUTE_CLASSIFIER_MIN_CONFIDENCE, 0.6),
    /** auto-cascade: escalate to strong when the fast model's own header confidence is below this (domain/routing/cascade.ts) */
    cascadeModelConfidenceBelow: num(env.ROUTE_CASCADE_MODEL_CONFIDENCE_BELOW, 0.7),
  },

  /** auto-smart's classification call (domain/routing/classifier.ts) */
  classifier: {
    /** the backend that classifies; if it is missing or disabled, the first enabled fast-tier backend does */
    backendId: env.ROUTE_CLASSIFIER_BACKEND ?? "groq-fast",
    /** gpt-oss reasons before it answers and those tokens count here; measured ~40 completion tokens */
    maxTokens: num(env.ROUTE_CLASSIFIER_MAX_TOKENS, 300),
    /** past this the heuristic decides; measured ~0.2–0.6 s on Groq, with outliers near 2 s */
    timeoutMs: num(env.ROUTE_CLASSIFIER_TIMEOUT_MS, 2_500),
  },

  health: {
    /** how often enabled backends are probed (GET {baseUrl}/models) for the online/offline label */
    intervalMs: num(env.HEALTH_INTERVAL_MS, 30_000),
    timeoutMs: 4_000,
  },

  breaker: {
    failureThreshold: num(env.BREAKER_FAILURES, 3),
    openMs: num(env.BREAKER_OPEN_MS, 30_000),
  },

  support: {
    topK: 8,
    /** retrieved entries shown to the model */
    contextK: 4,
    /** below this lexical coverage the question is treated as out of scope (no model call) */
    minCoverage: num(env.SUPPORT_MIN_COVERAGE, 0.3),
    /**
     * The gate only applies to short messages. In long, chatty messages ("third time my package is
     * late, I'm furious…") coverage is diluted by extra words, so they always go to the model,
     * which has its own "unknown" escape plus the confidence threshold. Found by the hard-case probe.
     */
    gateMaxTerms: num(env.SUPPORT_GATE_MAX_TERMS, 6),
    /** final confidence below this → refuse instead of answering */
    refuseBelow: num(env.SUPPORT_REFUSE_BELOW, 0.5),
    maxAnswerTokens: 800, // gpt-oss reasoning tokens count against max_tokens
    /** extra completion budget when the caller asks to see reasoning (thinking models spend it before answering) */
    reasoningExtraTokens: 1200,
    defaultPromptVersion: (env.SUPPORT_PROMPT_VERSION ?? "v3") as "v1" | "v2" | "v3",
  },

  backends: [
    {
      id: "groq-fast",
      kind: "openai-compatible",
      location: "cloud",
      tier: "fast",
      model: env.GROQ_FAST_MODEL ?? "openai/gpt-oss-20b",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: env.GROQ_API_KEY,
      extraBody: { reasoning_effort: "low" },
      // gpt-oss reasons either way (and it is billed either way); this only controls whether we receive it
      reasoningBody: { on: { include_reasoning: true }, off: { include_reasoning: false } },
      priceInPerM: 0.075,
      priceOutPerM: 0.3,
      firstTokenTimeoutMs: num(env.GROQ_TTFT_TIMEOUT_MS, 6_000),
      totalTimeoutMs: 30_000,
      enabled: !!env.GROQ_API_KEY,
    },
    {
      id: "groq-strong",
      kind: "openai-compatible",
      location: "cloud",
      tier: "strong",
      model: env.GROQ_STRONG_MODEL ?? "openai/gpt-oss-120b",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: env.GROQ_API_KEY,
      extraBody: { reasoning_effort: "low" },
      // gpt-oss reasons either way (and it is billed either way); this only controls whether we receive it
      reasoningBody: { on: { include_reasoning: true }, off: { include_reasoning: false } },
      priceInPerM: 0.15,
      priceOutPerM: 0.6,
      firstTokenTimeoutMs: num(env.GROQ_TTFT_TIMEOUT_MS, 8_000),
      totalTimeoutMs: 45_000,
      enabled: !!env.GROQ_API_KEY,
    },
    {
      // Local model behind any OpenAI-compatible server. Default: Qwen3.5-4B on Apple MLX
      // (`mlx_lm.server`); point LOCAL_LLM_BASE_URL at Ollama (http://localhost:11434/v1) to use that instead.
      id: "local-qwen3.5-4b",
      kind: "openai-compatible",
      location: "local",
      tier: "local",
      model: env.LOCAL_LLM_MODEL ?? "mlx-community/Qwen3.5-4B-MLX-4bit",
      baseUrl: env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:8080/v1",
      apiKey: "local",
      extraBody: env.LOCAL_LLM_EXTRA_BODY ? JSON.parse(env.LOCAL_LLM_EXTRA_BODY) : {},
      // Qwen3.5 thinking is a real cost here (≈ seconds of extra latency on a laptop), so it is opt-in
      reasoningBody: {
        on: { chat_template_kwargs: { enable_thinking: true } },
        off: { chat_template_kwargs: { enable_thinking: false } },
      },
      // marginal $ cost of a local model is ~0; we record 0 and say so in the report
      priceInPerM: 0,
      priceOutPerM: 0,
      firstTokenTimeoutMs: num(env.LOCAL_LLM_TTFT_TIMEOUT_MS, 20_000),
      totalTimeoutMs: 90_000,
      enabled: (env.LOCAL_LLM_ENABLED ?? "false") === "true",
    },
    {
      id: "mock",
      kind: "mock",
      location: "built-in",
      tier: "degraded",
      model: "extractive-kb-v1",
      priceInPerM: 0,
      priceOutPerM: 0,
      firstTokenTimeoutMs: 5_000,
      totalTimeoutMs: 20_000,
      enabled: true,
    },
  ] satisfies BackendConfig[] as BackendConfig[],
};

export type Config = typeof config;
