/**
 * The playground: build a request on the left, see the answer and how the gateway served it on
 * the right. It calls either public endpoint (the support assistant or raw chat completions),
 * streamed or as one JSON body, through the console twin of that endpoint: same quota, routing,
 * fallback and metering, as the signed-in user's tenant (operators can pick another). No API key
 * reaches the browser.
 */
import { useEffect, useState } from "react";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Fingerprint, History, Plus, Share2 } from "lucide-react";
import { fmtMs, humanize } from "../../../../entities/format";
import { checkPlayground } from "../../../../entities/limits";
import { ENDPOINT_PATH, type ConsoleConfig, type PlaygroundBody, type SessionUser } from "../../../../entities/models";
import type { Turn } from "../../../../entities/playground";
import { chatSnippet, supportSnippet, type Lang } from "../../../../entities/snippets";
import { Logo, Outcome } from "../../components/ui";
import { useApp } from "../../hooks/appContext";
import { Answer } from "./Answer";
import { Composer, type RequestForm } from "./Composer";
import { GetCode } from "./GetCode";
import { Inspector } from "./Inspector";
import { CHAT_TEMPLATES, DEFAULT_SYSTEM_PROMPT, SUPPORT_TEMPLATES, type Template } from "./templates";
import { usePlaygroundRun } from "./usePlaygroundRun";

/** operators start on the first customer tenant rather than their own internal one */
function initialTenant(cfg: ConsoleConfig, user: SessionUser, scope: string | null, isOperator: boolean) {
  if (scope) return scope;
  const preferred = isOperator ? cfg.tenants.find((t) => t.plan !== "internal")?.id : user.tenant?.id;
  return preferred ?? cfg.tenants[0].id;
}

/** the API request body for the form, plus the tenant field operators send */
function requestBody(form: RequestForm, tenantField: { tenant?: string }): PlaygroundBody {
  const message = form.message.trim();
  if (form.endpoint === "chat") {
    const system = form.system.trim();
    return {
      messages: [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        { role: "user" as const, content: message },
      ],
      model: form.model,
      include_reasoning: form.reasoning,
      ...tenantField,
    };
  }
  return {
    message,
    model: form.model,
    prompt_version: form.promptVersion,
    include_reasoning: form.reasoning,
    ...tenantField,
  };
}

export function Playground() {
  const { cfg, can, scope, user, go } = useApp();
  const isOperator = can("tenants:all");
  const [form, setForm] = useState<RequestForm>(() => ({
    endpoint: "support",
    tenantId: initialTenant(cfg, user, scope, isOperator),
    model: "auto",
    promptVersion: "v3",
    reasoning: true,
    stream: true,
    system: DEFAULT_SYSTEM_PROMPT,
    message: "",
  }));
  const update = (change: Partial<RequestForm>) => setForm((previous) => ({ ...previous, ...change }));
  const [codeOpen, setCodeOpen] = useState(false);
  const runs = usePlaygroundRun();

  // an operator switching tenant in the top bar switches the playground too
  useEffect(() => {
    if (isOperator && scope) update({ tenantId: scope });
  }, [isOperator, scope]);

  const tenant = cfg.tenants.find((t) => t.id === form.tenantId) ?? cfg.tenants[0];
  // the same limits the API enforces: characters per field, and the selected model's context window
  const check = checkPlayground(
    {
      endpoint: form.endpoint,
      message: form.message,
      system: form.system,
      model: form.model,
      includeReasoning: form.reasoning,
    },
    cfg,
    tenant.allowedTiers,
  );
  const templates = form.endpoint === "chat" ? CHAT_TEMPLATES : SUPPORT_TEMPLATES;
  const scopeName = form.endpoint === "chat" ? "chat.completions" : "support.answer";

  function run() {
    if (!form.message.trim() || runs.busy || check.problems.length > 0) return;
    const system = form.endpoint === "chat" ? form.system.trim() : "";
    runs.send({
      endpoint: form.endpoint,
      stream: form.stream,
      body: requestBody(form, isOperator ? { tenant: tenant.id } : {}),
      question: form.message.trim(),
      system: system || undefined,
      tenant: tenant.id,
      settings: { model: form.model, prompt_version: form.promptVersion, include_reasoning: form.reasoning },
    });
  }

  /** the request as code; an empty message box shows the first template instead */
  const code = (lang: Lang) => {
    const message = form.message.trim() || templates[0].text;
    if (form.endpoint === "chat") {
      const system = form.system.trim();
      return chatSnippet(lang, location.origin, {
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: message }],
        model: form.model,
        include_reasoning: form.reasoning,
        stream: form.stream,
      });
    }
    return supportSnippet(lang, location.origin, {
      message,
      model: form.model,
      prompt_version: form.promptVersion,
      include_reasoning: form.reasoning,
      stream: form.stream,
    });
  };

  function openKeys() {
    setCodeOpen(false);
    go("keys");
  }

  return (
    <>
      <div className="pg-head">
        <div>
          <h1>Playground</h1>
          <p>
            Call the support assistant or raw chat completions, streamed or not, see how the gateway served it, and copy
            the code to ship.
          </p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => setCodeOpen(true)}>
            <Share2 size={15} /> Get code
          </button>
          <RunHistory turns={runs.turns} onSelect={runs.select} />
          <button className="btn" onClick={runs.reset} disabled={runs.busy && !runs.turns.length}>
            <Plus size={15} /> New
          </button>
        </div>
      </div>

      <div className="pg">
        <Composer
          form={form}
          update={update}
          tenant={tenant}
          check={check}
          busy={runs.busy}
          onRun={run}
          onStop={runs.stop}
          code={code}
          scopeName={scopeName}
        />
        <section className="pg-right" aria-label="Response" data-tour="pg-inspector">
          {runs.current ? (
            <RunView turn={runs.current} />
          ) : (
            <TemplatePicker
              templates={templates}
              endpointPath={ENDPOINT_PATH[form.endpoint]}
              stream={form.stream}
              onPick={(message) => update({ message })}
            />
          )}
        </section>
      </div>

      <GetCode
        open={codeOpen}
        onClose={() => setCodeOpen(false)}
        code={code}
        scopeName={scopeName}
        canManageKeys={can("keys:read")}
        openKeys={openKeys}
      />
    </>
  );
}

