# Testing

Three layers, three frameworks:

| Layer | Framework | Location | Command |
|---|---|---|---|
| Backend unit | pytest | `backend-api/tests/` | `pytest` (in venv) or `npm run test:backend` |
| Frontend unit | Vitest | colocated `*.test.ts(x)` | `npm run test:unit` |
| End-to-end | Playwright + `_electron` | `tests/e2e/` | `npm run test:e2e` |

E2E prerequisites: `npm run build && npm run build:backend` must succeed
first — the tests drive the real packaged app.

## Testing code that needs a proprietary library

RIEGL `.rxp` reading needs RiVLib, which cannot be committed (its licence
forbids redistribution) and cannot be a CI secret (the useful subset is 55 MB
against a 64 KB cap). Left alone, that puts the whole reader — the ctypes
binding, the read loop, pulse grouping, column pruning, miss placement, the
transport and the backend's native runner — beyond any automated test.

`backend-api/tests/fixtures/fake_rivlib/` closes most of that gap. The reader
binds exactly **seven** C functions, so the fixture implements those seven (and
the eight the miss-recovery shim exports) in ~200 lines of our own C, emitting a
deterministic synthetic scan. `RIVLIB_SO` and `PHYTOGRAPH_RXP_SHIM` point at the
result, and `test_riegl_fake_rivlib.py` drives the real pipeline end to end
against known counts — 1000 pulses, every fifth returning twice, 200 no-return
shots, so 1200 echoes and 1400 points.

It builds with whatever compiler is present (MSVC on Windows, `cc` elsewhere)
and **skips** if there is none, so it needs no secrets and runs on fork PRs.

Two limits are worth stating plainly:

- **It proves nothing about RIEGL's behaviour.** If they reorder a struct, the
  stub and the reader stay wrong together. It catches *our* regressions, which
  is almost all of them, and a job using the real library has to be separate and
  credentialed.
- **The stub's struct layouts are load-bearing.** `scanifc_point3dstream_read`
  writes by stride, so a layout disagreement does not raise — it silently yields
  garbage attributes. A test asserts the C side against the same sizes the
  reader asserts at import, so the fixture cannot drift into testing a fiction.

Where it runs:

| | |
|---|---|
| Every push | `ci.yml`'s pytest job (Linux). The native runtime is forced with `PHYTOGRAPH_RIEGL_RUNTIME=native`, since it is otherwise reachable only on Windows. |
| Weekly, and as a release gate | `platform.yml` on Windows, for the three things only real there: loading a `.dll` via `os.add_dll_directory`, the `file:C:\…` URI form, and building the shim with MSVC. |

The same shape applies to any future dependency that cannot be committed: stand
in for the ABI, keep the stub honest with a layout assertion, and say out loud
what the stub cannot prove.

## E2E rules (non-negotiable)

These rules exist because the alternative — mocking the backend or
short-circuiting the UI — produces tests that pass in CI while shipping
broken builds to users.

### 1. Always run against the live backend

No mocking the FastAPI server, no stubbing `/api/*` responses. If the
supervised PyInstaller backend isn't built (`resources/phytograph_backend/`),
run `npm run build:backend` first — don't skip the test.

> "Backend wasn't running" is **not** an acceptable reason to skip.

### 2. Drive the real UI

Seed data, set options, and read results through the rendered DOM:

- Use the file-picker / dropzone to import fixtures.
- Click the actual buttons.
- Read values from the actual viewer state — don't reach into `window`
  to short-circuit.
- Exercise non-default user options where the workflow supports them.

### 3. Test correctness, not the absence of errors

"Didn't throw" is **not** a pass. Assert on concrete outputs:

- Vertex counts within a known range.
- Exported file contents.
- Persisted store values.
- Visible numbers in the UI.

Rubber-stamp tests that exist only to mark a box are worse than no test
at all.

### 4. Coverage target: 80%

- **Backend** — `pytest-cov` over `main.py`.
- **Frontend** — Vitest coverage over `src/renderer/lib/`,
  `src/renderer/utils/`, `src/renderer/hooks/` (the pure-logic surface).

React components (`src/renderer/components/`, `App.tsx`) are **covered by
E2E instead** — unit-testing 9,000+ lines of three.js viewer code yields
rubber stamps, not signal. E2E is judged by workflow coverage, not line
coverage.

### 5. Fixtures

Fabricate minimal text fixtures (small CSV / XYZ point clouds, tiny OBJ
meshes) that are safe to commit. If a workflow needs real LiDAR data too
large to commit, ask the maintainer — don't invent a synthetic substitute
that won't exercise the real code paths.

### 6. Share one app per spec file

Booting the Electron app + PyInstaller backend takes ~5–40 s, so a spec
file with several tests launches **one** app in `beforeAll` and resets to
a fresh scene between tests with `resetToFreshScene`
(`tests/e2e/helpers/resetApp.ts`) — it drives the real File → New flow,
which remounts the renderer scene and frees all backend sessions. See
`bulk-actions.spec.ts` for the reference pattern. Keep a per-test
`launchApp()` only when the test is about launch lifecycle itself
(fresh-boot splash, octree cache recovery, app close semantics), with a
comment saying why.

