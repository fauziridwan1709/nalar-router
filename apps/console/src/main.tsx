import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { CircleHelp, LogOut, Moon, Sparkles, Sun, UserRound } from "lucide-react";
import "./layers.css";
import "@fontsource-variable/figtree";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./styles.css";
import { api, currentSession, setSignedOutHandler, signOut, type ConsoleConfig, type Permission, type SessionUser } from "./api";
import { Ctx, PAGES, type AppCtx, type Page } from "./context";
import { SignIn } from "./SignIn";
import { Overview } from "./Overview";
import { Playground } from "./Playground";
import { Requests } from "./Requests";
import { Tenants } from "./Tenants";
import { Backends } from "./Backends";
import { Evaluations } from "./Evaluations";
import { ApiKeys } from "./ApiKeys";
import { AuditLog } from "./AuditLog";
import { TOUR, Tour, useSeen } from "./Tour";
import { useBackendStatus, statusOf } from "./StatusBadge";
import { Logo, NAV, ROLE_LABEL, Select } from "./ui";

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => localStorage.setItem("theme", theme), [theme]);
  return [theme, setTheme] as const;
}

function Root() {
  const [theme, setTheme] = useTheme();
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    currentSession().then(setUser).catch(() => setUser(null));
    setSignedOutHandler(() => {
      setNotice("Your session ended. Sign in again to continue.");
      setUser(null);
    });
  }, []);

  return (
    <Theme theme={neutralTheme} mode={theme}>
      {user === undefined ? (
        <div className="boot"><Logo size={36} /></div>
      ) : user === null ? (
        <SignIn notice={notice} onSignedIn={(u) => (setNotice(null), setUser(u))} />
      ) : (
        <Shell user={user} theme={theme} setTheme={setTheme} onSignOut={async () => (await signOut(), setUser(null))} />
      )}
    </Theme>
  );
}

