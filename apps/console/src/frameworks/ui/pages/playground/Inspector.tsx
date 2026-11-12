/** The inspector under the answer: one tab per question a reviewer asks about a run. */
import { useState } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Fingerprint } from "lucide-react";
import type { StepEvent } from "../../../../entities/events";
import { fmtMs, fmtN, fmtUsd, humanize } from "../../../../entities/format";
import { describeTraceEntry, slotTone, traceTone, type Turn } from "../../../../entities/playground";
import { useApp } from "../../hooks/appContext";
import { RoutingTab } from "./RoutingTab";

type TabId = "overview" | "trace" | "routing" | "retrieval" | "raw";

export function Inspector({ turn }: { turn: Turn }) {
  const [picked, setPicked] = useState<TabId>("overview");
  // chat runs have no retrieval tab
  const tab = picked === "retrieval" && turn.endpoint !== "support" ? "overview" : picked;
  return (
    <>
      <div className="inspector-tabs">
        <TabList value={tab} onChange={(value) => setPicked(value as TabId)} size="sm" hasDivider>
          <Tab value="overview" label="Overview" />
          <Tab value="trace" label={`Trace${turn.trace.length ? ` (${turn.trace.length})` : ""}`} />
          <Tab value="routing" label="Routing" />
          {turn.endpoint === "support" && <Tab value="retrieval" label="Retrieval" />}
          <Tab value="raw" label={turn.stream ? "Raw stream" : "Raw JSON"} />
        </TabList>
      </div>
      <div className="body inspector">
        {tab === "overview" && <OverviewTab turn={turn} />}
        {tab === "trace" && <TraceTab turn={turn} />}
        {tab === "routing" && <RoutingTab turn={turn} />}
        {tab === "retrieval" && <RetrievalTab turn={turn} />}
        {tab === "raw" && <RawTab turn={turn} />}
      </div>
    </>
  );
}

/** the step of a given name from the trace, if the run had it */
function stepOf<Name extends StepEvent["name"]>(turn: Turn, name: Name) {
  for (const entry of turn.trace) {
    if (entry.event === "step" && entry.data.name === name) return entry.data as Extract<StepEvent, { name: Name }>;
  }
  return undefined;
}

