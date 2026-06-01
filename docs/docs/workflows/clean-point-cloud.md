# Clean a point cloud

Raw LiDAR data almost never lands ready for analysis. This workflow
covers the five operations you'll reach for most often: **translate**,
**crop**, **erase**, **filter**, and **resample**. Apply them in
roughly that order.

## Translate and level

Use **Translate** (pencil icon in the tool column, or right-click the
cloud → Translate) to:

- Move the cloud to the world origin
- Rotate it so Z points up (common with airborne scans)
- Scale it (rare, but useful if units are wrong)

A 3D gizmo appears at the cloud's center. Drag the gizmo's:

- **Arrows** to translate along an axis
- **Rings** to rotate around an axis
- **Cubes** to scale along an axis

Or type exact values in the panel that opens on the right. Click
**Apply** to commit, **Cancel** to discard.

The toolbar also has a one-click **Move to Origin** that centers the
cloud's bounding box at (0, 0, 0) without rotating it.

## Crop

Use **Crop** (scissors icon) to keep only points inside (or outside)
a region. Three shapes are supported — a 3D **Box**, a screen-space
**Rect**(angle), and a freeform **Polygon** lasso — and the same region
applies to every scan you have selected.

1. Click **Crop**. A green box appears around the union of the selected
   scans' bounding boxes.
2. In the panel choose **Box**, **Rect**, or **Polygon** at the top, then a
   **Mode** below it: **Keep Inside** (default), **Keep Outside**, or
   **Segment**. The first two discard the points you don't keep;
   **Segment** keeps both halves as separate clouds (see below).
3. Shape the region (see below).
4. Click **Apply** at the bottom of the panel. A **Cropping…** indicator
   appears while the crop is processed, and the removed points stay
   hidden the whole time. Click the **×** in the panel header to dismiss
   without applying.

When more than one scan is selected, the panel shows "Applies to N scans"
and each scan gets its own cropped result — identities are preserved.

### Box mode

Two ways to shape the box:

- **Type dimensions / center** in the panel for an exact axis-aligned box.
- **Click "Draw box in viewport"** then click two opposite corners on the
  ground plane. After the first click a marker shows where it landed and a
  live preview box follows the cursor until you click the second corner.
  The box's Z extent auto-spans the data; refine with the dimension /
  center fields afterwards. <kbd>Esc</kbd> cancels.

Box mode is axis-aligned and easiest from a roughly top-down view. To crop
from an angled view, use **Rect** instead.

!!! tip "Cropping out the ground"
    For TLS scans of a single plant, raise the box's lower Z bound to
    the level of the lowest branch (adjust the Z center / dimension
    fields). With **Keep Inside** selected, this removes the ground in
    one step — much faster than filtering by height.

### Rect mode

Rect mode is a **screen-space rectangle** — the quick, any-view counterpart
to Box. Unlike the world-space box, it works from any camera angle.

1. Pick **Rect** in the panel; the view switches to a straight-on
   (orthographic) projection and the camera locks so the rectangle stays
   anchored to the view.
2. **Click-drag** in the viewport from one corner to the opposite corner.
   A dashed preview rectangle follows the cursor; release to commit it.
3. Click **Apply** in the panel, or use **Redraw rectangle** to start over.
   <kbd>Esc</kbd> cancels.

Like the polygon, the rectangle lives in screen space, so the in/out test
uses the camera as it was when you released the drag — orbiting afterwards
doesn't change the result. Because the draw is orthographic, the selection
extrudes straight into the scene: the cropped region is a true rectangular
slab from **any** viewing angle, not a perspective wedge. So you can, for
example, orbit to a side view, drag a rectangle around the part of a plant
you want, and get a clean axis-true cut.

### Polygon mode

Polygon mode is a **screen-space lasso** — useful when the region you
want isn't a tidy box.

1. Pick **Polygon** in the panel; the camera locks so the lasso stays
   anchored to the view.
2. Click in the viewport to add vertices. Right-click or
   <kbd>Backspace</kbd> removes the last vertex.
3. Press <kbd>Enter</kbd> to close the polygon. A filled preview shows
   what will be kept (green) or removed (red).
4. Click **Apply** in the panel, or use **Redraw polygon** to start over.

Because the polygon lives in screen space, the in/out test uses the
camera as it was when you closed the polygon — orbiting afterwards is
fine and doesn't change the result.

### Segment mode (keep both halves)

**Keep Inside** and **Keep Outside** discard the points you don't keep.
**Segment** instead splits each selected scan in two: the original scan
keeps the in-region points (the same set **Keep Inside** would keep), and a
new **"… (segment)"** cloud is added to the scene holding the cropped-out
points. No points are lost. It works with all three shapes — **Box**,
**Rect**, and **Polygon**.

The new cloud is added in a distinct colour so it's easy to tell apart;
recolour or rename it from the scan list like any other scan. It's handy
for separating a plant from its ground, or splitting one scan into named
regions without re-importing.

Cropping is non-destructive in the sense that it's undoable
(<kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd>). With **Keep Inside** / **Keep Outside**
it discards the points outside the kept set — if you need them back,
re-import the original file or use **Segment** so they're kept as a new
cloud.