function Shell({ user, theme, setTheme, onSignOut }: { user: SessionUser; theme: "light" | "dark"; setTheme: (t: "light" | "dark") => void; onSignOut: () => void }) {
  const can = useCallback((p: Permission) => user.permissions.includes(p), [user]);
  const allowed = useMemo(() => (Object.keys(PAGES) as Page[]).filter((p) => can(PAGES[p].perm)), [can]);
  const [cfg, setCfg] = useState<ConsoleConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [page, setPage] = useState<Page>(() => {
    const h = location.hash.slice(1) as Page;
    return allowed.includes(h) ? h : allowed[0];
  });
  const tourKey = `tour:v1:${user.id}`;
  const [touring, setTouring] = useState(false);
  const [keysSeen, markKeysSeen] = useSeen(`keys:${user.id}`);

  useEffect(() => {
    api<ConsoleConfig>("/api/console/config").then(setCfg).catch(() => setErr("Couldn't load the console. Reload the page to try again."));
  }, []);
  // first sign-in on this browser: offer the tour once the shell is up
  useEffect(() => {
    if (cfg && !localStorage.getItem(tourKey)) setTimeout(() => setTouring(true), 600);
  }, [cfg, tourKey]);
  useEffect(() => {
    if (location.hash.slice(1) !== page) location.hash = page;
    document.title = `${PAGES[page].label} · nalar-router`;
    if (page === "keys") markKeysSeen();
  }, [page, markKeysSeen]);
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.slice(1) as Page;
      if (allowed.includes(h)) setPage(h);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
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
  const initials = user.name.split(/\s+/).map((s) => s[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="shell">
      <nav className="nav" aria-label="Console" data-tour="nav">
        <div className="brand">
          <Logo />
          <div>
            <b>nalar-router</b>
            <span>LLM gateway console</span>
          </div>
        </div>
        <div className="tenant-chip">
          <span className={`role-dot ${user.role}`} aria-hidden />
          <div>
            <b>{user.tenant?.name.split(" (")[0] ?? "No tenant"}</b>
            <span>{ROLE_LABEL[user.role]} · {user.tenant?.plan} plan</span>
          </div>
        </div>
        {sections.map((s) => (
          <div key={s} className="nav-section">
            <div className="nav-heading">{s}</div>
            <ul>
              {allowed.filter((p) => PAGES[p].section === s).map((p) => {
                const I = NAV[p];
                return (
                  <li key={p}>
                    <button aria-current={page === p ? "page" : undefined} onClick={() => setPage(p)}>
                      <I size={16} strokeWidth={1.8} aria-hidden />
                      {PAGES[p].label}
                      {p === "keys" && !keysSeen && <span className="new-pill">New</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <div className="foot">{can("backends:read") && <BackendSummary />}</div>
      </nav>
      <div className="main">
        <div className="topbar">
          <div>
            <h1>{PAGES[page].title}</h1>
            <div className="sub">{PAGES[page].sub}</div>
          </div>
          <span className="spacer" />
          {cfg && can("tenants:all") && (
            <Select
              tour="scope"
              label="Tenant scope"
              width={200}
              value={scope || "*"}
              onChange={(v) => setScope(v === "*" ? "" : v)}
              options={[{ value: "*", label: "All tenants" }, ...cfg.tenants.map((t) => ({ value: t.id, label: t.name.split(" (")[0], description: `${t.plan} plan` }))]}
            />
          )}
          <Tooltip content="Feature guide">
            <button className="icon-btn" data-tour="help" onClick={() => setTouring(true)} aria-label="Open the feature guide">
              <CircleHelp size={17} />
            </button>
          </Tooltip>
          <Tooltip content={theme === "dark" ? "Light theme" : "Dark theme"}>
            <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </Tooltip>
          <DropdownMenu
            alignment="end"
            menuWidth={260}
            renderTrigger={(p) => (
              <button {...p} className="avatar-btn" aria-label={`Account menu for ${user.name}`}>
                <span className="avatar">{initials}</span>
              </button>
            )}
            header={
              <div className="menu-head">
                <b>{user.name}</b>
                <span className="mono tiny">{user.email}</span>
                <span className="tag">{ROLE_LABEL[user.role]} · {user.tenant?.name.split(" (")[0]}</span>
              </div>
            }
            items={[
              { label: "Take the feature tour", icon: <Sparkles size={15} />, onClick: () => setTouring(true) },
              { label: `Signed in as ${ROLE_LABEL[user.role].toLowerCase()}`, icon: <UserRound size={15} />, isDisabled: true },
              { type: "divider" },
              { label: "Sign out", icon: <LogOut size={15} />, variant: "destructive", onClick: onSignOut },
            ]}
          />
        </div>
        <main className="content" key={page}>
          {err && <div className="banner error">{err}</div>}
          {!ctx && !err && <div className="skeleton-page"><div /><div /><div /></div>}
          {ctx && (
            <Ctx.Provider value={ctx}>
              {page === "overview" && <Overview />}
              {page === "playground" && <Playground />}
              {page === "requests" && <Requests />}
              {page === "tenants" && <Tenants />}
              {page === "keys" && <ApiKeys />}
              {page === "backends" && <Backends />}
              {page === "evaluations" && <Evaluations />}
              {page === "audit" && <AuditLog />}
            </Ctx.Provider>
          )}
        </main>
      </div>
      {touring && ctx && <Tour steps={TOUR.filter((s) => !s.perm || can(s.perm)).filter((s) => !s.page || allowed.includes(s.page))} page={page} go={(p) => setPage(p)} onClose={endTour} />}
    </div>
  );
}

function BackendSummary() {
  const list = useBackendStatus(15_000);
  if (!list.length) return null;
  const online = list.filter((b) => statusOf(b).label === "online").length;
  return (
    <div className="small ink2 backend-summary">
      <span className={`pulse ${online === list.length ? "ok" : "warn"}`} aria-hidden />
      {online} of {list.length} backends online
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
