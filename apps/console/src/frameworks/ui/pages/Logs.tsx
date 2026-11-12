/** Logs: every metered request, newest first, with its route; a drawer shows the full record. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Fingerprint, ListTree, RefreshCcw, X } from "lucide-react";
import { Empty, GROUP, Outcome, RouteStrip } from "../components/ui";
import { useApp } from "../hooks/appContext";
import { FilterChip, PageHeader } from "../components/kit";
import type { Group, RequestDetail, RequestRow } from "../../../entities/models";
import { fmtUsd, fmtMs, fmtN, humanize, shortName } from "../../../entities/format";
import { groupOf } from "../../../entities/outcomes";
import { useApi } from "../hooks/api";

/** an attempt's outcome tag */
const ATTEMPT_OUTCOME_TONE: Record<string, string> = { ok: "good", refused: "warn" };

/** "email:1,card:2" → "email, card" */
const piiTypes = (summary: string) =>
  summary
    .split(",")
    .map((part) => humanize(part.split(":")[0]))
    .join(", ");

export function Logs() {
  const api = useApi();
  const { scope: tenant, can, cfg, setScope } = useApp();
  const [pii, setPii] = useState("");
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [group, setGroup] = useState<"" | Group>("");
  const [onlyFallback, setOnlyFallback] = useState(false);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.requests({ limit: 300, tenant }));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [tenant]);
  const open = (id: string) =>
    api
      .request(id)
      .then(setDetail)
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
    const timer = setInterval(load, 6000);
    return () => clearInterval(timer);
  }, [load]);

  const shown = useMemo(
    () =>
      rows.filter(
        (r) => (!group || groupOf(r.outcome) === group) && (!onlyFallback || r.fallback_used) && (!pii || !!r.pii),
      ),
    [rows, group, onlyFallback, pii],
  );

  return (
    <>
      <PageHeader
        title="Logs"
        sub="Every metered request, newest first, with the route it took. Select a row for the full routing decision and every attempt."
        actions={
          <button className="btn" onClick={load}>
            <RefreshCcw size={14} /> Refresh
          </button>
        }
      />
      <div className="chips">
        {can("tenants:all") && (
          <FilterChip
            label="Tenant"
            value={tenant || "*"}
            onChange={(v) => setScope(v === "*" ? "" : v)}
            options={[
              { value: "*", label: "All" },
              ...cfg.tenants.map((t) => ({ value: t.id, label: shortName(t.name) })),
            ]}
          />
        )}
        <FilterChip
          label="Outcome"
          value={group || "*"}
          onChange={(v) => setGroup(v === "*" ? "" : (v as Group))}
          options={[
            { value: "*", label: "All" },
            ...(Object.keys(GROUP) as Group[]).map((g) => ({ value: g, label: GROUP[g].label })),
          ]}
        />
        <FilterChip
          label="Fallback"
          value={onlyFallback ? "yes" : "*"}
          onChange={(v) => setOnlyFallback(v === "yes")}
          options={[
            { value: "*", label: "All" },
            { value: "yes", label: "Only fell back" },
          ]}
        />
        <FilterChip
          label="Personal data"
          value={pii || "*"}
          onChange={(v) => setPii(v === "*" ? "" : v)}
          options={[
            { value: "*", label: "All" },
            { value: "yes", label: "Masked or blocked" },
          ]}
        />
        <span className="muted small" style={{ marginLeft: "auto" }}>
          {fmtN(shown.length)} of the latest {fmtN(rows.length)}
        </span>
      </div>
      {err && <div className="banner error">{err}</div>}

      <section className="panel" style={{ overflow: "auto" }} data-tour="logs">
        <table className="tbl click">
          <thead>
            <tr>
              <th>Time</th>
              {can("tenants:all") && <th>Tenant</th>}
              <th>Credential</th>
              <th>Outcome</th>
              <th>PII</th>
              <th>Route (attempts in order)</th>
              <th>Intent</th>
              <th className="r">Tokens</th>
              <th className="r">Latency</th>
              <th className="r">First token</th>
              <th className="r">Cost</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} onClick={() => open(r.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open(r.id)}>
                <td className="num">{new Date(r.created_at).toLocaleTimeString()}</td>
                {can("tenants:all") && <td>{r.tenant_id}</td>}
                <td className="small">
                  <Credential row={r} />
                </td>
                <td>
                  <Outcome outcome={r.outcome} />
                </td>
                <td>
                  {r.pii ? (
                    <span className="tag pii" title={`Masked before the model: ${r.pii}`}>
                      <Fingerprint size={12} /> {piiTypes(r.pii)}
                    </span>
                  ) : (
                    <span className="muted">–</span>
                  )}
                </td>
                <td>
                  <RouteStrip trail={r.attempt_trail} />
                </td>
                <td className="small">{r.intent ?? <span className="muted">–</span>}</td>
                <td className="r">
                  {fmtN(r.prompt_tokens + r.completion_tokens)}
                  {r.usage_source === "estimated" && <span className="muted small"> est.</span>}
                </td>
                <td className="r">{fmtMs(r.latency_ms)}</td>
                <td className="r">{fmtMs(r.ttft_ms)}</td>
                <td className="r">{fmtUsd(r.cost_usd)}</td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={12}>
                  <Empty icon={ListTree} title="No requests match these filters">
                    Requests appear here as soon as they are metered.
                  </Empty>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {detail && <RequestDrawer detail={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

/** who made the call: the console playground, or an API key by name */
function Credential({ row }: { row: RequestRow }) {
  if (row.credential?.startsWith("user:")) return <span className="tag">console</span>;
  if (row.credential_name) return <span title={row.credential ?? undefined}>{row.credential_name}</span>;
  return <span className="muted">–</span>;
}

function RequestDrawer({ detail, onClose }: { detail: RequestDetail; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const trail = detail.attempts.map((a) => `${a.backend}:${a.outcome}`).join(",");
  return (
    <div className="drawer" onClick={onClose}>
      <div
        className="drawer-body"
        role="dialog"
        aria-label={`Request ${detail.id}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>
          <span className="mono">{detail.id}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </h3>
        <div className="filters small" style={{ marginBottom: 10 }}>
          <Outcome outcome={detail.outcome} />
          <span className="tag">{detail.tenant_id}</span>
          <span className="tag">{detail.endpoint}</span>
          {detail.error_code && <span className="tag bad">{detail.error_code}</span>}
          {detail.pii && (
            <span className="tag pii">
              <Fingerprint size={12} /> PII masked: {detail.pii}
            </span>
          )}
          <span className="muted">{new Date(detail.created_at).toLocaleString()}</span>
        </div>
        {detail.error_message && (
          <div className="banner small" style={{ marginBottom: 10 }}>
            {detail.error_message}
          </div>
        )}
        <div className="section">
          <h4>Route</h4>
          <RouteStrip trail={trail} />
        </div>
        {detail.route_reason && (
          <div className="section">
            <h4>Routing decision</h4>
            <div>
              <span className="tag accent">{detail.route_reason.rule}</span> {detail.route_reason.reason}
            </div>
            <div className="mono small muted" style={{ marginTop: 4 }}>
              planned chain: {detail.route_reason.chain.join(" › ")}
            </div>
            <pre>{JSON.stringify(detail.route_reason.signals, null, 2)}</pre>
          </div>
        )}
        <div className="section">
          <h4>Attempts</h4>
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th>
                <th>Backend</th>
                <th>Outcome</th>
                <th className="r">Latency</th>
                <th className="r">First token</th>
                <th className="r">Tokens in / out</th>
                <th>Usage</th>
                <th className="r">Cost</th>
              </tr>
            </thead>
            <tbody>
              {detail.attempts.map((a) => (
                <tr key={a.id}>
                  <td>{a.seq}</td>
                  <td className="mono">{a.backend}</td>
                  <td>
                    <span className={`tag ${ATTEMPT_OUTCOME_TONE[a.outcome] ?? "bad"}`}>{humanize(a.outcome)}</span>
                    {a.error && <div className="muted small">{a.error}</div>}
                  </td>
                  <td className="r">{fmtMs(a.latency_ms)}</td>
                  <td className="r">{fmtMs(a.ttft_ms)}</td>
                  <td className="r">
                    {fmtN(a.prompt_tokens)} / {fmtN(a.completion_tokens)}
                  </td>
                  <td>{a.usage_source}</td>
                  <td className="r">{fmtUsd(a.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="section">
          <h4>Metered record</h4>
          <pre>{JSON.stringify({ ...detail, attempts: undefined, route_reason: undefined }, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
