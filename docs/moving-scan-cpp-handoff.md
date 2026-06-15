# Hand-off: Moving-Platform LiDAR in the Helios C++ lidar plugin

> Give this prompt to the Helios C++ agent. It covers **only** the C++/PyHelios changes.
> A companion design (`~/.claude/plans/i-would-like-to-smooth-fountain.md`) describes the
> larger Phytograph feature this is the foundation of — read it for context, but the Python
> backend and renderer are **out of scope** for this hand-off.

---

You are implementing **moving-platform LiDAR support in the Helios C++ lidar plugin**
(`plugins/lidar/`, CPU-only `--nogpu` build, so one implementation site each — no `.cu`
mirror). This is the foundation of a larger feature; **only the C++/PyHelios changes below are
in scope** — do not modify Python backend or renderer code.

**Goal:** a synthetic LiDAR scan can be driven by a dense **timestamped 6-DOF pose trajectory**
so the scanner moves during the sweep, and every return (and every no-return miss) preserves
its own **per-beam origin + direction + real timestamp** for downstream Beer's-law voxel
inversion. The static single-origin scan path must stay **100% backward compatible**.

## 1. Timestamp rework (do this first — affects static too)

The synthetic scan currently writes a pulse *ordinal* into `HitPoint.data["timestamp"]`:
- hit path at `LiDAR.cpp:5618` — `pulse_scangrid_ij.at(r).y*Ntheta + .x`
- miss path at `LiDAR.cpp:5328` — `data["timestamp"] = i`

Replace both with a real per-pulse time `t = t0 + pulse_ordinal * pulse_period`, where
`pulse_period = 1/pulse_rate_hz` and `t0` defaults to 0 (relative seconds for now — no absolute
GPS epoch yet).

**Invariants** (the consumers depend on these — verify against `groupHitsByTimestamp` @4612
and `gapfillMisses_timestamp` @1864):
- All returns of one pulse get the **identical** time (grouping uses float equality; the
  per-return distinction stays in `target_index`/`target_count`).
- Times are **monotonic and uniformly spaced** within a scan (gapfill's `dt` / `round(dt/dt_avg)`
  assumes uniform spacing; it already writes float timestamps to filled beams @2117).
- **Unify the hit (5618) and miss (5328) encodings** so a miss and a hit at the same scan-grid
  cell get the same time (today they differ — ordinal `i` vs `j*Ntheta+i`).

## 2. Trajectory in `ScanMetadata` (`LiDAR.h:216`)

Add optional fields (empty ⇒ static, behavior unchanged):

```cpp
bool isMoving = false;
std::vector<double>        traj_t;     // M monotonic timestamps
std::vector<helios::vec3>  traj_pos;   // M positions
std::vector<helios::vec4>  traj_quat;  // M quaternions (qx,qy,qz,qw), Hamilton, body->world
helios::vec3 lever_arm     = {0,0,0};  // sensor optical center in body frame (m)
helios::vec3 boresight_rpy = {0,0,0};  // sensor rotational misalignment, radians
void poseAt(double t, helios::vec3 &pos, helios::vec4 &quat) const;
```

`poseAt` — binary-search bracket on `traj_t`, **linear** position interpolation, **SLERP**
quaternion interpolation, clamp outside `[t_first, t_last]`.

## 3. Per-pulse pose in the synthetic ray fan (`LiDAR.cpp` ~5147–5719)

When `isMoving`, for each pulse compute its time `t(i,j)` (item 1) and call `poseAt(t)` →
`(pos, quat)`:
- origin = `pos + R(quat)·lever_arm` (replaces the single `scan_origin` used at ~5341/5448/5632)
- direction = `R(quat)·R(boresight)·dir` (composes onto the existing per-pulse `dir`, which
  already carries scan tilt)
- write per hit: `data["timestamp"] = t(i,j)`, `data["origin_x/y/z"]` = the origin, and
  `data["pulse_id"]`.

The spinning-multibeam azimuth sweep must advance **in time** across a revolution (platform
moves mid-sweep).

## 4. No-return / miss pulses (in scope)

The miss / `record_misses` path (`LiDAR.cpp:5328` and the in-loop miss branch) must attach the
**same** per-pulse real timestamp + `origin_x/y/z` as hits, so transmitted beams carry correct
path-length geometry.

## 5. `getHitOrigin` + C ABI

Add `helios::vec3 getHitOrigin(uint index) const` — returns the `origin_*` data values if
present, else `getScanOrigin(scanID)`. Do **not** widen the `HitPoint` struct (`LiDAR.h:84`);
its `std::map<std::string,double> data` map already carries arbitrary scalars.

Add an **additive** C ABI entry in `native/src/pyhelios_wrapper_lidar.cpp`:

```c
PYHELIOS_API unsigned int addLiDARScanMoving(
    LiDARcloud* cloud,
    const double* traj /* M*8 t,x,y,z,qx,qy,qz,qw */, unsigned int M,
    unsigned int Ntheta, float thetaMin, float thetaMax,
    unsigned int Nphi,   float phiMin,   float phiMax,
    float exitDiameter, float beamDivergence, float rangeNoiseStdDev, float angleNoiseStdDev,
    const char** columnFormat, unsigned int nCols,
    const float* leverArm /*3*/, const float* boresightRPY /*3*/,
    float pulseRateHz, double t0);
```

**Never change the existing `addLiDARScan` signature** (ABI version-lock).

## Tests (standalone C++/pyhelios scripts; statistical assertions — never "didn't throw")

- **(a) Per-beam origin reconstruction:** straight-line nadir trajectory `y = v·t` over a flat
  patch of known height → every hit's `origin_*` lies on the line within float tol; timestamps
  strictly increasing per pulse; all returns of one multi-return pulse share one timestamp.
- **(b) Static-equivalence:** a zero-velocity "moving" scan ≈ the existing static `addScan` over
  the same scene (counts / centroid within noise) — additivity regression guard.
- **(c) Non-trivial attitude:** a trajectory with real roll/pitch/yaw → reconstructed origins
  match hand-computed `pos + R·lever_arm`. **This is the only test that catches a quaternion
  convention / axis-sign bug** — (a) and (b) hide them.

## Riskiest parts

- **Quaternion convention** — pin Hamilton, body→world, and document the rotation composition
  order (`R(quat)·R(boresight)·dir`). A sign/axis error produces plausible-but-wrong origins
  that pass tests (a) and (b); only test (c) exposes it.
- **Timestamp's dual role** — it is both the pose-join key and the multi-return grouping key.
  Keep all returns of a pulse exactly equal, or `groupHitsByTimestamp` shatters beams.
