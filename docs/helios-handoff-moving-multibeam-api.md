# Hand-off: Rework the Helios LiDAR interface for moving-platform & spinning-multibeam scans

> **Audience:** an agent working **directly in the Helios source repo** (the `lidar`
> plugin). File paths below are relative to that repo's `plugins/lidar/`.
>
> **This is an implementation task, not a discussion.** You are being asked to **change
> the interface** — the `addScan*`-family API *and* the scan-XML/file format — so that a
> native Helios user sets up a moving-platform or spinning-multibeam scan using the
> **physical parameters of the instrument**, and Helios derives the internal sampling
> grid. Today a user has to hand-flatten an instrument into a raster grid; that work must
> move *into* Helios.
>
> The exact C++ signature shapes are yours to finalize in Helios-native style. What is
> **not** negotiable is the set of requirements in "What must change" below: which
> parameters the user sets, which raster-grid parameters must disappear or become
> internal, and that the XML path must support these scans too.
>
> **Scope:** only the **moving-platform** and **spinning-multibeam** scan setup. Leave the
> existing static *raster* scan (`addScan` + raster XML) as-is — a uniform θ×φ dome sweep
> is a sensible model for a stationary tripod TLS and is out of scope here.

---

## Why this is needed (the problem, in one paragraph)

The moving-platform and spinning-multibeam features were added incrementally on top of a
static `Ntheta × Nphi` raster-grid foundation. So to simulate a *real instrument* — e.g.
"a 32-channel spinning sensor at these elevations, 0.2° azimuth resolution, firing at its
PRF, carried along this flight trajectory" — the caller cannot state any of that directly.
They must manually convert it into a raster grid: compute the number of revolutions from
rotation rate × flight duration, set `Nphi = steps_per_rev × revolutions`, set
`phiMax = revolutions × 2π` (a value like 3790 radians), and size `Ntheta × Nphi` so the
sweep spans the flight. None of that arithmetic is inherent to the physics the user is
describing — it's an artifact of the grid-shaped API. **Move that translation into Helios.**

A downstream GUI (Phytograph) already does exactly this translation for *its* users; this
hand-off asks you to give *native Helios users* the same first-class setup, so the
behavior is consistent regardless of how Helios is driven.

---

## What a user should set vs. what Helios must derive

This is the target. For a **spinning-multibeam** scan (stationary or moving), the user
sets **physical instrument parameters**:

| User sets (physical) | Notes |
|---|---|
| **Per-channel beam elevation (or zenith) angles** | The exact channel list. Each pulse fires at an *exact* channel angle — not a resampled uniform θ grid (see fidelity fix below). |
| **Azimuth resolution** | The **primary** azimuth control: degrees-per-step (or steps-per-revolution). This is what a user dials on a real spinning sensor. |
| **Pulse repetition rate (PRF)** | The laser's fixed firing rate. |
| **Trajectory** (for a moving scan) | Timestamped 6-DOF poses. A **single pose** (or two coincident poses) ⇒ a *stationary* spinning capture; a real path ⇒ moving. |
| **Lever-arm + boresight** | The sensor's rigid offset/misalignment on the platform. |
| optics + noise (exit diameter, divergence, range/angle noise) | as today |

Helios **derives internally** (the user never sets these for a spinning sensor):

- **Rotation rate** = PRF ÷ (channels × steps_per_rev). (Report it back so the scan is
  introspectable — see ScanMetadata requirement.)
- **Number of revolutions** = rotation_rate × trajectory_duration (1 for a stationary
  single-revolution capture).
- The **total azimuth sampling** and the multi-revolution sweep — i.e. whatever currently
  has to be expressed as a giant `Nphi` and `phiMax = revs × 2π`.
- The **pulse → time → pose** mapping (`t = t0 + ordinal/PRF`), so the user never sizes a
  grid to make the sweep span the flight.

For a **moving raster** scan (a non-spinning sensor on a moving platform), the user
similarly sets the angular *resolution* + trajectory + PRF, and Helios derives how the
fixed θ×φ pattern is sampled in time along the trajectory — the user should not be
computing pulse counts or `phiMax` by hand.

---

## What must change (requirements)

