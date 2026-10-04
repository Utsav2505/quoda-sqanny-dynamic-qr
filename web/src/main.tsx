import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";

/**
 * SPA entry point.
 *
 * This file is reachable ONLY from the routes declared in `src/routes/spa.ts`
 * (`/app/*` and friends). The QR redirect routes `/q/:identifier` and
 * `/r/:code` are Hono handlers that never serve this bundle, so a customer
 * scanning a code downloads none of it. Requirement 9 and #54.12 are satisfied
 * by the routing table, not by anything in this file - do not add logic here
 * that the redirect path could ever reach.
 */
const container = document.getElementById("root");
if (!container) {
  // Loud, because a missing mount point means the shell template and this
  // bundle disagree about the document - silently rendering nothing would be
  // indistinguishable from a broken app in production.
  throw new Error("SQANNY: #root is missing from the shell document.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);