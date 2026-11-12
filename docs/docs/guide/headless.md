# Running in a sandbox (one-shot mode)

`python -m phytograph run` runs **one recipe and exits**. It starts no server and
opens no socket of any kind, not even on loopback. It never downloads anything,
and it writes only to folders you name. It is built for harnesses that run each
evaluation in a confined process: no network, a read-only engine, one writable
work directory, a thread budget, and nothing left running afterwards.

```bash
python -m phytograph run tree_qsm \
    --in tree.txt --out results/ --work /tmp/eval-17 \
    --threads 2 --param fork_symmetry=0.85
```

It writes `results/qsm_treeqsm.csv`, `results/qsm.json` and `results/record.json`.
The exit status says how it went:

| Status | Meaning |
|---|---|
| 0 | Success. |
| 1 | Anything else; the record has `status: "error"` and the message. |
| 2 | Bad usage: an unknown recipe, a misspelled `--param`, a missing input file. |
| 3 | The recipe's check failed (`RecipeError`). The record is still written, with `status: "failed"`. |
| 4 | No engine is installed (see [Install it first](#install-it-first)). |

Recipes `run` supports: `tree_qsm` (writes the TreeQSM-layout CSV and the QSM as
JSON) and `plot_inventory` (writes `inventory.csv`).

## How it works

`python -m phytograph run` finds the installed engine and **execs** it, so the
process you started *is* the engine. The engine imports its web app and runs
the recipe against it in the same process, through starlette's `TestClient`.
The recipe code is the same code a script runs against a server.

That has three consequences:

- **No socket.** The seatbelt rule `(deny network*)` and an unshared network
  namespace both work.
- **Process lifetime.** Its only children are the point-cloud converter during
  import and the segmentation workers. All of them stay in **your** process
  group, so killing the group you started kills everything. A worker also polls
  its parent, so it exits within a few seconds even if only the engine's pid is
  killed. Spawn-pool children of a worker exit with it. Nothing daemonizes.
- **Exit status and stderr are the interface.** Nothing needs importing to read
  them.

## Options

| Option | Meaning |
|---|---|
| `RECIPE` | `tree_qsm` or `plot_inventory`. |
| `--in FILE` | The point cloud. Any format the app imports. |
| `--out DIR` | Where the outputs go. |
| `--work DIR` | Writable folder for everything else the engine writes (see [Paths](#paths)). |
| `--record PATH` | Where the record goes (default `OUT/record.json`). |
| `--param K=V` | A recipe keyword. `V` is parsed as JSON, else taken as a string (`--param wood_method=null`). An unknown keyword exits 2. |
| `--import K=V` | An import option for the file, as `pg.Backend.open` takes it (`--import source_units=mm`). |
| `--threads N` | Cap on every thread pool (see [Threads](#threads)). |
| `--ml-device cpu\|auto` | ML segmentation device. The default is `cpu`, because GPU kernels can change the last digits. |
| `--engine PATH`, `--source` | Which engine, as for `pg.Backend(executable=..., source=...)`. |

## Install it first

The engine is about 400 MB and is installed once, outside the sandbox:

```bash
python -m phytograph download --dest /opt/phytograph-engine
```

Inside the sandbox, set `PHYTOGRAPH_BACKEND_CACHE=/opt/phytograph-engine`. The
same variable controls both where `download` installs and where every later
lookup looks. That location can be read-only, because the engine is a
PyInstaller *onedir* bundle that never unpacks itself.

`run` never tries the network. For scripts that use `pg.Backend()`, set
`PHYTOGRAPH_OFFLINE=1` (or pass `pg.Backend(offline=True)`). A missing engine
then raises `BackendNotFound` at once instead of starting a download.

## Paths

Every location the engine writes is set under `--work` before anything loads:

| What | Where | Variable |
|---|---|---|
| Temporary files, matplotlib config | `WORK/tmp` | `TMPDIR` |
| Logs | `WORK/logs` | `PHYTOGRAPH_LOG_DIR` |
| Octree cache and the session spill | `WORK/octrees` | `PHYTOGRAPH_OCTREE_CACHE_ROOT` |
| User-imported ML models | `WORK/ml_models` | `PHYTOGRAPH_ML_MODELS_DIR` |
| numba's compile cache | `WORK/numba` | `NUMBA_CACHE_DIR` |
| RIEGL extracts and shim | `WORK/riegl` | `PHYTOGRAPH_RIEGL_EXTRACT_ROOT`, `PHYTOGRAPH_RXP_SHIM_CACHE` |
| Anything using the XDG cache | `WORK/cache` | `XDG_CACHE_HOME` |

The current directory is `WORK`. The bundled ML weights are read from the
engine's own `resources/ml_models`, and nothing is downloaded. `$HOME` is never
read or written. `python/tests/test_sandbox.py` runs `run tree_qsm` under a
seatbelt profile that refuses the network, every write outside the work and
output folders, and every read under the home folder except the engine itself.

## Engine identity

```bash
python -m phytograph identity --json
```

This prints the exact build of the engine `run` (or `pg.Backend()`) would use,
without starting it or using the network. The same document is in every
record as `engine`, and `pg.engine_identity()` and `Backend.identity` return it.

| Field | Meaning |
|---|---|
| `key` | sha256 over the fields that define the build. Changes whenever the native code does. **Use it as the cache key.** |
| `engine_version`, `phytograph_version` | Engine and package versions. |
| `libhelios_sha256` | The compiled Helios library inside the engine. |
| `sources_sha256` | Every Python source compiled into the bundle, plus the PyHelios pins. |
| `pyhelios`, `helios_core` | `git describe` and commit of each. |
| `python`, `packages` | Interpreter version, and numpy, scipy, open3d, scikit-learn, torch, numba … versions. |
| `archive_sha256` | The verified digest of the downloaded archive (null for the app or a dev checkout). |
| `source`, `location` | `bundle` or `dev`, and where it is. |
| `dev_tree`, `dirty` | Dev checkouts only: HEAD plus the uncommitted diff, hashed. |

Rebuilding libhelios, or changing a dependency, changes `key` even when no
version number moves. `key` leaves out the install location and
`archive_sha256`, so the same bundle has the same key whether it came from the
app or from a download.

## Advisories

An advisory is a result that passed the recipe's checks but deserves a look.
The record lists each one as `{"code", "message", "step"}`. `run` also prints
each one to stderr as one line:

```
PHYTOGRAPH ADVISORY [qsm.inferred_radius] (qsm): 64% of cylinder radii have surface coverage under 0.7 …
```

Match on `code`, which never changes for a condition. The message may be
reworded. Newlines in a message are escaped as `\n`. The full list is
`phytograph.advisories.ADVISORIES`:

| Code | Meaning |
|---|---|
| `clean.noise_fraction_high` | More than 3% of points flagged as noise. |
| `ground.dem_sparse` | Fewer than half of the DEM cells have ground. |
| `inventory.tool_warning` | `tree_inventory` reported a warning. |
| `inventory.no_stem` | Trees with no stem fitted (merged or occluded). |
| `qsm.inferred_radius` | Most radii come from the taper model, not from the points. |
| `qsm.tree_failed` | A tree's QSM failed and is missing (`tree_qsms`). |
| `registration.zero_rmse` | ICP reported zero RMSE (possibly no overlap). |
| `registration.scene` | The registration's scene-type advisory. |
| `backend.warning` | A backend tool's non-fatal warning. |
| `backend.quality_warning` | A backend tool's result-quality warning. |
| `backend.fusion_warning` | Tree segmentation merged trunks; the count is a minimum. |
| `backend.ground_warning` | Tree segmentation ran without usable ground labels. |
| `backend.cost_acknowledged` | A cost gate was confirmed automatically (`confirm_costly=True`). |
| `python.warning` | Any other Python warning raised while the recipe ran (the category is in the message). |

Deprecation warnings are not recorded, because they describe code, not results.
Scripts see all of these as Python warnings as well: the recipes re-raise
what they record, and `PhytographWarning` subclasses carry `.code`.

## Threads

`--threads N`, `PHYTOGRAPH_THREADS=N` or `pg.Backend(threads=N)` caps every
thread pool the engine uses:

- OpenMP (open3d, scikit-learn), BLAS (OpenBLAS, MKL, Accelerate), numexpr and
  numba, pinned before they load;
- torch's intra- and inter-op threads;
- `cKDTree` queries and every Python executor;
- the tile process pools.

Segmentation workers inherit the cap. The record's `runtime.threads` shows
what each native pool actually runs with. A value that is not a positive
integer is an error, not "use every core".

## Reproducibility

The same input, parameters and seed on the same engine build (`key`) and the
same `--threads` give byte-identical outputs. The record's `outputs` holds
their sha256, so a harness can compare runs without opening the files. The
`tree_qsm` path has no unseeded randomness:

- the thinning to `max_points` is seeded by `seed`;
- ML wood segmentation's crop order, the geometric wood split and TreeIso's
  sampling use fixed seeds;
- the QSM solver has no random step at all.

The device is fixed to CPU by default.

**Measured.** The leaf-off eastern redbud scan (1.2 M points) ran with
`tree_qsm` defaults (ground removal, ML wood separation, thinning to 60 000
points, QSM) inside the sandbox. Both output files had the same sha256 in every
run: twice at 4 threads, and once each at 1 and 8 threads. All runs produced
3198 cylinders. The tolerance is therefore **zero**: any difference in the
output bytes means something changed. `python/tests/test_determinism.py` checks
the same property on a small tree, at 1, 2 and 4 threads.

Two things are outside this guarantee. A different engine build (a new `key`)
may change the numbers, which is the reason `key` exists. `--ml-device auto`
on a GPU may change the last digits of ML results.

## The QSM file

`qsm_treeqsm.csv` (and `QSM.to_treeqsm_csv(path)` in a script) is byte for byte
what the app's File → Export QSM writes. It has one row per cylinder, base to
tip within each branch, in metres:

| Column | Meaning |
|---|---|
| `ID`, `parentID` | Cylinder id, and its parent cylinder (-1 for the base). |
| `branchID` | The cylinder's shoot (Phytograph's branch). |
| `branchOrder` | The shoot's rank: trunk 0, +1 per branching. |
| `segmentID` | Equal to `branchID`. Phytograph's only branch notion is the continuous shoot. |
| `parentSegmentID` | The parent shoot (-1 for the trunk). |
| `startX..Z`, `endX..Z` | Axis end points, world coordinates. |
| `axisX..Z` | Unit axis direction (0, 0, 0 for a zero-length cylinder). |
| `radius`, `length` | Metres. |
| `surfaceCoverage` | Fraction of the cylinder surface the points cover. Empty when the radius was not fitted from points. |
| `meanAbsDeviation` | Mean absolute distance of the points from the surface (m). Empty as above. |

`growthLength` and `reverseBranchOrder` are not written; rTwig derives them.
`QSM.to_csv` is a different file: a flat dump of every cylinder field.
