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
   icon) or **Tools → Pre-processing → Stitch Clouds…**.
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
and still reports a good score.

Auto-Register instead matches the **overall pattern of the planting**: it looks
down on each cloud from above and finds the rotation and shift that make the two
patterns line up. Because it uses the whole cloud at once, it does not depend on
recognising the same individual plants in both scans — which matters, since two
scan positions typically detect only about half the same plants, the rest being
hidden behind others.

1. Open **Auto-Register Clouds** from the **Pre-processing** toolbar group
   (sparkles icon), **Tools → Pre-processing**, or the command palette
   (<kbd>⌘/Ctrl</kbd>+<kbd>K</kbd>).
2. Pick the **target** (stays fixed) and the **source** (moves onto it).
   Either may be a streamed cloud.
3. Choose the **scene type** — see below. This is the important one.
4. For vegetated scenes, choose what to **match on**.
5. Click **Register**.

### Scene type

This picks the *method*, not a preset, so it is worth getting right:

| Scene type | What it does |
|------------|--------------|
| **Crops or orchard** | Matches plant by plant. For plantings set out on a grid or in rows. |
| **Natural woodland** | Matches plant by plant, tuned for irregular spacing. |
| **Buildings or built site** | Matches **surface shape** instead. Built scenes have no per-plant landmark to find, so plant matching does not apply. |

If the cloud looks nothing like the type you chose — say you picked *crops* for
a street of buildings — Phytograph stops and asks before doing the slow work,
rather than spending a minute producing something wrong. You can switch to what
it suggests, or keep your choice and continue. It never changes the method on
its own.

!!! tip "Built scenes: try plain ICP too"
    For buildings, **Align Clouds (ICP)** below is often all you need. Flat
    walls, roofs and corners are exactly what ICP is good at — the opposite of
    the vegetation case, where the lack of such surfaces is what makes
    Auto-Register necessary. Reach for Auto-Register when a built scene starts
    badly out of alignment.

### Use the scanner heading

Most terrestrial scanners record their own position and heading (GNSS,
inclination sensors, compass). When your scans carry that information, leave
**Use the scanner heading** ticked — it makes registration markedly more
reliable, and it is on by default.

The reason is worth knowing. An orchard scanned from within looks much the same
from several directions, so a search over all possible rotations can find an
alignment that fits the points *better* than the correct one while being
completely wrong. A lower residual does not mean a better alignment — on a
regular planting a row-flipped result still lands plant on plant.

The heading is used to *narrow the search*, not to skip it. That distinction
matters: an earlier version treated a known heading as "these clouds are already
close enough" and went straight to fine alignment. Measured against RiSCAN PRO's
own registration of a real peach orchard, that left three of five scan pairs a
full 180° out, because fine alignment on its own cannot tell which end of a
symmetric row it started from. Narrowing the search to the recorded heading
instead brought every pair to within 0.1°.

Untick the box only if the recorded heading is missing or you know it to be
wrong — registration then searches every orientation, which is slower and more
easily fooled on repetitive plantings.

### If a run looks wrong

Auto-Register offers three matching strategies. The default (**canopy pattern**)
is the fastest and the most reliable on real data, and is what you should
normally use.

| Strategy | When to try it |
|----------|----------------|
| **Canopy pattern** (default) | Almost always. Matches the planting's overall layout. |
| **Plant landmarks** | Sparse, well-separated plants where individual crowns or trunks are cleanly detectable in both scans. |
| **Surface shape** | Built scenes rather than vegetation. |

If Auto-Register warns that the result may be wrong, the first thing to try is a
different strategy — they fail in different ways.

### Why three scans beat two

On a regular planting a wrong alignment is not a poor fit. A result shifted by a
whole number of rows lands plant on plant, so it can score *better* than the
correct one — measured on a real vineyard, a pose four rows out fitted more
tightly than the right answer. Nothing measurable from a single pair of clouds
separates those two cases, so with only two scans a warning is the most honest
output available.

Three or more overlapping scans break the tie. Going around a closed loop of
scans has to bring you back where you started, and a row-shifted pose does not
cancel around that loop even though it fits its own pair well. Measured across
three orchards: loops whose alignments are all correct close to within about a
tenth of a metre, while a loop containing a bad one misses by several metres.

Two practical consequences:

- **Scan so the positions overlap in a loop**, not as a chain. Three scans that
  all see some common ground can validate each other; three in a line cannot.
- **With four or more scans the culprit is identified**, not just detected. The
  good alignments close their own loops, so the bad one is the alignment no
  passing loop vouches for. With exactly three, the problem is detected but any
  of the three could be responsible.

