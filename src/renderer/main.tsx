// MUST be first: stubs console.timeStamp before React evaluates, disabling the
// dev-only render instrumentation that OOMs on huge typed-array props.
import "./disableReactDevPerfTrack";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { SceneProvider } from "./state/sceneStore";
import { initBackendUrl, deleteCloudSession } from "./utils/backendApi";
import { installConsoleForwarding } from "./lib/logger";

// Forward console.error/warn into the unified session log file (via main) so a
// bug report can attach renderer-side errors, which otherwise only live in the
// invisible DevTools console of a packaged build.
installConsoleForwarding();

// Resolve the backend URL from the main process before first render, so every
// getBackendUrl() caller sees the per-instance dynamic port. The fetch is a
// single fast IPC round-trip; if it fails (e.g. running outside Electron) the
// cached default is used and we render anyway.
function mount() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {/* freeSession releases a removed cloud's backend octree session, but only
          when its `remove` transaction is evicted off the history tail or purged
          by a destructive boundary — never on the remove itself, so undo can
          resurrect the scan with its session (and unbaked edits) intact. */}
      <SceneProvider freeSession={(sessionId) => { void deleteCloudSession(sessionId); }}>
        <App />
      </SceneProvider>
    </React.StrictMode>,
  );
}

initBackendUrl().finally(mount);
