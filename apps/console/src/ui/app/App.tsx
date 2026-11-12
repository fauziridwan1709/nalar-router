import { useCallback, useEffect, useMemo, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { CommandPalette } from "@astryxdesign/core/CommandPalette";
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { Bell, BookOpen, Building2, ChevronsUpDown, LogOut, Moon, Search, Sparkles, Sun } from "lucide-react";
import { Ctx, type AppCtx } from "../../application/appContext";
import { SignIn } from "../pages/SignIn";
import { Dashboard } from "../pages/Dashboard";
import { Usage } from "../pages/Usage";
import { Cost } from "../pages/Cost";
import { Reliability } from "../pages/Reliability";
import { Playground } from "../pages/Playground";
import { Requests } from "../pages/Logs";
import { Tenants } from "../pages/Quotas";
import { Backends } from "../pages/Backends";
import { Evaluations } from "../pages/Evaluations";
import { ApiKeys } from "../pages/ApiKeys";
import { AuditLog } from "../pages/AuditLog";
import { Guardrails } from "../pages/Guardrails";
import { Access } from "../pages/Access";
import { TOUR, Tour, useSeen } from "../components/Tour";
import { statusOf } from "../components/StatusBadge";
import { Logo, NAV } from "../components/ui";
import type { Permission, SessionUser, ConsoleConfig } from "../../domain/models";
import { ROLE_LABEL, PAGES, type Page } from "../../domain/access";
import { useApi } from "../../application/api";
import { levelOf, share, tokenShare } from "../../domain/quota";

const DOCS_URL = "https://github.com/fauziridwan1709/nalar-router/blob/main/docs/API.md";

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    return saved === "light" ? "light" : "dark"; // dark by default, like the Claude Console
  });
  useEffect(() => localStorage.setItem("theme", theme), [theme]);
  return [theme, setTheme] as const;
}

/** the console: sign-in gate, theme, and the shell once a session exists */
export function App() {
  const api = useApi();
  const [theme, setTheme] = useTheme();
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.auth.session().then(setUser).catch(() => setUser(null));
    api.auth.onSignedOut(() => {
      setNotice("Your session ended. Sign in again to continue.");
      setUser(null);
    });
  }, []);

  return (
    <Theme theme={neutralTheme} mode={user ? theme : "dark"}>
      {user === undefined ? (
        <div className="boot"><Logo size={36} /></div>
      ) : user === null ? (
        <SignIn notice={notice} onSignedIn={(u) => (setNotice(null), setUser(u))} />
      ) : (
        <Shell user={user} theme={theme} setTheme={setTheme} onSignOut={async () => (await api.auth.signOut(), setUser(null))} />
      )}
    </Theme>
  );
}

interface Alert {
  id: string;
  title: string;
  detail: string;
  page: Page;
}

/** what deserves a dot on the bell: quotas close to the limit, backends that are down */
function useAlerts(can: (p: Permission) => boolean) {
  const api = useApi();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const out: Alert[] = [];
      if (can("usage:read")) {
        const usage = await api.usage().catch(() => []);
        for (const u of usage) {
          const level = levelOf(u);
          if (level === "ok") continue;
          const p = Math.max(tokenShare(u), share(u.requestsUsed, u.requestQuota));
          out.push({
            id: `q-${u.tenant}`,
            title: level === "out" ? `${u.name.split(" (")[0]} is rejecting requests` : `${u.name.split(" (")[0]} at ${Math.round(p * 100)}% of quota`,
            detail: level === "out" ? "New requests get 429 until the period resets or the quota is reset." : "Requests will be rejected once it reaches 100%.",
            page: "quotas",
          });
        }
      }
      if (can("backends:read")) {
        const list = await api.backends().catch(() => []);
        for (const b of list) {
          const s = statusOf(b);
          if (b.enabled && s.label !== "online") out.push({ id: `b-${b.id}`, title: `${b.id} is ${s.label}`, detail: s.reason || "The router skips it and falls back.", page: "backends" });
        }
      }
      if (alive) setAlerts(out);
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [can]);
  return alerts;
}

