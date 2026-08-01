# Register & compare

Align two datasets and measure how well they match. Phytograph supports
automatic registration (no starting guess needed), three flavors of ICP for
refining an alignment, and simple multi-cloud stitching.

**Which one do I want?**

- Clouds are **far apart or rotated** → [Auto-Register](#auto-register-when-clouds-start-far-apart)
- Clouds are **nearly aligned already** → [Cloud-to-cloud ICP](#cloud-to-cloud-icp)
- Clouds are **already correct** and you want one file → [Stitch](#stitch)

## Stitch

The simplest case: you have several point clouds of the same plant
(e.g., from different scan positions) that are already roughly aligned
in world coordinates, and you want a single combined cloud.

1. Open **Stitch Clouds** from the **Pre-processing** toolbar group (merge
   icon) or **Tools → Pre-processing → Stitch Clouds**.
2. In the dialog, check the two or more clouds to merge. (If you had clouds
   selected in the scene, they're pre-checked — you can change the choice
   here.)
3. Optionally tick **Keep original clouds** to merge non-destructively — see
   below.
4. Click **Stitch**. The clouds are combined in the backend (a brief
   progress indicator shows while the merged cloud's octree is built), and a
   single new cloud replaces the originals in the scene.

Stitching is reversible: a single **Undo** removes the merged cloud and
restores the original clouds exactly as they were, so you can re-stitch with
a different subset.

### Keep original clouds

By default the source clouds are **removed** from the scene when they merge.
Tick **Keep original clouds** and they stay instead — hidden, so the viewport
looks the same, but still listed and still fully usable. Click the eye icon
next to one to bring it back.

This is useful when you want the merged cloud for a whole-plot view while
keeping the individual scans for per-scan analyses — the retained clouds keep
their scanner origins, so **Backfill Misses**, **Helios triangulation**, and
**Leaf Area Density** still run on them even though they're unavailable on the
merge itself.

!!! note "Undo with retained originals"
    With **Keep original clouds** ticked, **Undo** removes the merged cloud but
    leaves the originals hidden — showing and hiding clouds isn't part of the
    undo history. Click the eye icons to bring them back.

!!! note "Stitch ≠ register"
    Stitch **concatenates** the clouds' points into one cloud. Clouds
    imported with different global shifts are lined up in true world
    coordinates automatically, so a stitch never mis-places a shifted cloud.
    What it does **not** do is *register* — it won't correct clouds that are
    genuinely mis-aligned in the world. For that, use **Cloud-to-cloud ICP**
    (below) on each pair first, then stitch.

!!! warning "Stitching discards scanner origins"
    A stitched cloud has no single scanner origin, so scan parameters
    (origin, trajectory) from the source clouds are dropped on the merge. That
    means **origin-dependent analyses are unavailable on the merged cloud**:

    - **Backfill Misses** — recovered sky/miss points can't be placed for the
      viewer overlay (they'd still be computed for LAD *directions*, but LAD
      itself is unavailable — see below).
    - **Helios triangulation** (the *Helios method*, which projects to per-pulse
      spherical angles from the scanner origin).
    - **Leaf Area Density** (needs the beam origin for the Beer's-law inversion).

    If any cloud you're stitching carries an origin, the Stitch dialog shows a
    warning and the button reads **Stitch anyway** so the loss is a deliberate
    choice. You have three ways around it: tick **Keep original clouds** so the
    sources (and their origins) survive the merge, run these analyses on the
    individual scans *before* stitching, or — if the clouds are mis-aligned —
    **register** them with Cloud-to-cloud ICP first (that preserves each scan's
    own origin) rather than stitching.

    The underlying points, colors, intensity, and scalar attributes are all
    preserved (attributes present on only some inputs are carried through and
    filled with zeros for the clouds that lacked them).

## Auto-register (when clouds start far apart)

**Align Clouds (ICP)** below can only *polish* a pair that already starts
close together. **Auto-Register** handles the case it can't: two scans of the
same plot that are arbitrarily rotated or offset, with no manual
pre-alignment.

The difference is what gets matched. Matching raw points fails on a planting,
because every plant's foliage looks like every other plant's — the match
happily snaps the source onto a *neighbouring* plant, one row-spacing off,
and still reports a good score. Auto-Register first reduces each cloud to
**one landmark per plant**, then matches those. A few dozen well-separated
landmarks are far easier to line up unambiguously than a million
interchangeable foliage points.

1. Open **Auto-Register Clouds** from the **Pre-processing** toolbar group
   (sparkles icon), **Tools → Pre-processing**, or the command palette
   (<kbd>⌘/Ctrl</kbd>+<kbd>K</kbd>).
2. Pick the **target** (stays fixed) and the **source** (moves onto it).
   Either may be a streamed cloud.
3. Choose what to **match on** — see the table below.
4. Click **Register**.

### Choosing what to match on

The right landmark depends on how the data was captured, not on which
algorithm sounds better:

| Match on | Use when | Notes |
|----------|----------|-------|
| **Tree crowns** (default) | Aerial/drone scans, or any data where trunks are hidden by canopy | Needs no visible trunk — the usual choice |
| **Trunk bases** | Ground-based scans of trees or vines with clear trunks | The most repeatable landmark when trunks *are* visible |
| **Canopy peaks** | Either of the above finds too few plants | Uses no segmentation at all, so it still works on dense or touching canopies |

If a run looks wrong, switching the match method is the first thing to try —
they fail in different ways, which is why all three ship.

**Detail size** can normally stay blank; Phytograph sizes it from the cloud.
Increase it if registration finds nothing; decrease it for small or very
finely sampled plants.

### Reading the result

Auto-Register always tells you **which method actually ran**. Normally it
matches the plants it found; if it could not find enough, it says so and
matches the overall surface shape instead. That fallback still often works, but
it is the weaker path — worth knowing before you trust the result.

Two warnings are worth acting on:

- **"This planting is too regular to be sure"** — another alignment fits almost
  as well. On a perfectly regular block, an alignment shifted by one plant (or
  rotated a quarter turn) can line up just as convincingly as the right one, and
  no error measurement can tell them apart. Check the result visually, or crop
  to an area with some irregularity — a gap, an edge, a size difference — and
  register that first.
- **"This alignment may be wrong"** — too few plants were matched to be
  confident. Undo and try a different match method or detail size.

A quiet result means the plants matched unambiguously.

Like ICP, the transform is applied to the source's points *and* its scanner
origin/trajectory, and a single **Undo** reverts it.

!!! tip "Auto-register first, then fine-tune"
    Auto-Register finishes with an ICP refinement pass, so its output is
    usually final. If you later crop or clean the clouds, running **Align
    Clouds (ICP)** afterwards will polish the fit further.

## Cloud-to-cloud ICP

Align one cloud to another by iteratively minimizing point-to-point
distance. Use this to **polish** a pair that is already roughly lined up; if
the clouds start far apart or rotated, use **Auto-Register** above instead.

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

Unlike stitching, ICP **preserves** the source's scan parameters: the
scanner **origin** (and, for a moving-platform scan, the whole trajectory)
is moved by the same rigid transform as the points, so it stays consistent
with the aligned cloud. Origin-dependent analyses (LAD, triangulation)
therefore keep working on a registered source scan.

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
**RMSE** (the average residual distance after alignment) alongside the overlap
percentage. Undo to revert.

!!! warning "Read the RMSE, not the overlap percentage"
    Overlap (ICP's "fitness") is the *share of points that found a match* — it
    reaches 100% whenever the search radius is generous relative to the object,
    including for a visibly wrong alignment. **RMSE is the honest number**: a
    good registration lands well under 1% of the cloud's size. When the residual
    is large relative to the scene, the toast turns into a warning telling you
    to review the result before keeping it, rather than reporting success.

!!! tip "Distance then snap"
    The **Alignment** panel from a Cloud-to-Mesh Distance run also has a
    **Snap to Fit (ICP)** button that registers the same cloud + mesh you just
    measured — so you can check the fit, then snap, in one place.

!!! note "Progress and cancelling"
    Every registration and the cloud-to-mesh distance run shows a progress pill
    at the top of the viewport while it works — the ICP tools advance it per
    iteration batch with the current RMSE. Click the **✕** on the pill to
    cancel; the alignment stops (within one iteration batch) and nothing is
    moved, exactly as if it hadn't been run.

## When ICP fails

ICP finds a *local* minimum, so it needs the inputs to be roughly
pre-aligned. If RMSE comes back huge, or the result looks visibly
wrong:

1. **Try [Auto-Register](#auto-register-when-clouds-start-far-apart)** — for
   two clouds of a planting, this is usually the fix rather than a
   workaround: it does not need a starting guess at all.
2. **Pre-align manually** with [Transform](clean-point-cloud.md#transform-translate-and-rotate)
   — translate and rotate to within ~10 cm and a few degrees before running ICP.
3. **Reduce voxel size** for finer-grained matching.
4. **Increase max iterations** if convergence is plausible but slow.

!!! warning "A zero-error result is not always a good result"
    If the two clouds share no overlap at all, ICP can report zero error
    simply because it found nothing to compare. Phytograph now flags this
    ("no overlapping points were found") instead of showing it as a perfect
    fit — if you see that warning, the clouds need a rough pre-alignment or
    they may not cover the same ground.

For very different inputs (e.g., a sparse cloud and a dense mesh),
expect higher RMSE than for similar-density inputs.
