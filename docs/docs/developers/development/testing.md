# Testing

Three layers, three frameworks:

| Layer | Framework | Location | Command |
|---|---|---|---|
| Backend unit | pytest | `backend-api/tests/` | `pytest` (in venv) or `npm run test:backend` |
| Frontend unit | Vitest | colocated `*.test.ts(x)` | `npm run test:unit` |
| End-to-end | Playwright + `_electron` | `tests/e2e/` | `npm run test:e2e` |

E2E prerequisites: `npm run build && npm run build:backend` must succeed
first — the tests drive the real packaged app.

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
