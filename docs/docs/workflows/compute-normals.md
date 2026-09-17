# Compute normals

A **normal** is the direction a surface faces at a point. LiDAR measures
positions, not surfaces, so normals have to be estimated: Phytograph fits
a small plane through each point's nearest neighbours and takes the
direction perpendicular to it.

Computing them once and storing them on the cloud means you can colour by
them, export them alongside the points, and inspect surface shape without
recomputing anything.

## Run it

1. Select one imported cloud.
2. Open **Compute Normals** (tool column, or Tools → Pre-processing →
   Compute Normals).
3. Set the options below, then click **Compute Normals**.

The cloud is recoloured by **curvature** when the run finishes, which is
usually the most informative first look: smooth bark and ground go dark,
foliage and edges light up.

## Options

**Neighbours** — how many nearby points are fitted to estimate each
normal. Larger values give a smoother, noise-tolerant result but blur
fine detail like twigs and leaf edges; smaller values follow detail but
are noisier. The default of 30 suits most scans.

**Limit search radius** — off by default. A plain neighbour count adapts
on its own to a terrestrial scan, where return density falls with
distance from the scanner: a fixed radius that is right at 5 m finds
almost nothing at 40 m. Turn it on, and set a radius in metres, when you
need to stop the search bridging across a gap — between two leaves that
are close in space but not part of the same surface, for instance.

**Orientation** — a plane fit gives a direction but not *which way along
it* the surface faces, so the result has to be oriented:

- **Toward sensor** (default) flips each normal back along the beam that
  measured it. This is the physically correct answer for a scan, and
  Phytograph uses the best sensor information the cloud carries — the
  per-pulse beam origins if they were imported, otherwise the scan
  origin. If nothing records where the scanner was, the cloud's own
  centre is used as the viewpoint instead, so normals face inward toward
  it — the same convention as a real sensor, which sees a surface from
  one side.
- **Up (+Z)** points every normal to the upper hemisphere. Use it for
  ground, terrain, or a DEM-like surface.
- **Leave unoriented** keeps the raw plane fit. Fine for curvature and
  verticality, which ignore the sign, but not for meshing.

## What it writes

Five per-point columns, all available in the **Display → Color by**
picker and in the [export column
picker](../reference/file-formats.md):

| Column | Meaning |
| --- | --- |
| `nx`, `ny`, `nz` | The normal's three components. |
| `curvature` | Surface variation — near 0 on a flat patch, rising at edges and in foliage. Cannot exceed 1/3. |
| `verticality` | Angle of the normal from vertical, in degrees, folded to 0–90. 0 is flat ground, 90 a vertical trunk or wall. |

`nx`/`ny`/`nz` are the standard PLY names for normals, so a cloud
exported as PLY carries its normals into CloudCompare, MeshLab or
anything else that reads them — and a PLY with normals imported back into
Phytograph is recognised as carrying normals rather than three unrelated
scalar columns.

## Large clouds

The compute splits the cloud into overlapping tiles and runs them across
every available core, so it scales to hundreds of millions of points
without needing the whole cloud in memory at once. Each tile overlaps its
neighbours by enough that a point near a tile edge still sees its full
neighbourhood — the result is identical to processing the cloud whole.

Expect roughly 40 seconds for 10 million points on a modern laptop. Above
5 million points the recolouring is handed to a background job so the
columns are usable immediately, and you can keep working while the viewer
catches up. **Cancel** stops a run at any point and leaves the cloud
untouched.

## Normals and later edits

Normals describe a point's *neighbourhood*, so cropping, erasing or
filtering the cloud afterwards changes what the right answer would be for
every surviving point near the cut.

Phytograph does not throw the columns away when this happens — away from
the cut they are still a good approximation, and recomputing a large
cloud is not free. Instead, reopening **Compute Normals** on an edited
cloud shows a note that the normals may be out of date, and the button
offers **Recompute Normals**. Recompute when you are about to rely on
them; ignore it when you are not.

## Related

- [Clean a point cloud](clean-point-cloud.md) — crop, filter and resample
  before computing normals, not after.
- [Triangulate a mesh](triangulate.md) — meshing estimates its own
  normals internally, with the orientation each method needs.
- [File formats](../reference/file-formats.md) — which formats carry
  normals out of Phytograph.
