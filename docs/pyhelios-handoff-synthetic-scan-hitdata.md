# PyHelios handoff: expose hit-data + generalize synthetic-scan primitive-data transfer

## Who this is for
A pyhelios/Helios C++ agent working in the **pyhelios submodule** at
`pyhelios/` (with nested C++ at `pyhelios/helios-core/`). The parent project
(Phytograph) drives synthetic LiDAR scans through the Python `LiDARCloud` API and
needs richer per-hit data back. Everything below is about the `lidar` plugin.

## Background / why
Phytograph added a synthetic-scan feature: it loads plant/imported mesh geometry
into a Helios `Context`, adds one scan per user-placed scanner via
`LiDARCloud.addScan(...)`, runs `syntheticScan(context)`, and reads the resulting
hit points back through the Python wrapper to build a point cloud.

Today the Python wrapper only exposes **XYZ + raydir + RGB color + count** per hit
(`pyhelios/native/src/pyhelios_wrapper_lidar.cpp`:
`getLiDARHitXYZ/getLiDARHitRaydir/getLiDARHitColor/getLiDARHitCount`). The rich
per-hit scalar data that `syntheticScan` already computes — `intensity`,
`distance`, `timestamp`, `target_index`, `target_count`, `deviation`,
`nRaysHit`, `beam_azimuth` (see `pyhelios/helios-core/plugins/lidar/src/LiDAR.cpp`
~lines 4932–4950 and 3255) — is stored in each `HitPoint.data`
(`std::map<std::string,double>`) but is **unreachable from Python**. We also
can't read which scan a hit belongs to (`HitPoint.scanID`).

Separately, during a synthetic scan the transfer of *primitive* data onto hits is
**hardcoded** to exactly two fields (`LiDAR.cpp` ~lines 4959–4973):
`object_label` (copied to hit data) and `reflectivity_lidar` (multiplied into
`intensity`). The scan's `columnFormat` is **not** consulted to decide which
primitive data flows onto hits — `addLiDARScan` in the native wrapper even passes
an **empty** `columnFormat`. So there is currently no general "name a primitive-
data field and have the scanner sample it onto each hit" path for synthetic scans,
even though Helios uses the column format as the source-of-truth for hit-data
columns on file load/export.

## What we need (three parts)

### Part 1 — Expose existing per-hit accessors through the native ctypes wrapper
These public C++ methods already exist on `LiDARcloud`
(`pyhelios/helios-core/plugins/lidar/include/LiDAR.h`):
- `double getHitData(uint index, const char *label) const;`        (~line 585)
- `bool   doesHitDataExist(uint index, const char *label) const;`  (~line 600)
- `int    getHitScanID(uint index) const;`                         (~line 612)

Add matching `PYHELIOS_API` exports in
`pyhelios/native/src/pyhelios_wrapper_lidar.cpp` following the exact pattern of the
existing `getLiDARHitColor` (clearError / null-checks / try-catch / setError):
- `int  getLiDARHitScanID(LiDARcloud* cloud, unsigned int index)`
- `int  doesLiDARHitDataExist(LiDARcloud* cloud, unsigned int index, const char* label)`  (return 0/1)
- `double getLiDARHitData(LiDARcloud* cloud, unsigned int index, const char* label)`
  (return NaN and setError on out-of-bounds / missing label; note `getHitData`
  throws `helios_runtime_error` on a missing label, so guard with
  `doesHitDataExist` first or catch and return NaN — do NOT let it propagate).

Then wire them in `pyhelios/pyhelios/wrappers/ULiDARWrapper.py` (argtypes/restype +
thin Python fns mirroring `getLiDARHitColor`), and add high-level methods to
`pyhelios/pyhelios/LiDARCloud.py`:
- `getHitScanID(self, index: int) -> int`
- `doesHitDataExist(self, index: int, label: str) -> bool`
- `getHitData(self, index: int, label: str) -> float`

Bonus (nice-to-have, big perf win): a **bulk** export of all hits in one FFI call,
e.g. `getLiDARHitData_all(cloud, const char* label, float* out, unsigned int n)`
and/or a combined `getLiDARHitsXYZRGB_all(...)`, since the consumer currently has
to loop `getHitXYZ`/`getHitColor` per hit in Python (slow for million-ray scans).
Mirror the existing bulk-ingest `addLiDARHitPoints` style.

