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

3. **Origin** — (X, Y, Z) in meters of the scanner head. A typical TLS
   campaign places scanners 1.5–2 m above ground, 3–5 m from the
   plant.

4. **Scan size**:
    - **Zenith points** — number of rays vertically
    - **Azimuth points** — number of rays horizontally

    For reference: a Riegl VZ-400 at fine resolution is roughly
    20,000 × 30,000 rays. For preview work, 500 × 1000 is fast and
    produces a usable cloud.

5. **Angular sweep** — set the min and max angular positions of the
   sweep; the range is the difference between them, so asymmetric
   sweeps are supported:
    - **Zenith (θ) min / max** — vertical bounds in degrees (e.g.
      30–130 from straight up; 0–180 for full vertical coverage)
    - **Azimuth (φ) min / max** — horizontal bounds (e.g. 0–360 for a
      full pan)

6. **Return type**:

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

7. Click **Add Scan** to place the scanner. A radio-tower marker
   appears in the 3D view at the origin.

## Import scan positions from a real campaign

If you already have scanner positions from field data, click **Import
from XML file** in the Add Scan popup. This reads the same format the
Helios scan simulator uses; one scan is created per `<scan>` element.
If a `<scan>` carries a `<filename>` tag and that file is on disk
alongside the XML (or in the current working directory), Phytograph
auto-loads the point data and attaches it to the new scan. Otherwise
you can attach it later from the row's paperclip button.

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
the PyHelios `lidar` plugin: every visible scanner traces its rays
against the scene geometry, so the result respects occlusion, scanner
position, field of view, and resolution — not a uniform random sprinkle
of points over the surface.

1. Make sure the scan markers you want to use are visible (eye icon on);
   hidden scanners are skipped.
2. Make sure the geometry to scan is visible. Only **plant models** and
   **meshes imported from file** are scanned — triangulation results,
   the voxel grid, and generated primitive shapes are ignored.
3. Run it: click **Run Synthetic LiDAR Scan** at the top of the **Scans
   panel** (this button appears as soon as one scanner exists). The same
   action is also available on a selected mesh's toolbar and from the
   command palette (search "scan").

Phytograph loads all visible scannable geometry into one Helios scene,
ray-traces it once from every visible scanner, then writes each
scanner's hit points back **onto that scanner's own scan** — the row's
subtitle changes from `params · origin (…)` to include the point count,
and the scan now carries both its parameters and the point data. Each
point also gets scalar fields you can color by or filter on: **intensity**
(beam–surface angle × reflectivity), **distance**, **timestamp**, and —
for multi-return — **target index** and **target count**. Switch the
viewer's color mode to *Intensity* or any scalar to inspect them.

If a scanner already holds point data (e.g. an imported scan), Phytograph
asks whether to **overwrite** it, **keep the original and add a duplicate**
scan for the synthetic points, or **cancel**.

If no visible scanner exists, or no scannable geometry is visible, the
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
