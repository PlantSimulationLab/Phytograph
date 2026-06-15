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

    Dropping a **Helios scan XML** (`.xml`) loads its scans and grids the
    same way the **Add Scan** popup's *Import from XML file* does — see
    [Import scan positions from a real campaign](simulate-scan.md#import-scan-positions-from-a-real-campaign).
    Any point-cloud files the XML references are located relative to the
    XML and stepped through the import wizard. If a referenced data file
    can't be found (moved or renamed), Phytograph warns you by name and
    offers to **Locate…** it — pick the file and the import continues — or
    **Skip** to cancel.

=== "File menu"

    **File → Import** has an entry per format; each opens a file picker
    filtered to that type. Pick one or more files and Phytograph imports
    them as that format:

    - **Auto-detect** (default) — type chosen from extension + contents
      (recognizes `.xml` scan files too)
    - **Point Cloud** — force, e.g., a `.ply` to be read as a cloud
    - **Mesh** — force, e.g., a vertex-only `.obj` to be read as a mesh
    - **Skeleton** — for `.json` skeleton graphs
    - **Scan XML** — for Helios `.xml` scan/grid definitions

    Use a specific format when auto-detection picks the wrong type. As with
    drag-and-drop, point clouds open the [import wizard](#the-import-wizard)
    before loading.

### The import wizard

Every point-cloud import opens an **import wizard** before the cloud is
loaded. It lays the file out like a spreadsheet — one column per column in
the file, with the first rows of real data shown underneath — and a
dropdown at the top of each column for its role. Auto-detection fills the
dropdowns in; you correct anything that's wrong before importing:

- **Column roles** — for ASCII formats (`.xyz`, `.txt`, `.csv`, `.pts`,
  `.asc`), each column's dropdown sets its role: **X / Y / Z**,
  **Red / Green / Blue**, **Intensity**, **Reflectance**,
  **Scan Row Index**, **Scan Column Index**, **Miss Flag**, **Scalar**,
  **Label**, or **Skip**. X, Y, and Z must be assigned before you can import.
- **Scalar vs Label** — a **Scalar** column is a continuous measurement
  (intensity, height, timestamp) and colors as a smooth gradient; a
  **Label** column holds class ids (tree id, segment, classification) and
  colors as discrete classes with a legend. The wizard flags columns whose
  values look like class labels with a one-click *"use Label?"* suggestion.
- **Scan Row / Column Index** — integer positions of each point within the
  scanner's rectangular acquisition grid. Mapping these preserves the scan's
  raster layout, which the gap-filling / miss-reconstruction tools use to
  rebuild missing pulses within the scan pattern. They carry through as
  scalar fields (slugs `row_index` / `column_index`) and auto-detect from
  common headers like `Row` / `Column` / `row_index`.
- **Miss Flag** — a per-pulse 0/1 indicator of whether the laser returned
  nothing (`0` = hit, `1` = sky/miss). Mapping it preserves the scan's miss
  rays, which leaf-area-density inversion needs to measure gap fraction. It
  carries through under the canonical `is_miss` slug (so the color-by **Miss**
  mode and its fixed Hit/Miss legend find it) and auto-detects from headers
  like `is_miss` / `miss` / `sky`. By default the viewer colors it with the
  dedicated **Hit/Miss** scheme. If you instead pick **Scalar** for the column,
  it keeps the `is_miss` slug (LAD still works) but colors as a continuous 0–1
  gradient with a numeric legend — useful when you'd rather see the raw flag
  value than the named classes.
- **RGB range** — when an RGB role is present, choose whether the values are
  **0–255 integers** or **0–1 floats**, so colors import at the right
  brightness.
- **Rename fields** — a column set to **Scalar** or **Label** shows a name
  box under its dropdown; the name you give it is what appears later in the
  color-by picker.
- **Global shift** — scans in a projected coordinate system (UTM, state plane)
  carry very large coordinates — hundreds of thousands to millions of metres
  from the meridian/equator. The wizard offers a **Global shift**: a checkbox
  plus X / Y / Z fields, pre-filled with a suggested offset when the data's
  coordinates are large. Leaving it **on** subtracts the offset at import so the
  stored cloud sits near the origin; the offset is remembered, so **exports
  recover the original world coordinates** automatically. This is the
  CloudCompare-style "global shift" — convenient when you want small, readable
  coordinates. Turning it **off keeps the original large coordinates** — and
  that's perfectly fine to do: the viewer renders large-coordinate scenes
  cleanly either way (see the note below). Z defaults to 0/off, matching the
  common case where only the horizontal coordinates are large.

!!! note "Large coordinates render cleanly with or without a shift"
    The 3D viewport stores positions in 32-bit floats, which lose precision at
    UTM magnitudes (~5 cm at 500,000 m) — historically this made the ground grid
    kink or vanish and QSM/skeleton meshes flicker. The viewer now applies an
    automatic, render-only offset that draws every scene near the origin
    regardless of the stored coordinates' magnitude. It never changes your data,
    exports, or any measurement — so you can **keep large coordinates** and still
    get a clean grid and flicker-free meshes. The global shift above and this
    automatic rendering offset are independent: the shift changes what's
    *stored*; the rendering offset changes only what's *drawn*.

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
the others. So you don't import later scans without reviewing their column
mapping, the **Import** button stays disabled until you've either stepped
through to the last scan with **Next** or ticked **Apply these settings to
all scans**. Each file becomes its own entry in the Scene panel with a
distinct color; nothing is merged automatically. If you want to merge
clouds, use [Stitch](register-compare.md#stitch) after import.

While a large import is in progress a modal shows the file currently being
read and overall progress, so you know the app is working — reading a
multi-GB scan from disk can take 30 seconds or more.

Importing a Helios scan **XML** (which can reference several scans at once)
runs the same wizard, once the referenced point-cloud files are located.

If the XML also contains one or more top-level `<grid>` blocks — the voxel grid
Helios uses for leaf-area-density computation — Phytograph creates a matching
**voxel grid** for each, named `Grid 1`, `Grid 2`, … The grid's `<center>`,
`<size>`, `<Nx>/<Ny>/<Nz>`, and optional `<rotation>` (degrees about z) become
the box's position, size, subdivisions, and rotation, so it's ready to use as
the grid input for [leaf-area-density](estimate-leaf-area-density.md) with no
manual setup. A grid-only XML (no `<scan>`) imports just the grids.

### Importing textured meshes

A `.obj` that references a `.mtl` material library is imported with its
materials applied, as long as the `.mtl` and any image files it names sit in the
same folder as the `.obj`. Phytograph reads the diffuse texture (`map_Kd`) and
diffuse color (`Kd`) for each material: textured faces get the image, and faces
with only a `Kd` color get that color (so a multi-material livery with no
textures imports with each part's color, not flat). An `.obj` with no `.mtl`
(and `.stl`, which has no materials) imports as plain geometry. See
[Meshes: Textures](../concepts/meshes.md#textures). Meshes imported from a file
default to fully opaque.

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

### Scans that bring their own parameters

When a point-cloud file records the scanner's geometry in its header, importing
it on its own auto-fills the scan's **scan parameters** — no need to enter them
by hand. `.e57` brings the scanner origin and orientation, plus the angular
sweep and grid resolution when present; `.pcd` brings a sensor origin from its
`VIEWPOINT` field. Anything the file omits stays at its default. (Loading a
Helios XML still takes precedence — its `<scan>` definitions win.) See
**[Scan parameters recovered from the point-cloud file](../reference/file-formats.md#scan-parameters-recovered-from-the-point-cloud-file)**.

## Export

Select an object in the Scene panel and click the purple **Export** button
in the toolbar (or **File → Export…**) to open the **Export** window. It is
context-sensitive: a point cloud shows the format chooser + column picker, a
mesh or skeleton shows its formats, and any scans in the scene show the scan
export section. You pick the destination in a native file dialog after setting
the options.

### Point cloud formats

Pick a **Format** in the Export window, then click **Export**. For the text
formats (XYZ / TXT / CSV) a **column picker** appears: check which fields to
write (x, y, z, colour, intensity, scalars, labels) and **drag the rows to
reorder** them — the chosen order becomes the file's column order. The binary /
structured formats (LAS / LAZ / PLY / OBJ) use their own fixed schema, so the
column picker is hidden for them.

| Format | Carries |
|---|---|
| `.las` / `.laz` | x, y, z, intensity, color, classification — LAS standard fields only |
| `.ply` | All fields including arbitrary scalars |
| `.xyz` | x, y, z only, with a `#`-prefixed column header line |
| `.txt` | x, y, z plus color / intensity / scalars, with a `#`-prefixed column header |
| `.csv` | Same fields as `.txt` but comma-separated with a plain header row |
| `.obj` | Vertices only (no faces) — useful for piping into other tools |

The `.xyz` and `.txt` exports write a leading `#`-prefixed column header
(the CloudCompare convention, e.g. `# x y z is_miss`). Phytograph's own
importer reads that header to auto-map columns on re-import, and most
ASCII readers (CloudCompare included) skip the `#` line as a comment.

If you need to round-trip with full fidelity, use `.ply` — it preserves
everything Phytograph knows about the cloud.

### Exporting scans

Whenever the scene holds **scans** — clouds that carry scanner parameters
(origin, field of view, beam optics) — the Export window shows a **Scan export**
section. It lists every scan with a checkbox, so you can export one, several,
or all of them at once. The checklist is pre-checked to match the scans
currently selected in the Scans panel, but you can check or uncheck any scan
without changing the viewport selection. The export always writes **one data
file per scan** (named `<base>_<scanID>.<ext>`); you pick the destination
folder in the file dialog after setting the options.

**Output mode** — the two toggles at the top:

- **XML + data** (default) — writes a Helios scan bundle: an `.xml` metadata
  file plus one `.xyz` data file per scan. This bundle is **re-loadable as a
  scan** — re-importing the XML restores the scanner parameters and the
  [sky/miss points](../reference/file-formats.md#skymiss-points), so the
  imported clouds can drive parameter-dependent analyses (leaf area density,
  Helios triangulation) again. It is the round-trip-faithful path for synthetic
  and edited scans.
- **Data only** — writes just the per-scan data files, no XML, and reveals a
  **Format** chooser: `LAS`, `LAZ`, `PLY`, `XYZ`, `CSV`, `TXT`, `OBJ`, or
  `E57`. Use this to round-trip a scan into any supported format for another
  tool.

**Columns** — for the text formats (XYZ / CSV / TXT, and the XML bundle's
`.xyz` data), a column picker lets you check which fields to write and **drag to
reorder** them. `x`, `y`, `z` are required and locked on. Binary / structured
formats (LAS / LAZ / PLY / OBJ / E57) use their own fixed schema, so the column
picker is hidden for them.

**Include miss points** — when on (default), the sky/miss points and the
`is_miss` flag are written, so misses survive the round-trip. Turn it off for a
returns-only export. Available only when at least one checked scan carries
misses.

The per-scan file split is always kept (the XML metadata references each data
file by scan). Edits (crop, translation, filtering) are baked into the exported
coordinates — what you see is what gets written. If the scene holds no scans
with parameters, the section does not appear.

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