### Part 2 — Generalize primitive-data → hit-data transfer in the synthetic scan
Make the synthetic scan copy **arbitrary named primitive data** from the struck
primitive into each hit's data map, instead of the hardcoded `object_label` /
`reflectivity_lidar` pair. Concretely, where the scan resolves the struck
primitive UUID and currently does (LiDAR.cpp ~4959–4973):

```cpp
if (context->doesPrimitiveDataExist(uint(UUID), "object_label") && ...) { ... }
if (context->doesPrimitiveDataExist(uint(UUID), "reflectivity_lidar") && ...) { data.at("intensity") *= rho; }
```

…generalize so that, for a **caller-supplied list of primitive-data labels**, the
scan copies each existing scalar primitive-data value on the struck primitive into
`data[label]` (cast to double; support at least HELIOS_TYPE_FLOAT / _INT / _UINT /
_DOUBLE). Keep the existing `reflectivity_lidar`→intensity behavior as a built-in.

Make the **source of truth the scan's `columnFormat`** (Helios-native model): the
labels to transfer are the non-standard column names in
`getScanColumnFormat(scanID)` (i.e. anything that isn't a geometry/standard token
like x/y/z/r/g/b/raydir/etc.). That way "add a field name to the scan's column
format → the synthetic scanner samples that primitive data onto the hits", which is
the behavior we expected. If a cleaner explicit-list API is preferable, expose that
instead and we'll pass labels through — your call, but document it.

### Part 3 — Let Python set a scan's column format
`addLiDARScan` in the native wrapper hardcodes an empty `columnFormat`
(see its comment "no columnFormat for now"). Add a way to set it so Part 2 has
input. Either:
- extend `addLiDARScan` with a trailing `const char** columnFormat, unsigned int nCols`, or
- add `setLiDARScanColumnFormat(cloud, scanID, const char** cols, unsigned int n)`,

and surface it on `LiDARCloud.addScan(...)` as an optional
`column_format: list[str] | None = None` argument (default keeps today's behavior).

## Acceptance / how to verify
Add a pytest under `pyhelios/tests/` (mirror `pyhelios/tests/test_lidar.py`) that:
1. Builds a Context with a small 3-D mesh (e.g. a tetrahedron — note: a perfectly
   FLAT mesh has a degenerate bounding box and the scan's AABB ray cull rejects all
   rays, so use 3-D geometry), sets a custom primitive-data scalar on the
   triangles (e.g. `context.setPrimitiveData(uuid, "reflectivity_lidar", 0.7)` and a
   custom `"my_scalar"`).
2. Adds a scan whose `column_format` includes `my_scalar`, runs
   `syntheticScan(context)`, asserts `getHitCount() > 0`.
3. Asserts `doesHitDataExist(i, "intensity")`, `"timestamp"`, `"target_index"`,
   `"target_count"` are true for a real hit, and that `getHitData(i,"my_scalar")`
   returns the value set on the struck primitive.
4. Asserts `getHitScanID(i)` returns the scan id added.

## Notes / constraints
- The native lib auto-rebuilds: Phytograph's backend recompiles `libhelios` on
  startup when C++ under `helios-core/`/`native/` is newer than the compiled lib,
  so a backend restart picks up these changes (cmake + C++ compiler required).
- Keep all new exports null/range-guarded and non-throwing across the FFI boundary
  (the existing wrapper never lets a C++ exception cross into ctypes — match that).
- Don't change existing signatures incompatibly; add optional params / new fns so
  current callers keep working.
- After landing, bump nothing in Phytograph from here — the parent repo owns the
  version-lock trio and will bump when it consumes the new API.

## What the Phytograph side will do once this lands
Per-scanner synthetic scan → read back XYZ + color + `intensity`/`distance`/
`timestamp`/`target_index`/`target_count` (and any column-format primitive data)
per hit → attach them as `PointCloudData.intensities` + `scalarFields{...}` on the
**existing scanner scan**, so "color by intensity / scalar" works and multi-return
metadata is available. That frontend/backend wiring is tracked separately in
Phytograph; this handoff is only the pyhelios native + Python API surface.