1. **First-class spinning-multibeam scan setup.** Add an entry point (C++ method) whose
   parameters are the physical ones above — channel angles, azimuth resolution, PRF,
   trajectory, lever-arm/boresight, optics/noise. It must:
   - derive rotation rate, revolutions, and the full azimuth sweep internally;
   - require **no** caller-supplied `Nphi`, `phiMin/phiMax`, or multi-revolution angle;
   - fire each pulse at the **exact** per-channel elevation;
   - support both a stationary capture (single/coincident trajectory pose ⇒ one
     revolution) and a moving capture (real trajectory ⇒ many revolutions) through the
     same entry point. Do **not** keep a separate "stationary spinning sensor with a
     partial azimuth *range*" model — a free-spinning sensor has no partial-arc azimuth;
     its only azimuth control is resolution. (You may deprecate or internally re-express
     the current stationary `addScanMultibeam` partial-`phiMin/phiMax` API; see the
     backward-compat constraint.)

2. **First-class moving-platform (raster) scan setup.** For a moving non-spinning sensor,
   the caller sets angular resolution + trajectory + PRF; Helios derives the time
   sampling. The caller must not have to compute pulse counts, `t_total`, or size the grid
   so the sweep spans the flight.

3. **Eliminate the manual raster-flattening from the caller's surface.** After this work,
   a native user setting up these scans must **not** have to set `Nphi`, `phiMin/phiMax`,
   or compute `phiMax = revolutions × 2π`, and must not have to compute pulse_period or
   total pulse counts to make the flight be covered. Those become internal.