function RunHistory({ turns, onSelect }: { turns: Turn[]; onSelect: (id: number) => void }) {
  const status = (turn: Turn) => {
    if (turn.done) return `${humanize(turn.done.outcome)} · ${fmtMs(turn.done.latencyMs)}`;
    return turn.error ? turn.error.code : "running";
  };
  return (
    <DropdownMenu
      alignment="end"
      menuWidth={340}
      button={{
        label: `History${turns.length ? ` (${turns.length})` : ""}`,
        variant: "ghost",
        icon: <History size={15} />,
      }}
      header={
        turns.length ? undefined : (
          <div className="menu-head">
            <span className="tiny muted">Runs from this session appear here.</span>
          </div>
        )
      }
      items={[...turns].reverse().map((turn) => ({
        label: turn.question.length > 46 ? `${turn.question.slice(0, 45)}…` : turn.question,
        description: status(turn),
        onClick: () => onSelect(turn.id),
      }))}
    />
  );
}

/** the response card and its inspector */
function RunView({ turn }: { turn: Turn }) {
  return (
    <>
      <div className="panel response">
        <header>
          <div>
            <h2>Response</h2>
            <p className="mono">
              POST {ENDPOINT_PATH[turn.endpoint]} · {turn.stream ? "stream" : "JSON"}
              {turn.meta?.requestId
                ? ` · ${turn.meta.requestId}`
                : turn.streaming
                  ? " · waiting for the gateway…"
                  : " · rejected before a model was called"}
            </p>
          </div>
          <div className="tools">{turn.done && <Outcome outcome={turn.done.outcome} />}</div>
        </header>
        <div className="body">
          <Answer turn={turn} />
        </div>
      </div>
      <div className="panel">
        <Inspector turn={turn} />
      </div>
    </>
  );
}

function TemplatePicker(props: {
  templates: Template[];
  endpointPath: string;
  stream: boolean;
  onPick: (message: string) => void;
}) {
  return (
    <div className="templates">
      <div className="mascot">
        <Logo size={44} />
      </div>
      <h3>Start with a template</h3>
      <p>
        Build your request and press Run. It goes to <span className="mono">POST {props.endpointPath}</span>
        {props.stream ? ", streamed" : " as one JSON response"}.
      </p>
      <div className="tpl-grid">
        {props.templates.map((template) => (
          <button key={template.title} className="tpl" onClick={() => props.onPick(template.text)}>
            <b>{template.title}</b>
            <p>{template.body}</p>
            <div className="tags">
              {template.tags.map((tag) => (
                <span key={tag} className={`tag ${tag === "PII guardrail" ? "pii" : ""}`}>
                  {tag === "PII guardrail" && <Fingerprint size={12} />}
                  {tag}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
