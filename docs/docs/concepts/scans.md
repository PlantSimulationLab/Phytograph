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

In a [synthetic scan](../workflows/simulate-scan.md), these gap-misses
arise naturally: leaves are textured quads with a transparent background,
and the ray-tracer respects the texture's alpha channel, so a beam aimed
at the empty space around a leaf's silhouette passes through and becomes a
miss rather than a spurious hit on the rectangular quad. That alpha
fidelity is what makes a simulated canopy's gap fraction — and therefore
its LAD — physically meaningful.

Some formats keep misses (E57, structured PLY). Many don't, but retain
enough to **reconstruct** them — a per-return `timestamp` and/or
scan-grid `row`/`column` indices — by inferring which grid cells of the
scan raster had no return. The [Backfill Misses](../workflows/backfill-misses.md)
step does that recovery and stores the misses on the scan, where the
**"Show misses"** toggle in the Scans panel draws them. Because their true
coordinates are far-field (~20 km), the misses are projected onto a sphere
just beyond the cloud and streamed as their own level-of-detail octree (the
same streaming the hit cloud uses), so even a dense sky shell stays smooth and
never bogs the viewer. LAD requires misses to be present and does not recover
them silently.

## What's in the parameters

- **Origin** — (x, y, z) position of the scanner head in metres
- **Scan pattern** — one of:
    - **raster** — a uniform zenith × azimuth grid, the classic
      terrestrial-scanner dome sweep.
    - **spinning multibeam** — a rotating multi-channel sensor like a
      Velodyne/Ouster/Hesai, where each channel fires at a fixed elevation as
      the head spins.
    - **Livox rosette** — a Livox non-repeating rosette (a rotating
      Risley-prism deflector); see
      [Livox non-repeating rosette](#livox-non-repeating-rosette-risley-prism)
      below.

    Both the spinning multibeam and the Livox rosette rotate/trace
    continuously, so they are **moving-platform patterns** and require a
    [trajectory](#moving-platform-scans) — see the note below.
- **Zenith (θ) min / max, points** — vertical sweep bounds (degrees) and
  number of rays (raster only)
- **Beam elevation angles** (spinning multibeam only) — per-channel
  elevation angles in degrees above the horizon; the channel count sets
  the vertical resolution in place of a zenith point count
- **Azimuth (φ) min / max, points** — for a raster scan, the horizontal
  sweep bounds (degrees) and number of rays. A spinning multibeam has no
  azimuth *range* (it rotates a full 360° per revolution); its azimuth
  control is just the **points per revolution** (angular resolution)
- **Return type** — how many returns each pulse reports (a property of the
  real instrument):
    - **Single** — at most **one** return per pulse, chosen by the
      **selection** policy below. Models single-return instruments (Leica,
      FARO, single-return-configured spinning sensors).
    - **Multi** — **all** detected returns up to a **max returns** cap.
      Models full-waveform / multi-echo instruments (RIEGL VZ-400i, miniVUX)
      that penetrate foliage.

    For an idealized, *exact* scan (one ray per pulse, no beam footprint),
    set **rays per pulse** to 1 when you run the scan — that is a simulation
    option, not a return type. See [Simulate a scan](../workflows/simulate-scan.md).
- **Return selection** (single only) — which return to keep when the beam
  cone resolves several: **strongest**, **first** (nearest), or **last** (farthest)
- **Max returns** (multi only) — the cap on returns reported per pulse
- **Beam properties** — exit diameter and divergence, which define the cone
  the pulse's sub-rays sample (at rays-per-pulse = 1 the cone collapses to
  one exact ray)
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

Attach one either by **importing a trajectory file** or by **building one by
hand**. In the Add Scan popup, **Import trajectory file…** reads a
CSV / whitespace-delimited table, one pose per row:

- `t x y z qx qy qz qw` — time (seconds), position (metres), and a
  Hamilton orientation quaternion, or
- `t x y z roll pitch yaw` — orientation as Tait-Bryan angles (radians;
  the importer also accepts degrees) in intrinsic Z-Y-X order.

A **binary Applanix SBET** (`.sbet` / `.out`) is also accepted: it is parsed
on the backend, with latitude/longitude projected to UTM and the NED attitude
converted to Phytograph's ENU frame. See
[File formats → Platform trajectory files](../reference/file-formats.md#platform-trajectory-files)
for the full list, GPS-time clock handling, and LAS per-beam-origin ExtraBytes.

Alternatively, **Build trajectory manually…** opens an editor to author the
poses with no file: a docked table of poses (position + roll/pitch/yaw) plus
clickable scanner models in the 3D view that you can translate/rotate with the
`t`/`r` shortcuts, and **+** affordances to insert poses between or beyond the
existing ones. The same editor opens from the **Edit trajectory** button on a
moving scan's row, so an imported trajectory can be tweaked afterwards. See
[the walkthrough](../workflows/simulate-scan.md#building-and-editing-a-trajectory-by-hand).

Times must strictly increase. A header row and `#` / `//` comment lines
are ignored. Once attached, the scan's origin is anchored to the first
pose, and the trajectory is drawn as a path line in the viewer. Each pose
along the path is shown using the selected scanner model — the instrument's
shape, posed by that sample's position and orientation and drawn at its
real-world size — so the path reads as the scanner flown along it. A generic
scanner instead marks each pose with a small sphere and a forward-pointing
arrow.

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

### Livox non-repeating rosette (Risley prism)

A **Livox rosette** models a Livox-style sensor (Mid-40, Mid-70, Avia),
whose beam is steered not by a mirror but by a stack of continuously
rotating **wedge prisms** (a Risley-prism deflector). A single beam is
refracted through the wedges, and because the wedges spin at different,
incommensurate rates it traces a dense **non-repetitive rosette** that fills
a **circular** field of view.

Two things make this pattern different from the raster and spinning
patterns:

- **The field of view is *emergent*.** It is a property of the wedge angles
  and refractive indices, computed by ray-tracing the beam through the
  prisms — not something you set. So the rosette has **no zenith/azimuth
  sweep and no zenith/azimuth point counts**; those fields are hidden. Its
  coverage is a fixed circular cone (≈38° for the Mid-40, ≈70° for the
  Mid-70 and Avia).
- **It is always trajectory-driven**, exactly like a spinning multibeam. A
  stationary tripod capture is a trajectory with **two identical poses**
  (same position *and* attitude) separated in time by the acquisition
  duration; the pulse count is `pulse rate × duration`.

Selecting a Livox model (in the scanner-model dropdown) loads that
instrument's verified prism stack — wedge angles, refractive indices, and
rotor rates — from the manufacturer / HELIOS++ reference values, and
switches the pattern to the rosette automatically. The prism stack is shown
read-only in the popup.

!!! note "Single-stack approximation for the Avia"
    The real Livox Avia fires several laser channels; the simulator models a
    single beam through one prism stack, which is the faithful approximation
    of the rosette footprint. As with any trajectory-driven scan, a rosette
    scan **cannot be triangulated or gap-filled** row/column-wise — leaf-area
    density uses the per-beam origins reconstructed from the trajectory
    instead. Rosette scans are also **not** exported to the Helios XML/ASCII
    bundle (that format assumes a zenith × azimuth grid).

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

### Scan pattern wireframes

**View → Show Scan Pattern Wireframes** (off by default) overlays a faint
wireframe shell on each scanner that depicts its *angular coverage* — not
its body. A **raster** scan draws a partial lat/long sphere with the
unswept zenith/azimuth slices removed (so a dome scan reads as a banded
sphere missing its top and bottom caps). A **spinning multibeam** draws one
ring per beam elevation, each with a few spokes back to the scanner to
suggest the cone the channel sweeps; a 0° beam flattens to a horizontal
disk. The shell rotates and leans with the scanner's heading and tilt, is
coloured to match the scan, and its radius is five times the scanner's
real-world height scaled by the **Scan marker size** setting — a halo
around the instrument, not the full scan range. Toggle it back off from the
same menu item.

See [Simulate a LiDAR scan](../workflows/simulate-scan.md) for the full
walkthrough of placing virtual scanners.
