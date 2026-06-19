# Simulate a LiDAR scan

Place a virtual scanner in the scene and synthesize the point cloud a
real TLS would produce. Use this to plan field campaigns, generate
ground-truth data, or run sensitivity studies. See
[Scans](../concepts/scans.md) for the concept — what you're placing
here is a scan with only parameters; the point data lands once you run
the simulation.

## Prerequisite

You need geometry in the scene to scan: typically a generated
[plant model](generate-plant.md) or an imported mesh.

## Place a scanner

1. Click **Add Scan** (radio icon in the toolbar) or the `+` in the
   Scans panel. The Add Scan popup opens.

2. **Label** — a name for this scan (e.g., `north-1`, `position-A`).
   The label appears on the scanner marker in the 3D view.

3. **Scanner model** — pick the instrument the scan represents. Choosing
   a specific model (RIEGL VZ-400i, Leica ScanStation P40, Leica BLK360
   (G1), Leica BLK360 (G2), FARO Focus S350, Velodyne HDL-32E, or RIEGL
   miniVUX-3UAV) does two things:

    - **Marks the position with that instrument's shape**, drawn to its
      real-world size (a Velodyne puck is ~14 cm; a Leica P40 ~40 cm).
    - **Auto-fills the instrument-fixed parameters** — beam optics
      (diameter and divergence), scan pattern, return type, per-channel
      beam elevations (for spinning sensors), and the maximum angular
      sweep — from the manufacturer's datasheet. Resolution (point
      counts) is yours to set, and every auto-filled value stays editable.

    The RIEGL miniVUX-3UAV is the **single-channel** spinning case: one
    laser folded through a 45° rotating mirror that sweeps a flat 360°
    **plane** (not a tilted cone — that conical geometry is the separate
    miniVUX-1DL), modelled as a spinning multibeam with a single 0° beam
    elevation. Its datasheet pins the azimuth resolution (a 0.018°–0.36°
    step, so 1,000–20,000 points per revolution), so unlike the
    terrestrial scanners it also presets a points-per-revolution starting
    value (~3,600 ≈ 0.1°). Like the Velodyne, it is a moving-platform
    sensor and so requires a trajectory.

    Leave it on **Generic / custom** for an unknown or hand-tuned
    scanner; the position is marked with a plain sphere and no values are
    changed.

