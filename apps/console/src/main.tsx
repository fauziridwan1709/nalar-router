import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadDemoConfig, type DemoConfig } from "./api";
import { Overview } from "./Overview";
import { Playground } from "./Playground";
import { Requests } from "./Requests";
import { Tenants } from "./Tenants";
import { Backends } from "./Backends";
import { Evaluations } from "./Evaluations";
import { Icon, Logo, NAV_ICONS } from "./ui";
import { useBackendStatus, statusOf } from "./StatusBadge";
import "./styles.css";

const PAGES = {
  overview: { label: "Overview", title: "Overview", sub: "Traffic, reliability and spend across every tenant" },
  playground: { label: "Playground", title: "Support assistant playground", sub: "Send a customer message and inspect every decision the gateway makes" },
  requests: { label: "Requests", title: "Requests", sub: "Every metered request, with the route it took" },
  tenants: { label: "Tenants & quota", title: "Tenants and quota", sub: "Monthly usage against each plan's limits" },
  backends: { label: "Backends", title: "Backends", sub: "Health, pricing, timeouts, and fault injection" },
  evaluations: { label: "Evaluations", title: "Evaluations", sub: "Committed eval runs: accuracy, quality, latency and cost per configuration" },
} as const;
type Page = keyof typeof PAGES;

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);
  return [theme, setTheme] as const;
}

function App() {
  const [cfg, setCfg] = useState<DemoConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState<Page>(() => {
    const h = location.hash.slice(1);
    return (h in PAGES ? h : "overview") as Page;
  });
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    loadDemoConfig()
      .then((c) => (c ? setCfg(c) : setErr("Demo mode is off on this server. The console needs DEMO_MODE=true to get tenant keys.")))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    if (location.hash.slice(1) !== page) location.hash = page;
    document.title = `${PAGES[page].label} · nalar-router`;
  }, [page]);
  // deep links and the back button
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.slice(1);
      if (h in PAGES) setPage(h as Page);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="shell">
      <nav className="nav" aria-label="Console">
        <div className="brand">
          <Logo />
          <div>
            <b>nalar-router</b>
            <span>LLM gateway console</span>
          </div>
        </div>
        <ul>
          {(Object.keys(PAGES) as Page[]).map((p) => (
            <li key={p}>
              <button aria-current={page === p ? "page" : undefined} onClick={() => setPage(p)}>
                <Icon d={NAV_ICONS[p]} size={16} />
                {PAGES[p].label}
              </button>
            </li>
          ))}
        </ul>
        <div className="foot">
          {cfg && <BackendSummary adminToken={cfg.adminToken} />}
          <div className="row">
            <span className="small muted">{location.hostname === "localhost" ? "Local" : location.hostname}</span>
            <button className="btn ghost sm" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              <Icon d={theme === "dark" ? NAV_ICONS.sun : NAV_ICONS.moon} />
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        </div>
      </nav>
      <div className="main">
        <div className="topbar">
          <div>
            <h1>{PAGES[page].title}</h1>
            <div className="sub">{PAGES[page].sub}</div>
          </div>
        </div>
        <main className="content">
          {err && <div className="banner error">{err}</div>}
          {!cfg && !err && <div className="muted">Loading…</div>}
          {cfg && page === "overview" && <Overview cfg={cfg} go={(p) => setPage(p as Page)} />}
          {cfg && page === "playground" && <Playground cfg={cfg} />}
          {cfg && page === "requests" && <Requests cfg={cfg} />}
          {cfg && page === "tenants" && <Tenants cfg={cfg} />}
          {cfg && page === "backends" && <Backends cfg={cfg} />}
          {cfg && page === "evaluations" && <Evaluations cfg={cfg} />}
        </main>
      </div>
    </div>
  );
}

function BackendSummary({ adminToken }: { adminToken: string }) {
  const list = useBackendStatus(adminToken, 15_000);
  if (!list.length) return null;
  const online = list.filter((b) => statusOf(b).label === "online").length;
  return (
    <div className="small ink2">
      {online} of {list.length} backends online
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
