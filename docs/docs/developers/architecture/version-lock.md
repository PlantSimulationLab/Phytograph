# Version Lock

The supervisor refuses to talk to a mismatched backend. This guards against
shipping a build where the renderer expects API shapes the backend doesn't
provide (or vice versa).

## The three-way contract

When a backend change requires a new build, **all three must move together**:

| # | File | Field |
|---|---|---|
| 1 | `backend-api/main.py` | `BACKEND_VERSION` |
| 2 | `src/shared/constants.ts` | `EXPECTED_BACKEND_VERSION` |
| 3 | `package.json` | `version` |

`backend.ts` hits `/version` on startup; if the running backend's version
doesn't match `EXPECTED_BACKEND_VERSION`, it kills the port and respawns
its own bundled binary.

## What happens on mismatch

1. The supervisor detects a backend on 8008 reports `BACKEND_VERSION = "0.1.9"`.
2. The renderer build was compiled against `EXPECTED_BACKEND_VERSION = "0.2.0"`.
3. The supervisor terminates the backend, removes the lock on port 8008, and spawns the version it shipped with.
4. The renderer retries and connects to the matching backend.

This is the same code path that recovers from stale uvicorn processes left
over from a previous dev session.

## Tagging a release

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The `release.yml` workflow signs and notarizes the macOS app, builds for
Windows, and publishes a draft GitHub Release. Both the bundled backend
and the renderer reference `vX.Y.Z`, so the supervisor's check passes by
construction.

## When you can skip a backend rebuild

If a change only touches `src/renderer/`, the renderer's
`EXPECTED_BACKEND_VERSION` doesn't change and you can ship a renderer-only
update. In practice this only matters for hotfixes — the normal flow is to
bump all three together.
