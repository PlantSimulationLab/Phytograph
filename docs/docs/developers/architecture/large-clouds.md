# Large clouds: memory budget, cost advisories, benchmarks

Phytograph holds an imported cloud in RAM as the source of truth (see
[Backend sidecar](backend.md)), so "how big a cloud can it handle" is a
question about memory first and time second. This page documents the
machinery that makes both visible and bounded, and the measurements it is
built on. The phased plan toward arbitrarily large clouds (memory-mapped
sessions, tiled processing, streaming import) builds on these pieces.

## What a cloud costs

A `CloudSession` stores positions as float64 (24 B/pt), every scalar column
as float32 (4 B/pt each), colours as three uint16 (6 B/pt), intensity as
uint16 (2 B/pt), timestamps as float64 (8 B/pt), and a one-byte delete mask.
A typical terrestrial LAS import is ~57 B/pt; a RIEGL position with its
thirteen attributes is ~87 B/pt. So:

| Points | Resident session | Peak during import (2x) |
|---|---|---|
| 10 M | 0.6–0.9 GB | 1.2–1.7 GB |
| 30 M | 1.7–2.6 GB | 3.4–5.2 GB |
| 100 M | 5.7–8.7 GB | 11–17 GB |

`memory_budget.bytes_per_point()` and `estimate_session_bytes()` are the
single source of these numbers in code.

## The memory budget

`backend-api/memory_budget.py` measures the machine (via `psutil`, with an
`os.sysconf` fallback) and derives a **budget**: `PHYTOGRAPH_MEMORY_BUDGET_BYTES`
if pinned, otherwise `PHYTOGRAPH_MEMORY_BUDGET_FRACTION` (default 0.5) of
physical RAM. A fraction rather than a constant so the same build scales from
a 16 GB laptop (~8 GB budget) to a 64 GB workstation (~32 GB) without a
setting. Every large-cloud threshold in the backend derives from this number.

`GET /health` reports the budget, the backend's resident set, and what is
currently admitted against the budget; the slow-request log line
(`[slow] POST /api/... took 12.3s, rss 1.2 GB -> 4.8 GB of a 16.0 GB budget`)
says what a slow request cost.

### Admission control

Heavy paths declare their working set to `_ADMISSION.admit(bytes, label)`
before allocating it: the import read (which briefly holds the LAS record
and the float64 copy at once), the killable segmentation workers (parent
copy + worker copy + labels), and export (a copy of every surviving column).
A job waits until it fits beside what is already running; a job larger than
the whole budget is admitted **alone** and logged rather than refused. The
budget is advisory for a lone job and a hard cap only on concurrency, because
paging is recoverable and a refused export is not. Refusing or prompting
happens *before* the work is committed to, via the cost advisory.

## Cost advisories (the 409 prompt)

Ground segmentation estimates its wall time and transient memory before
spawning anything, from measured throughputs (`_RATE_*` constants next to
`_cost_advisory` in `main.py`, deliberately about half the measured rate so
the estimate errs long):

- cloth filter: worker start (~4.5 s) + staging + CSF at ~10 M pts/s + the
  cloth simulation at ~50 M node-iterations/s (nodes = (extent / cloth)²,
  500 iterations);
- octree rebuild: LAS write at ~10 M pts/s + PotreeConverter at the rate of
  the sampling method it will be given (below); a run that will split into
  ground/plant children counts the parent's points twice.

Past `PHYTOGRAPH_COST_WARNING_SECONDS` (default 90) — or when the transient
working set alone exceeds the memory budget — the endpoint answers **409**
with a structured `cost_warning` (`message`, `estimated_seconds`,
`estimated_bytes`, `budget_bytes`, `over_time`, `over_memory`). The renderer's
existing `CostWarningError` path (shared with TreeIso) turns that into an
amber advisory and a **Segment Anyway** button, which re-sends with
`acknowledge_cost: true`. A cloth resolution that would build more than
25 M cloth nodes is refused outright (400) with the coarsest resolution that
fits, because that is a hang, not a slowdown, and independent of point count.

## Octree LOD sampling policy

PotreeConverter builds each inner node's level-of-detail sample either with
`poisson` (blue-noise; its default) or `random`. Measured on a 10 M-point
cloud on an M-series laptop:

| Stage | Time |
|---|---|
| LAS write (laspy, chunked) | 0.4 s |
| sha1 of the LAS | 0.2 s |
| PotreeConverter `-m poisson` | 32.2 s (0.31 M pts/s) |
| PotreeConverter `-m random` | 5.1 s (1.97 M pts/s) |

The converter is the largest cost of every import, bake, filter, split and
segmentation on a large cloud, and a ground segmentation with split
reconverts about 2N points. So the backend passes `-m random` from
2 M points up (`_POTREE_RANDOM_SAMPLING_MIN_POINTS`) and `-m poisson` below,
where the user cannot feel the difference. Random sampling is what
Entwine/untwine (COPC) and QGIS use; the full-resolution leaves are identical
either way and only the coarse LOD nodes differ. Pin a method with
`PHYTOGRAPH_POTREE_SAMPLING=poisson|random`, or move the knee with
`PHYTOGRAPH_POTREE_RANDOM_SAMPLING_MIN_POINTS`.

**The cloth filter itself is not the wall.** Measured at 10 M points: CSF
0.27 s, copying its result out of the SWIG vector 0.30 s, converting labels
to JSON 0.04 s, staging the worker's input 0.08 s. What made "ground
segmentation above ~20 M points" slow was the three Poisson reconverts that
followed it.

## Benchmark harness

`backend-api/tools/make_big_cloud.py` writes a synthetic terrestrial-style
LAS at any size in chunks: 1/r² areal density from a central scanner, a
ground plane with mm noise, ellipsoidal tree crowns, optional sky/miss
returns projected 1 km out, plus intensity, RGB, gps_time, a `ground_truth`
column and a `target_index`/`target_count` pair.

`backend-api/tests/bench/test_large_cloud_bench.py` (gated on
`PHYTO_BENCH=1`) drives import → ground segmentation → split → delete +
rebuild → LAZ export through the real HTTP API and records wall time and
peak resident memory of the backend *and its children* per stage, plus the
agreement of the CSF result with the generator's ground truth. Results land
in `perf/bench-large-<N>M-<timestamp>.json`.

```bash
cd backend-api
PHYTO_BENCH=1 PHYTO_BENCH_POINTS=10e6,30e6 venv/bin/python -m pytest tests/bench -s --no-cov
```

Compare runs on the same machine and the same point counts; the generated
LAS is cached under `tmp/bench/` so only the pipeline is re-measured.
