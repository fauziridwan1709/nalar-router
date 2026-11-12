/** A console user and the session lifetime rules. */
import type { Role } from "./rbac.js";

/** sessions end after 2 h idle or 12 h total, whichever comes first */
export const SESSION_IDLE_MS = 2 * 3_600_000;
export const SESSION_MAX_MS = 12 * 3_600_000;

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
}
