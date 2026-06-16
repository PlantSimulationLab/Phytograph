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

## What's in the parameters

- **Origin** — (x, y, z) position of the scanner head in metres
- **Scan pattern** — **raster** (a uniform zenith × azimuth grid, the
  classic terrestrial-scanner dome sweep) or **spinning multibeam** (a
  rotating multi-channel sensor like a Velodyne/Ouster/Hesai, where each
  channel fires at a fixed elevation as the head spins)
- **Zenith (θ) min / max, points** — vertical sweep bounds (degrees) and
  number of rays (raster only)
- **Beam elevation angles** (spinning multibeam only) — per-channel
  elevation angles in degrees above the horizon; the channel count sets
  the vertical resolution in place of a zenith point count
- **Azimuth (φ) min / max, points** — horizontal sweep bounds (degrees) and number of rays
- **Return type** — single (one return per ray) or multi (partial
  returns through foliage)
- **Beam properties** (multi-return only) — exit diameter, divergence
- **Scanner tilt** — residual roll/pitch lean away from level (degrees)
- **Scanner heading** — initial azimuth the scanner faces in the
  horizontal plane (degrees; 0 is the default heading). Orients the
  scanner marker in the 3D view and round-trips through XML
  (`<scanAzimuthOffset>`)

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
