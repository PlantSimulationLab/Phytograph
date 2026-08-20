# Import & export

## Import

Three entry points. All accept the same set of formats — see
**[File formats](../reference/file-formats.md)** for the full list.

!!! tip "RIEGL raw projects"
    A `.riproject` is a *directory* of scan positions, not a file, so it has its
    own path: **[Import a RIEGL raw project](import-riegl-riproject.md)**. Data
    that has already been through RiSCAN PRO or RiPROCESS should be exported to
    LAS/E57 and imported normally.

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
    - **QSM CSV** — for `.csv` cylinder tables (see
      [Importing a QSM](#importing-a-qsm))

    Use a specific format when auto-detection picks the wrong type. As with
    drag-and-drop, point clouds open the [import wizard](#the-import-wizard)
    before loading.

=== "Open with Phytograph"

    Phytograph registers itself with the operating system as a handler for
    every importable format, so you can start from your file manager instead
    of from the app:

    - **macOS** — right-click the file in Finder → **Open With → Phytograph**
      (or set Phytograph as the default for that type via **Get Info**).
    - **Windows** — right-click → **Open with → Phytograph** (or
      double-click once Phytograph is the default for the extension).
    - **Linux** — right-click → **Open With** → Phytograph in file managers
      that honour the desktop entry.

    The file is **auto-detected** by extension (the same as drag-and-drop), so
    point clouds open the [import wizard](#the-import-wizard) and meshes,
    skeletons, and Helios scan XML each load as their type. Opening several
    files at once steps through them in the wizard.

    If Phytograph is **already open**, the file imports into the **current
    scene** — it does not launch a second copy of the app. On a cold launch the
    file is imported as soon as the app and its compute backend finish starting
    up.

### The import wizard

Every point-cloud import opens an **import wizard** before the cloud is
loaded. It lays the file out like a spreadsheet — one column per column in
the file, with the first rows of real data shown underneath — and a
dropdown at the top of each column for its role. Auto-detection fills the
dropdowns in; you correct anything that's wrong before importing:

- **Column roles** — each column's dropdown sets its role: **X / Y / Z**,
  **Red / Green / Blue**, **Intensity**, **Reflectance**,
  **Timestamp**, **Target Index**, **Target Count**,
  **Scan Row Index**, **Scan Column Index**, **Miss Flag**,
  **Beam Origin X / Y / Z**, **Scalar**, **Label**, or **Skip**. X, Y, and Z
  must be assigned before you can import. Every role except **Scalar**,
  **Label**, and **Skip** is a *singleton* — a cloud has exactly one of each —
  so assigning one to a column removes it from whichever column previously held
  it (that column drops to **Skip**).

    For ASCII formats (`.xyz`, `.txt`, `.csv`, `.pts`, `.asc`) every column is
    freely assignable, including X / Y / Z.

    For formats that carry named scalar fields (`.las`, `.laz`, `.riproject`)
    the **geometry** columns are fixed by the file, but the scalar fields can be
    reassigned. This matters because a scalar's name is whatever the exporting
    software chose: Phytograph recognises the common spellings — `gps_time`,
    `GpsTime`, `time` and `Timestamp[s]` all resolve to **Timestamp** — but it
    cannot know that a column called `shot_time` is the same thing. Set its
    dropdown to **Timestamp** and the tools that need one (Backfill Misses,
    leaf-area density, multi-return grouping) will find it.

    Reassigning a role only changes how Phytograph reads the column. Your
    source file is never modified.
- **Import (skip a column)** — every column except X / Y / Z carries an
  **Import** checkbox above its role dropdown. Untick it to leave that field
  out: its preview values grey out, and the column is never read. A skipped
  field is not stored in the cloud, doesn't appear in the Display panel's
  *Color by* list, and can't be exported — so unticking the columns you don't
  need keeps a cloud smaller and its field list shorter. X, Y, and Z have no
  checkbox because a cloud can't be imported without them.

    The checkbox works for **every** format, including the ones whose roles
    are fixed (`.ply`, `.pcd`, `.e57`, `.ptx`). For ASCII files it is the same
    thing as choosing the **Skip** role (the two controls stay in sync).

    Unticking a field that other tools read — **Miss Flag**, the scan grid
    indices, or the multi-return trio — shows an inline warning naming what
    stops working (leaf-area density, gap filling, the Hit/Miss coloring).
    It's still allowed: an all-zero miss flag on a hits-only export is exactly
    the kind of dead weight worth dropping.
- **Scalar vs Label** — a **Scalar** column is a continuous measurement
  (intensity, height, timestamp) and colors as a smooth gradient; a
  **Label** column holds class ids (tree id, segment, classification) and
  colors as discrete classes with a legend. The wizard flags columns whose
  values look like class labels with a one-click *"use Label?"* suggestion.
- **Timestamp / Target Index / Target Count** — the per-pulse multi-return
  fields: each return's acquisition time, its index within its laser pulse
  (1st / 2nd / … return), and the pulse's total return count. Mapping all three
  lets the gap-filling / miss-reconstruction and leaf-area-density tools group
  returns back into their originating pulses. LAS/LAZ files fill these in
  automatically (from `gps_time` / `return_number` / `number_of_returns`); for
  ASCII they auto-detect from headers like `Timestamp` / `Target Index` /
  `Target Count` (and aliases such as `gps_time`, `return_number`,
  `number_of_returns`). If a column is unlabeled or named something the
  auto-detect doesn't recognize, pick the matching role from its dropdown — you
  no longer have to map it as **Scalar** and type the exact field name. They
  carry through under the canonical `timestamp` / `target_index` / `target_count`
  slugs the tools look them up by.
- **Scan Row / Column Index** — integer positions of each point within the
  scanner's rectangular acquisition grid. Mapping these preserves the scan's
  raster layout, which the gap-filling / miss-reconstruction tools use to
  rebuild missing pulses within the scan pattern. They carry through as
  scalar fields (slugs `row_index` / `column_index`) and auto-detect from
  common headers like `Row` / `Column` / `row_index`. With no header, up to two
  leading **all-integer** columns sitting before the (fractional) coordinates
  are recognized as the row/column index pair, so a `row col x y z …` scanner
  export lands xyz on the right columns instead of mistaking the indices for
  coordinates.
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

    !!! tip "Misses are auto-detected even without a Miss Flag column"
        A Helios synthetic scan exported to plain ASCII often *drops* the
        `is_miss` column but keeps a **Target Index** column, where misses carry
        the sentinel value `99`. On import, Phytograph recovers the miss flag
        from that sentinel — so the misses appear under the row's **sky/miss**
        toggle, stay out of the displayed cloud's bounding box, and feed
        leaf-area-density — with nothing to configure. If the scan has no
        target-index column either, a distance fallback tags points farther than
        the **Miss detection distance** setting (default 1001 m, the Helios
        placeholder distance) from the scanner. An explicit `is_miss` column
        always takes precedence over auto-detection.
- **Beam Origin X / Y / Z** — the per-pulse laser emission point (the scanner's
  position for each return), in the same coordinate frame as X/Y/Z. Mapping all
  three makes the cloud carry **ground-truth origins** that leaf-area-density
  inversion uses directly — measuring each ray's true path through the canopy
  without needing a separate scanner trajectory. This is the ASCII equivalent of
  the `ox`/`oy`/`oz` origin columns a LAS file can carry; they auto-detect from
  headers like `ox` / `oy` / `oz`, `xorigin` / `yorigin` / `zorigin`, or
  `beamoriginx` / `…y` / `…z`. Origins are kept at full coordinate precision (not
  the millimeter display quantization), so projected/UTM-scale origins survive
  exactly. Map all three for them to take effect; a partial pair is ignored.
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

- **Platform trajectory** — for **mobile-platform** data (drone, robot,
  backpack, or vehicle MLS), click **Import trajectory file…** to attach the
  platform's trajectory to the scan. The imported cloud then becomes a
  moving-platform acquisition: leaf-area density reconstructs a per-beam origin
  for every return by joining the return's timestamp to the trajectory, instead
  of assuming one fixed scanner position. All trajectory formats Phytograph reads
  are accepted — text **CSV / TXT / TSV / .traj** (`t x y z` plus a quaternion or
  Euler attitude) and binary **SBET** (`.sbet` / `.out`, parsed server-side). The
  wizard shows the pose count and duration once it's attached; **Replace…** swaps
  it and the **✕** removes it. Leave it empty for a static tripod scan. When you
  import several files at once, attaching a trajectory to one scan **fills in the
  others by default** (the common case is one platform pass split across files) —
  but you can give any scan its own trajectory, and an explicit per-scan choice is
  never overwritten by the default.

For `.ply`, `.pcd`, `.las`, `.laz` and `.ptx`, the column layout is defined
inside the file, so X/Y/Z and color roles can't be reassigned — but you can still
preview the fields, rename scalars, and switch any scalar between **Scalar**
and **Label**. For `.las`, `.laz` and `.riproject` you can additionally assign a
scalar its true role (see *Column roles* above), which is how you tell Phytograph
that a field named something it doesn't recognise is really the timestamp,
reflectance, or a multi-return column. `.e57` is the one format with no sample rows: reading values out
of it means decoding its binary point data, so the wizard shows the structure
only.

(A LAS/LAZ or ASCII cloud that already carries per-pulse beam-origin columns —
`ox`/`oy`/`oz` — needs no trajectory: those ground-truth origins are used
directly. The trajectory button is for mobile data whose origins must be
reconstructed from the platform path.)

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
multi-GB scan from disk can take 30 seconds or more. The bar tracks the
stage the import has reached (reading the source file, loading points into
memory, building the octree), so it keeps moving even on a single file.

**Cancel** stops the import. This genuinely halts the work — the app tells
the backend to abandon the run and frees the memory it had allocated,
rather than just hiding the dialog and letting the import finish out of
sight. Use it if you picked the wrong file or an import is taking longer
than you're willing to wait.

When you cancel part-way through a **multi-file** import, the scans that
already finished are kept (they're complete and correct); a notice tells you
how many of the selected files made it. Cancelling a Helios scan **XML**
import is all-or-nothing, matching how that pathway already treats a failed
scan — nothing from the bundle is added.

Importing a Helios scan **XML** (which can reference several scans at once)
runs the same wizard, once the referenced point-cloud files are located.

If the XML also contains one or more top-level `<grid>` blocks — the voxel grid
Helios uses for leaf-area-density computation — Phytograph creates a matching
**voxel grid** for each, named `Grid 1`, `Grid 2`, … The grid's `<center>`,
`<size>`, `<Nx>/<Ny>/<Nz>`, and optional `<rotation>` (degrees about z) become
the box's position, size, subdivisions, and rotation, so it's ready to use as
the grid input for [leaf-area-density](estimate-leaf-area-density.md) with no
manual setup. A grid-only XML (no `<scan>`) imports just the grids.

A grid that was **snapped to the ground** before export carries its per-column
terrain offsets in the XML (`<columnOffsets>`/`<keptColumns>` — see the
[file-format reference](../reference/file-formats.md#scan-position-files)), so it
re-imports already snapped, bending to follow the same terrain, without needing
the DEM in the scene. Likewise, a scan's chosen **scanner model** round-trips via
a `<scannerModel>` tag, so a re-imported RIEGL/Leica/FARO/etc. scan keeps its
instrument identity rather than reverting to generic.

A scan's **return mode** also round-trips, via `<returnMode>` (plus
`<returnSelection>` for single-return or `<maxReturns>` for multi-return) tags.
Helios scan XML has no native field for return mode, and it can't be inferred
from the exported columns, so Phytograph writes it explicitly. If you import an
older XML (or one not exported by Phytograph) that lacks these tags, the scan
loads as single-return and a warning tells you to set the mode in the scan's
parameters before scanning or running LAD — it never silently guesses.

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

An `.stl` is imported as a mesh in either encoding — ASCII or binary, detected
from the file's own contents, so binary files written by Blender, MeshLab, CAD
tools and slicers import directly. Binary STL has an unstandardized per-facet
color field that different tools write incompatibly; Phytograph reads it only
for facets that set the field's "color valid" bit, and leaves the mesh
untinted when no facet does. STL is always **exported** as ASCII.

### Importing ASCII clouds with custom columns

For `.xyz`, `.txt`, and `.csv` files, auto-detection maps columns by header
name when one is present. Without a header it falls back to position: the
coordinates are the first three columns (or, if up to two **all-integer**
columns lead the fractional coordinates, the row/column scan indices come
first and xyz follow); a 0–255 integer triple right after xyz is taken as
**RGB**; and a lone trailing column as **intensity**. Anything else is stored
as a **scalar field** named after the column header (or `Column N` if there's
no header). The [import wizard](#the-import-wizard) is where you correct that
mapping when the file uses a non-standard column order, RGB stored as 0–1
floats, or a class column that should be categorical. You can color the cloud
by any scalar field later — see **[Color modes](../reference/color-modes.md)**.

### Importing a QSM

A QSM cylinder CSV — one Phytograph exported, or one from another
SimpleForest/TreeQSM-family tool — can be imported back as a QSM. It appears in
the QSM results panel exactly as a freshly built one does, with its shoots and
ranks intact, so you can color it by **Shoot rank** or **Shoot id**, add leaves,
or re-export it.

**Export a QSM to CSV and re-import it and you get the same model back** — same
cylinders, same shoot topology, and the same trunk diameter, height, woody
volume, and max rank in the results panel. The whole-tree metrics aren't columns
in the file; they're recomputed from the cylinders when you import.

`.csv` is shared with point clouds, so Phytograph looks at the header row to
tell them apart: a cylinder table has `branchID` and `branchOrder` columns,
which no point-cloud CSV does. Drag-and-drop and **Open With** route on that
automatically. Use **File → Import → QSM CSV…** to skip the check and force a
file to be read as a QSM — useful for an unusual dialect whose header isn't
recognized.

An imported QSM has no source point cloud, so it's listed under the file's name
rather than a scan's, and its coordinates are used exactly as they appear in the
file. See
[File formats: QSM cylinder CSV](../reference/file-formats.md#qsm-cylinder-csv)
for the columns and the requirements on a hand-edited file.

### Importing scans with sky/miss points

`.e57`, `.ptx` and structured `.ply` scans — and a re-imported Helios **scan XML
bundle**, which carries the scanner `<origin>` and an `is_miss` column — bring
**sky/miss points** — pulses that hit the sky and returned nothing — which the
[leaf-area-density inversion](../concepts/leaf-area-density.md) relies on.
Phytograph recovers and tags them on import. They're hidden by default (their
true positions are ~20 km away); toggle the **Show misses** button on a scan row
to draw them in a distinct colour, relocated onto the scan's bounding sphere, so
you can confirm a scan actually carries miss information. The relocation needs a
scanner origin — supplied by the E57/PTX/PLY pose or the XML bundle's
`<origin>`; a bare ASCII cloud with no scanner geometry shows its misses at their
true far-field position instead. See
**[Sky/miss points](../reference/file-formats.md#skymiss-points)**.

### Scans that bring their own parameters

When a point-cloud file records the scanner's geometry in its header, importing
it on its own auto-fills the scan's **scan parameters** — no need to enter them
by hand. A file holding several scanner setups (a multi-block `.ptx`, a
multi-scan `.e57`) imports as **one scan per setup**, each with its own pose and
grid — see
**[Files holding several scan positions](../reference/file-formats.md#files-holding-several-scan-positions)**.
`.e57` brings the scanner origin and orientation, plus the angular
sweep and grid resolution when present; `.ptx` brings the registered scanner
position and the grid resolution from its header, and its angular sweep is
measured back off the scan grid; `.pcd` brings a sensor origin from its
`VIEWPOINT` field. Anything the file omits stays at its default. (Loading a
Helios XML still takes precedence — its `<scan>` definitions win.) See
**[Scan parameters recovered from the point-cloud file](../reference/file-formats.md#scan-parameters-recovered-from-the-point-cloud-file)**.

## Export

Choose **File → Export…** (<kbd>⌘/Ctrl</kbd>+<kbd>S</kbd>), or
run *Export* from the command palette, to open the **Export** window.

It opens on an **object list** holding *every* point cloud in the scene, each
with a checkbox. Whatever you had selected in the Scans panel starts checked —
but that is only a starting point, and checking or unchecking a row here never
changes the viewport selection. What you check then decides the rest of the
window: a single plain cloud shows the format chooser + column picker for that
one file, while several objects (or any scan) show the batch controls described
under [Exporting several objects](#exporting-several-objects). A selected mesh
or skeleton shows its own formats instead. Once the options are set you pick the
destination in a native dialog: a **file** for the exports that write exactly one
(a single plain cloud, a mesh, a skeleton), a **folder** for the batch export,
which writes one file per object.

### Point cloud formats

Pick a **Format** in the Export window, then click **Export**. Every format
except OBJ shows a **field picker**: check which fields to write (x, y, z, colour,
intensity, scalars, labels). Everything is checked by default, so a plain export
stays lossless and you prune from there. The picker lists **every field the cloud
actually holds** — including scalars that came from a LAS extra dimension or an
import-wizard column, and the class labels a segmentation added.

For XYZ / TXT / CSV / PLY you can also **drag the rows to reorder** them; the
chosen order becomes the file's column order. **LAS / LAZ** identify their
dimensions by name rather than by position, so order doesn't apply there and the
drag handle is omitted.

**OBJ** stores vertex coordinates only and cannot carry colour or scalars at all,
so it has no picker.

!!! note "What LAS/LAZ cannot leave out"

    Each scalar becomes a named LAS *extra dimension*, so any scalar can be
    unchecked. Two standard dimensions are different:

    - **X/Y/Z** are the point record itself.
    - **Intensity** is present in every LAS point format, so it cannot be
      removed — unchecking it could only write zeros. Both are shown locked.

    Unchecking **colour** is a real omission: it selects LAS point format 1,
    which has no RGB dimension. (Because the point format is a fixed menu rather
    than a free choice of dimensions, dropping RGB also drops GPS time.)

| Format | Carries |
|---|---|
| `.las` / `.laz` | x, y, z, intensity, colour, plus the scalars you select as **named LAS extra dimensions** |
| `.ply` | The columns you select, each declared as a named `property` |
| `.xyz` | The columns you select, whitespace-separated, with no header line |
| `.txt` | The columns you select, whitespace-separated, with a `#`-prefixed column header |
| `.csv` | Same columns as `.txt` but comma-separated with a plain header row |
| `.obj` | Vertices only (no faces) — geometry cannot carry scalars in OBJ |

The `.txt` export writes a leading `#`-prefixed column header (the CloudCompare
convention, e.g. `# X Y Z is_miss`). Phytograph's own importer reads that header
to auto-map columns on re-import, and most ASCII readers (CloudCompare included)
skip the `#` line as a comment. Bare `.xyz` carries no header, so its extra
columns are positional — use `.txt` or `.csv` when you want the field names
preserved.

For a full-fidelity round trip, use `.las` / `.laz` or `.ply`. LAS/LAZ writes
each scalar as a named extra dimension, so re-importing the file restores the
same named fields (and is far smaller and faster than text for a large cloud).

!!! note "Scalar fields are no longer dropped"

    Before v0.65.0 the text exports wrote only x/y/z (plus colour and intensity
    for `.txt`/`.csv`) and LAS/LAZ wrote only x/y/z and colour — every other
    field was silently lost, and the column picker offered only x/y/z for a
    normally-imported cloud. If you have exports from an earlier version that
    are missing their scalars, re-export them.

After you click **Export**, a save dialog asks where to write the file. Once you
confirm the destination the Export window closes and a **progress pill** appears
at the top of the viewer, showing a live percentage as the cloud is written (a
25-million-point text export takes roughly half a minute). The pill has a
**cancel** button — stopping an export leaves no partial file behind. When the
write finishes the pill clears and a toast reports the file name and point
count, so there's no need to click Export twice. Cancelling the save dialog
writes nothing and reports nothing.

The pill names the stage it is on. For the text formats that is mostly
*Formatting*, which is where nearly all their time goes; `.las`/`.laz` step
through *Computing bounds*, *Packing coordinates*, *Packing colours*, *Packing
intensity*, *Packing scalar fields* and *Writing file* instead (the packing
stages appear only for the fields the cloud actually has). Binary formats are
several times faster than text for the same cloud, so their pill moves through
those stages quickly.

### Exporting several objects

Check more than one object in the list — or any single **scan** (a cloud
carrying scanner parameters: origin, field of view, beam optics) — and the
window switches to **Export objects**, which writes **one data file per checked
object**.

Because that is many files from one name, this export does not ask for a file
name in a Save dialog. You type a **Base name** in the window and the button
asks only for a destination **folder** — and above the button the window lists
the files it is about to write, so nothing is a surprise:

```
Base name  [ myscan ]

Will write 3 files:
  myscan_ScanPos002.laz
  myscan_ScanPos001.laz
  myscan_ScanPos014.laz
```

Each file is named for the object it holds, so the exported set maps back to the
Scans panel rather than to the order the scans were added. Characters a file
system won't take (spaces, slashes, `:` and friends) become underscores, and two
objects sharing a name get a `_2`, `_3` … suffix. Exporting a **single** object
is the exception — it is written under the base name alone, with nothing
appended. An **XML + data** bundle also writes `<base>.xml` next to its per-scan
data files.

The list holds every cloud in the scene, scans and plain imports alike, with a
**Select all** checkbox above it and a count of how many of them are checked.
Plain clouds (a `.xyz` / `.las` / `.ply` import with no scanner metadata) can be
written to any of the data formats, so exporting a whole folder's worth of
clouds in one pass is a single check-all and click.

Two outputs *do* need scan geometry, and the rows they can't write grey out with
the reason on hover rather than vanishing:

- the **XML + data** bundle needs a scanner origin and angular sweep, so it is
  offered only when something checked is a scan;
- **PTX** needs a complete raster grid, so it skips plain clouds and non-raster
  patterns (a Livox rosette has no `Ntheta × Nphi` grid).

**Select all** only ever checks the rows the current output can actually write,
and switching between outputs is non-destructive — a cloud greyed out by XML
mode is still checked when you switch back to **Data only**.

**Output mode** — the two toggles at the top:

- **XML + data** (default) — writes a Helios scan bundle: an `.xml` metadata
  file plus one `.xyz` data file per scan. This bundle is **re-loadable as a
  scan** — re-importing the XML restores the scanner parameters and the
  [sky/miss points](../reference/file-formats.md#skymiss-points), so the
  imported clouds can drive parameter-dependent analyses (leaf area density,
  Helios triangulation) again. It is the round-trip-faithful path for synthetic
  and edited scans.
- **Data only** — writes just the per-scan data files, no XML, and reveals a
  **Format** chooser: `LAS`, `LAZ`, `PLY`, `XYZ`, `CSV`, `TXT`, `OBJ`, `E57`, or
  `PTX`. Use this to round-trip a scan into any supported format for another
  tool.

!!! note "Exporting to PTX"
    PTX is a *complete raster*: it writes one line per grid cell, so the file
    always has `Ntheta x Nphi` data rows and a cell with no return is recorded as
    an all-zero row. That completeness is what lets a PTX be re-imported with its
    sky/miss points recovered. Two consequences: the scan needs a grid — either
    real row/column indices (from an E57/PTX import) or a raster scan's
    **Ntheta x Nphi** resolution — and a non-raster pattern (Risley/Livox) can't be
    exported to PTX at all. **Include miss points** has no effect on a PTX,
    because an excluded miss is written as the same empty cell. Points are written
    in the scanner's local frame with the registered scanner position in the
    header, so the file opens in the right place in Cyclone or CloudCompare.

**Columns** — for the text formats (XYZ / CSV / TXT, and the XML bundle's
`.xyz` data), a column picker lets you check which fields to write and **drag to
reorder** them. `x`, `y`, `z` are required and locked on. Binary / structured
formats (LAS / LAZ / PLY / OBJ / E57 / PTX) use their own fixed schema, so the
column picker is hidden for them.

**Include miss points** — when on (default), the sky/miss points and the
`is_miss` flag are written, so misses survive the round-trip. The `is_miss`
column is always included while this is on, even if you unchecked it in the
column picker — without that flag the far-field miss points would re-import as
real returns, breaking the round-trip. Turn it off for a returns-only export.
Available only when at least one checked scan carries misses.

**Export grid** — shown only in **XML + data** mode when the scene holds one or
more [voxel grids](../concepts/scans.md). Tick it to reveal a checklist of the
scene's grids; each grid you check is written into the bundle's `.xml` as a
top-level `<grid>` block (its center, size, `Nx`/`Ny`/`Nz` subdivisions, and
z-rotation). This closes the round-trip for a file like Helios' `sphere.xml` —
import it (the `<grid>` becomes a voxel box), then re-export with the grid
ticked and the saved XML carries the grid back out, ready to drive
[leaf-area-density](estimate-leaf-area-density.md) or Helios triangulation
again. Leaving the box unticked (or checking it but adding no grids) writes no
`<grid>` blocks.

The per-object file split is always kept (in XML mode the metadata references
each data file by scan). Edits (crop, translation, filtering) are baked into the
exported coordinates — what you see is what gets written.

After you choose a save location the export dialog closes and a **progress pill**
appears at the top of the viewer, showing a live percentage as each object is
written — it names the object it is on (*Writing plot_A (2/5)*), and the objects
are weighted by point count, so a batch holding one big cloud and three small
ones doesn't jump to 75% and stall. The pill has a **cancel** button; stopping a
batch removes the files it had already written, so you never find half a bundle
in the destination folder. In **XML + data** mode the bar advances per scan while
the scans are loaded, then parks on *Writing Helios scan bundle* for the single
write that produces the files. The pill clears and a toast confirms the file
count when the write finishes — there's no need to click Export twice.

### Mesh formats

Click a format and pick the destination in the save dialog; the file is written
when you confirm, and a toast reports what was saved.

| Format | Carries |
|---|---|
| `.obj` | Vertices, faces, normals, UVs and materials (see below) |
| `.ply` | Vertices, faces and per-vertex color |
| `.stl` | Triangles only (no color or topology metadata) |

A textured mesh — a generated plant, or an OBJ you imported with its materials —
exports to `.obj` as a **bundle**: the `.obj`, a `.mtl` material library, and one
image per textured material, all written together in the folder you chose. That
is what lets the model round-trip: re-importing the `.obj` picks the `.mtl` and
its images back up and the plant comes back textured. Move the three together;
an `.obj` on its own re-imports as plain grey geometry.

Organs with no texture (petioles, internodes, stems) keep their color too — they
are grouped by color into materials in the same `.mtl`, since OBJ has no portable
per-vertex color. A mesh with only vertex colors and no textures therefore still
exports an `.obj` + `.mtl` pair; one with no color information at all exports as
a single `.obj`.

Generated plants also write their Helios structure XML (`<name>_helios.xml`)
beside the mesh.

### Skeleton formats

| Format | Carries |
|---|---|
| `.json` | Full graph: nodes, edges, branch orders, per-node attributes |
| `.obj` | Line segments only — suitable for visualization in other tools |

Use `.json` if you want to do further analysis programmatically. Use
`.obj` if you want a quick visualization in Blender or MeshLab.

As with the other object types, clicking a format opens a save dialog; the file
is written where you choose and a toast confirms it.

## What's next

- **[Viewer navigation](viewer-navigation.md)** — get comfortable moving the camera.
- **[Clean a point cloud](clean-point-cloud.md)** — once your scan is loaded.