function OverviewTab({ turn }: { turn: Turn }) {
  const done = turn.done;
  const piiGuard = stepOf(turn, "pii_guard");
  const placeholders = stepOf(turn, "placeholders_rendered");
  const outcome = done ? humanize(done.outcome) : turn.error ? turn.error.code : "…";
  return (
    <>
      <div className="metrics">
        <Metric label="Served by" value={done?.backend ?? (turn.streaming ? "…" : "none")} note={done?.model ?? undefined} />
        <Metric label="Fallback" value={done ? (done.fallbackUsed ? "Yes" : "No") : "…"} />
        <Metric
          label="Tokens"
          value={done?.usage ? `${fmtN(done.usage.promptTokens)} in, ${fmtN(done.usage.completionTokens)} out` : "–"}
          note={done?.usage?.source && `from ${done.usage.source}`}
        />
        <Metric label="Latency" value={fmtMs(done?.latencyMs)} note={done?.ttftMs != null ? `first token ${fmtMs(done.ttftMs)}` : undefined} />
        <Metric label="Estimated cost" value={fmtUsd(done?.costUsd)} note={done?.quota && `${fmtN(done.quota.tokensRemaining)} tokens left this month`} />
        <Metric label="Outcome" value={outcome} />
      </div>
      {piiGuard && (
        <div className="section first">
          <h4>PII guardrail · {piiGuard.mode}</h4>
          {piiGuard.masked.length ? (
            <>
              <div className="tags">
                {piiGuard.masked.map((m) => (
                  <span key={m.placeholder} className="tag pii"><Fingerprint size={12} /> {m.label} → <span className="mono">{m.placeholder}</span></span>
                ))}
              </div>
              <div className="tiny muted" style={{ marginTop: 6 }}>The provider received the placeholders. The values were restored only in the answer you see.</div>
            </>
          ) : <div className="small muted">{piiGuard.detail}.</div>}
        </div>
      )}
      {(turn.intent || turn.refusal?.intent) && <IntentSection turn={turn} />}
      {placeholders && (
        <div className="section">
          <h4>Placeholders filled by the gateway</h4>
          <table className="tbl small">
            <tbody>
              {placeholders.slots.map((slot) => (
                <tr key={slot.name}>
                  <td className="mono">{`{{${slot.name}}}`}</td>
                  <td>{slot.source === "pii" ? <span className="muted">shown only in the answer</span> : slot.value || <span className="muted">removed</span>}</td>
                  <td><span className={`tag ${slotTone(slot.source)}`}>{slot.source === "pii" ? "restored PII" : humanize(slot.source)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** the detected intent and how its confidence was computed, or why the assistant refused */
function IntentSection({ turn }: { turn: Turn }) {
  const { cfg } = useApp();
  const weights = cfg.support.confidenceWeights;
  const intent = turn.intent;
  return (
    <div className="section">
      <h4>Intent and confidence</h4>
      {intent ? (
        <>
          <div>
            <b>{intent.intent}</b> <span className="tag">{intent.label}</span>{" "}
            {!intent.agreesWithRetrieval && <span className="tag warn">disagrees with retrieval</span>}
          </div>
          <div className="bar" role="meter" aria-valuenow={intent.confidence} aria-valuemin={0} aria-valuemax={1} aria-label="confidence">
            <div style={{ width: `${Math.round(intent.confidence * 100)}%` }} />
          </div>
          <div className="small muted num">
            {intent.confidence.toFixed(2)} = {weights.vote.toFixed(2)} × retrieval vote {intent.components.retrievalVote}
            {" "}+ {weights.coverage.toFixed(2)} × coverage {intent.components.coverage}
            {" "}+ {weights.model.toFixed(2)} × model {intent.components.model}
          </div>
        </>
      ) : (
        <div className="small">
          The model said <b>{turn.refusal!.intent}</b> with confidence {turn.refusal!.confidence}, so the assistant refused ({turn.refusal!.detail}).
        </div>
      )}
    </div>
  );
}

function TraceTab({ turn }: { turn: Turn }) {
  if (!turn.trace.length) return <div className="muted small">No events yet.</div>;
  return (
    <ol className="trace">
      {turn.trace.map((entry, i) => (
        <li key={i} className={traceTone(entry)} style={{ animationDelay: `${i * 30}ms` }}>
          <span className="tt">+{entry.t} ms</span>
          <span>{describeTraceEntry(entry)}</span>
        </li>
      ))}
    </ol>
  );
}

function RetrievalTab({ turn }: { turn: Turn }) {
  const retrieval = turn.retrieval;
  if (!retrieval) return <div className="muted small">No retrieval for this run.</div>;
  return (
    <>
      <div className="small ink2" style={{ marginBottom: 6 }}>Coverage {retrieval.coverage}. Retrieved knowledge base entries, raw text:</div>
      <div className="filters small">
        {retrieval.votes.map((vote) => <span key={vote.intent} className="tag">{vote.intent} {Math.round(vote.share * 100)}%</span>)}
      </div>
      {retrieval.entries.map((entry) => (
        <details key={entry.id} className="kb">
          <summary><span className="num muted">{entry.score}</span> <span className="tag">{entry.intent}</span> {entry.question}</summary>
          <div className="small pre ink2">{entry.answer}</div>
        </details>
      ))}
    </>
  );
}

/** what an API client receives, verbatim */
function RawTab({ turn }: { turn: Turn }) {
  if (!turn.raw) return <div className="muted small">{turn.streaming ? "Waiting for the response…" : "No response body."}</div>;
  let note = "The single JSON body an API client receives with stream: false.";
  if (turn.stream && turn.endpoint === "chat") note = "OpenAI chat.completion.chunk events; the gateway's route and attempt events ride along as SSE comments.";
  else if (turn.stream) note = "Server-Sent Events, as an API client receives them.";
  return (
    <>
      <div className="small ink2" style={{ marginBottom: 6 }}>{note}</div>
      <CodeBlock code={turn.raw} language={turn.stream ? "plaintext" : "json"} hasCopyButton maxHeight={420} size="sm" />
    </>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string | false | null }) {
  return (
    <div className="metric">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {note && <div className="s">{note}</div>}
    </div>
  );
}
