# File formats

## Point clouds

| Format | Import | Export | Notes |
|---|---|---|---|
| `.las` | ✅ | ✅ | LAS 1.2/1.4. Standard fields only on export (x, y, z, intensity, RGB, classification). |
| `.laz` | ✅ | ✅ | Compressed LAS. Round-trips with `.las`. |
| `.e57` | ✅ | ✅ | Structured scan format. Carries intensity and RGB colour, and recovers **sky/miss points** from the grid on import (see below). Export is per-scan (one `.e57` per scan) via the scan export's **Data only** mode, carrying x/y/z, intensity, and colour. |
| `.ply` | ✅ | ✅ | Preserves all scalar fields. Best for full-fidelity round-trips. Structured/organized PLYs recover sky/miss points (see below). |
| `.pcd` | ✅ | ✅ | Point Cloud Data format (PCL). |
| `.xyz` / `.txt` | ✅ | ✅ | Whitespace-separated. First three columns = x, y, z. |
| `.csv` | ✅ | ✅ | Comma-separated. First non-numeric row treated as header. |
| `.pts` | ✅ | ✅ | Whitespace-separated, usually with a header line of the point count. |
| `.asc` | ✅ | ✅ | ASCII point cloud, treated like `.xyz`. |
| `.obj` | — | ✅ | Vertices only, no faces. |

### ASCII format details

- First three columns: x, y, z (required).
- Additional columns become scalar fields. If the file has a header row,
  column names become field names. Otherwise fields are named
  `field_0`, `field_1`, ….
- Separator is auto-detected: comma for `.csv`, whitespace otherwise.
- Lines starting with `#` (or `//`) are treated as comments. A comment on
  the **first** line is also read as a column header when its tokens resolve
  to a valid `x`/`y`/`z` layout — so a legend like
  `# x y z r255 g255 b255 row column is_miss` names every field on import
  instead of being discarded. A `#` remark that isn't a column list (e.g.
  `# exported by FooScan`) stays an ordinary comment.

When a point cloud is loaded by path (dragged into the viewer, or attached
via Helios XML bulk import), it is converted to a streaming **octree** in the
Python backend and rendered tile-by-tile, so files far larger than the
browser's ~512 MB string limit load without exhausting memory. This applies
to every supported point-cloud format: ASCII (`.xyz`/`.txt`/`.csv`/`.pts`/`.asc`)
via pandas, `.ply` (parsed directly, scalar fields preserved — see below),
`.pcd` (via open3d, position + color only), and `.las`/`.laz` (passed straight
through). If the source XML provides an `<ASCII_format>` tag
for an XYZ-family file, Phytograph forwards it to the parser; recognised
column tokens are `x`, `y`, `z`, `r`/`g`/`b` (0–1 range),
`r255`/`g255`/`b255` (0–255 range, normalised to 0–1 on read),
`intensity`, `reflectance`, `timestamp`, `target_index`, `target_count`,
`row`/`column` (structured-scan grid indices), `is_miss`/`miss`/`sky`
(sky/miss flag), `deviation`. Any other numeric columns are carried through as named
**scalar fields** (color-mappable in the viewer) rather than discarded —
on large octree-streamed clouds they travel into the octree as extra
attributes. Field names come from the file's header row when present
(e.g. `Reflectance[dB]` → `Reflectance [dB]`), else a positional
fallback. The hint is ignored for PLY/PCD because those formats encode
their column layout in-file.

`intensity` and `reflectance` are read at whatever scale the source uses —
Helios reflectance in **dB** (negative), `[0, 1]` floats, `[0, 255]` bytes, or
Helios's raw signed beam·normal dot product — and normalised to the viewer's
gradient by their observed range, so the **Intensity** color mode works for any
of them. When a file carries **both** an `intensity` and a `reflectance`
column, the first becomes the dedicated intensity channel and the second is
kept as a named scalar field (color-mappable under **Scalar Field**), so
neither is dropped.

When no `<ASCII_format>` hint is given, Phytograph auto-detects the
layout: a header row's column names — whether plain or written as a
leading `#` comment — are matched to roles where recognised (so
`XYZ[0][m]`/`XYZ[1][m]`/`XYZ[2][m]` map to x/y/z and the rest become
scalar fields), otherwise it falls back to a positional guess (xyz, then
RGB at six columns, then intensity at seven). The positional RGB guess is
range-checked: columns 4–6 are only assigned to red/green/blue when their
sampled values actually look like 8-bit colour (0–255 integers), so a
six-column file whose extra columns hold timestamps or return counts (e.g.
Helios multi-return `x y z timestamp intensity return#`) is left as
reassignable scalars rather than silently mislabelled as colour.

`.ply` clouds are parsed directly (not via open3d), so arbitrary per-vertex
scalar properties — intensity, reflectance, and any custom numeric field —
are preserved and carried into the octree as color-mappable scalar fields.
`red`/`green`/`blue` become color, the first of `intensity`/`reflectance`
becomes intensity, and every other numeric property is kept under its own
name.

