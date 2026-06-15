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
   (globe icon) or **Tools → Pre-processing → Align Clouds (ICP)**.
2. In the dialog, pick the **target** (stays fixed) and the **source**
   (moves onto the target). Streamed (large/octree) clouds can only be the
   target — the source must be a regular cloud, since ICP transforms it.
3. Click **Align**.

ICP runs and reports:

- **RMSE** — root-mean-square distance after alignment
- **Min / Max distance** — worst-case error
- A transformation matrix applied to the source cloud

The source cloud is updated in place with the transformation. Undo to
revert.

## Mesh-to-mesh ICP

Same idea as cloud-to-cloud but on surfaces.

1. Select exactly two meshes in the scene panel.
2. Run **Align Mesh to Mesh (ICP)** from the **Tools** menu or the command
   palette (<kbd>⌘/Ctrl</kbd>+<kbd>K</kbd>). Mesh-to-mesh is typically more
   accurate than cloud-to-cloud because surface normals provide an extra
   constraint.

## Cloud-to-mesh

For comparing a real scan against a procedural model (or any
cloud-versus-mesh ground truth):

1. Select one cloud and one mesh in the scene panel.
2. Run **Align Mesh to Cloud** from the **Tools** menu or the command
   palette.

The mesh is transformed to best fit the cloud, and the result includes a
**distance heatmap** — each point colored by its distance to the nearest
mesh face. Use this to identify where your scan diverges from the model.

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
