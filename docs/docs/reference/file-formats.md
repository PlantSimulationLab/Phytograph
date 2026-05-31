# File formats

## Point clouds

| Format | Import | Export | Notes |
|---|---|---|---|
| `.las` | ✅ | ✅ | LAS 1.2/1.4. Standard fields only on export (x, y, z, intensity, RGB, classification). |
| `.laz` | ✅ | ✅ | Compressed LAS. Round-trips with `.las`. |
| `.ply` | ✅ | ✅ | Preserves all scalar fields. Best for full-fidelity round-trips. |
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
- Lines starting with `#` are treated as comments.

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
`deviation`. Any other numeric columns are carried through as named
**scalar fields** (color-mappable in the viewer) rather than discarded —
on large octree-streamed clouds they travel into the octree as extra
attributes. Field names come from the file's header row when present
(e.g. `Reflectance[dB]` → `Reflectance [dB]`), else a positional
fallback. The hint is ignored for PLY/PCD because those formats encode
their column layout in-file.

When no `<ASCII_format>` hint is given, Phytograph auto-detects the
layout: a header row's column names are matched to roles where
recognised (so `XYZ[0][m]`/`XYZ[1][m]`/`XYZ[2][m]` map to x/y/z and the
rest become scalar fields), otherwise it falls back to a positional
guess (xyz, then RGB at six columns, then intensity at seven).

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

## Meshes

| Format | Import | Export | Notes |
|---|---|---|---|
| `.obj` | ✅ | ✅ | Vertices + faces + normals + vertex colors. On import, a sibling `.mtl` with `map_Kd` textures (and the images it names, alongside the file) is loaded and applied. |
| `.ply` | ✅ | ✅ | Full fidelity including arbitrary per-vertex scalars. |
| `.stl` | ✅ | ✅ | Triangles only — no color or topology metadata. |

Polygonal faces with more than three vertices are triangulated on
import. Textured `.obj` import reads UV coordinates (`vt`) and per-material
diffuse color (`Kd`) and texture (`map_Kd`); textures are **not** written on
export.

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

For the [Helios Triangulation](../workflows/triangulate.md#helios-triangulation)
workflow and bulk scan import:

| Format | Use | Layout |
|---|---|---|
| Plain text | `ScanName X Y Z` per row | Tab, space, or comma separated |
| Helios XML | Single file with many scan definitions | The format Helios scan simulator uses |

A Helios XML file describes scan *parameters* and references separate point
cloud files — it holds no coordinates itself. Load it through the **Add Scan**
tool's **Import from XML file** action, not by dropping it into the viewer.
Dropping an XML file directly is rejected with a message pointing you to the
right place.

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
