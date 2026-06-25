// MUST be first: stubs console.timeStamp before React evaluates, disabling the
// dev-only render instrumentation that OOMs on huge typed-array props.
import "./disableReactDevPerfTrack";
import React, { useCallback, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { BackendSplash } from "./components/BackendSplash";
import { SceneProvider } from "./state/sceneStore";
import { initBackendUrl, deleteCloudSession } from "./utils/backendApi";
import { installConsoleForwarding } from "./lib/logger";

// Forward console.error/warn into the unified session log file (via main) so a
// bug report can attach renderer-side errors, which otherwise only live in the
// invisible DevTools console of a packaged build.
installConsoleForwarding();

// Root owns the File → New reset. Rather than reload the whole window (which
// re-runs this module, re-probes the backend over IPC, and re-shows the splash
// for its minimum duration), File → New just bumps `resetKey` to remount the
// SceneProvider + App subtree. React unmounts the old tree and mounts a fresh
// one, so every scene collection and every useState/ref in App and the viewer
// resets to launch state — without touching the still-running backend or its
// already-resolved port. BackendSplash lives OUTSIDE the keyed subtree so the
// remount never makes it flash back up; it stays mounted and 'ready'.
function Root() {
  const [resetKey, setResetKey] = useState(0);
  const resetScene = useCallback(() => setResetKey((k) => k + 1), []);
  return (
    <>
      <BackendSplash />
      {/* freeSession releases a removed cloud's backend octree session, but only
          when its `remove` transaction is evicted off the history tail or purged
          by a destructive boundary — never on the remove itself, so undo can
          resurrect the scan with its session (and unbaked edits) intact. */}
      <SceneProvider key={resetKey} freeSession={(sessionId) => { void deleteCloudSession(sessionId); }}>
        <App onResetScene={resetScene} />
      </SceneProvider>
    </>
  );
}

// Resolve the backend URL from the main process before first render, so every
// getBackendUrl() caller sees the per-instance dynamic port. The fetch is a
// single fast IPC round-trip; if it fails (e.g. running outside Electron) the
// cached default is used and we render anyway.
function mount() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

initBackendUrl().finally(mount);
