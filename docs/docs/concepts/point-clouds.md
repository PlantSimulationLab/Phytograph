# Point clouds

A **point cloud** is an unordered set of 3D samples — each point has an
x, y, z position in space, and may carry additional per-point data:

In Phytograph point data always lives inside a [Scan](scans.md), the
unit shown in the right-side panel. A scan may carry only its point
data (the common case for a freshly imported file), only scan
parameters (a planned scanner with no recording yet), or both.

- **Intensity** — LiDAR return strength (a single scalar, usually
  representing surface reflectivity at the laser's wavelength).
- **RGB** — color from a co-registered camera or hand assignment.
- **Scalar fields** — any other per-point quantity (height above ground,
  normal vector components, classification labels, custom values).

Phytograph stores all of these on import and lets you color the cloud by
any of them. See **[Color modes](../reference/color-modes.md)**.

## Formats

| Extension | Notes |
|---|---|
| `.las`, `.laz` | Industry-standard LiDAR formats. Compressed LAZ supported. |
| `.ply` | Polygon File Format. Carries colors and arbitrary scalar fields. |
| `.xyz`, `.txt` | Whitespace-separated text. First three columns are x/y/z; subsequent columns become scalar fields. |
| `.csv` | Comma-separated. First three columns x/y/z; column headers used as scalar field names. |

For ASCII formats, Phytograph auto-detects the separator and treats the
first non-numeric row as a header if present.

## What you can do with a point cloud

| Operation | Workflow |
|---|---|
| Reposition / level | [Clean a point cloud](../workflows/clean-point-cloud.md#translate-and-level) |
| Crop out ground or unwanted regions | [Clean a point cloud](../workflows/clean-point-cloud.md#crop) |
| Erase points by painting | [Clean a point cloud](../workflows/clean-point-cloud.md#erase) |
| Filter by intensity / scalar range | [Clean a point cloud](../workflows/clean-point-cloud.md#filter) |
| Resample to fewer points | [Clean a point cloud](../workflows/clean-point-cloud.md#resample) |
| Stitch multiple clouds into one | [Register & compare](../workflows/register-compare.md#stitch) |
| Align two clouds (ICP) | [Register & compare](../workflows/register-compare.md#cloud-to-cloud-icp) |
| Triangulate to a mesh | [Triangulate a mesh](../workflows/triangulate.md) |
| Extract a skeleton | [Extract a skeleton](../workflows/extract-skeleton.md) |
| Export | [Import & export](../workflows/import-export.md#export) |

## Performance notes

Phytograph handles tens of millions of points in the viewer; the GPU
draws them as a point primitive without LOD. If you find rotation
choppy:

- **Reduce point size** in the Scene panel — smaller points cost less.
- **Resample** to a working subset, then re-import the full cloud at
  the end. The [Resample workflow](../workflows/clean-point-cloud.md#resample)
  has a live preview.

## Coordinate systems

Phytograph treats whatever frame your data was in as the world frame.
The grid and axes overlays show the world XY plane (Z up). If your
scan is rotated relative to Z-up (common with airborne scans), use
**Translate** with rotation handles to re-align it before downstream
work.
