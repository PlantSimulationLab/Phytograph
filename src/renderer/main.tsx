// MUST be first: stubs console.timeStamp before React evaluates, disabling the
// dev-only render instrumentation that OOMs on huge typed-array props.
import "./disableReactDevPerfTrack";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { initBackendUrl } from "./utils/backendApi";

// Resolve the backend URL from the main process before first render, so every
// getBackendUrl() caller sees the per-instance dynamic port. The fetch is a
// single fast IPC round-trip; if it fails (e.g. running outside Electron) the
// cached default is used and we render anyway.
function mount() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

initBackendUrl().finally(mount);