4. **Scan pattern** — choose how the rays are laid out. The pattern
   determines which inputs the popup shows next:

    === "Raster"

        A uniform zenith × azimuth grid — the classic gimbal/dome sweep
        of a terrestrial laser scanner. You set both a vertical (zenith)
        and horizontal (azimuth) ray count and sweep. This is the
        default and matches most TLS instruments.

    === "Spinning multibeam"

        A rotating multi-channel sensor (Velodyne / Ouster / Hesai
        style). Each laser channel fires at a fixed elevation as the head
        spins, so instead of a zenith sweep you list the **beam elevation
        angles** directly (see step 4). The number of channels sets the
        vertical resolution.

        A spinning sensor rotates **continuously**, so it is a
        moving-platform pattern and **requires a trajectory** — the popup
        won't let you add a multibeam scan without one. See
        [Moving-platform scans](#moving-platform-drone-robot-tractor-scans)
        below; for a stationary capture, use a trajectory with two poses at
        the same position one revolution apart.

5. **Origin** — (X, Y, Z) in meters of the scanner head. A typical TLS
   campaign places scanners 1.5–2 m above ground, 3–5 m from the
   plant.

6. **Scan size** and **angular sweep** — what you enter here depends on
   the pattern:

    === "Raster"

        - **Scan size** — **Zenith points** (rays vertically) and
          **Azimuth points** (rays horizontally). For reference: a Riegl
          VZ-400 at fine resolution is roughly 20,000 × 30,000 rays. For
          preview work, 500 × 1000 is fast and produces a usable cloud.
          The azimuth field has a **use °/ray** toggle: switch it to enter
          the horizontal **angular resolution** (degrees between rays)
          instead of a point count — handy for transcribing a datasheet
          that quotes a step width. The two are equivalent (points =
          sweep ÷ resolution) and the value auto-converts when you
          toggle.
        - **Angular sweep** — min and max angular positions of the sweep;
          the range is the difference between them, so asymmetric sweeps
          are supported:
            - **Zenith (θ) min / max** — vertical bounds in degrees
              (e.g. 30–130 from straight up; 0–180 for full vertical
              coverage)
            - **Azimuth (φ) min / max** — horizontal bounds (e.g. 0–360
              for a full pan)

    === "Spinning multibeam"

        - **Azimuth (per rev)** — number of azimuth steps in one full
          revolution (the angular resolution). A spinning sensor always
          rotates a full 360°, so there is **no azimuth min/max range** —
          just this per-revolution count. A **use °/ray** toggle lets you
          enter the step width in degrees instead (e.g. a Velodyne
          HDL-32E's ~0.2° at 10 Hz); over the full 360° revolution that
          converts to points = 360 ÷ resolution, and the value
          auto-converts when you toggle.
        - **Beam elevation angles** — a comma- or space-separated list of
          per-channel elevation angles, in **degrees above the horizon**
          (positive = above horizon, the convention on manufacturer spec
          sheets). For example `15, 10, 5, 0, -5, -10, -15, -20` is an
          8-channel sensor. The channel count sets the vertical
          resolution; there is no separate zenith point count or zenith
          sweep.
        - **Trajectory** — required (a spinning sensor is moving-only). The
          total pulses fired ≈ pulse rate × flight duration; how many
          revolutions result is derived from those. See
          [Moving-platform scans](#moving-platform-drone-robot-tractor-scans).
        - **Azimuth (φ) min / max** — horizontal bounds, as for raster.

7. **Return type**:

    === "Single-return"

        One return per ray, located at the first surface the ray hits.
        Fast. Use for solid surfaces (trunks, fruit, ground).

    === "Multi-return"

        Up to several returns per ray, including partial penetration of
        foliage. Two additional parameters:

        - **Beam exit diameter** — diameter at the scanner head (mm)
        - **Beam divergence** — half-angle divergence (mrad)

        Slower but produces realistic returns from leaves and porous
        canopy.

8. **Scanner tilt** — residual lean of the scanner away from level, in
   degrees. Real terrestrial scanners are never perfectly plumb; a
   dual-axis inclinometer reports the lean as two angles:
    - **Roll** — applied first, about the scanner's lateral axis
    - **Pitch** — applied second, about its forward axis

    Leave both at `0` for a perfectly level scanner. Tilt is a property
    of the scan (it describes the instrument), so it's stored on the scan
    and editable later — useful even for documenting a real scan's pose.

9. **Scanner heading** — the initial azimuth the scanner faces in the
   horizontal plane, in degrees (`0` is the default heading; counter-clockwise
   positive). Like tilt, it's a property of the scan and editable later. The
   heading rotates both the scanner **marker** in the 3D view and the
   synthetic-scan **rays** — the simulated sweep is offset about the vertical
   axis so a partial-azimuth scan points where the marker faces. The field is
   stored and round-trips through XML (`<scanAzimuthOffset>`).

10. Click **Add Scan** to place the scanner. A marker — the selected
   instrument's shape, or a sphere for a generic scanner — appears in the
   3D view at the origin.

## Import scan positions from a real campaign

If you already have scanner positions from field data, import a Helios
scan XML any of three ways: click **Import from XML file** in the Add
Scan popup, choose **File → Import → Scan XML…** (or **Auto-detect…**),
or drag the `.xml` onto the viewport. All three run the same import.
This reads the same format the Helios scan simulator uses; one scan is
created per `<scan>` element, and any top-level `<grid>` blocks become
voxel-grid boxes.
A `<scanTilt>` tag (two numbers, `roll pitch` in degrees) populates the
scanner tilt; absent, the scan imports level. A `<scanAzimuthOffset>` tag
(a single number, degrees) populates the scanner heading; absent, the
scan imports at heading 0 — so XML written before this field existed
still loads.
A `<scanPattern>spinning_multibeam</scanPattern>` tag imports the scan as
a spinning-multibeam scan; its per-channel `<beamElevationAngles>` (a
space-separated list of elevation degrees above the horizon) and the
azimuth resolution populate the pattern's inputs. The azimuth count comes
from `<Nphi>`, `<size>`, or `<azimuthStep>` (degrees per firing step —
the form PyHelios writes for spinning scans, from which Phytograph
recovers the per-revolution count). Without a `<scanPattern>` tag the
scan imports as a raster scan, as before. Scans exported from Phytograph
round-trip: a multibeam scan you save as Helios XML re-imports as a
multibeam scan.
If a `<scan>` carries a `<filename>` tag and that file is on disk
alongside the XML (or in the current working directory), Phytograph
auto-loads the point data and attaches it to the new scan. Otherwise
you can attach it later from the row's paperclip button.

## Moving-platform (drone / robot / tractor) scans

A static scanner fires from one fixed position. To simulate a **moving
platform**, attach a *trajectory* to the scan: in the Add Scan popup,
click **Import trajectory file…** and pick a CSV/text file of poses (see
[Scans → Moving-platform scans](../concepts/scans.md#moving-platform-scans)
for the format — `t x y z` plus a quaternion or roll/pitch/yaw per row).

Once a trajectory is attached:

- The scan is flagged **moving** in the Scans panel, and its path is drawn
  as a line in the 3D view, with the selected scanner model placed at each
  pose — posed by that sample's position and orientation and drawn at its
  real-world size. A generic scanner instead marks each pose with a small
  sphere and a forward-pointing arrow.
- The **Origin** field is replaced by a read-only anchor — position now
  comes from the trajectory, not a single point.
- A **Pulse rate / PRF (Hz)** field appears, pre-filled from the selected
  scanner model. This is the laser's fixed pulse repetition rate — a
  property of the instrument, not something you normally change (editable
  for a generic/custom scanner).
- The **azimuth point count** is now interpreted as points **per
  revolution** (the sensor's angular resolution). For a multibeam sensor
  the zenith rows are its laser channels (the beam elevation angles), so
  there is no separate zenith count.

The scan simulates a real spinning sensor: it fires continuously at the
PRF, the head spins at the rate the PRF and the per-revolution resolution
imply, and the platform flies the trajectory — **for the entire flight**.
The popup shows the derived **rotation rate**, **number of revolutions**,
and **total pulse count** before you run, so you can see the cost. Because
a real PRF over a multi-second flight is millions of pulses, a warning
appears for very large scans — lower the azimuth-per-revolution count or
use a shorter trajectory for a quick test. Unlike a static dome scan, you
do **not** size a fixed pulse budget; the flight duration sets how many
revolutions (and total points) result.

The resulting cloud carries each return's per-beam origin and timestamp,
so it feeds straight into a moving-platform
[leaf area density](estimate-leaf-area-density.md#moving-platform-scans)
inversion.

Large scans (anything past a few hundred megabytes — typical for a TLS
campaign) are parsed by the Python backend rather than in the browser,
so multi-gigabyte files load without hitting browser memory limits.
This covers `.xyz`/`.txt`/`.csv`/`.pts`/`.asc` (via pandas) and
`.ply`/`.pcd` (via open3d, ASCII or binary). If the `<scan>` also
includes an `<ASCII_format>` tag (for example
`x y z r255 g255 b255 reflectance`), Phytograph forwards that hint to
the parser so RGB and reflectance land in the right columns. Without
the tag, the parser auto-detects layout from the first non-comment
row. The hint is ignored for PLY and PCD, which carry their column
layout in the file header.

## Run the scan

The **Synthetic LiDAR Scan** action runs a true ray-traced scan through
the PyHelios `lidar` plugin: the scan positions you pick trace their rays
against the scene geometry, so the result respects occlusion, scanner
position, field of view, and resolution — not a uniform random sprinkle
of points over the surface.

1. The options dialog lists **every** scan position, whether or not it's
   currently visible or selected — visibility (the eye icon) only affects
   the 3D view, not which positions can scan. Toggle the positions you
   want to ray-trace in the dialog; you don't need to make hidden
   scanners visible first.
2. Make sure the geometry to scan is visible. Only **plant models** and
   **meshes imported from file** are scanned — triangulation results,
   the voxel grid, and generated primitive shapes are ignored.
3. Run it: click **Run Synthetic LiDAR Scan** at the top of the **Scans
   panel** (this button appears as soon as one scanner exists). The same
   action is also available on a selected mesh's toolbar and from the
   command palette (search "scan").

### Synthetic scan options

Running opens the **Synthetic Scan Options** dialog as soon as at least
one scanner position exists — you don't need geometry in the scene yet.
If there's nothing to scan, the dialog still opens so you can review your
scan positions and settings, but it shows a notice to add a plant or
mesh and keeps **Run** disabled until scannable geometry is visible.

Unlike a scan's properties (origin, sweep, tilt — set per scan), these
are simulation settings chosen per run; your last-used values are
remembered and pre-filled next time:

- **Measurement noise** — Gaussian noise added during ray-tracing, to
  mimic a real instrument's error. **Range** (mm) displaces each hit
  along its beam; **angle** (mrad) jitters the beam direction. `0`
  disables each (a perfect scan).
- **Include sky / miss points** — keep the rays that hit nothing (the
  "sky"). When on, the scan is routed through a session so the misses
  show up under the row's **sky/miss** toggle (projected onto a sphere
  just past the farthest hit) and feed leaf-area-density. On by default.
- **Crop scan to grid** — restrict ray-tracing to the cells of a voxel
  grid. Enabled only when exactly one voxel grid is visible; the scan
  then ignores geometry outside that grid.
- **Full-waveform** (multi-return scanners only) — **rays per pulse**
  (sub-rays fired per beam) and **pulse distance threshold** (m, how
  close hits must be to merge into one return).

Click **Run scan** to proceed.

Phytograph loads all visible scannable geometry into one Helios scene,
ray-traces it once from each scan position you selected, then writes each
scanner's hit points back **onto that scanner's own scan** — the row's
subtitle changes from `params · origin (…)` to include the point count,
and the scan now carries both its parameters and the point data. Each
point also gets scalar fields you can color by or filter on: **intensity**
(beam–surface angle × reflectivity), **distance**, **timestamp**, and —
for multi-return — **target index** and **target count**. Switch the
viewer's color mode to *Intensity* or any scalar to inspect them.

While the scan runs, the **Run** button is replaced by a progress
indicator showing the current stage (loading geometry → configuring
scanners → ray-tracing → extracting hits → building point clouds) with a
bar that fills as the scan advances. The ray-tracing pass is a single
uninterruptible step, so the bar pulses (rather than ticking a
percentage) during it. A **Cancel** button next to the indicator
abandons a long or hung scan without force-quitting the app.

If a scanner already holds point data (e.g. an imported scan), Phytograph
asks whether to **overwrite** it, **keep the original and add a duplicate**
scan for the synthetic points, or **cancel**.

If no scanner exists at all, or no scannable geometry is visible, the
app shows a message explaining what's missing instead of scanning.

!!! note "Scanned colors"
    Point colors come from the surface each ray strikes. Plant organs are
    texture-mapped, so a scanned plant currently takes each organ's solid
    fallback colour (e.g. leaf green) rather than the per-pixel texture
    colour; texture-accurate scan colours arrive with a pending Helios
    update. Colour by *Intensity* in the meantime for the most informative
    view.

!!! note "Flat geometry"
    The scanner culls rays against each object's 3-D bounding box, so a
    perfectly flat (single-plane) mesh produces no hits. Plant models and
    real imported meshes are genuinely three-dimensional, so this only
    affects degenerate test geometry.

## Use cases

**Plan a field campaign.** Place 3–4 candidate scanners around a
generated plant of your target species and age. Run the scan, then
visually inspect the resulting cloud for coverage gaps. Iterate scanner
positions until the combined coverage is acceptable, then take those
positions to the field.

**Generate training data.** Generate a procedural plant, scan it from
several positions, and use the resulting clouds. The scan respects
occlusion just like a real TLS, so the cloud has realistic topology but
perfectly known ground truth. Repeat for many plants to build a labeled
dataset.

**Sensitivity to scan resolution.** Vary zenith/azimuth point counts;
run your downstream analysis (triangulation, skeleton extraction); plot
metric quality vs. resolution. This quantifies how good a scan you
need for your specific analysis.

## What's next

- **[Triangulate](triangulate.md)** the simulated cloud — especially
  Helios Triangulation, which uses the scan geometry you just set up.
- **[Register & compare](register-compare.md)** the simulated cloud
  against the original mesh to quantify reconstruction error.
