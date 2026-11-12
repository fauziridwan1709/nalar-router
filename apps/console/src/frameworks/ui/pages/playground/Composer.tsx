/** The left side of the playground: the request form (or its code), and the run bar. */
import { useState } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Switch } from "@astryxdesign/core/Switch";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { CornerDownLeft, Play, Settings2, Square } from "lucide-react";
import { fmtN, shortName } from "../../../../entities/format";
import type { PlaygroundCheck } from "../../../../entities/limits";
import { ENDPOINT_PATH, type ConsoleTenant, type PiiMode, type PlaygroundEndpoint } from "../../../../entities/models";
import { LANGS, type Lang } from "../../../../entities/snippets";
import { LOCATION_LABEL, statusOf, useBackendStatus } from "../../components/StatusBadge";
import { Select } from "../../components/ui";
import { useApp } from "../../hooks/appContext";

/** everything the user sets before pressing Run */
export interface RequestForm {
  endpoint: PlaygroundEndpoint;
  tenantId: string;
  model: string;
  promptVersion: string;
  reasoning: boolean;
  stream: boolean;
  /** chat only; the support assistant's system prompt is managed by the gateway */
  system: string;
  message: string;
}

const ENDPOINT_OPTIONS = [
  { value: "support", label: "Support answer", description: "POST /v1/support/answer · retrieval, intent, placeholders" },
  { value: "chat", label: "Chat completions", description: "POST /v1/chat/completions · OpenAI-compatible, raw" },
];

const PROMPT_VERSIONS = [
  { version: "v3", label: "v3 · placeholders filled by the gateway" },
  { version: "v2", label: "v2 · grounded" },
  { version: "v1", label: "v1 · minimal" },
];

/** what the tenant's PII guardrail does, as the end of a sentence */
const PII_BEHAVIOUR: Record<PiiMode, { support: string; chat: string }> = {
  mask: { support: "masked before the model and restored in the answer", chat: "masked before the model, and not restored" },
  block: { support: "blocked: a message containing it is refused", chat: "blocked: a message containing it is refused" },
  off: { support: "not checked (the guardrail is off)", chat: "not checked (the guardrail is off)" },
};

export function Composer(props: {
  form: RequestForm;
  update: (change: Partial<RequestForm>) => void;
  tenant: ConsoleTenant;
  check: PlaygroundCheck;
  busy: boolean;
  onRun: () => void;
  onStop: () => void;
  code: (lang: Lang) => string;
  scopeName: string;
}) {
  const { form, update, check } = props;
  const [view, setView] = useState<"form" | "code">("form");
  return (
    <section className="pg-left" aria-label="Build your request">
      <div className="pg-left-head">
        <h2>Build your request</h2>
        <span className="endpoint-pill" title="The public endpoint this request mirrors"><b>POST</b> {ENDPOINT_PATH[form.endpoint]}</span>
        <div className="seg2" role="group" aria-label="View">
          <button aria-pressed={view === "form"} onClick={() => setView("form")}>Form</button>
          <button aria-pressed={view === "code"} onClick={() => setView("code")}>Code</button>
        </div>
      </div>

      {view === "form" ? <RequestFields {...props} /> : <CodeView code={props.code} scopeName={props.scopeName} />}

      <div className="pg-runbar">
        <RequestSize check={check} endpoint={form.endpoint} />
        <span className="spacer" />
        {props.busy ? (
          <button className="btn sm" onClick={props.onStop}><Square size={13} /> Stop</button>
        ) : (
          <button className="btn primary" disabled={!form.message.trim() || check.problems.length > 0} onClick={props.onRun} data-tour="pg-run">
            <Play size={14} /> Run <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}</kbd><kbd>↵</kbd>
          </button>
        )}
      </div>
    </section>
  );
}