!!! note "Apply latency on large XYZ scans"
    For XYZ-imported scans, **Apply** re-runs the octree converter on the
    filtered source file. Typical cost is ~3 M points/sec on M-series
    Macs — a 13 M-point Helios scan takes ~5 s, a 30 M-point scan ~12 s.
    The render itself stays interactive throughout: the panel closes
    immediately on click, a **Cropping…** indicator shows the work is
    running, the removed points stay hidden the whole time, and the
    cropped cloud streams in when the new octree is ready. Subsequent
    crops with identical parameters are instant (cached). LAS/LAZ and
    PLY/PCD scans use the older flat-array path and apply synchronously.

## Erase

Use **Erase Brush** (eraser icon) for irregular regions a box can't
capture — stray points, noise behind the plant, isolated outliers.

The brush is a **square stamp** that cuts straight through the cloud along
your view direction — like the rectangle/polygon crop, but a pre-shaped
square you paint freely. It shows a live preview of what it removes;
nothing is deleted until you apply.

1. Click **Erase Brush** to open the tool. The panel opens but the view
   stays interactive — orbit/pan/zoom to frame the angle you want to erase
   from.
2. Click **Start Erasing** in the panel (or press **`E`**) to turn erase
   mode on. This **freezes the viewport** so every stamp shares the same
   view, and a square brush follows your cursor (orange → red).
3. **Click** on the cloud to stamp a square, or **click-drag** to paint a
   strip of squares. The points behind each square disappear in the live
   preview — and because the square extrudes through the whole cloud, it
   removes points at every depth behind it, not just the near surface.
4. Press **`E`** (or the button) again to turn erase mode off **without
   closing the tool** — the view unfreezes so you can reorient, then turn
   erase back on and keep stamping. Painted strokes are kept across toggles.
5. Click **Apply Erase** to remove the painted points for real, or
   **Clear Strokes** to discard the preview.

Adjust brush size (in screen pixels) with the slider; because the brush is
screen-space, its size stays constant on screen regardless of the cloud's
distance.

Erase composes like crop: each apply removes the painted union from the
current point set, so you can apply, reorient, and stamp again to clear
points hidden behind a surface.

!!! info "How erase works on large scans"
    Imported scans stream from an on-disk octree, so the preview is done on
    the GPU (each square's view-aligned volume clips its points live) and
    **Apply** re-converts the cloud on the backend at full resolution — the
    same path **Crop** uses, testing each point's screen position against
    the painted squares. While erase mode is on, the view is projected
    orthographically (as the Rect crop does) so the square extrudes as a
    straight prism and the cleared region matches the brush outline exactly
    rather than flaring into a perspective trapezoid. Since the test is in
    screen space the stamp is depth-independent: it removes every point
    behind the square, not just the near surface — reorient and paint again
    to clear points it was shielding. You can still use **Crop** with
    **Keep Outside** for a box, rect, or polygon region when a regular shape
    fits better.

## Filter

Use **Filter Points** (filter icon) to keep only points whose values
fall within a range — useful when the file carries intensity,
classification, or custom scalars. This works for large, octree-backed
clouds too: their imported scalar attributes (the same ones offered in
the **Color by** picker) appear in the filter field list alongside
X, Y, and Z.

To set a filter:

1. Pick a **field** from the dropdown (X, Y, Z, intensity, or any scalar).
2. Set the criterion:
    - **Continuous fields** (intensity, height, deviation, …) show **min**
      and **max** inputs — points in the inclusive range are "in range".
      The range takes effect immediately.
    - **Class fields** — `ground_class` (from
      [Segment ground](segment-ground.md)) and `tree_instance` (from
      [Segment trees](segment-trees.md)) — are categorical, so instead of
      a range you get a **checkbox per class** (Ground, Non-ground, or
      Tree 1…N). Tick the classes to **keep**; use **All** / **None** to
      toggle the whole set. This is the natural way to isolate, say, just
      the non-ground points after a ground classification.
3. Repeat for other fields to stack filters — they compose with **AND**,
   so only points passing every active filter are "in range".

Then choose how to commit (there is no separate Apply step):

- **Filter (remove points)** — deletes the out-of-range points, keeping
  only the in-range ones.
- **Segment (split into two clouds)** — keeps the in-range points on the
  original cloud and adds the out-of-range points as a **second cloud**
  (`<name> (filtered out)`). Nothing is discarded; the two clouds
  together equal the original. Handy for separating, say, a canopy from
  the rest by height without losing the rest.

Use <kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd> to undo. If a filter excludes every
point, you're offered the chance to delete the cloud instead.

!!! info "Small vs large clouds"
    Small (in-memory) clouds preview the filter live in the viewport as
    you edit the range. Large, octree-backed clouds have no live preview —
    committing re-converts the cloud on the backend (the same path
    **Crop** uses on large clouds), so the change appears once that
    finishes.

## Resample

Use **Resample Point Cloud** (scatter icon) when a cloud is too large
to work with interactively or
when you want a uniformly sparser version for export.

1. Click **Resample**.
2. The fraction slider goes from 0.1 (keep 10%) to 1.0 (keep all).
3. Quick presets: **10%**, **25%**, **50%**, **75%**.
4. Live preview shows the resampled cloud before you commit.
5. Click **Apply** to replace, or **Cancel** to keep the original.

Resampling is uniform-random, not voxel-based. For voxel downsampling,
export to `.ply` and use a tool like CloudCompare.

## A typical cleaning order

1. **Translate** — get the cloud level and centered.
2. **Crop** — remove the ground and far-field noise with a single box.
3. **Filter** — drop low-intensity returns if intensity is reliable.
4. **Erase** — clean up stragglers a box couldn't reach.
5. **Resample** — only if needed for performance.

Save (`Export → .ply`) at each milestone if you want backup checkpoints.
