import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadDemoConfig, type DemoConfig } from "./api";
import { Playground } from "./Playground";
import { Usage } from "./Usage";
import { Backends } from "./Backends";
import "./styles.css";

type Tab = "playground" | "usage" | "backends";

function App() {
  const [cfg, setCfg] = useState<DemoConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || "playground");
  useEffect(() => {
    loadDemoConfig()
      .then((c) => (c ? setCfg(c) : setErr("Demo mode is disabled on this server; the console needs DEMO_MODE=true.")))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    location.hash = tab;
  }, [tab]);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">◆</span> Nalar <span className="tagline">LLM gateway with common sense</span>
        </div>
        <nav>
          {(["playground", "usage", "backends"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t === "playground" ? "Playground" : t === "usage" ? "Usage & requests" : "Backends & chaos"}
            </button>
          ))}
        </nav>
      </header>
      {err && <div className="banner error">{err}</div>}
      {!cfg && !err && <div className="muted pad">Loading…</div>}
      {cfg && tab === "playground" && <Playground cfg={cfg} />}
      {cfg && tab === "usage" && <Usage cfg={cfg} />}
      {cfg && tab === "backends" && <Backends cfg={cfg} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