function RequestFields({ form, update, tenant, check, onRun }: Parameters<typeof Composer>[0]) {
  const { cfg, can } = useApp();
  const modelOptions = useModelOptions(form.endpoint, tenant);
  return (
    <div className="pg-form">
      <div className="pg-row" data-tour="pg-toolbar">
        <Select label="Endpoint" width={200} value={form.endpoint} onChange={(value) => update({ endpoint: value as PlaygroundEndpoint })} options={ENDPOINT_OPTIONS} />
        {can("tenants:all") && (
          <Select
            label="Tenant" width={180} value={tenant.id} onChange={(tenantId) => update({ tenantId })}
            options={cfg.tenants.map((t) => ({ value: t.id, label: shortName(t.name), description: `${t.plan} plan` }))}
          />
        )}
        <Select label="Model routing" width={200} value={form.model} onChange={(model) => update({ model })} options={modelOptions} />
        {form.endpoint === "support" && (
          <DropdownMenu
            menuWidth={300}
            renderTrigger={(p) => <button {...p} className="icon-btn" aria-label="Request settings" title="Request settings"><Settings2 size={16} /></button>}
            header={<div className="menu-head"><b>Request settings</b></div>}
            items={[{
              type: "section",
              title: "Prompt version",
              items: PROMPT_VERSIONS.map(({ version, label }) => ({
                label, endContent: form.promptVersion === version ? "✓" : undefined, onClick: () => update({ promptVersion: version }),
              })),
            }]}
          />
        )}
      </div>
      <div className="pg-row">
        <Switch label={`stream: ${form.stream}`} value={form.stream} onChange={(stream) => update({ stream })} size="sm" />
        <Switch label="Reasoning" value={form.reasoning} onChange={(reasoning) => update({ reasoning })} size="sm" />
      </div>

      {form.endpoint === "chat" ? (
        <div>
          <div className="pg-label">System <span className="muted">optional · sent as the first message</span></div>
          <textarea className="msg system" aria-label="System prompt" rows={2} value={form.system} onChange={(e) => update({ system: e.target.value })} placeholder="No system prompt" />
          <div className="tiny muted">No retrieval or placeholder filling on this path. Personal data is {PII_BEHAVIOUR[tenant.piiMode].chat}.</div>
        </div>
      ) : (
        <SupportSystemPrompt tenant={tenant} promptVersion={form.promptVersion} />
      )}

      <div data-tour="pg-composer">
        <div className="pg-label">Messages</div>
        <span className="role-tag">user</span>
        <textarea
          className="msg"
          aria-label={form.endpoint === "chat" ? "User message" : "Customer message"}
          rows={5}
          value={form.message}
          placeholder={form.endpoint === "chat" ? "Type any prompt, or pick a template on the right…" : "Type a customer message, or pick a template on the right…"}
          onChange={(e) => update({ message: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onRun();
          }}
        />
        {check.problems.length > 0 && (
          <div role="alert" className="tiny danger">
            {check.problems.map((problem) => <div key={problem}>{problem}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

/** the support assistant's system prompt is the gateway's; this describes what it does for this tenant */
function SupportSystemPrompt({ tenant, promptVersion }: { tenant: ConsoleTenant; promptVersion: string }) {
  const { cfg } = useApp();
  const profileFields = Object.entries(tenant.profile ?? {});
  return (
    <div>
      <div className="pg-label">System <span className="muted">managed by the gateway · prompt {promptVersion}</span></div>
      <div className="pg-box system">
        Answers only from the {fmtN(cfg.support.contextK)} best-matching knowledge-base entries, detects one of {cfg.intents.length} intents,
        and writes contact details as {"{{placeholders}}"} the gateway fills.{" "}
        {profileFields.length ? `${profileFields.length} company profile fields are available.` : "No company profile, so answers use generic phrases."}{" "}
        Personal data is {PII_BEHAVIOUR[tenant.piiMode].support}.
        {profileFields.length > 0 && (
          <details>
            <summary className="small">Company profile for {shortName(tenant.name)}</summary>
            <table className="table-view" style={{ marginTop: 6 }}>
              <tbody>
                {profileFields.map(([field, value]) => (
                  <tr key={field}><td className="mono" style={{ textAlign: "left" }}>{`{{${field}}}`}</td><td style={{ textAlign: "left" }}>{value}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </div>
  );
}

/** the routing choices: the three auto modes, each tier, and each backend with its status and context window */
function useModelOptions(endpoint: PlaygroundEndpoint, tenant: ConsoleTenant) {
  const { cfg } = useApp();
  const statusById = Object.fromEntries(useBackendStatus().map((b) => [b.id, b]));
  const tiers = [...new Set(cfg.backends.map((b) => b.tier))];
  return [
    { value: "auto", label: "Auto", description: "Heuristic: free, instant, explains every signal" },
    { value: "auto-smart", label: "Auto · smart", description: "A small model judges complexity first (~0.5 s)" },
    {
      value: "auto-cascade", label: "Auto · cascade",
      description: endpoint === "support" ? "Fast first; strong only if the fast model doubts itself" : "Support only; chat uses the heuristic",
    },
    ...tiers.map((tier) => ({ value: tier, label: `Tier: ${tier}`, description: "Pin a tier, fall back inside it" })),
    ...cfg.backends.map((b) => {
      const status = statusById[b.id] ? statusOf(statusById[b.id]) : { label: b.enabled ? "online" : "offline" };
      const parts = [
        LOCATION_LABEL[b.location] ?? b.location,
        status.label,
        ...(b.contextWindow ? [`${fmtN(b.contextWindow)} ctx`] : []),
        ...(tenant.allowedTiers.includes(b.tier) ? [] : ["not on plan"]),
      ];
      return { value: b.id, label: b.id, description: parts.join(" · "), disabled: status.label === "offline" };
    }),
  ];
}

/** characters against the field limit, and tokens against the selected model's context window */
function RequestSize({ check, endpoint }: { check: PlaygroundCheck; endpoint: PlaygroundEndpoint }) {
  const overWindow = check.window !== null && check.promptTokens + check.completionTokens > check.window;
  const promptNote = endpoint === "support"
    ? "your message; the gateway adds instructions and knowledge-base entries and checks the full prompt"
    : "system prompt and message";
  const windowText = check.window === null ? "no limit" : `${check.window.toLocaleString()} tokens`;
  const tooltip = [
    "The model's context window must hold the prompt and the reply.",
    `Prompt: ~${check.promptTokens.toLocaleString()} tokens (${promptNote})`,
    `Reply: ${check.completionTokens.toLocaleString()} tokens reserved (max_tokens)`,
    `Window of ${check.windowLabel}: ${windowText}`,
  ].join("\n");
  return (
    <>
      <span style={{ whiteSpace: "nowrap" }} className={`tiny num ${check.chars > check.maxChars ? "danger" : "muted"}`} title="Characters in the message box. The API rejects a longer message.">
        {check.chars.toLocaleString()} / {check.maxChars.toLocaleString()} chars
      </span>
      <span style={{ whiteSpace: "nowrap" }} className={`tiny num ${overWindow ? "danger" : "muted"}`} title={tooltip}>
        · ~{check.promptTokens.toLocaleString()} prompt + {check.completionTokens.toLocaleString()} reply
        {check.window === null ? " tokens (no limit)" : ` of ${windowText}`}
      </span>
    </>
  );
}

/** the current request as code, in the language picked */
function CodeView({ code, scopeName }: { code: (lang: Lang) => string; scopeName: string }) {
  const [lang, setLang] = useState<Lang>("curl");
  return (
    <div className="pg-form">
      <TabList value={lang} onChange={(value) => setLang(value as Lang)} size="sm" hasDivider>
        {LANGS.map((option) => <Tab key={option.id} value={option.id} label={option.label} />)}
      </TabList>
      <CodeBlock code={code(lang)} language={LANGS.find((option) => option.id === lang)!.language} hasCopyButton size="sm" />
      <div className="callout">
        <CornerDownLeft size={15} />
        <span>The same request through the API needs a key with the <span className="mono">{scopeName}</span> scope, read from <span className="mono">NALAR_API_KEY</span>.</span>
      </div>
    </div>
  );
}
