import { createContext, useContext } from "react";
import type { ConsoleConfig, Permission, SessionUser } from "./api";

/** every page, the permission it needs, and where it sits in the sidebar */
export const PAGES = {
  dashboard: { label: "Dashboard", perm: "dashboard:read", section: "" },
  playground: { label: "Playground", perm: "playground:run", section: "Build & configure" },
  keys: { label: "API keys", perm: "keys:read", section: "Build & configure" },
  usage: { label: "Usage", perm: "dashboard:read", section: "Monitor" },
  cost: { label: "Cost", perm: "dashboard:read", section: "Monitor" },
  reliability: { label: "Reliability", perm: "dashboard:read", section: "Monitor" },
  logs: { label: "Logs", perm: "requests:read", section: "Monitor" },
  quotas: { label: "Quotas", perm: "usage:read", section: "Monitor" },
  guardrails: { label: "Guardrails", perm: "governance:read", section: "Security & data" },
  access: { label: "Access", perm: "governance:read", section: "Security & data" },
  audit: { label: "Audit log", perm: "audit:read", section: "Security & data" },
  backends: { label: "Backends", perm: "backends:read", section: "Platform" },
  evaluations: { label: "Evaluations", perm: "evals:read", section: "Platform" },
} as const satisfies Record<string, { label: string; perm: Permission; section: string }>;
export type Page = keyof typeof PAGES;

export interface AppCtx {
  user: SessionUser;
  cfg: ConsoleConfig;
  can: (p: Permission) => boolean;
  /** tenant filter: "" means all tenants (operators only); everyone else is always their own tenant */
  scope: string;
  setScope: (t: string) => void;
  go: (p: Page) => void;
  tenantName: (id: string) => string;
}

export const Ctx = createContext<AppCtx | null>(null);
export const useApp = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside the console shell");
  return c;
};
