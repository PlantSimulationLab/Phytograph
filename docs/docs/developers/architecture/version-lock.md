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

1. The supervisor detects that the backend on its resolved port reports `BACKEND_VERSION = "0.1.9"`.
2. The renderer build was compiled against `EXPECTED_BACKEND_VERSION = "0.2.0"`.
3. The supervisor terminates that backend and spawns the version it shipped with.
4. The renderer retries and connects to the matching backend.

This is the same code path that recovers from stale uvicorn processes left
over from a previous dev session.

## The splash enforces it too

The version lock is checked in two places, not one. Besides the supervisor
(main process), the renderer's startup splash (`useBackendReady`) polls
`/version` and only treats the backend as **ready** when the reported version
equals `EXPECTED_BACKEND_VERSION`. A `200` carrying a *different* version (a
stale or incompatible backend adopted on the resolved port) is **not** accepted — the
splash stays in its "Starting backend…" state while the supervisor kills and
respawns the bundled binary, then flips to ready once the matching version
answers. Without this, the UI could go live against a backend the supervisor
is in the middle of replacing, and `/api/*` calls would fail silently after
the splash had already dismissed.

## The fourth copy: the PyInstaller bundle

`resources/phytograph_backend/` is a **build-time** copy of the backend, and it
is the one that bites. It only changes when someone runs `npm run build:backend`,
so editing `main.py` leaves a stale binary on disk while all three source
declarations still agree with each other.

The build therefore writes **two** stamps into the bundle directory, and
`npm run check:backend` compares both without launching anything (it is a file
read plus a hash of ~2 MB of Python — single-digit milliseconds):

| Stamp | Catches |
|---|---|
| `phytograph_backend_version.txt` | The bundle was built from a **different `BACKEND_VERSION`** |
| `phytograph_backend_sources.sha256` | The bundle was built from **different Python**, at the same version |

The second one exists because the first has a blind spot that is the *common*
case, not an exotic one. `BACKEND_VERSION` only moves when a change breaks the
renderer contract, so most backend edits — bug fixes, new filtering, anything
additive — leave it untouched. The version stamp then still matches, the check
prints a tick, and E2E launches a bundle compiled from **older Python** while
reporting green.

That is worse than the stale-version failure the stamp was written to catch. A
version mismatch hangs every spec at the splash: loud, and impossible to miss.
Source drift is silent — the suite passes, having exercised code that is not the
code under review. (Observed exactly that way: a bundle built one day sailed
through `check:backend` against sources edited the next.)

The hash covers the `.py` files PyInstaller actually compiles in
(`backend-api/`, `qsm/`, `qsm/validation/`, `vendor/treeiso/`) and includes each
file's **path** as well as its bytes, so an added, deleted, or renamed module is
caught even when no existing file changed. `research/`, `tools/`, `scripts/` and
`tests/` are deliberately excluded — they never enter the bundle, and hashing
them would demand pointless 10-minute rebuilds.

Both `npm run test:e2e` and `launchApp()` run this check first, so a drifted
bundle fails in milliseconds with an exact diagnosis rather than 30 s per spec at
an unrelated locator. A bundle built before source hashing existed reports a
**warning** rather than a tick — the version alone can no longer be read as
proof — and one rebuild clears it.

## Tagging a release

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The `release.yml` workflow signs and notarizes the macOS app, builds for
Windows and Linux, and publishes a GitHub Release (published, not a draft —
electron-updater needs it that way to detect the update). Both the bundled backend
and the renderer reference `vX.Y.Z`, so the supervisor's check passes by
construction.

## When you can skip a backend rebuild

If a change only touches `src/renderer/`, the renderer's
`EXPECTED_BACKEND_VERSION` doesn't change and you can ship a renderer-only
update. In practice this only matters for hotfixes — the normal flow is to
bump all three together.
