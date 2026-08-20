# Fit a crown & metrics

Fit a simple geometric **shape to a tree's crown** and read off per-tree
metrics — **tree height, crown volume, crown center, and crown
dimensions**. Each fitted crown becomes a mesh in the scene with its
statistics attached, and you can export every crown to a CSV table (one
row per crown) that records the shape's **fit parameters**, not just its
statistics.

Fitting is done **per scan**, and — for a cloud that carries tree labels
— **per tree** within a scan. You can select several scans at once and
fit them all in one run.

## Inputs

Each scan you fit must be a **segmented individual tree with the ground
handled**. Phytograph reads the classification labels the segmentation
tools write and adapts the fit to what's present:

| Step | Label | Effect on the fit |
|------|-------|-------------------|
| [Segment ground points](segment-ground.md) | `ground_class` | Ground points are excluded and give the height baseline. |
| [Separate leaf and wood](segment-wood.md) | `wood_class` | The crown is fit to the **leaf** points only (trunk/branches excluded). |
| [Segment individual trees](segment-trees.md) | `tree_instance` | One crown is fit **per tree** in the cloud. |

!!! warning "Missing labels are ambiguous — you'll be warned"
    If a scan has **no** ground / tree / wood labels, Phytograph can't
    tell whether you segmented that step manually (removed the ground,
    split one tree per cloud) or simply forgot to run it. So a missing
    label raises a **warning in the setup modal** rather than silently
    proceeding or blocking you:

    - **No tree labels** → the fit assumes the cloud is a single,
      manually-segmented tree. If it actually holds several trees or
      unsegmented data, [segment the trees](segment-trees.md) first (or
      split them into separate clouds).
    - **No ground labels** → tree height is measured from the tree's
      **lowest point** as the ground baseline. Make sure the ground was
      removed / the base sits at ground level, or
      [segment the ground](segment-ground.md).
    - **No leaf/wood labels** → the crown includes trunk and branch
      points. [Separate leaf and wood](segment-wood.md) for a leaf-only
      crown.

    A scan is only *disabled* in the picker when it's structurally
    unusable (too few points, or no backing data).

## Run the fit

1. Select one or more scans, then open **Tools → Fit Crown & Metrics**
   (or press <kbd>Cmd/Ctrl</kbd>+<kbd>K</kbd> and search "crown").
2. **Choose the scans** to fit. Ineligible scans are greyed out with a
   reason; scans missing labels show a warning banner but stay fittable.
3. **Pick a crown shape:**

    | Shape | Best for |
    |-------|----------|
    | **Ellipsoid** | Rounded, broadleaf crowns (a good default). |
    | **Rectangular prism** | Reporting width × depth × height directly. |
    | **Cone** | Conifers and young trees (apex at the crown top). |
    | **Alpha shape** | Faithfully hugging an irregular crown outline. |

    Ellipsoid, prism, and cone are fit **axis-aligned** (upright and
    square to the world axes), so the reported dimensions read as
    width × depth × height.

4. **Set the fuzziness** (range `0`–`0.5`, default `0.2`). `0` bounds
   every point (including a lone branch shooting outside the crown);
   higher values trim the outermost points so an outlier branch doesn't
   inflate the shape with empty space. See
   [Crown metrics](../concepts/crown-metrics.md#fuzzy-trimming) for how
   the trim works.
5. *(Alpha shape only)* Optionally override the **alpha radius** — leave
   blank for automatic.
6. *(Optional)* Tick **Export crown table to CSV**. Give the export a
   **file name** (it defaults to the first selected scan's name), and —
   for an alpha shape — pick the **crown mesh format** (OBJ, PLY or STL).
   The line under the name field previews exactly what will be written.
7. Click **Fit crowns**.

## Results

Each fitted crown is added to the **Meshes** panel. Expand a crown mesh
to see its metrics:

- **Tree height** — crown top minus the ground baseline.
- **Crown volume** — the fitted shape's volume.
- **Crown center** — the center of the fitted shape, in world coordinates.
- **Crown dimensions** — width × depth × height of the fitted shape.
- **Surface area** and **points used**.

The source scans are hidden after a successful fit so the crowns are
visible; re-show them from the Scans panel any time.

### CSV export

With **Export crown table to CSV** ticked, Phytograph writes one **row
per crown** when the fit completes. Each row carries the crown's metrics
*and* the parameters that define its shape — an ellipsoid's semi-axes, a
cone's base radius and height — so a row is enough to rebuild the solid.
See [File formats](../reference/file-formats.md#crown-metrics-csv) for
the column list.

#### Alpha shapes also write a mesh

An alpha shape has no such parameters: it's a concave hull, so its
**geometry is the result**. Those crowns therefore get a **mesh file
written alongside the CSV**, and the row's `mesh_file` column names it.

Because that means more than one file, an alpha export asks you to
**choose a folder** rather than a save location; the CSV and every crown
mesh are written into it together. The mesh file names are
`<file name>_<scan>_tree<N>.<ext>` (or `…_crown` when the whole cloud was
fitted as a single tree).

The other three shapes need no mesh — their parameter columns already
describe them completely — so they leave `mesh_file` empty and are saved
through the ordinary save dialog as a single CSV.

!!! tip "Exporting a crown mesh on its own"

    Any fitted crown is a normal mesh in the scene, so you can also select
    it and export it from the **Export** window at any time — see
    [Import & export](import-export.md). The `mesh_file` column exists so
    that a *table* stays a complete record without that extra step.

## See also

- [Crown metrics](../concepts/crown-metrics.md) — what each metric means
  and how each shape's volume is defined.
- [Separate leaf and wood](segment-wood.md),
  [Segment individual trees](segment-trees.md),
  [Segment ground points](segment-ground.md) — the prerequisites.
