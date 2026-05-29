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

When a point cloud is loaded by path (from Helios XML bulk import or any
auto-attach), parsing happens in the Python backend so files larger than
the browser's ~512 MB string limit still load. This applies to all ASCII
formats above and to `.ply` / `.pcd` (open3d reads ASCII and binary
variants of both). If the source XML provides an `<ASCII_format>` tag
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

Open3D doesn't preserve PLY/PCD scalar fields (intensity, reflectance,
etc.) when loading by path. If you need those fields for a `.ply` /
`.pcd` cloud, drop it into the viewer directly so it goes through the
in-renderer parser, or convert it to `.xyz` with the columns named in
an `<ASCII_format>` tag.

## Meshes

| Format | Import | Export | Notes |
|---|---|---|---|
| `.obj` | ✅ | ✅ | Vertices + faces + normals + vertex colors. |
| `.ply` | ✅ | ✅ | Full fidelity including arbitrary per-vertex scalars. |
| `.stl` | ✅ | ✅ | Triangles only — no color or topology metadata. |

Polygonal faces with more than three vertices are triangulated on
import.

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