If a scan cannot be placed consistently, Auto-Register reports it as unresolved
rather than putting it somewhere plausible-looking.

### Registering a whole set at once

Given three or more scans, registering them **together** rather than one pair at
a time lets the loop check above do its work. As well as validating the result,
it can recover scenes that pair-at-a-time registration gets wrong: the matching
settings that suit a tall orchard are not the ones that suit a low vineyard, and
the only reliable way to tell which is right for your scene is to try them and
see which produces a set of alignments that agree with each other.

On a real vineyard this was the difference between failing completely and
registering to about 0.1 m — the correct settings were not the ones that scored
best on any individual pair.

The cost is that every pair has to be registered, so time grows with the square
of the scan count. Expect a few minutes for a handful of scans and appreciably
longer for a dozen.

### Choosing what to match on

*(Only applies to the **plant landmarks** strategy on vegetated scenes.)*

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
  confident. Run [Reset Registration](#undoing-a-registration), then try a
  different match method or detail size.

A quiet result means the plants matched unambiguously.

Like ICP, the transform is applied to the source's points *and* its scanner
origin/trajectory.

### Seeing what has been registered

A scan that Auto-Register moved is marked **registered** in the Scans panel,
next to its name. This matters because the alignment is baked into the points
themselves — without the marker there is nothing about the scan afterwards to
show it was ever moved.

Expand the scan's row for the detail: which scan it was registered onto, how far
it travelled, and how many registration passes have been applied to it.

The scan you registered *onto* is marked too, but differently — as
**reference**, in a lighter outline. It did not move, and resetting the
registration will not move it. Expanding a reference scan lists the scans that
were registered onto it.

So a scan is in one of three states:

| Marker | Meaning | Affected by Reset Registration? |
|--------|---------|---------------------------------|
| **registered** | Auto-Register moved this scan | Yes — it moves back |
| **reference** | Others were registered onto it; it never moved | No |
| *(none)* | Untouched by registration | No |

The **reference** marker is derived from the scans currently registered onto it,
so it disappears on its own once those are reset or deleted.

### Undoing a registration

Registration is **not** covered by **Undo**. It permanently rewrites the scan's
points, and Phytograph deliberately keeps changes of that size off the undo
stack (the same is true of cropping, baking a transform, and segmentation).

To reverse one, use **Tools ▸ Registration ▸ Reset Registration…**. It returns
every registered scan — and its scanner origin and trajectory — to the position
it held before Auto-Register ran, and clears the *registered* marker. If a scan
has been registered more than once, the reset undoes all of the passes at once,
returning it to where it started.

The command lives in the menu bar only, not the toolbar: it acts on the whole
project rather than the current selection, and it is a corrective rather than a
step in a workflow. It is **greyed out** until something has actually been
registered, so the menu tells you whether there is anything to reset without
your having to open it.

It confirms first, listing the scans that are about to move, because the reset
itself cannot be undone — recovering the alignment afterwards means running
Auto-Register again. Reference scans are not listed: they never moved.

!!! warning "Reset restores position, not edits"
    Reset Registration moves the points back. It does not roll back anything
    else you did while the scan was registered — crops, erased points, labels
    and segmentation results all stay as they are.

### How accurate is it?

Validated against RiSCAN PRO's automatic registration on a four-position
terrestrial survey of a real almond orchard (~14 M points per scan, trees to
~12 m, scanners in a clearing). Registering each scan onto a common reference
and comparing with RiSCAN's solution:

| Scan | Difference from RiSCAN |
|------|------------------------|
| ScanPos002 | 0.16° / 4 cm |
| ScanPos004 | 1.41° / 33 cm |
| ScanPos005 | 0.64° / 21 cm |

ScanPos005 is the interesting one: it sits at roughly 170° to the others, and
Auto-Register recovered it with no starting guess. **Align Clouds (ICP) cannot
do that** — it needs the clouds to start close together.

Two practical notes from that test. More points is not more accurate: the same
survey registered slightly *better* at 100 k points per scan than at 400 k,
because tree positions are what matter and those are already resolved at the
lower density. And the **trunk-bases** method was the least reliable on this
data, where crowns and canopy peaks both agreed closely with RiSCAN — if a
result looks wrong, switching method is the first thing to try.

!!! tip "Auto-register first, then fine-tune"
    Auto-Register finishes with an ICP refinement pass, so its output is
    usually final. If you later crop or clean the clouds, running **Align
    Clouds (ICP)** afterwards will polish the fit further.

## Cloud-to-cloud ICP

Align one cloud to another by iteratively minimizing point-to-point
distance. Use this to **polish** a pair that is already roughly lined up; if
the clouds start far apart or rotated, use **Auto-Register** above instead.

1. Open **Align Clouds (ICP)** from the **Pre-processing** toolbar group
   (globe icon) or **Tools → Registration → Align Clouds (ICP)…**.
2. In the dialog, pick the **target** (stays fixed) and the **source**
   (moves onto the target). Either can be any cloud — a large streamed cloud
   can be the source too; its transform is applied on the backend and its
   octree rebuilt.
3. Click **Align**.

ICP runs and reports:

- **RMSE** — root-mean-square distance after alignment
- **Overlap %** — the fitness score, i.e. the share of source points that
  found a correspondence
- A transformation matrix applied to the source cloud

!!! warning "ICP is not undoable"
    The source cloud is updated in place and its backend session rewritten,
    so <kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd> will **not** revert an alignment (it
    pops whatever edit preceded it). Duplicate the scan first if you want to
    keep the pre-alignment version.

Read the **RMSE against the cloud's own extent**, not the overlap figure —
fitness can read near-100% on a badly wrong alignment.

Unlike stitching, ICP **preserves** the source's scan parameters: the
scanner **origin** (and, for a moving-platform scan, the whole trajectory)
is moved by the same rigid transform as the points, so it stays consistent
with the aligned cloud. Origin-dependent analyses (LAD, triangulation)
therefore keep working on a registered source scan.

## Mesh-to-mesh ICP

Same idea as cloud-to-cloud but on surfaces.

1. Run **Align Mesh to Mesh (ICP)…** from **Tools → Registration** or the
   command palette (<kbd>⌘/Ctrl</kbd>+<kbd>K</kbd>).
2. In the dialog, pick the **target** (stays fixed) and the **source** (moves
   onto the target). If you had meshes selected in the scene, they're
   pre-picked — you can change the choice here.
3. Click **Align**. The source mesh is transformed to best fit the target;
   the toast reports the fit. As with the other ICP tools, this is **not
   undoable**.

Mesh-to-mesh is typically more accurate than cloud-to-cloud because points
are sampled uniformly off both surfaces, giving a denser and more even
correspondence set than raw scan points.

## Cloud-to-mesh distance

Measure how well a mesh fits a point cloud — e.g., comparing a real scan
against a procedural model or any cloud-versus-mesh ground truth — without
moving anything.

1. Run **Cloud-to-Mesh Distance…** from **Tools → Registration** or the command
   palette.
2. In the dialog, pick the **point cloud** and the **mesh**. (Pre-picked from
   the scene selection when available.)
3. Click **Compute Distance**.

The **Alignment** panel opens with point-to-mesh distance statistics:

- **Mean / Median / RMSE** and **standard deviation**
- **Min / Max** distance and the **90th / 95th / 99th percentiles**
- **Coverage** — the share of cloud points within three distance bands. The
  panel labels these *< 1mm*, *< 5mm*, and *< 10mm*, but they are **relative**,
  not absolute: the thresholds are 0.1%, 0.5%, and 1% of the cloud's
  bounding-box diagonal. On a 10 m cloud, "< 1mm" means within 10 mm
- The **point count** the statistics were computed from

## Cloud-to-mesh ICP (snap to fit)

To actually *move* a mesh onto a cloud:

1. Run **Align Mesh to Cloud (ICP)…** from **Tools → Registration** or the
   command palette.
2. In the dialog, pick the **point cloud** (stays fixed) and the **mesh**
   (moves onto it). Click **Snap to Fit (ICP)**.

The mesh is transformed to best fit the cloud, and the toast reports the
**RMSE** (the average residual distance after alignment) alongside the overlap
percentage. Like the other ICP tools, this is **not undoable**.

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
2. **Crop away non-overlapping regions** so the correspondence search isn't
   dominated by geometry the other input doesn't contain.

The ICP dialogs are deliberately minimal — pick a source, pick a target, run.
There are no voxel-size or iteration-count settings to tune, so improving a
bad result means improving the inputs.

!!! warning "A zero-error result is not always a good result"
    If the two clouds share no overlap at all, ICP can report zero error
    simply because it found nothing to compare. Phytograph now flags this
    ("no overlapping points were found") instead of showing it as a perfect
    fit — if you see that warning, the clouds need a rough pre-alignment or
    they may not cover the same ground.

For very different inputs (e.g., a sparse cloud and a dense mesh),
expect higher RMSE than for similar-density inputs.
