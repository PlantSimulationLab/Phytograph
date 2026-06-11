// MUST be first: stubs console.timeStamp before React evaluates, disabling the
// dev-only render instrumentation that OOMs on huge typed-array props.
import "./disableReactDevPerfTrack";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
