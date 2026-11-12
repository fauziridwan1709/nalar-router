/** The response card's body: the question, any reasoning, the answer as it streams, and a summary line. */
import { Brain } from "lucide-react";
import { fmtMs, fmtN, fmtUsd, humanize } from "../../../../entities/format";
import type { Turn } from "../../../../entities/playground";

export function Answer({ turn }: { turn: Turn }) {
  const failedBeforeAnswer = !!turn.error && !turn.answer;
  const discarded = (seq: number) =>
    turn.attempts.some((a) => a.seq === seq && a.status !== "started" && a.status !== "ok");
  return (
    <div className="answer">
      {turn.system && (
        <div className="q-bubble sys">
          <span className="tag">system</span> {turn.system}
        </div>
      )}
      <div className="q-bubble">
        <span className="tag">{turn.tenant}</span> {turn.question}
      </div>
      {turn.reasoning.map((block) => (
        <details key={block.seq} className="thinking" open={turn.streaming && !turn.answer}>
          <summary>
            <Brain size={13} /> Reasoning from <span className="mono">{block.backend}</span>
            {discarded(block.seq) && <> (attempt {block.seq}, discarded)</>}
          </summary>
          <div className="thought">{block.text}</div>
        </details>
      ))}
      <div className={`a ${turn.refusal ? "refusal" : ""} ${failedBeforeAnswer ? "err" : ""}`}>
        <AnswerText turn={turn} failedBeforeAnswer={failedBeforeAnswer} />
      </div>
      <div className="foot">
        {turn.refusal && <span className="tag warn">refused: {humanize(turn.refusal.reason)}</span>}
        {turn.done?.backend && <span className="tag">{turn.done.backend}</span>}
        {turn.done?.fallbackUsed && <span className="tag warn">fallback</span>}
        {turn.intent && (
          <span className="tag accent">
            {turn.intent.intent}, {turn.intent.label}
          </span>
        )}
        {turn.done && (
          <span className="num">
            {fmtN(turn.done.usage?.totalTokens)} tokens · {fmtMs(turn.done.latencyMs)} · {fmtUsd(turn.done.costUsd)}
          </span>
        )}
      </div>
    </div>
  );
}

/** a refusal's message, an error that stopped the run, or the answer so far */
function AnswerText({ turn, failedBeforeAnswer }: { turn: Turn; failedBeforeAnswer: boolean }) {
  if (turn.refusal) return <>{turn.refusal.message}</>;
  if (failedBeforeAnswer) return <>{turn.error!.message}</>;
  return (
    <>
      {turn.answer}
      {turn.streaming && <span className="cursor">▍</span>}
      {turn.error && <div className="tag bad">{turn.error.message}</div>}
    </>
  );
}
