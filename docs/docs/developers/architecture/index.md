# Architecture

Phytograph runs as three cooperating processes inside one packaged binary:

```
                         packaged .app / .exe
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  Electron main process (Node)                                  │
│  ┌─────────────────────────────────┐                           │
│  │  main.ts                        │                           │
│  │   └─ backend.ts                 │                           │
│  │       └─ spawns ────────────────┼──► phytograph_backend     │
│  │   └─ ipc.ts (handlers)          │     (PyInstaller bundle)  │
│  │   └─ updater.ts                 │     listens on :8008      │
│  └─────────────────────────────────┘             ▲             │
│           ▲                                      │ HTTP        │
│           │ IPC (contextBridge)                  │ (fetch)     │
│           ▼                                      │             │
│  ┌─────────────────────────────────┐             │             │
│  │  Preload (preload.ts)           │             │             │
│  │   exposes window.electronAPI    │             │             │
│  └─────────────────────────────────┘             │             │
│           ▲                                      │             │
│           │                                      │             │
│  ┌─────────────────────────────────┐             │             │
│  │  Renderer (React, Chromium)     ├─────────────┘             │
│  │   - HTTP for data               │                           │
│  │   - electronAPI for OS stuff    │                           │
│  └─────────────────────────────────┘                           │
└────────────────────────────────────────────────────────────────┘
```

Read the rest of this section in order:

1. **[Processes & IPC](processes.md)** — what each process is responsible for and the narrow bridge between them.
2. **[Backend Sidecar](backend.md)** — how the Python sidecar is built, supervised, and addressed.
3. **[Version Lock](version-lock.md)** — the three-way version contract that keeps the supervisor and backend in sync.

## Why a Python sidecar instead of native bindings

The bulk of the scientific stack (open3d, scipy) ships as Python wheels;
PyHelios is built from a source submodule (see
[Backend](backend.md)) so the Helios C++ core can be co-developed. Bundling
them via PyInstaller is the fastest path to a shippable cross-platform build.
Native Helios bindings beyond PyHelios are a future direction (would skip
Python for hot paths) but not on the current roadmap.

## Why Electron over Tauri

This is the second-generation desktop shell; the first was Tauri. The
migration is complete and Tauri is retired. Electron was chosen for richer
renderer debugging tools and to avoid Rust-side complexity in a project
where the heavy compute is in Python anyway.
