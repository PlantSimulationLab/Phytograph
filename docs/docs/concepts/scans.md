# Scans

A **scan** is the central unit in Phytograph. It represents one LiDAR
scan from one scanner position, and may carry:

- **Point data** — the recorded points (positions, optionally colors,
  intensities, scalar fields).
- **Scan parameters** — the scanner's origin, angular sweep, sample
  counts, return type, and beam properties.
- **Both** — the common case for a freshly recorded scan you know the
  scanner position for.

A scan can also exist with only one of the two. The Scans panel on the
right of the viewer adapts each row to what's present.

## When a scan has only point data

You imported a `.las`/`.xyz`/etc. but don't know the scanner origin —
maybe the file is a pre-merged combination of several scans, or the
metadata was lost. Most analyses still work:

- **Triangulation** (ball pivoting, Poisson, alpha shape, Delaunay)
- **Skeleton extraction**
- **Cleaning / cropping / filtering**
- **Stitching with other data-bearing scans**

Analyses that need per-pulse direction (notably the
[Helios triangulation](../workflows/triangulate.md#helios-method)
mode) are disabled until parameters are added. Click the radio icon
on the row to add them — the origin pre-fills to the scan's bounds
centre as a starting point.

## When a scan has only parameters

You're planning a campaign, or you've imported a Helios scan XML whose
referenced point data isn't on disk yet. The scanner marker still
renders in the viewer at the configured origin so you can visualise
coverage. Click the paperclip icon on the row to attach a point cloud
file later.

## When a scan has both

The full picture — points plus the scanner origin that produced them.
Every analysis is available, and Helios triangulation can reconstruct
per-pulse directions from `(point − origin)`.

## Sky/miss points

When a scanner fires a pulse that never hits anything — it passes through
a gap in the canopy and on into open sky — that's a **miss** (also called
a sky point). Misses carry no surface coordinate, but they record that a
beam was transmitted along a known direction. They matter for
[leaf area density](leaf-area-density.md): the inversion compares beams
that *returned* against beams that *passed through* a voxel, and the
misses are that second population — without them a fully transparent gap
and a fully occluding leaf wall look identical.

