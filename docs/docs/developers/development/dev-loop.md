# Dev Loop

## Common commands

```bash
npm run dev          # builds main+preload once, starts Vite on 1427, launches Electron
npm run typecheck    # tsc --noEmit
npm run test:unit    # vitest
npm run test:backend # pytest in backend-api/
npm run test:e2e     # Playwright + _electron
```

## What hot-reloads, what doesn't

| Edits to | Reload behavior |
|---|---|
| `src/renderer/` | Vite HMR — instant |
| `src/main/` | Restart `npm run dev` |
| `src/preload/` | Restart `npm run dev` |
| `backend-api/` (Python) | uvicorn `--reload` — automatic (see [Iterating on Python](#iterating-on-python)) |

## TypeScript path aliases

Defined in `tsconfig.json`:

- `@renderer/*` → `src/renderer/*`
- `@main/*` → `src/main/*`
- `@shared/*` → `src/shared/*`

## Build outputs (all gitignored)

- `dist-main/` — Electron main process
- `dist-preload/` — preload script
- `dist-renderer/` — renderer bundle
- `~/builds/phytograph.noindex/` — electron-builder output (outside the repo
  and outside Dropbox; CI falls back to a repo-relative `release/`)
- `resources/phytograph_backend/` — PyInstaller bundle

Don't hand-edit these; they're produced by the scripts above.

## Stale backend processes

Ports are picked dynamically per instance, so a leftover backend no longer
blocks the next launch — it simply lands on a different free port. To clean up
orphans anyway:

```bash
pkill -f phytograph_backend      # packaged bundle
pkill -f 'uvicorn main:app'      # dev
```

To see what holds a specific port: `lsof -ti :<port>`.

## Dev renderer disables React's performance track

`src/renderer/disableReactDevPerfTrack.ts` (the first import of `main.tsx`)
stubs out `console.timeStamp` in dev so React's development build skips its
"Components ⚛" DevTools performance track. That instrumentation deep-diffs a
component's previous and next props on every re-render and `for...in`s over
any object in changed props — including TypedArrays, whose indices are all
enumerable. With multi-million-element buffers as props (point cloud
positions, per-triangle color buffers), one re-render allocates gigabytes of
key/value strings and OOM-crashes the renderer at V8's ~4 GB
pointer-compression cap (verified against react-dom 19.2.6; production React
builds don't contain the instrumentation, so packaged apps were never
affected).

Consequences: no "Components ⚛" lane in the Performance panel during dev
profiling, and `console.timeStamp` is unavailable in the dev renderer. Don't
move that import — it must evaluate before anything that pulls in React.

## Iterating on Python

**Nothing to set up — Python hot-reloads automatically.** When
`backend-api/venv` exists, `scripts/dev.mjs` spawns
`uvicorn main:app --reload --reload-dir .` on a free port and sets
`PHYTOGRAPH_DEV_BACKEND=1`, which tells the Electron supervisor to stand down
rather than spawn the bundled binary. So edits under `backend-api/` reload in
place, and the PyInstaller sidecar is **not** part of the dev loop — you only
rebuild it (`npm run build:backend`) for E2E and packaged installers.

Edits to the PyHelios/Helios C++ source are recompiled too: the backend
rebuilds `libhelios` on startup when the lib is stale, so restart the backend
to pick up C++ edits.
