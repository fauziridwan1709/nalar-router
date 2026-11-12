/** The inspector's Routing tab: the decision, what the classifier said, the complexity score, and every attempt. */
import type { ClassifierVerdict, ComplexityAssessment } from "../../../../entities/events";
import { fmtMs, fmtUsd, humanize } from "../../../../entities/format";
import { attemptTone, type Turn } from "../../../../entities/playground";

const SIGNAL_LABEL: Record<string, string> = {
  long_query: "Long query", medium_query: "Medium-length query", ambiguous_intent: "Ambiguous intent",
  multi_question: "Several questions", reasoning: "Reasoning asked for", multi_step: "Multi-step request",
  constraints: "Output constraints", code: "Code", math: "Calculation", long_conversation: "Long conversation",
};

const MODE_LABEL: Record<string, string> = {
  heuristic: "Auto (heuristic)", smart: "Auto · smart (classifier)", cascade: "Auto · cascade (fast first, escalate on doubt)", pinned: "pinned by the caller",
};

export function RoutingTab({ turn }: { turn: Turn }) {
  const route = turn.route;
  return (
    <>
      {route ? (
        <div className="section first">
          <h4>Routing decision</h4>
          <div><span className="tag accent">{route.rule}</span> <span className="small">{route.reason}</span></div>
          {route.mode && <div className="small muted" style={{ marginTop: 4 }}>mode: {MODE_LABEL[route.mode] ?? route.mode}</div>}
          <div className="mono small muted" style={{ marginTop: 4 }}>chain: {route.chain.join(" › ")}</div>
        </div>
      ) : <div className="muted small">No routing decision: the request didn't reach the router.</div>}
      {route?.signals?.classifier && <Classifier verdict={route.signals.classifier} />}
      {route?.signals?.complexity && <Complexity assessment={route.signals.complexity} />}
      {turn.attempts.length > 0 && <Attempts turn={turn} />}
    </>
  );
}

function Attempts({ turn }: { turn: Turn }) {
  return (
    <div className="section">
      <h4>Attempts</h4>
      <table className="tbl small">
        <tbody>
          {turn.attempts.map((a) => (
            <tr key={a.seq}>
              <td>{a.seq}</td>
              <td className="mono">{a.backend}</td>
              <td><span className={`tag ${attemptTone(a.status)}`}>{humanize(a.status)}</span></td>
              <td className="r">{a.latencyMs != null ? fmtMs(a.latencyMs) : "…"}</td>
              <td className="r">{a.promptTokens != null ? `${a.promptTokens} / ${a.completionTokens}` : ""}</td>
              <td className="r">{a.costUsd != null ? fmtUsd(a.costUsd) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {turn.attempts.filter((a) => a.error).map((a) => <div key={a.seq} className="muted small">Attempt {a.seq}: {a.error}</div>)}
    </div>
  );
}

/** auto-smart: what the classifier said, or why the heuristic decided instead */
function Classifier({ verdict }: { verdict: ClassifierVerdict }) {
  return (
    <div className="section">
      <h4>Classifier{verdict.status === "ok" ? ` · ${verdict.label}` : " · failed"}</h4>
      {verdict.status === "ok" ? (
        <div className="small">
          <span className={`tag ${verdict.label === "complex" ? "warn" : "good"}`}>{verdict.label}</span>{" "}
          confidence {verdict.confidence}{verdict.why ? <> · <span className="muted">"{verdict.why}"</span></> : null}
          <div className="muted" style={{ marginTop: 4 }}>{verdict.backend} · {verdict.latencyMs != null ? fmtMs(verdict.latencyMs) : ""}</div>
        </div>
      ) : (
        <div className="small muted">{verdict.error}{verdict.backend ? ` (${verdict.backend})` : ""}; the heuristic below decided.</div>
      )}
    </div>
  );
}

/** the complexity score behind auto routing: a meter with the threshold marked, then each signal */
function Complexity({ assessment }: { assessment: ComplexityAssessment }) {
  const { score, level, threshold, signals } = assessment;
  return (
    <div className="section">
      <h4>Query complexity · {level}</h4>
      <div className="cx-meter" role="meter" aria-label="complexity score" aria-valuenow={score} aria-valuemin={0} aria-valuemax={1}>
        <div className={score >= threshold ? "hi" : ""} style={{ width: `${Math.max(score * 100, 1)}%` }} />
        <span className="cx-threshold" style={{ left: `${threshold * 100}%` }} title={`threshold ${threshold}`} />
      </div>
      <div className="small muted num" style={{ marginBottom: 8 }}>
        score {score} · strong tier at {threshold} or more
      </div>
      {signals.length ? (
        <table className="tbl small">
          <tbody>
            {signals.map((signal) => (
              <tr key={signal.id}>
                <td>{SIGNAL_LABEL[signal.id] ?? signal.id}</td>
                <td className="muted">{signal.detail}</td>
                <td className="r num">+{signal.weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="small muted">No complexity signals: a short, single, unambiguous question.</div>}
    </div>
  );
}