Some formats keep misses (E57, structured PLY). Many don't, but retain
enough to **reconstruct** them — a per-return `timestamp` and/or
scan-grid `row`/`column` indices — by inferring which grid cells of the
scan raster had no return. The [Backfill Misses](../workflows/backfill-misses.md)
step does that recovery and stores the misses on the scan, where the
**"Show misses"** toggle in the Scans panel draws them (relocated onto the
scan's bounding sphere, since their true coordinates are far-field). LAD
requires misses to be present and does not recover them silently.

## What's in the parameters

- **Origin** — (x, y, z) position of the scanner head in metres
- **Scan pattern** — **raster** (a uniform zenith × azimuth grid, the
  classic terrestrial-scanner dome sweep) or **spinning multibeam** (a
  rotating multi-channel sensor like a Velodyne/Ouster/Hesai, where each
  channel fires at a fixed elevation as the head spins). A spinning sensor
  rotates continuously, so it is a **moving-platform pattern** and requires
  a [trajectory](#moving-platform-scans) — see the note below.
- **Zenith (θ) min / max, points** — vertical sweep bounds (degrees) and
  number of rays (raster only)
- **Beam elevation angles** (spinning multibeam only) — per-channel
  elevation angles in degrees above the horizon; the channel count sets
  the vertical resolution in place of a zenith point count
- **Azimuth (φ) min / max, points** — for a raster scan, the horizontal
  sweep bounds (degrees) and number of rays. A spinning multibeam has no
  azimuth *range* (it rotates a full 360° per revolution); its azimuth
  control is just the **points per revolution** (angular resolution)
- **Return type** — single (one return per ray) or multi (partial
  returns through foliage)
- **Beam properties** (multi-return only) — exit diameter, divergence
- **Scanner tilt** — residual roll/pitch lean away from level (degrees)
- **Scanner heading** — initial azimuth the scanner faces in the
  horizontal plane (degrees; 0 is the default heading). Orients the
  scanner marker in the 3D view, offsets the synthetic-scan sweep about
  the vertical axis, and round-trips through XML (`<scanAzimuthOffset>`)
- **Platform trajectory** (optional) — turns a static scan into a
  **moving-platform** scan (drone / ground robot / tractor). Imported from
  a trajectory file; see *Moving-platform scans* below.

## Moving-platform scans

A static scan has one fixed origin. A **moving-platform** scan instead
carries a *trajectory*: a dense, timestamped 6-DOF path the scanner
followed (position + orientation over time). When a trajectory is
attached, each return is reconstructed from its **own** beam origin — the
platform pose at the moment that pulse was fired — rather than a single
scanner position. This is what leaf-area inversion needs to trace beam
paths correctly for a sensor that was moving through the scene.

Attach one with **Import trajectory file…** in the Add Scan popup. The
file is a CSV / whitespace-delimited table, one pose per row:

- `t x y z qx qy qz qw` — time (seconds), position (metres), and a
  Hamilton orientation quaternion, or
- `t x y z roll pitch yaw` — orientation as Tait-Bryan angles (radians;
  the importer also accepts degrees) in intrinsic Z-Y-X order.

Times must strictly increase. A header row and `#` / `//` comment lines
are ignored. Once attached, the scan's origin is anchored to the first
pose, and the trajectory is drawn as a path line in the viewer.

Leaf-area density for a moving-platform scan uses a **beam-based**
inversion that needs a supplied mean leaf-projection coefficient
*G(θ)* (it can't triangulate a moving sweep to derive one); see
[Estimate leaf area density](../workflows/estimate-leaf-area-density.md).

### Spinning multibeam is a moving pattern

A spinning multibeam sensor rotates continuously, so it only makes sense
as a moving-platform scan — there's no coherent "stationary free-spinning"
capture without a time element. Selecting the spinning-multibeam pattern
(or a Velodyne preset) therefore **requires a trajectory** before the scan
can be added or run.

To simulate a sensor sitting **still** and spinning, give it a trajectory
with **two poses at the same position**, separated in time by one
revolution's duration. That produces exactly one full 360° revolution from
the fixed origin. (The revolution duration is `points-per-revolution ÷
pulse rate` — but in practice any small time gap that yields one revolution
works; the scan covers the whole 360° regardless.)

## Importing scans

Three entry paths:

- **Drag/drop a point file** — creates a data-only scan. Add
  parameters from the row when ready.
- **Add Scan button** (radio icon in the toolbar, or the `+` in the
  Scans panel) — creates a parameters-only scan from the popup.
- **Import from XML file** (inside the Add Scan popup) — parses a
  Helios scan XML and creates one scan per `<scan>` element. If the
  XML's `<filename>` tag points to a point data file that can be
  located on disk, that file is loaded and attached to the new scan
  automatically. Phytograph looks first in the XML's directory, then
  in the working directory, and finally prompts you to locate the
  file.

## What scans look like in the viewer

A scan with point data renders as its points. A scan with parameters
renders an additional marker at the scanner origin — the shape of the
selected scanner model (drawn to its real-world size), or a plain sphere
for a generic scanner. Toggling visibility on the row hides both, if
present.

The markers are real-world sized, so a small sensor (a Velodyne puck) is
genuinely tiny next to a large cloud. Two viewer controls help:

- **Display panel → Scan markers** (lower-right) shows or hides the whole
  marker layer at once, independent of each scan's row visibility.
- **Settings → Scan marker size** sets a global scale multiplier applied
  to every marker (1 = real-world size). Raise it to make markers easier
  to spot; the change applies as soon as you close Settings.

See [Simulate a LiDAR scan](../workflows/simulate-scan.md) for the full
walkthrough of placing virtual scanners.
