# Python scripting client

`python/phytograph` is a pure-Python client (httpx + numpy) for the backend. A
script runs the same backend the app ships, as a private child process, and
drives it over loopback HTTP. The user-facing guide is
[Scripting with Python](../../guide/scripting.md).

```
user script ── phytograph ──HTTP + token──▶ phytograph_backend (headless child)
                 Backend     launch / attach, version check, lifetime
                 _transport  PHP1/PHB1 streams, cancel, 409 cost gate, progress
                 Cloud       a handle on one CloudSession (session_id)
```

## Why a client and not an importable library

The compute stack (open3d, pyhelios with its native `libhelios`, torch) is hard
to install, and on macOS torch and libhelios can't share a process (see
*Testing* in `CLAUDE.md`). The PyInstaller bundle already solves all of that. A
client that launches the bundle needs nothing in the user's environment beyond
httpx and numpy.

## Design rules

- **Session paths only.** `Cloud` wraps a backend `CloudSession`. Every tool
  reads through `_read_points_from_source(include_misses=False)`, so the rule
  that sky/miss points are excluded holds automatically. The client never sends
  inline points, so it has no `collectHitPoints` twin to keep in sync.
- **World coordinates at the API.** The session stores positions with
  `world_shift` subtracted.
    - `/arrays`, export and `transform` are already in world coordinates.
    - Regions act on stored positions, so `Cloud._session_region` subtracts the
      shift before sending a box.
- **No octree work the script can't see.** `filter` sends `rebuild: false`, and
  `transform` sends `octree_mode: "none"`, a mode added for the client that moves
  the geometry and leaves the octree stale. `"pose"` would not be enough: it
  needs a current octree, so after a `filter(rebuild=false)` it falls back to a
  full PotreeConverter reconvert. Session create, `extract` and `split` still
  build octrees, because they are part of those code paths.
- **Imports go through `create-multi`.** A multi-scan E57 or multi-block PTX
  becomes one cloud per position, as in the app. `open()` refuses to merge them
  silently; `open(scan_index=i)` uses the singular `create` for one position.
- **Intensity is 0–1 at the API.** The session stores it at LAS uint16 scale,
  `/arrays` returns 0–1, and `Cloud` multiplies a `where={"intensity": ...}`
  range by 65535 before sending it. `_session_scalar_column` resolves
  `intensity` (on its own field, not in `extras`), so filters can use it.
- **Same identity as the renderer.** A `Cloud` is a `session_id`, which is the
  same key the renderer keeps in `scan.data.octree.sessionId`. That shared key
  is what will let a future in-app console pass clouds between the UI and code.

## Backend endpoints added for it

| Endpoint | Purpose |
|---|---|
| `GET /api/cloud/session/{id}/info` | Row, live and hit counts, `world_shift`, and the readable columns (the extras plus `intensity` and `timestamp`). The renderer gets these from the create response; a client holding only an id needs a way to ask. |
| `GET /api/cloud/session/{id}/arrays` | Live points as `.npz`: `positions` in float64 world coordinates, colors, intensity, and each extra column in its stored dtype. It goes through `_read_points_and_extras`, so deletions, miss exclusion and lockstep filtering of columns behave as they do for compute. It uses `.npz` because PHB1 only carries f32/u32. |

Both are pinned by `backend-api/tests/test_session_arrays.py`.

## Launch, auth, and lifetime

- **Port.** `_ports.py` probes the `script` band (5000–9999) of `PORT_BANDS` in
  `scripts/free-port.mjs` and never binds `:0`. `scripts/free-port.test.mjs`
  reads the Python file and asserts that the two copies of the band agree.
- **Auth.** The client mints its own `PHYTOGRAPH_BACKEND_TOKEN` and sends it as
  `X-Phytograph-Token` on every request, so a script's backend is guarded
  exactly like the app's.
- **Private cache.** Each launch gets its own temp directory for the log and the
  octree cache (`PHYTOGRAPH_OCTREE_CACHE_ROOT`), deleted by `close()`. It must
  not share the app's cache: eviction pins only the evicting process's live
  sessions, so a batch script could evict the octree of a cloud edited in the
  running app, which is the only copy of those edits.
- **Lifetime.** The client sets `PHYTOGRAPH_EXIT_WITH_PARENT=1` and holds the
  child's stdin pipe. `close()` closes the pipe, which shuts the child down
  cleanly. If the script dies, the OS closes the pipe, which has the same
  effect. The child gets its own process group, so a forced kill takes down the
  whole tree.
