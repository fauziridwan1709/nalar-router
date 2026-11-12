import { useEffect, useMemo, useState } from "react";
import { Select } from "../components/ui";
import { PageHeader } from "../components/kit";
import { ChartPanel, HBars, TableView } from "../components/charts";
import type { EvalSummary, EvalRun } from "../../../entities/models";
import { fmtMs } from "../../../entities/format";
import { useApi } from "../hooks/api";


/** what each run was for, so the picker reads as a list of experiments */
const PURPOSE: Record<string, string> = {
  "2026-11-10T04-15-13": "Local Qwen prompt v1 vs v2, with retrieval-only baseline",
  "2026-11-10T04-32-12": "Model and prompt comparison: Groq fast vs strong, v1 vs v2, local Qwen",
  "2026-11-10T08-11-44": "Placeholder rendering: v2 raw vs v3 rendered (clean run)",
  "2026-11-10T08-35-26": "Placeholder rendering re-run, hit Groq rate limits (resilience result)",
};

const pct = (v: number) => `${(v * 100).toFixed(v === 1 ? 0 : 1)}%`;

export function Evaluations() {
  const api = useApi();
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [file, setFile] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.evals()
      .then((r) => {
        setRuns(r);
        const preferred = r.find((x) => x.stamp === "2026-11-10T04-32-12") ?? r[0];
        setFile(preferred?.file ?? "");
      })
      .catch((e) => setErr((e as Error).message));
  }, []);
  const run = useMemo(() => runs.find((r) => r.file === file), [runs, file]);

  if (err) return <div className="banner error">{err}</div>;
  if (!run) return <div className="muted">Loading evaluation runs…</div>;
  const c = run.configs;
  const hasLeak = c.some((x) => x.answersWithRawPlaceholders != null);

  return (
    <>
      <PageHeader title="Evaluations" sub="Committed eval runs over held-out Bitext cases: intent accuracy, answer quality, latency and cost per configuration." />
      <div className="filters">
        <Select label="Evaluation run" width={520} value={file} onChange={setFile} search
          options={runs.map((r) => ({ value: r.file, label: PURPOSE[r.stamp] ?? r.configs.map((x) => x.config).join(" vs "), description: r.stamp.replace("T", " ").slice(0, 16) }))} />
        <span className="muted small">
          {run.n.inDomain} held-out Bitext cases + {run.n.ood} out-of-domain, through the real gateway. Judge: {run.judge ?? "none"}.
        </span>
      </div>

      <div className="grid c3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))" }}>
        <ChartPanel title="Intent accuracy" sub="Refusals count as wrong">
          <HBars format={pct} rows={c.map((x) => ({ label: x.config, value: x.intentAccuracy }))} />
        </ChartPanel>
        {c.some((x) => x.judgeMean != null) && (
          <ChartPanel title="Answer quality (LLM judge)" sub={`Mean score, 1 to 5, ${run.judge} vs the Bitext reference`}>
            <HBars format={(v) => v.toFixed(2)} rows={c.map((x) => ({ label: x.config, value: x.judgeMean ?? 0, sub: `n=${x.judgeN}` }))} />
          </ChartPanel>
        )}
        <ChartPanel title="Latency p50" sub="Client-measured, end to end">
          <HBars format={(v) => fmtMs(Math.round(v))} rows={c.map((x) => ({ label: x.config, value: x.latencyP50 ?? 0, sub: `p95 ${fmtMs(Math.round(x.latencyP95 ?? 0))}` }))} />
        </ChartPanel>
        <ChartPanel title="Cost per 1,000 requests" sub="Estimated from metered tokens and list prices">
          <HBars format={(v) => `$${v.toFixed(3)}`} rows={c.map((x) => ({ label: x.config, value: x.costPer1kRequestsUsd, sub: `${x.tokensPerModelCall} tokens per call` }))} />
        </ChartPanel>
        {hasLeak && (
          <ChartPanel title="Answers showing raw placeholders" sub={`Out of ${run.n.inDomain} in-domain answers; lower is better`}>
            <HBars format={(v) => String(v)} rows={c.map((x) => ({ label: x.config, value: x.answersWithRawPlaceholders ?? 0 }))} />
          </ChartPanel>
        )}
        <ChartPanel title="Fallbacks" sub="Requests served by a backend other than the first choice">
          <HBars format={(v) => String(v)} rows={c.map((x) => ({ label: x.config, value: x.fallbacks, sub: Object.entries(x.backends).map(([k, v]) => `${k} ${v}`).join(", ") }))} />
        </ChartPanel>
      </div>

      <section className="panel">
        <header><div><h2>All metrics</h2><p>From <span className="mono">tools/eval/results/{run.file}</span></p></div></header>
        <div className="body" style={{ overflow: "auto" }}>
          <TableView
            rows={c}
            cols={[
              { label: "Configuration", get: (x) => <span className="mono">{x.config}</span> },
              { label: "Intent acc.", get: (x) => pct(x.intentAccuracy) },
              { label: "False refusals", get: (x) => `${x.falseRefusals}/${run.n.inDomain}` },
              { label: "OOD refused", get: (x) => `${x.oodCorrectlyRefused}/${x.oodTotal}` },
              { label: "Judge", get: (x) => (x.judgeMean == null ? "–" : x.judgeMean.toFixed(2)) },
              { label: "ROUGE-L", get: (x) => (x.rougeLMean == null ? "–" : x.rougeLMean.toFixed(2)) },
              { label: "p50 / p95", get: (x) => `${fmtMs(Math.round(x.latencyP50 ?? 0))} / ${fmtMs(Math.round(x.latencyP95 ?? 0))}` },
              { label: "First token p50", get: (x) => fmtMs(Math.round(x.ttftP50 ?? 0)) },
              { label: "Tokens/call", get: (x) => x.tokensPerModelCall },
              { label: "$ / 1k req", get: (x) => `$${x.costPer1kRequestsUsd.toFixed(3)}` },
              ...(hasLeak ? [{ label: "Raw {{…}}", get: (x: EvalSummary) => x.answersWithRawPlaceholders ?? "–" }] : []),
              { label: "Errors / fallbacks", get: (x) => `${x.errors} / ${x.fallbacks}` },
            ]}
          />
        </div>
      </section>
    </>
  );
}