`.pcd` clouds are read via open3d, which carries position and color only —
PCD scalar fields are **not** preserved. If you need scalar fields from a
`.pcd`, convert it to `.ply` or to `.xyz` with the columns named in an
`<ASCII_format>` tag. `.las`/`.laz` clouds retain their native extra
dimensions.

`.e57` clouds carry **intensity** and **RGB colour** when the file records them
(both are surfaced in the import wizard and become color-mappable in the viewer);
colour on the recovered sky/miss points is set to black. Other E57 per-point
fields beyond position, intensity, and colour are not yet preserved.

### Large / projected coordinates

Scans in a projected coordinate reference (UTM, state plane) have coordinates
hundreds of thousands to millions of metres from the meridian/equator. Two
features keep these usable:

- **Global shift** (at import, optional, persistent) — the import wizard can
  subtract a per-axis offset so the **stored** cloud sits near the origin, and
  remembers the offset so **exports recover the original world coordinates**.
  CloudCompare-style; suggested automatically when coordinates are large. See
  [the import workflow](../workflows/import-export.md#the-import-wizard).
- **Automatic render offset** (always on, render-only) — independent of the
  shift, the viewer draws every scene near the origin to avoid 32-bit-float
  artifacts (a kinked/missing ground grid, flickering QSM/skeleton meshes) at
  large magnitudes. It changes only what's drawn — never stored data, exports,
  measurements, or backend operations — so keeping large coordinates stays a
  fully supported choice.

### Sky/miss points

The [leaf-area-density inversion](../concepts/leaf-area-density.md) needs to know
which laser pulses hit the **sky** and returned nothing (the "misses"). Helios
represents each miss as a real point placed very far away (~20 km) from the
scanner along the pulse direction.

Phytograph recovers misses on import:

- **E57** — the structured-grid `cartesianInvalidState` / `sphericalInvalidState`
  flag marks cells with no return. Those become miss points along the cell's beam
  direction. The scanner pose (origin) travels with the scan.
- **Structured / organized PLY** — vertices with non-finite (NaN/Inf)
  coordinates, or a `is_miss` / `miss` / `sky` property, are treated as misses.

Recovered misses are tagged with an `is_miss` flag (0 = hit, 1 = miss) and kept
in the scan. Because their true coordinates are ~20 km away, they are **excluded
from the viewer's octree** (so they don't wreck camera framing) and **hidden by
default**. Toggle **Show misses** on a scan row to draw them in a distinct colour,
relocated onto the scan's bounding sphere so they sit at a sensible distance.

If a scan has **no** miss points but **does** have a `timestamp` column, the LAD
inversion recovers misses automatically by *gapfilling* the scan grid; if it has
neither, the inversion warns that its result is likely to be inaccurate.

> **RIEGL `.rxp` is not supported.** It needs RIEGL's license-gated RiVLib SDK,
> which can't be redistributed. Convert `.rxp` to `.e57` (e.g. in RiSCAN Pro)
> to import it with miss recovery.

## Meshes

| Format | Import | Export | Notes |
|---|---|---|---|
| `.obj` | ✅ | ✅ | Vertices + faces + normals + vertex colors. On import, a sibling `.mtl` with `map_Kd` textures (and the images it names, alongside the file) is loaded and applied. |
| `.ply` | ✅ | ✅ | Vertices + faces + normals + per-vertex color. ASCII **and** binary on import (read via open3d). No textures. |
| `.stl` | ✅ | ✅ | Triangles only — no color or topology metadata. |

Polygonal faces with more than three vertices are triangulated on
import. Textured `.obj` import reads UV coordinates (`vt`) and per-material
diffuse color (`Kd`) and texture (`map_Kd`); textures are **not** written on
export.

### PLY: point cloud or mesh?

`.ply` is an ambiguous container — the same extension is used for point
clouds (vertices only) and polygon meshes (vertices **and** faces). On import,
Phytograph reads the PLY header and routes automatically: if it declares
`element face` with at least one face, the file imports as a **mesh**;
otherwise it imports as a **point cloud**. You can override this with the
**File → Import** menu's explicit **Point cloud** / **Mesh** choices. A PLY mesh imported
this way keeps its geometry, normals, and per-vertex color, but (unlike PLY
point clouds) does not carry arbitrary per-vertex scalar fields.

## Skeletons

| Format | Import | Export | Notes |
|---|---|---|---|
| `.json` | ✅ | ✅ | Full graph: nodes, edges, branch orders, attributes. |
| `.obj` | ✅ | ✅ | Line segments only (lines, not faces). |

### Skeleton JSON shape

```json
{
  "nodes": [
    {"id": 0, "x": 0.0, "y": 0.0, "z": 0.0, "branch_order": 1},
    ...
  ],
  "edges": [
    {"source": 0, "target": 1, "length": 0.15},
    ...
  ],
  "metadata": {
    "method": "LAPLACE",
    "tolerance": 0.02
  }
}
```