- **Version.** The client checks `/version` against `EXPECTED_BACKEND_VERSION`
  in `python/phytograph/_version.py` and raises `VersionMismatch` if they
  differ. See [Version lock](version-lock.md).

## Wire format

`phytograph/_frames.py` is the one Python decoder for PHP1 markers and PHB1
frames. `backend-api/tests/binframe.py` delegates to it. It raises on a
malformed marker rather than skipping it, since a skipped marker could be the
terminal error. On Ctrl-C, `_transport.post_stream` posts
`/api/cancel/{run_id}` and closes the stream, and the backend treats either one
as a cancel. Synchronous POSTs (`extract`, `transform`) can't be canceled; they
have no client-side read timeout, because a client that gave up would leave the
backend to commit the edit anyway, and a retry would apply it twice. A 409 `cost_warning` is re-sent
with `acknowledge_cost: true` unless the backend was created with
`confirm_costly=False`.

## Tests

Run them with `npm run test:python`. They use a real backend launched from
`backend-api/venv`, with no mocks. In CI, `PHYTOGRAPH_BACKEND_EXE` points at
`backend_wrapper.py`, so the runner's Python serves it.

## Analysis tools (Phase 2)

`Cloud` wraps the session tool endpoints (`compute_normals`, `segment_ground`,
`dem`, `denoise`, `detect_stems`, `segment_trees`, `segment_wood`,
`segment_organs`, `tree_inventory`, `tree_qsm`) and the `PointSource` ones
(`/api/qsm/build`, `/api/skeleton/extract`, `/api/triangulate`, `/api/fit/crown`,
`/api/c2c/{icp,global}-register`). `Backend.lad` wraps `/api/lad/compute` with a
`session_id` per scan. Result types live in `phytograph/results.py`.

- **One definition of the seeded defaults.** The panels seed CSF, DEM and
  TreeIso parameters from the hits-only extent in TypeScript. The scripting
  client gets them from `GET /api/cloud/session/{id}/defaults`, which runs
  `backend-api/param_defaults.py` on the session's current live hits. Both
  implementations are pinned to `src/shared/parameterDefaults.contract.json`
  (`parameterDefaults.contract.test.ts` and `test_param_defaults.py`), so neither
  can drift without failing its own test. The renderer still computes its own;
  moving it onto the endpoint is optional.
- **Frames.** Most results are already in world coordinates: DEM
  (`world_shift` is in its meta and the client adds it), inventory, QSM,
  skeleton, mesh and crown. `detect_stems` returns seeds in the **stored**
  frame, and `segment_trees` reads `seed_points` in that frame too, so `Cloud`
  converts in both directions. `test_every_tool_reports_world_coordinates_under_a_large_shift`
  runs the whole pipeline with and without a 4,000 km shift and compares the
  results.
- **No display work.** `segment_ground`, `compute_normals` and `segment_wood`
  send `defer_octree: true`.
- **Ctrl-C.** The killable tools (ground, normals, trees, wood, organs,
  denoise) run in a `seg_worker` that `_run_killable` SIGKILLs when the client
  disconnects. A real SIGINT interrupts the client's blocking read and drops the
  connection; the backend then logs a 499 and writes nothing.
  `_thread.interrupt_main` does *not* reproduce this, because it can't interrupt
  a blocking socket read, so the test sends SIGINT.

## Arrays in, and the shipped wheel (Phase 3)

- **`POST /api/cloud/session/create-from-arrays`** takes an `.npz` body and
  builds the session directly (`_session_from_arrays`), the same way
  `_create_lidar_scan_session` builds a synthetic scan's. Colors and intensity
  arrive 0–1 and are stored at LAS uint16 scale. `timestamp` is kept as float64
  on its own field. Every other member becomes a column, and `is_miss` marks
  misses just as on an import. No octree is built. The handler is `async` only
  to read the body; the decode and build run in the threadpool.
  `Backend.from_numpy` is the client side.
- **The wheel ships inside the app.** `python/build_wheel.py` builds a
  `py3-none-any` wheel with the standard library only, with no setuptools or
  `build/` directory. Entries are sorted with fixed timestamps, so builds are
  byte-for-byte reproducible. `scripts/build-python-wheel.mjs` runs it from
  `npm run build` (and so from every `npm run package*` and the release
  workflow) into `resources/python/`, and `extraResources` packages
  `python/*.whl`. The script **fails the build** if it can't produce exactly
  one wheel, because an `extraResources` glob that matches nothing ships nothing
  and says nothing. `scripts/smoke-packaged-app.mjs` checks the packaged bundle
  for `phytograph-<version>-py3-none-any.whl`. `python/tests/test_wheel.py`
  pip-installs a fresh build into a temporary directory and imports it from
  there.

