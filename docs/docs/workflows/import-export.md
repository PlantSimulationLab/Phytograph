# Import & export

## Import

Two entry points. Both accept the same set of formats — see
**[File formats](../reference/file-formats.md)** for the full list.

=== "Drag and drop"

    Drag any supported file from your file manager anywhere onto the
    Phytograph window. Format is auto-detected from the extension and,
    for ambiguous formats like `.ply` and `.obj` (which can be either
    mesh or point cloud), from the file contents. Point clouds open the
    [import wizard](#the-import-wizard) so you can confirm or adjust the
    column mapping before loading.

=== "Import button"

    The **Import** button in the toolbar opens a file picker. The
    chevron next to it opens a dropdown for forcing a specific format:

    - **Auto-detect** (default)
    - **Point Cloud** — force, e.g., a `.ply` to be read as a cloud
    - **Mesh** — force, e.g., a vertex-only `.obj` to be read as a mesh
    - **Skeleton** — for `.json` skeleton graphs

    Use this when auto-detection picks the wrong type.

### The import wizard

Every point-cloud import opens an **import wizard** before the cloud is
loaded. It lays the file out like a spreadsheet — one column per column in
the file, with the first rows of real data shown underneath — and a
dropdown at the top of each column for its role. Auto-detection fills the
dropdowns in; you correct anything that's wrong before importing:

- **Column roles** — for ASCII formats (`.xyz`, `.txt`, `.csv`, `.pts`,
  `.asc`), each column's dropdown sets its role: **X / Y / Z**,
  **Red / Green / Blue**, **Intensity**, **Reflectance**, **Scalar**,
  **Label**, or **Skip**. X, Y, and Z must be assigned before you can import.
- **Scalar vs Label** — a **Scalar** column is a continuous measurement
  (intensity, height, timestamp) and colors as a smooth gradient; a
  **Label** column holds class ids (tree id, segment, classification) and
  colors as discrete classes with a legend. The wizard flags columns whose
  values look like class labels with a one-click *"use Label?"* suggestion.
- **RGB range** — when an RGB role is present, choose whether the values are
  **0–255 integers** or **0–1 floats**, so colors import at the right
  brightness.
- **Rename fields** — a column set to **Scalar** or **Label** shows a name
  box under its dropdown; the name you give it is what appears later in the
  color-by picker.

For `.ply`, `.pcd`, `.las`, and `.laz`, the column layout is defined inside
the file, so X/Y/Z and color roles can't be reassigned — but you can still
preview the fields, rename scalars, and switch any scalar between **Scalar**
and **Label**.

If a file can't be previewed, the wizard says so and still lets you import
with auto-detection.

### Importing several files at once

Drop multiple files together, or select several at once from the
**Import** menu. The wizard **steps through each scan** — use **Back** /
**Next** to move between them, and tick **Apply these settings to all
scans with the same column layout** to copy one scan's column mapping onto
the others. Each file becomes its own entry in the Scene panel with a
distinct color; nothing is merged automatically. If you want to merge
clouds, use [Stitch](register-compare.md#stitch) after import.

While a large import is in progress a modal shows the file currently being
read and overall progress, so you know the app is working — reading a
multi-GB scan from disk can take 30 seconds or more.

Importing a Helios scan **XML** (which can reference several scans at once)
runs the same wizard, once the referenced point-cloud files are located.

### Importing textured meshes

A `.obj` that references a `.mtl` material library is imported with its image
textures applied, as long as the `.mtl` and the image files it names sit in the
same folder as the `.obj`. Phytograph reads the diffuse texture (`map_Kd`) and
diffuse color (`Kd`) for each material; faces with no image fall back to that
material's color. Untextured `.obj` files (and `.stl`) import as plain geometry
as before. See [Meshes: Textures](../concepts/meshes.md#textures).

A `.ply` is imported as a mesh when its header declares faces (otherwise it
imports as a point cloud — see
[File formats: PLY](../reference/file-formats.md#ply-point-cloud-or-mesh)).
Both ASCII and binary PLY meshes are read, including per-vertex color; PLY
meshes carry no textures.

### Importing ASCII clouds with custom columns

For `.xyz`, `.txt`, and `.csv` files, auto-detection treats the first three
columns as x, y, z and stores additional columns as **scalar fields** named
after the column header (or `Column N` if there's no header). The
[import wizard](#the-import-wizard) is where you correct that mapping when
the file uses a non-standard column order, RGB stored as 0–1 floats, or a
class column that should be categorical. You can color the cloud by any
scalar field later — see **[Color modes](../reference/color-modes.md)**.

### Importing scans with sky/miss points

`.e57` and structured `.ply` scans carry **sky/miss points** — pulses that hit
the sky and returned nothing — which the
[leaf-area-density inversion](../concepts/leaf-area-density.md) relies on.
Phytograph recovers and tags them on import. They're hidden by default (their
true positions are ~20 km away); toggle the **Show misses** button on a scan row
to draw them in a distinct colour, relocated onto the scan's bounding sphere, so
you can confirm a scan actually carries miss information. See
**[Sky/miss points](../reference/file-formats.md#skymiss-points)**.

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