Use `.json` for downstream analysis in Python/R. Use `.obj` for
visualization in Blender or MeshLab.

## Scan position files

For the [Helios Triangulation](../workflows/triangulate.md#helios-method)
workflow and bulk scan import:

| Format | Use | Layout |
|---|---|---|
| Plain text | `ScanName X Y Z` per row | Tab, space, or comma separated |
| Helios XML | Single file with many scan definitions | The format Helios scan simulator uses |

A Helios XML file describes scan *parameters* and references separate point
cloud files — it holds no coordinates itself. Load it any of three ways: the
**Add Scan** tool's **Import from XML file** action, **File → Import →
Scan XML…** (or **Auto-detect…**), or by dragging the `.xml` onto the viewer.
All three run the same import; the XML's relative `<filename>` references are
resolved next to the XML on disk.

Per `<scan>`, Phytograph reads `<origin>`, `<size>` (theta/phi point counts),
the `<thetaMin>`/`<thetaMax>`/`<phiMin>`/`<phiMax>` sweep bounds,
`<exitDiameter>`/`<beamDivergence>` (multi-return optics), and `<scanTilt>` —
two numbers, `roll pitch` in degrees, giving the scanner's residual tilt away
from level (absent → level). `<filename>` and `<ASCII_format>` auto-attach the
referenced point data.

A `<scan>` carrying `<scanPattern>spinning_multibeam</scanPattern>` imports as a
**spinning-multibeam** scan instead of a raster scan. Such a scan replaces the
zenith point count and zenith sweep with `<beamElevationAngles>` — a
space-separated list of per-channel elevation angles in degrees above the
horizon (required for multibeam) — and takes its azimuth step count from
`<Nphi>` (or the second component of `<size>`). The azimuth sweep
(`<phiMin>`/`<phiMax>`) still applies. Scans exported from Phytograph round-trip:
a multibeam scan saved as Helios XML re-imports as multibeam.

A Helios XML may also contain top-level `<grid>` blocks (siblings of `<scan>`),
which describe the voxel grid Helios uses for leaf-area-density. On import,
each `<grid>` becomes a **voxel grid** object named `Grid 1`, `Grid 2`, …:

| `<grid>` tag | Maps to | Notes |
|---|---|---|
| `<center>` x y z | grid position | world coordinates (required) |
| `<size>` x y z | grid size | full extent per axis; all > 0 (required) |
| `<Nx>` `<Ny>` `<Nz>` | subdivisions | integer cells per axis; default 1 |
| `<rotation>` | z-rotation | degrees about the z-axis; default 0 |

An XML with only `<grid>` blocks (no `<scan>`) imports just the grids.

### Scan parameters recovered from the point-cloud file

Some point-cloud formats embed the scanner's geometry in the file header. When
you import one of these **on its own** (not via a Helios XML), Phytograph reads
that metadata and auto-populates the new scan's **scan parameters** — the same
fields the XML carries — so you don't have to enter them by hand. Whatever the
file *doesn't* record is left at its default (blank), exactly as before.

| Format | Origin | Orientation | Angular sweep (zenith/azimuth) | Sample resolution |
|---|---|---|---|---|
| `.e57` | ✅ pose translation | ✅ pose rotation (applied to points) | ✅ from `sphericalBounds`, when present | ✅ from the structured grid, when present |
| `.pcd` | ✅ `VIEWPOINT`, when non-identity | — | — | — |
| `.las` / `.laz` | — | — | — | — |
| `.ply` | — | — | — | — |
| ASCII (`.xyz`, …) | — | — | — | — |

- **E57** is the richest source: each scan's pose (origin + rotation) is applied
  to its points, and the angular sweep and grid resolution are read when the
  file includes them. A multi-scan E57 uses the first scan's parameters for the
  merged cloud. E57 elevation (measured from the horizontal plane) is converted
  to Phytograph's zenith angle automatically.
- **PCD** records only a sensor origin (`VIEWPOINT`); it's used only when it
  differs from the identity default that most files leave in place.
- **LAS/LAZ, PLY, and ASCII** carry no standard scanner-geometry fields, so an
  imported scan starts with default parameters — set them in the **Add Scan**
  tool if you need them for [Helios triangulation](../workflows/triangulate.md)
  or [LAD](../workflows/estimate-leaf-area-density.md).

## Plant parameter presets

The Morph popup exports / imports JSON describing a complete parameter
set:

```json
{
  "species": "Apple",
  "age_days": 1825,
  "parameters": {
    "internode_length": {"distribution": "normal", "mean": 0.04, "stddev": 0.005},
    "insertion_angle": {"distribution": "constant", "value": 45},
    ...
  }
}
```

Treat these as configuration; check them into the same repository as
your analysis code.