## `pip install phytograph` alone (no app)

Each release publishes a **headless backend archive** per platform:
`phytograph-backend-<version>-{macos-arm64,macos-x64,linux-x64}.tar.gz` and
`…-windows-x64.zip`, about 400 MB each, plus `<asset>.sha256`. The archive holds
exactly what the app ships under its resources folder, minus Electron:
`resources/{phytograph_backend,potree_converter,ml_models}` and `docker/riegl`.
It uses the app's layout so `PHYTOGRAPH_RESOURCES` and the backend's
"one level up" lookups resolve as they do in a packaged app.

- **One definition.** `phytograph/_download.py` owns the asset name, the
  layout and `SUPPORTED`. `python/pack_backend.py` imports it, and a test checks
  `SUPPORTED` against the release matrix.
- **Packed from signed bytes.** The release `build` job runs "Package headless
  backend" after the macOS codesign steps and the Windows native-library
  signing, then uploads the archive after "Build & publish app". A test pins
  that ordering. The packer refuses a bundle whose version stamp differs from
  the package version. It filters **nothing**: an early "skip `build/` dirs"
  rule dropped `_internal/pyhelios/assets/build`, and the extracted backend died
  at startup. Only the real-bundle test caught it.
- **Integrity.** `build-python-wheel` runs only when every platform's build
  succeeded. It embeds all four digests in the wheel
  (`phytograph/_backend_manifest.json`, `--require-all-platforms`), so a PyPI
  install pins the exact archive bytes. A wheel without that manifest (a source
  checkout, or the app-shipped wheel) uses the release's `.sha256`, or a
  `.sha256` copied beside an archive for an offline install. Nothing is
  extracted before it is verified.
- **Safe extraction.** `_safe_extract` refuses absolute paths, `..`, hard links
  and devices. It allows symlinks only when they resolve inside the install,
  because PyInstaller's macOS bundle has 33 relative dylib links. The install is
  staged in the cache directory and renamed into place, with a `.complete`
  marker.
- **Resolution order** (`_resolve_command`): explicit executable, then dev
  checkout, then an installed app *whose `phytograph_backend_version.txt`
  matches*, then the download cache, then a download. An app of another version
  is passed over rather than launched only to fail the version check.
- **Linux floor.** `LINUX_GLIBC_FLOOR` equals `GLIBC_FLOOR` in
  `scripts/glibc-floor.mjs` (pinned by a test). It is checked before a download
  that could never run.
- **Retention.** `scripts/prune-release-assets.mjs` prunes the archives along
  with the installers (newest two releases), by decision: a pinned older client
  gets a message saying to upgrade or to point at an app of its version. The
  `.sha256` files and the wheel are tiny and are kept.
- **PyPI.** The `publish-pypi` job uses Trusted Publishing (no stored token).
  It was set up on 2026-11-02 as a *pending* publisher, because the project
  did not exist on PyPI yet. It is registered on the **account's**
  Publishing page (https://pypi.org/manage/account/publishing/, GitHub tab),
  not under a project: PyPI Project Name `phytograph`, Owner
  `PlantSimulationLab`, Repository name `Phytograph`, Workflow name
  `release.yml` (the file name only), Environment name `pypi`. A pending
  publisher does not reserve the name. The first successful publish turns it
  into the project's trusted publisher, which is then managed under the
  project's Settings → Publishing. Renaming the workflow file or the
  environment breaks publishing until the publisher is updated to match.
  GitHub creates the `pypi` environment on the job's first run; add required
  reviewers there to approve each publish.

Tests: `python/tests/test_download.py` serves a fake release over local HTTP
(`PHYTOGRAPH_BACKEND_URL`). Its archive is in the real format, with a shell stub
that starts the dev backend. The tests cover download, verification,
tampering, an embedded digest overriding the server, 404 messages, offline
`--archive`, unsafe entries and version-gated app lookup. To run the shipped
PyInstaller bundle from the cache, set `PHYTOGRAPH_TEST_REAL_ARCHIVE=1`
(`test_real_bundle_archive`): it packs about 1 GB, so it is opt-in. Run it
after touching the packer or the bundle layout.

## Not yet

- **An older-glibc Linux build** (manylinux-style), so HPC systems on RHEL/Rocky
  8–9 or Ubuntu 22.04 can run the downloaded backend.
- **`.phyto` read/write.** `scene.bin` is built only by the renderer.
- **The in-app console.**
