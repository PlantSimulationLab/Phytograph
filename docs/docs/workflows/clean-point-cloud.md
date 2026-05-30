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
a region. Two shapes are supported — a 3D **Box** and a 2D **Polygon**
lasso — and the same region applies to every scan you have selected.

1. Click **Crop**. A green box appears around the union of the selected
   scans' bounding boxes.
2. In the panel choose **Box** or **Polygon** at the top, and **Keep
   Inside** (default) or **Keep Outside** below it.
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
  ground plane. The box's Z extent auto-spans the data; refine with the
  dimension / center fields afterwards.

!!! tip "Cropping out the ground"
    For TLS scans of a single plant, raise the box's lower Z bound to
    the level of the lowest branch (adjust the Z center / dimension
    fields). With **Keep Inside** selected, this removes the ground in
    one step — much faster than filtering by height.

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

Cropping is non-destructive in the sense that it's undoable
(<kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd>), but it does discard points — if you
need them back, re-import the original file.

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

1. Click **Erase Brush**.
2. A red circular brush follows your cursor over the cloud.
3. Adjust brush size with the slider in the side panel (or `[` and `]`).
4. Hold left-click and paint over points to delete.
5. Click **Done** when finished.

The brush deletes points that fall within its 3D radius from the
camera, so painting around the plant from different angles is sometimes
necessary to clear everything you wanted to.

!!! info "Erase Brush vs XYZ scans"
    The free-form brush works only on LAS/LAZ and PLY/PCD scans, which
    keep all points in memory. For XYZ-imported scans (which stream from
    an on-disk octree), use **Crop** with **Keep Outside** to remove a
    box or polygon region instead — it goes through the same backend
    re-conversion path and gives the same full-resolution result.

## Filter

Use **Filter Points** (filter icon) to keep only points whose values
fall within a range — useful when the file carries intensity,
classification, or custom scalars. This works for large, octree-backed
clouds too: their imported scalar attributes (the same ones offered in
the **Color by** picker) appear in the filter field list alongside
X, Y, and Z.

To set a filter:

1. Pick a **field** from the dropdown (X, Y, Z, intensity, or any scalar).
2. Enter a **min** and **max**. The range takes effect immediately.
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
