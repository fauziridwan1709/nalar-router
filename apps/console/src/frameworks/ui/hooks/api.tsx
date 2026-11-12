/**
 * Dependency injection for the UI: the composition root (main.tsx) provides a ConsoleApi, and
 * pages and hooks get it with useApi(). Nothing in the UI knows how the API is reached.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ConsoleApi } from "../../../use-cases/ports";

const ApiCtx = createContext<ConsoleApi | null>(null);

export function ApiProvider({ api, children }: { api: ConsoleApi; children: ReactNode }) {
  return <ApiCtx.Provider value={api}>{children}</ApiCtx.Provider>;
}

export function useApi(): ConsoleApi {
  const api = useContext(ApiCtx);
  if (!api) throw new Error("useApi outside ApiProvider");
  return api;
}
