/**
 * Composition root: the only module that knows every layer. It loads the styles (cascade order
 * first, see frameworks/ui/styles/layers.css), builds the HTTP adapter for the ConsoleApi port, and renders
 * the app with it.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./frameworks/ui/styles/layers.css";
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./frameworks/ui/styles/styles.css";
import { ApiProvider } from "./frameworks/ui/hooks/api";
import { createHttpConsoleApi } from "./interface-adapters/gateways/http/consoleApi";
import { App } from "./frameworks/ui/app/App";

const api = createHttpConsoleApi();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApiProvider api={api}>
      <App />
    </ApiProvider>
  </StrictMode>,
);