The suite runs **2 Playwright workers**: parallel spec files each get
their own app instance, backend port, and octree cache directory, so a
test must never assume a fixed port or that it is the only running
instance.

## Why E2E launches a cloned Electron bundle (macOS)

On macOS the suite does **not** run
`node_modules/electron/dist/Electron.app`. It runs a patched clone of it,
built on demand by `scripts/headless-electron.mjs` and passed to
`_electron.launch({ executablePath })` by
`tests/e2e/helpers/launchApp.ts`.

The reason is the Dock. `src/main/main.ts` calls
`app.setActivationPolicy('accessory')` under `PHYTOGRAPH_E2E`, but that
can only *demote* an app AppKit has already registered — Electron creates
`NSApp` in `PreBrowserMain()`, long before `main.js` is loaded. Measured
on the pristine bundle, the process is registered as a `Foreground` app
from roughly +230 ms to +450 ms after launch, which is exactly long
enough to draw a Dock icon and then destroy it. With one app per spec
file that was ~90 icon flashes per local run.

The only real cure is `LSUIElement=1` in the running bundle's
`Info.plist`, which AppKit reads before any JavaScript exists, so no tile
is ever created. It cannot be set at runtime. Since that same bundle also
serves `npm run dev` and the docs screenshot scripts — which *want* a
Dock icon — the flag goes on a test-only copy instead:

- The clone lives at
  `~/Library/Caches/Phytograph/e2e-electron.noindex/Electron.app`, outside
  both the repo and the Dropbox tree.
- It is created with `cp -c`, an APFS copy-on-write clone: a 233 MB
  bundle for about 72 KB of real disk and under half a second.
- It is rebuilt automatically when the Electron version or the source
  `Info.plist` changes, and `rm -rf`ing the cache directory is always a
  safe reset.
- `app.setActivationPolicy('accessory')` stays in `main.ts` as the
  fallback for Windows, Linux, and any run where the clone can't be
  built. Those still work; they just flash.

`scripts/smoke-packaged-app.mjs` is deliberately excluded. It launches the
real signed `.app`, whose Developer ID signature seals `Info.plist`, and
patching it would mean the smoke test no longer exercises the exact
artifact that ships. It launches once per run, so it costs one flash.

## Profiling resource usage during E2E

E2E drives two full app instances (Electron + an open3d/pyhelios backend
each) through the heaviest compute in the product, so it is the best
available load test — and the fastest way to catch a tool that is
quietly resource-hungry.

```bash
npm run test:e2e:profile      # the suite, wrapped in the resource sampler
```

`scripts/monitor-resources.mjs` samples once a second while the suite
runs and prints a mean/p50/p95/max table plus a per-spec breakdown:

- **CPU** per process group (backend / Electron / node / everything
  else), as per-core percentages — `1000%` means 10 cores pinned.
- **Memory** — free, compressed, and wired GB from `vm_stat`, swap used
  from `sysctl vm.swapusage`, and swapin/pageout rates. On macOS these
  matter more than RSS: the machine gets sluggish from compression and
  swap long before anything reports an out-of-memory error.
- **GPU** — `Device Utilization %` from the IORegistry accelerator entry
  (Apple Silicon; no `sudo`, unlike `powermetrics`).
- **Per spec file** — peak Phytograph-attributed CPU and peak backend /
  Electron RSS observed while that spec was in flight. Spans overlap
  across the 2 workers, so a sample is credited to every spec running at
  that instant, and a light spec scheduled beside a heavy one inherits
  its peak — read the table as a shortlist, then confirm a suspect by
  profiling it alone.

The **phytograph share** line is the one that answers "is it us?". Take
an idle baseline to compare against — run the sampler with no command
and Ctrl-C after a minute:

```bash
node scripts/monitor-resources.mjs      # Ctrl-C to stop and summarize
```

A dev machine's sync, backup, and endpoint-security agents can account
for more CPU than the suite does, and they also *react* to the file
churn a build or test run creates, so the idle number is the only honest
reference point.

Raw per-second samples land in `perf/*.jsonl` (gitignored) for plotting.

The sampler works on any command, not just the suite — no `--` command
means it samples until Ctrl-C, which is handy for profiling a manual
`npm run dev` session:

```bash
node scripts/monitor-resources.mjs --interval 500 -- npm run test:e2e -- tests/e2e/qsm-build.spec.ts
node scripts/monitor-resources.mjs             # Ctrl-C to stop and summarize
```

Per-spec attribution needs the timeline reporter
(`tests/e2e/helpers/timeline-reporter.ts`), which `playwright.config.ts`
registers only when `PHYTOGRAPH_E2E_TIMELINE` is set — the `--timeline`
flag does that. Passing `--reporter=…` on the Playwright command line
overrides the config reporter list and silently drops it.
