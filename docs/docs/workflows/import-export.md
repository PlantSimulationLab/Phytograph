# Import & export

## Import

Three entry points. All three accept the same set of formats — see
**[File formats](../reference/file-formats.md)** for the full list.

=== "Drag and drop"

    Drag any supported file from your file manager onto the Home tab's
    drop zone or directly onto the Viewer canvas. Format is auto-detected
    from the extension and, for ambiguous formats like `.ply` and `.obj`
    (which can be either mesh or point cloud), from the file contents.

=== "Import button"

    The **Import** button in the toolbar opens a file picker. The
    chevron next to it opens a dropdown for forcing a specific format:

    - **Auto-detect** (default)
    - **Point Cloud** — force, e.g., a `.ply` to be read as a cloud
    - **Mesh** — force, e.g., a vertex-only `.obj` to be read as a mesh
    - **Skeleton** — for `.json` skeleton graphs

    Use this when auto-detection picks the wrong type.

=== "Recent files"

    The Home tab keeps a list of recently imported files. Click any to
    re-import it. The list is per-machine and persists across launches.

### Importing several files at once

Drop multiple files together — Phytograph imports them in order and
assigns each a distinct color. Each becomes its own entry in the Scene
panel; nothing is merged automatically. If you want to merge clouds, use
[Stitch](register-compare.md#stitch) after import.

### Importing ASCII clouds with custom columns

For `.xyz`, `.txt`, and `.csv` files, the first three columns are
treated as x, y, z. Additional columns are stored as **scalar fields**
named after the column header (or `field_0`, `field_1`, … if no header).
You can color the cloud by any of these later — see
**[Color modes](../reference/color-modes.md)**.

## Export

Each kind of scene object exports independently. Select the object in
the Scene panel and click the purple **Export** button in the toolbar
(or use the per-entry export action).

### Point cloud formats

| Format | Carries |
|---|---|
| `.las` / `.laz` | x, y, z, intensity, color, classification — LAS standard fields only |
| `.ply` | All fields including arbitrary scalars |
| `.xyz` / `.txt` | x, y, z, plus selected scalars as additional columns |
| `.csv` | Same as `.xyz` but with comma separators and a header row |
| `.obj` | Vertices only (no faces) — useful for piping into other tools |

If you need to round-trip with full fidelity, use `.ply` — it preserves
everything Phytograph knows about the cloud.

### Mesh formats

| Format | Carries |
|---|---|
| `.obj` | Vertices, faces, normals, vertex colors |
| `.ply` | Same as `.obj` plus arbitrary per-vertex scalars |
| `.stl` | Triangles only (no color or topology metadata) |

### Skeleton formats

| Format | Carries |
|---|---|
| `.json` | Full graph: nodes, edges, branch orders, per-node attributes |
| `.obj` | Line segments only — suitable for visualization in other tools |

Use `.json` if you want to do further analysis programmatically. Use
`.obj` if you want a quick visualization in Blender or MeshLab.

## What's next

- **[Viewer navigation](viewer-navigation.md)** — get comfortable moving the camera.
- **[Clean a point cloud](clean-point-cloud.md)** — once your scan is loaded.
