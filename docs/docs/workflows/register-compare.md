# Register & compare

Align two datasets and measure how well they match. Phytograph supports
three flavors of ICP plus simple multi-cloud stitching.

## Stitch

The simplest case: you have several point clouds of the same plant
(e.g., from different scan positions) that are already roughly aligned
in world coordinates, and you want a single combined cloud.

1. Open **Stitch Clouds** from the **Pre-processing** toolbar group (merge
   icon) or **Tools → Pre-processing → Stitch Clouds**.
2. In the dialog, check the two or more clouds to merge. (If you had clouds
   selected in the scene, they're pre-checked — you can change the choice
   here.)
3. Click **Stitch**. A new cloud appears containing all points. The
   originals stay in the scene; hide them if you want.

Stitching is reversible via undo, and the originals aren't deleted —
you can re-stitch with a different subset.

!!! note "Stitch ≠ register"
    Stitch is a simple concatenation. It assumes the clouds are
    already in the same coordinate frame. If you need to register them
    first, use **Cloud-to-cloud ICP** (below) on each pair before
    stitching.

## Cloud-to-cloud ICP

Align one cloud to another by iteratively minimizing point-to-point
distance.

1. Open **Align Clouds (ICP)** from the **Pre-processing** toolbar group
   (globe icon) or **Tools → Registration → Align Clouds (ICP)**.
2. In the dialog, pick the **target** (stays fixed) and the **source**
   (moves onto the target). Either can be any cloud — a large streamed cloud
   can be the source too; its transform is applied on the backend and its
   octree rebuilt.
3. Click **Align**.

ICP runs and reports:

- **RMSE** — root-mean-square distance after alignment
- **Min / Max distance** — worst-case error
- A transformation matrix applied to the source cloud

The source cloud is updated in place with the transformation. Undo to
revert.

## Mesh-to-mesh ICP

Same idea as cloud-to-cloud but on surfaces.

1. Run **Align Mesh to Mesh (ICP)** from **Tools → Registration** or the
   command palette (<kbd>⌘/Ctrl</kbd>+<kbd>K</kbd>).
2. In the dialog, pick the **target** (stays fixed) and the **source** (moves
   onto the target). If you had meshes selected in the scene, they're
   pre-picked — you can change the choice here.
3. Click **Align**. The source mesh is transformed to best fit the target;
   the toast reports the fit. Undo to revert.

Mesh-to-mesh is typically more accurate than cloud-to-cloud because surface
normals provide an extra constraint.

## Cloud-to-mesh distance

Measure how well a mesh fits a point cloud — e.g., comparing a real scan
against a procedural model or any cloud-versus-mesh ground truth — without
moving anything.

1. Run **Cloud-to-Mesh Distance** from **Tools → Registration** or the command
   palette.
2. In the dialog, pick the **point cloud** and the **mesh**. (Pre-picked from
   the scene selection when available.)
3. Click **Compute Distance**.

The **Alignment** panel opens with point-to-mesh distance statistics:

- **Mean / Median / RMSE** and **standard deviation**
- **Min / Max** distance and the **90th / 95th / 99th percentiles**
- **Coverage** — the share of cloud points lying within 1 mm, 5 mm, and 10 mm
  of the mesh surface
- The **point count** the statistics were computed from

## Cloud-to-mesh ICP (snap to fit)

To actually *move* a mesh onto a cloud:

1. Run **Align Mesh to Cloud (ICP)** from **Tools → Registration** or the
   command palette.
2. In the dialog, pick the **point cloud** (stays fixed) and the **mesh**
   (moves onto it). Click **Snap to Fit (ICP)**.

The mesh is transformed to best fit the cloud, and the toast reports the
fitness and RMSE. Undo to revert.

!!! tip "Distance then snap"
    The **Alignment** panel from a Cloud-to-Mesh Distance run also has a
    **Snap to Fit (ICP)** button that registers the same cloud + mesh you just
    measured — so you can check the fit, then snap, in one place.

## When ICP fails

ICP finds a *local* minimum, so it needs the inputs to be roughly
pre-aligned. If RMSE comes back huge, or the result looks visibly
wrong:

1. **Pre-align manually** with [Translate](clean-point-cloud.md#translate-and-level)
   — get within ~10 cm and a few degrees before running ICP.
2. **Reduce voxel size** for finer-grained matching.
3. **Increase max iterations** if convergence is plausible but slow.

For very different inputs (e.g., a sparse cloud and a dense mesh),
expect higher RMSE than for similar-density inputs.