function Shell({ user, theme, setTheme, onSignOut }: { user: SessionUser; theme: "light" | "dark"; setTheme: (t: "light" | "dark") => void; onSignOut: () => void }) {
  const api = useApi();
  const can = useCallback((p: Permission) => user.permissions.includes(p), [user]);
  const allowed = useMemo(() => (Object.keys(PAGES) as Page[]).filter((p) => can(PAGES[p].perm)), [can]);
  const [cfg, setCfg] = useState<ConsoleConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [page, setPage] = useState<Page>(() => {
    const h = location.hash.slice(1) as Page;
    return allowed.includes(h) ? h : allowed[0];
  });
  const tourKey = `tour:v2:${user.id}`;
  const [touring, setTouring] = useState(false);
  const [guardSeen, markGuardSeen] = useSeen(`guardrails:${user.id}`);
  const alerts = useAlerts(can);

  useEffect(() => {
    api.config().then(setCfg).catch(() => setErr("Couldn't load the console. Reload the page to try again."));
  }, []);
  useEffect(() => {
    if (cfg && !localStorage.getItem(tourKey)) setTimeout(() => setTouring(true), 700);
  }, [cfg, tourKey]);
  useEffect(() => {
    if (location.hash.slice(1) !== page) location.hash = page;
    document.title = `${PAGES[page].label} · nalar console`;
    if (page === "guardrails") markGuardSeen();
  }, [page, markGuardSeen]);
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.slice(1) as Page;
      if (allowed.includes(h)) setPage(h);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey);
    };
  }, [allowed]);

  const ctx: AppCtx | null = cfg && {
    user, cfg, can, go: (p) => allowed.includes(p) && setPage(p),
    scope: can("tenants:all") ? scope : user.tenant?.id ?? "",
    setScope,
    tenantName: (id) => cfg.tenants.find((t) => t.id === id)?.name.split(" (")[0] ?? id,
  };
  const sections = [...new Set(allowed.map((p) => PAGES[p].section))];
  const endTour = () => {
    localStorage.setItem(tourKey, "done");
    setTouring(false);
  };

  const commands = useMemo(
    () => [
      ...allowed.map((p) => ({ id: `go:${p}`, label: `${PAGES[p].label}`, auxiliaryData: { hint: PAGES[p].section || "Home" } })),
      ...(can("keys:create") ? [{ id: "do:key", label: "Create an API key", auxiliaryData: { hint: "Action" } }] : []),
      ...(can("governance:write") ? [{ id: "do:pii", label: "Change the PII masking policy", auxiliaryData: { hint: "Action" } }] : []),
      { id: "do:theme", label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", auxiliaryData: { hint: "Action" } },
      { id: "do:tour", label: "Take the feature tour", auxiliaryData: { hint: "Help" } },
      { id: "do:docs", label: "Open the API documentation", auxiliaryData: { hint: "Help" } },
      { id: "do:signout", label: "Sign out", auxiliaryData: { hint: "Account" } },
    ],
    [allowed, can, theme],
  );
  const source = useMemo(() => createStaticSource(commands, { keywords: (c) => [String((c.auxiliaryData as any)?.hint ?? "")] }), [commands]);
  const runCommand = (id: string) => {
    setPaletteOpen(false);
    if (id.startsWith("go:")) setPage(id.slice(3) as Page);
    else if (id === "do:key") setPage("keys");
    else if (id === "do:pii") setPage("guardrails");
    else if (id === "do:theme") setTheme(theme === "dark" ? "light" : "dark");
    else if (id === "do:tour") setTouring(true);
    else if (id === "do:docs") window.open(DOCS_URL, "_blank", "noopener,noreferrer");
    else if (id === "do:signout") onSignOut();
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="logo" href="#dashboard" onClick={(e) => (e.preventDefault(), allowed.includes("dashboard") && setPage("dashboard"))} aria-label="nalar console home">
          <Logo />
          <b>nalar <span>console</span></b>
        </a>
        <button className="search-pill" onClick={() => setPaletteOpen(true)} data-tour="search">
          <Search size={15} aria-hidden /> Search console…
          <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} K</kbd>
        </button>
        <div className="top-actions">
          <a className="top-link" href={DOCS_URL} target="_blank" rel="noopener noreferrer"><BookOpen size={16} /> Documentation</a>
          <DropdownMenu
            alignment="end"
            menuWidth={320}
            renderTrigger={(p) => (
              <button {...p} className="icon-btn bell" aria-label={`Notifications${alerts.length ? `, ${alerts.length} new` : ""}`}>
                <Bell size={17} />
                {alerts.length > 0 && <span className="dot" />}
              </button>
            )}
            header={<div className="menu-head"><b>Notifications</b>{!alerts.length && <span className="tiny muted">Nothing needs your attention.</span>}</div>}
            items={alerts.map((a) => ({ label: a.title, description: a.detail, onClick: () => setPage(a.page) }))}
          />
          <Tooltip content="Feature guide">
            <button className="icon-btn" data-tour="help" onClick={() => setTouring(true)} aria-label="Open the feature guide"><Sparkles size={17} /></button>
          </Tooltip>
        </div>
      </header>

      <div className="frame">
        <aside className="sidebar">
          <nav aria-label="Console" data-tour="nav">
            {sections.map((s) => (
              <div key={s || "home"}>
                {s && <div className="nav-heading">{s}</div>}
                <ul>
                  {allowed.filter((p) => PAGES[p].section === s).map((p) => {
                    const I = NAV[p];
                    return (
                      <li key={p}>
                        <button aria-current={page === p ? "page" : undefined} onClick={() => setPage(p)}>
                          <I size={17} strokeWidth={1.7} aria-hidden />
                          {PAGES[p].label}
                          {p === "guardrails" && !guardSeen && <span className="new-pill">New</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <div className="account">
            <DropdownMenu
              placement="above"
              menuWidth={240}
              renderTrigger={(p) => (
                <button {...p} className="account-btn" aria-label={`Account menu for ${user.name}`}>
                  <span className="org"><Building2 size={16} /></span>
                  <span>
                    <b>{user.name}</b>
                    <span>{user.tenant?.name.split(" (")[0]} · {ROLE_LABEL[user.role]}</span>
                  </span>
                  <ChevronsUpDown size={15} className="muted" />
                </button>
              )}
              header={
                <div className="menu-head">
                  <b>{user.name}</b>
                  <span className="mono tiny muted">{user.email}</span>
                  <span className="tag"><span className={`role-dot ${user.role}`} /> {ROLE_LABEL[user.role]} · {user.tenant?.plan} plan</span>
                </div>
              }
              items={[
                { label: theme === "dark" ? "Light theme" : "Dark theme", icon: theme === "dark" ? <Sun size={15} /> : <Moon size={15} />, onClick: () => setTheme(theme === "dark" ? "light" : "dark") },
                { label: "Take the feature tour", icon: <Sparkles size={15} />, onClick: () => setTouring(true) },
                { type: "divider" },
                { label: "Sign out", icon: <LogOut size={15} />, variant: "destructive", onClick: onSignOut },
              ]}
            />
          </div>
        </aside>

        <main className="main" id="main">
          {err && <div className="page"><div className="banner error">{err}</div></div>}
          {!ctx && !err && <div className="page"><div className="skeleton-page"><div /><div /><div /></div></div>}
          {ctx && (
            <Ctx.Provider value={ctx}>
              <div className={`page${page === "playground" ? " wide" : ""}`} key={page}>
                {page === "dashboard" && <Dashboard alerts={alerts.length} />}
                {page === "usage" && <Usage />}
                {page === "cost" && <Cost />}
                {page === "reliability" && <Reliability />}
                {page === "playground" && <Playground />}
                {page === "logs" && <Requests />}
                {page === "quotas" && <Tenants />}
                {page === "keys" && <ApiKeys />}
                {page === "backends" && <Backends />}
                {page === "evaluations" && <Evaluations />}
                {page === "guardrails" && <Guardrails />}
                {page === "access" && <Access />}
                {page === "audit" && <AuditLog />}
              </div>
            </Ctx.Provider>
          )}
        </main>
      </div>

      <CommandPalette
        isOpen={paletteOpen}
        onOpenChange={setPaletteOpen}
        searchSource={source}
        onValueChange={runCommand}
        label="Search console"
        emptySearchText="No page or action matches."
        width={560}
      />
      {touring && ctx && <Tour steps={TOUR.filter((s) => !s.perm || can(s.perm)).filter((s) => !s.page || allowed.includes(s.page))} page={page} go={(p) => setPage(p)} onClose={endTour} />}
    </div>
  );
}

