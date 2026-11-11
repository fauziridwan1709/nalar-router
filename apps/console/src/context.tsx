import { createContext, useContext } from "react";
import type { ConsoleConfig, Permission, SessionUser } from "./api";

export const PAGES = {
  overview: { label: "Overview", title: "Overview", sub: "Traffic, reliability and spend", perm: "dashboard:read", section: "Monitor" },
  requests: { label: "Requests", title: "Requests", sub: "Every metered request, with the route it took", perm: "requests:read", section: "Monitor" },
  tenants: { label: "Usage & quota", title: "Usage and quota", sub: "Monthly usage against each plan's limits", perm: "usage:read", section: "Monitor" },
  playground: { label: "Playground", title: "Playground", sub: "Send a customer message and inspect every decision the gateway makes", perm: "playground:run", section: "Build" },
  keys: { label: "API keys", title: "API keys", sub: "Create, scope and revoke the keys your services use to call the gateway", perm: "keys:read", section: "Build" },
  backends: { label: "Backends", title: "Backends", sub: "Health, pricing, timeouts and fault injection", perm: "backends:read", section: "Platform" },
  evaluations: { label: "Evaluations", title: "Evaluations", sub: "Committed eval runs: accuracy, quality, latency and cost per configuration", perm: "evals:read", section: "Platform" },
  audit: { label: "Audit log", title: "Audit log", sub: "Sign-ins, key changes and operator actions", perm: "audit:read", section: "Platform" },
} as const satisfies Record<string, { label: string; title: string; sub: string; perm: Permission; section: string }>;
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
