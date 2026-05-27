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
| `backend-api/` (Python) | Restart uvicorn (or `--reload`), or `npm run build:backend` |

## TypeScript path aliases

Defined in `tsconfig.json`:

- `@renderer/*` → `src/renderer/*`
- `@main/*` → `src/main/*`
- `@shared/*` → `src/shared/*`

## Build outputs (all gitignored)

- `dist-main/` — Electron main process
- `dist-preload/` — preload script
- `dist-renderer/` — renderer bundle
- `release/` — electron-builder output
- `resources/phytograph_backend/` — PyInstaller bundle

Don't hand-edit these; they're produced by the scripts above.

## Port hygiene

If `npm run dev` fails with the backend stuck, a previous sidecar may
still hold port 8008:

```bash
kill $(lsof -ti :8008)
```

## Iterating on Python

For tight Python iteration, run uvicorn directly so the supervisor reuses
your process instead of spawning the bundled binary:

```bash
kill $(lsof -ti :8008) 2>/dev/null
cd backend-api && source venv/bin/activate
uvicorn main:app --port 8008 --reload
```

In another terminal: `npm run dev`. The supervisor checks `/version`; if
the version matches `EXPECTED_BACKEND_VERSION`, it defers to uvicorn.