4. **Fix the spurious azimuth warning.** The warning at `src/LiDAR.cpp` (≈451–452,
   "azimuth angle … is greater than 2pi. Did you mistakenly use degrees instead of
   radians?") fires on every legitimate multi-revolution spinning scan. With the new
   interface no user-facing `phiMax` exists, but ensure the internal multi-revolution path
   does not emit this warning (gate it to genuine degrees-vs-radians mistakes on the
   static raster path only).

5. **Make the scan self-describing in `ScanMetadata`.** Store the physical descriptors —
   scan mode (e.g. spinning-multibeam vs. raster, moving vs. static as a clear
   descriptor rather than two independent booleans inferred together), rotation rate, and
   revolutions — so a scan can be introspected ("how fast did it spin / how many
   revolutions?") without reverse-engineering it from `phiMax`.

6. **Per-channel-angle fidelity fix.** Verify the *moving* multibeam ray fan fires each
   pulse at the true per-channel zenith angle, not a uniform θ grid spanning the channels'
   min..max. Today the moving path appears to build a uniform θ grid (`src/LiDAR.cpp`
   ≈5582–5588 derives `dtheta` from a θ range), which is wrong for a channelized sensor.
   Fire exact channel angles.

7. **Scan-XML / file support for these scans.** The lidar XML loader currently handles
   static scans only (origin, size, angular bounds, filename/ASCII_format, and a
   `<scanPattern>spinning_multibeam</scanPattern>` + `<beamElevationAngles>`). Extend the
   format so a moving-platform and/or spinning-multibeam scan can be **authored, stored,
   and loaded from a config file** using the same physical parameters as the C++ API: a
   trajectory (inline or a referenced trajectory file), azimuth resolution, PRF,
   lever-arm/boresight, and scan mode. A user must be able to express one of these scans
   in XML — not only in code — just as they can a static scan today. (Tag names/shape are
   yours; mirror the physical-parameter model above.)

8. **selfTest + docs.** Replace/extend the moving-platform selfTest so the *setup* uses the
   new physical-parameter entry point (not the manual `t_total = Ntheta*Nphi/PRF` +
   hand-built `traj_t` + raster `ScanMetadata` pattern in the current test, ≈3694–3760),
   and add a multi-revolution spinning case (the current test only does one revolution).
   Update the plugin's user-facing docs for the new setup.

---

## Evidence (verified against current code) — justification, not the deliverable

These confirm the friction the requirements above remove. File paths relative to
`plugins/lidar/`.

- **Moving API is grid-shaped.** `include/LiDAR.h` (≈735–757) `addScanMoving(ScanMetadata
  scan, traj_t, traj_pos, traj_quat|traj_rpy, lever_arm, boresight_rpy, pulse_rate_hz,
  t0)` — the `ScanMetadata` carries a static `Ntheta/thetaMin/thetaMax/Nphi/phiMin/phiMax`
  raster grid; a spinning sensor must be encoded into it.
- **Multi-revolution must be hand-built into `phiMax`.** Ray fan `src/LiDAR.cpp`
  (≈5585–5614): `for j<Nphi { phi = phimin + j*dphi; for i<Ntheta {...} }`, where the
  caller sized `Nphi` and `phiMax` to cover all revolutions; `dtheta` is computed from a θ
  range even when channels exist.
- **Pulse→time mapping is implicit.** `src/LiDAR.cpp` (≈5594–5602): `ordinal = Ntheta*j+i;
  t = t0 + ordinal*pulse_period;` — to cover the flight, the caller must arrange
  `Ntheta*Nphi ≈ PRF*duration`.
- **Spurious warning.** `src/LiDAR.cpp` (≈451–452), quoted in requirement 4.
- **Stationary multibeam's partial-range oddity.** `include/LiDAR.h` (≈264): the
  `ScanMetadata` multibeam constructor takes `Nphi, phiMin, phiMax` — a partial azimuth
  *range* for a free-spinning sensor.
- **`ScanMetadata` is flattened.** `include/LiDAR.h` (≈407–453): `isMoving, traj_t,
  traj_pos, traj_quat, lever_arm, boresight_rpy, pulse_period, t0` — no rotation rate,
  revolutions, or unified scan-mode descriptor.
- **Awkward setup in the test.** `tests/selfTest.cpp` (≈3694–3760) manually computes
  `pulse_period`, `t_total = Ntheta*Nphi*pulse_period`, builds `traj_t`, and passes a
  raster `ScanMetadata` — exactly the manual flattening this hand-off removes; one
  revolution only.
- **No XML path for these scans.** The lidar XML loader supports static scans only.

### What downstream (Phytograph) computes today — i.e. the math to move into Helios
Before calling `addScanMoving`, Phytograph computes:
`pulses_per_rev = channels × azimuth_points_per_rev`; `rotation_rate = PRF/pulses_per_rev`;
`n_revolutions = rotation_rate × trajectory_duration`;
`Nphi_total = round(azimuth_points_per_rev × n_revolutions)`;
`phiMax = n_revolutions × 2π`; `Ntheta = channels`. This is the translation a native user
must do by hand — and what the new interface should do internally.

---

## Hard constraint: don't silently break the existing API

A downstream consumer (Phytograph, via PyHelios) depends on the **current** signatures and
conventions. Prefer **additive** first-class entry points that internally call the existing
primitives, so downstream can migrate deliberately. If you must change or remove an
existing signature (e.g. the stationary `addScanMultibeam` partial-range form), provide a
migration path and **bump the plugin/library version** so the downstream version-lock can
react, and note it in the changelog.

Conventions that must be preserved (or explicitly versioned):
- Hamilton quaternions, **body→world**, components `(qx, qy, qz, qw)` scalar-last.
- Euler input intrinsic **Z-Y-X** (yaw-pitch-roll), radians.
- Per-pulse timestamp `= t0 + ordinal × pulse_period`, **identical across all returns of a
  pulse** (multi-return grouping / gapfill depend on float equality), monotonic, uniformly
  spaced.
- Per-hit data keys `origin_x/origin_y/origin_z`, `timestamp`, `pulse_id`; `getHitOrigin`;
  the `calculateLeafArea(..., Gtheta)` overload. Geometry is float32; time is double.

---

## Deliverable

Implement a first-class interface — **C++ method(s) and scan-XML/file support** — so a
native Helios user sets up a moving-platform and/or spinning-multibeam scan with physical
instrument parameters (channel angles, azimuth resolution, PRF, trajectory,
lever-arm/boresight), with Helios deriving the sampling grid, rotation rate, revolutions,
and time mapping internally. Remove the manual raster-flattening from the caller's surface,
fix the per-channel-angle fidelity and the >2π warning, make the scan self-describing in
`ScanMetadata`, and keep the existing API working (or versioned-migrated) per the
constraint above. Update selfTest + docs to use the new setup.
