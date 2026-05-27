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
a box.

1. Click **Crop**. A red box appears around the cloud's bounding box.
2. Drag the box's handles to resize it.
3. In the side panel choose **Keep Inside** (default) or **Keep
   Outside**.
4. Press <kbd>Enter</kbd> or click **Apply**.

Cropping is non-destructive in the sense that it's undoable
(<kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd>), but it does discard points — if you
need them back, re-import the original file.

!!! tip "Cropping out the ground"
    For TLS scans of a single plant, drag the box's bottom face up to
    the level of the lowest branch. With **Keep Inside** selected, this
    removes the ground in one click — much faster than filtering by
    height.

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

## Filter

Use **Filter Points** (filter icon) to keep only points whose values
fall within a range — useful
when the file carries intensity, classification, or custom scalars.

The panel shows one row per available channel (X, Y, Z, intensity, any
scalar fields). For each:

- A dual-handle slider sets the min/max of the keep range.
- A live histogram shows the distribution.
- A checkbox enables or disables that filter.

Multiple filters compose with AND — only points that pass every active
filter survive.

Click **Apply** to commit; the discarded points are removed. Use
<kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd> to undo.

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
