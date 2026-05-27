# Register & compare

Align two datasets and measure how well they match. Phytograph supports
three flavors of ICP plus simple multi-cloud stitching.

## Stitch

The simplest case: you have several point clouds of the same plant
(e.g., from different scan positions) that are already roughly aligned
in world coordinates, and you want a single combined cloud.

1. Select two or more clouds in the Scene panel
   (<kbd>Shift</kbd>+click or <kbd>⌘/Ctrl</kbd>+click).
2. Click **Stitch Selected Clouds** (toolbar merge icon).
3. A new cloud appears containing all points. The originals stay in
   the scene; hide them if you want.

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

1. Select **exactly two** clouds.
2. Click **Align** (double-arrow icon) → **Cloud-to-cloud**.
3. The panel shows ICP parameters:
    - **Max iterations** (default 50)
    - **Convergence threshold** in meters (default 1e-6)
    - **Voxel size** for downsampling during fit (default 0.02 m)
4. Click **Run**.

ICP runs and reports:

- **RMSE** — root-mean-square distance after alignment
- **Min / Max distance** — worst-case error
- A transformation matrix applied to the second cloud

The second cloud is updated in place with the transformation. Undo to
revert.

## Mesh-to-mesh ICP

Same idea as cloud-to-cloud but on surfaces.

1. Select exactly two meshes.
2. Click **Align** → **Mesh-to-mesh**.
3. Run. Mesh-to-mesh is typically more accurate than cloud-to-cloud
   because surface normals provide an extra constraint.

## Cloud-to-mesh

For comparing a real scan against a procedural model (or any
cloud-versus-mesh ground truth):

1. Select one cloud and one mesh.
2. Click **Align** → **Cloud-to-mesh**.
3. Run.

The cloud is transformed to best fit the mesh. The result includes a
**distance heatmap** — each cloud point colored by its distance to the
nearest mesh face. Use this to identify where your scan diverges from
the model.

To swap roles (transform the mesh to fit the cloud), use **Mesh-to-cloud**
in the same panel.

## Reading the heatmap

After any C2M or M2M run, the moving dataset is colored by per-point
or per-vertex distance:

- **Deep green** — distance ≈ 0 (excellent fit)
- **Lime / mustard** — moderate distance
- **Bright yellow / cream** — large distance (poor fit)

Switch back to a regular color mode (Height, RGB, …) via the entry's
**Color By** dropdown when you're done inspecting.

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
