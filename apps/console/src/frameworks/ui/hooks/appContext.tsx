import { createContext, useContext } from "react";
import type { Permission, SessionUser, ConsoleConfig } from "../../../entities/models";
import type { Page } from "../../../entities/access";


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
