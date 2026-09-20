# Leaf area density

**Leaf area density (LAD)** is the one-sided leaf area per unit volume,
in m²/m³, estimated **per voxel** of a 3-D grid you place over a scanned
canopy. It is the spatial building block of leaf area index (LAI) — sum
LAD over a column of voxels and multiply by their height and you get the
LAI of that column.

Two summaries fall directly out of a computed grid, and Phytograph reports
both in the **Profile & LAI** window of a LAD result:

- The **vertical profile** — mean LAD per horizontal level — is how the
  canopy's foliage is distributed with height. It is what distinguishes a
  canopy that carries its leaf area in a dense upper crown from one that
  spreads the same total over its whole depth.
- The **bulk LAI** — total leaf area over the grid's ground footprint — is
  the single canopy-scale number, and the one most often quoted.

Neither counts **occluded** voxels. A voxel the beams never adequately
probed is *unmeasured*, not empty, and treating its density as zero is the
most common way both figures come out biased low. See
[estimating LAD](../workflows/estimate-leaf-area-density.md#occlusion).

Phytograph computes LAD with the PyHelios LiDAR plugin from one or more
terrestrial scans that carry scanner parameters.

## LAD is not a sum of leaf areas

A common misconception is that LAD is the triangulated leaf surface area
divided by the voxel volume. It is **not**. You cannot see every leaf
from a scanner — leaves occlude each other — so simply meshing the hit
points and summing triangle areas systematically *undercounts* the
foliage deeper in the canopy.

Instead, LAD is recovered by **inverting Beer's law** on the laser beams
that pass through each voxel:

1. **Triangulate** the hit points. The mesh is **not** the answer — it is
   used only to estimate the per-voxel **G-function**, `G(θ)`: the mean
   projection of the leaves onto the plane perpendicular to the beam. For
   a random (spherical) leaf-angle distribution `G(θ) ≈ 0.5`; for erect
   (vertical) leaves it is lower. (You can also skip this step and
   [prescribe `G(θ)` directly](#leaf-angle-distributions-and-g) from a known
   leaf-angle distribution.)
2. **Trace every beam** through the voxel grid and measure the path
   length `dr` it travels inside each voxel.
3. **Count returns** to estimate the gap probability `P` (the fraction of
   beams that pass *through* the voxel without a return).
4. **Invert** `P = exp(−G(θ) · LAD · dr)` for `LAD`, per voxel.

Because it works from transmission (gaps) rather than from visible
surface, the inversion accounts for occluded foliage — which is the whole
point.

## Leaf-angle distributions and G(θ)

`G(θ)` is the **mean leaf-projection coefficient**: the fraction of leaf area
projected onto the plane perpendicular to a beam travelling at zenith angle `θ`,
averaged over the leaves' orientations. It depends on the canopy's **leaf-angle
distribution** `g_L(θ_L)` (how leaf inclinations are spread between horizontal and
vertical) and on the beam zenith. For a given distribution,

`G(θ) = ∫ A(θ, θ_L) · g_L(θ_L) dθ_L`

where `A` is the standard azimuthally-averaged projection kernel (Warren-Wilson /
Lemeur). Three common cases:

- **Spherical (random):** leaf normals point in every direction equally;
  `G(θ) ≈ 0.5` at all zeniths. This is the usual default.
- **Planophile (mostly horizontal):** `G` is high near nadir and falls toward the
  horizon.
- **Erectophile (mostly vertical):** the opposite — `G` is low near nadir and
  rises toward the horizon.

Phytograph normally **estimates `G(θ)` per voxel from a triangulation** of the hit
points (the surface normals give the leaf orientations). But you can also
**prescribe it directly** — see
[Override G(θ) directly](../workflows/estimate-leaf-area-density.md#override-g-directly).
Three ways to specify it:

1. **Constant value** — e.g. `G(θ) = 0.42`.
2. **de Wit classical distribution** — pick a named family (spherical, planophile,
   erectophile, plagiophile, extremophile, uniform); `G(θ)` is derived by
   integrating the kernel over the **actual beam zenith angles** in your scan.
3. **Beta (μ, ν)** — Goel–Strebel parameters (the same convention used by
   [Adjust leaf angles](../workflows/adjust-leaf-angles.md) and the
   [leaf-angle de Wit fitting](../workflows/triangulate.md) on the triangulation
   side); `G(θ)` is derived as for de Wit.

Each can be applied **uniformly** across the grid or as a **vertical profile** (one
method, with the parameter varying by z-level) when leaf inclination changes with
canopy height.

## The voxel grid is required

For [triangulation](../workflows/triangulate.md) a grid is optional. For
LAD it is **mandatory**: LAD is defined per voxel, so the grid *is* the
calculation. You supply it as a **voxel box** created in the viewer, with
its position, size, and per-axis cell counts (Nx × Ny × Nz) setting the
grid. A 1×1×1 box with 1×1×1 cells yields a single canopy-wide LAD value;
subdividing it gives a 3-D density field.

## Single- vs multi-return scans

The inversion differs by return type, and Phytograph detects it from each
scan's parameters:

- **Single-return (discrete):** one return per pulse. The gap fraction is
  estimated directly from hit/miss classification, so the scan still needs
  miss information — either imported miss points or a `timestamp` column to
  gapfill from (see [Sky/miss points](#skymiss-points-and-gapfilling) below).
- **Multi-return (full-waveform):** several returns per pulse. The beams
  are grouped by pulse and weighted equally, and sky/miss rays are
  gap-filled before the inversion. This needs per-return metadata —
  `timestamp`, `target_index`, and `target_count` — preserved from the
  source file.

You don't choose the algorithm, and there is no setting for it: it follows
directly from whether those three per-pulse columns are present in the data.
The Scan Parameters dialog reports the verdict under **Detected from point
data**, and the LAD dialog echoes it read-only. See
[Return type is detected, not declared](scans.md#return-type-is-detected-not-declared).

### Keep the later echoes if the instrument recorded them

If your instrument records multiple echoes per pulse, **import in a way that
preserves them**. Using only the first echo of each pulse — the "first-hits"
method — biases LAD in a known direction: a beam that is partially intercepted
before *and* after a voxel counts as zero transmission, so transmission is
underestimated and LAD comes out **too high**.

Kent and Bailey ([2024](https://doi.org/10.1016/j.rse.2024.114229)) quantified
this against simulated scans with known leaf area. First-hits differed most from
the reference of every method tested, consistently underestimating transmission
and overestimating LAD — overestimating total leaf area by 149–266% in their
most demanding case, against 80–122% for the equal-weighting method Phytograph
uses for multi-return scans. (Their headline result is a separate question:
intensity-based weighting of echoes did *not* reliably beat equal weighting, so
equal weighting is "an acceptable choice" — which is why the multi-return path
above weights each echo equally.)

The practical consequence is about **file formats**, since a format that stores
one point per beam leaves no later echoes to weight. Formats that keep them:

- **[RIEGL `.riproject` / `.PROJ`](../workflows/import-riegl-project.md)** —
  carries per-pulse target index and count directly.
- **Structured `.e57`** — keeps every echo for a cell.
- Any format retaining `timestamp`, `target_index`, and `target_count` as
  columns (LAS/LAZ, PLY, or the text formats).

**`.ptx` cannot** — it is a complete raster of one line per grid cell, so it
collapses each pulse to a single echo and has no schema slot for those three
columns. A multi-return scan re-imported from PTX is not a multi-return scan
that quietly falls back; it *is* single-return, its **return type** field agrees,
and no warning fires because nothing is inconsistent. The echoes are gone with
nothing downstream able to tell you. PTX remains a perfectly good LAD input for
genuinely single-return instruments, where it retains misses well (see
[Sky/miss points](#skymiss-points-and-gapfilling)).

### Cropped and segmented clouds

The equal-weighting inversion counts, for each pulse, the returns inside and
beyond every voxel the beam pierces. Those counts come from the returns
**present in the cloud**. So if a pulse hit a needle inside a voxel and then
the ground behind it, and the ground return is gone (a crop to the tree, a
ground filter, a leaf/wood classification that keeps only leaf points), the
surviving needle return becomes the whole beam: a pulse that was half
transmitted reads as fully intercepted, and LAD comes out **too high**. Worse,
a pulse that crossed the voxel and returned *only* beyond it, which is the
transmission signal itself, disappears altogether. The removed energy does
**not** become a sky miss; it simply vanishes.

How well Phytograph recovers from that depends on where the crop happened.

**Cropped in Phytograph (crop box, erase, filter).** A deletion keeps the
point's coordinates, and LAD feeds every deleted point that lies **outside the
voxel grid** back to the inversion, because for the inversion a deleted return
beyond the grid is a transmitted beam exactly as before and one before the
grid contributes nothing either way. So cropping to the grid, or deleting noise
outside it, changes nothing: the result is identical to the uncropped scan,
and a miss buffer computed before the crop stays valid. The one deletion the
inversion cannot repair is a point deleted **inside** the grid, and LAD warns
with the count when it finds one.

This holds for as long as the deleted points are kept, which is until you
choose **Permanently apply deletions** in the Erase panel. The display
refresh that follows a crop, erase or filter keeps them. Applying deletions
removes the points for good, so LAD can no longer restore the ones outside
the grid, and it warns that the result may read high. The same happens to a
cloud made by **split**, **extract**, **duplicate** or **merge**: it holds
only the points it took, so the rest of the scan's returns are gone from it.
Either crop without applying deletions, or re-run **Backfill Misses** on the
new or applied cloud. Backfilling against the points that remain recovers the
lost pulses as misses, which brings LAD back in line and clears the warning.
Likewise, after you move or rotate a cloud, LAD warns until you re-run
Backfill Misses, because the misses' beam directions predate the move.

**Cropped before import (a segmented tree file).** The removed returns were
never in the session, so the inversion works from what the file kept. If the
surviving returns still carry the per-pulse `target_index` and `target_count`
the scanner wrote (LAS `return_number` / `number_of_returns`, or the same
columns in a text file), a removed return can be placed from the surviving
indices alone, since a pulse's returns are ordered by range and a beam crosses
the grid in one contiguous segment:

- an index **below** the smallest surviving index was before the grid and
  changes nothing;
- an index **above** the largest surviving index was beyond the grid and is
  counted as transmitted through every voxel the beam pierces;
- an index **between** two surviving returns cannot be placed. It is left out,
  and the result reports how many.

That covers pulses that kept a return inside the grid. Pulses that lost *all*
their returns have nothing to carry a count, so run **Backfill Misses** on the
cropped cloud: the gapfill synthesises a miss for every pulse with no return,
which restores the beams that crossed the grid and returned only beyond it.
The limit of that recovery is **occlusion**: a pulse whose only return was on
something *between* the scanner and the grid (a neighbouring crown, a trunk
outside the grid) comes back as a miss too, and a miss counts as transmitted,
so those voxels read **low**. Nothing in the cropped file can tell a blocked
beam from a transmitted one. For a per-tree profile in a closed stand, crop
in Phytograph rather than before import, or keep the returns between the
scanner and the tree in the file.

Two warnings catch the cases the inversion cannot repair: LAD warns when a
session has deleted points inside the voxel box, and when the inversion found
returns it could not place. Separating wood from leaf area is a correction
applied after the inversion, not a point filter before it — which is exactly
how Phytograph does it; see [Wood area](#wood-area) below.

## Wood area

Branches and trunks intercept beams too, so an inversion that treats every
return as foliage reports **plant** area density under the name LAD. When the
cloud carries a wood/leaf classification (run
[Segment Wood / Leaf](../workflows/segment-wood.md) first), Phytograph splits
each voxel's result into a leaf part and a wood part, and reports both.

The split happens **after** the inversion, never by filtering points before it.
Every return and every sky miss stays in the cloud, so the beam bookkeeping is
untouched; what the classification changes is only how each voxel's measured
interception is attributed. Deleting wood points instead would turn a beam
stopped by a branch into a transmitted one and bias the leaf density — the
failure described under [cropped and segmented
clouds](#cropped-and-segmented-clouds).

The two numbers use different, deliberate conventions, and both mean "the area
that intercepts light":

| | Reported as | Projection coefficient |
|---|---|---|
| **LAD** | one-sided leaf area per m³ | G ≈ 0.5 for a spherical leaf-angle distribution |
| **WAD** | **total** woody surface area per m³ | G = 0.25 for randomly-oriented cylinders |

A leaf is flat, so its "two-sided" area is twice its one-sided area. A branch
has no such doubling — its two-sided area *is* its surface area. Using each
convention's own coefficient makes the two add up: **LAI + WAI = PAI**, and the
summary export reports all three.

Phytograph estimates the wood projection coefficient from the branch axes it can
measure in the cloud, pooled into one value per cloud rather than one per voxel
(a per-voxel estimate is unreliable on short, thick wood and can be worse than
no estimate at all). Where too few reliable axes exist it falls back to the
randomly-oriented value and says so. This matters less than it might sound:
across every achievable branch-angle distribution the coefficient only spans
about ±13%, because a cylinder is symmetric about its axis.

Both LAD and WAD are **absolute** areas, not just a ratio. A discrete-return
scan records the first thing each beam hits, so leaf and wood compete as
independent risks along the path — and for that process the share of returns
that are wood is exactly the share of *interception* that wood is responsible
for. Multiplying that share by the total interception the inversion measured
gives each medium's own area density.

!!! warning "Wood accuracy depends on voxel size"

    The one assumption is that leaf and wood are **mixed** within a voxel. A
    trunk thick enough to block a beam by itself takes nearly every return in
    its footprint, so a voxel large enough to hold both a trunk *and* the
    foliage beside it will misattribute between them. Holding the true areas
    fixed and varying only how the wood is distributed:

    | Wood in the voxel | Wood area error | Leaf area error |
    | --- | --- | --- |
    | Fine twigs, well mixed | −0.2% | ±0.0% |
    | Mostly twigs, small trunk | −6% | −0.2% |
    | Half twigs, half trunk | −21% | −0.9% |
    | Mostly trunk | −53% | −0.6% |

    **Leaf area stays accurate throughout** — wood is the minority component, so
    misattributing it barely moves the leaf number. The split makes LAD *better*,
    never worse.

    For accurate **wood** area the voxel has to be comparable to the trunk, so
    that the trunk fills its footprint rather than competing with foliage inside
    the same cell. Simulated for a 20 cm trunk in a canopy of LAD 2:

    | Voxel side | Trunk fills | Wood area error |
    | --- | --- | --- |
    | 2.0 m | 10% | −20% |
    | 1.0 m | 20% | −23% |
    | 0.5 m | 40% | −20% |
    | 0.25 m | 80% | −8% |
    | 0.15 m | 100% | ±0% |

    Fine woody material in the crown — twigs and small branches — is mixed
    through the foliage and is accurate at any resolution. It is specifically
    trunks and thick scaffold branches that need the fine grid.

    The reason a finer grid is the *only* remedy is that a trunk **saturates**
    the beams that meet it: with a trunk in 5% of a voxel's footprint, 95% of
    the beams never meet wood at all and the few that do are stopped almost
    every time. A saturated return is a lower bound, not a measurement, so no
    reweighting of the beam data can recover what was never sampled.

    If you need woody area for a trunk and cannot use a fine grid, measure it
    structurally instead: a [QSM](qsm.md) fits cylinders to the woody skeleton
    and reports their surface area directly, which is the right tool for
    trunks and the wrong one for foliage.

## Sky/miss points and gapfilling

The inversion measures *gaps* — beams that passed through a voxel without a
return — so it needs to know about the beams that hit the **sky** and returned
nothing at all (the "misses"). Phytograph handles misses three ways, in order of
preference:

1. **Imported misses.** Scans from an [E57 or structured PLY](../reference/file-formats.md#skymiss-points)
   carry real miss points (flagged `is_miss`). The inversion uses them directly.
   Toggle **Show misses** on the scan row to verify they're present — they draw
   in a distinct colour. Until the scan has a scanner [origin](../workflows/simulate-scan.md),
   the misses show at their true (typically far-field) coordinates; once you give
   the scan a scanner origin, they're drawn on a sphere just beyond the farthest
   hit so they stay visible against the cloud.
2. **Gapfilled misses.** A scan with **no** miss points but **a `timestamp`
   column** has its misses recovered automatically at compute time: Phytograph
   reconstructs the scan grid from the pulse timestamps and fills the gaps. It
   reports how many misses it recovered.
3. **No miss information.** A scan with neither miss points nor a timestamp can't
   account for the gaps, so the inversion **cannot run** — it would have no valid
   denominator and would only produce a biased number. Phytograph stops with a
   clear message asking you to re-import the scan from a format that carries misses
   (E57 / structured PLY) or one with a `timestamp` column so misses can be
   gapfilled.

## Reading the result

The result is a grid of translucent voxel cells colored by LAD through
the shared [colormap](../reference/color-modes.md), with a colorbar in
m²/m³. Hover a cell to read its exact LAD, G(θ), and hit count. Empty
voxels (no returns) are hidden by default.

## How certain is the estimate?

Every inversion also reports a **sampling-uncertainty interval** following
Pimont et al. (2018). It depends on the **element width** you set in the
LAD dialog — the characteristic width of a leaf or needle (broadleaf
≈ 0.05 m, conifer ≈ 0.002 m) — which scales the variance without changing
the LAD point estimate.

When you select the result, the panel shows a **group-scale confidence
interval** aggregated over all solved voxels (e.g. *Mean LAD 1.23
[1.15–1.31] m²/m³, 95% CI*). This group-scale interval is the one to
report: per-voxel intervals are routinely ±50–100% and only trustworthy in
narrow regimes, whereas the aggregate is much tighter (typically ±5–10%).

Two caveats worth keeping in mind:

- The interval is **conditional on the beams that entered the voxels**. It
  quantifies sampling noise, not **occlusion bias** — which is screened
  separately, below.
- If the data fall outside the method's validity envelope, no interval is
  reported rather than a misleading one.

## Occlusion

Foliage intercepts beams, so a voxel behind dense canopy is reached by few
beams travelling only a short way through it. Its Beer's-law inversion then
goes wrong in a specific direction: **LAD is overestimated**, increasingly so
as the probed path shortens.

Phytograph screens for this with the **total probed beam path** through each
voxel — the sum, over all beams, of the chord each cut through it. Below a
threshold the voxel is reported as *occluded* rather than measured: excluded
from the leaf-area total and from the group-scale interval, written as NoData
in every export, and drawn in its own colour in the viewer. The default
threshold is **100 × the voxel side length**, the form the criterion takes in
Soma, Pimont & Dupuy (2021).

Occlusion means *beams went in and were stopped short* — some path through the
voxel, but not enough. A voxel that **no beam entered at all** is a different
thing: it lies outside what the scan swept, which is ordinary for the headroom
and margin around a canopy, and it keeps its honest LAD of zero rather than
being counted as occluded. Folding those in would swamp the occlusion figure
with geometry: on a 3 m box drawn around a 1 m canopy, doing so flags 69 % of
the grid, of which only a handful is real occlusion.

### Why not use the confidence interval instead?

It is tempting to screen on the Pimont interval — it is already computed, and a
badly-sampled voxel ought to have a wide one. It does not work, for a reason
worth knowing:

The sampling variance carries a factor *I*(1 − *I*)/*N*, where *N* is the beam
count and *I* the fraction intercepted. Deep occlusion lowers *N*, which widens
the interval — but it also drives *I* toward 1, which *shrinks* that numerator.
The two effects largely cancel. Pushed far enough the interval gets **narrower**
as occlusion worsens: a voxel reached by a handful of nearly-all-intercepted
beams can report a confident-looking interval around a wildly inflated value.

Underneath that is a simpler point: occlusion produces **bias**, and a
confidence interval describes **variance**. An interval is not obliged to cover
a systematic offset, and this one does not. The interval remains the right tool
for what it measures, which is why it is used to *weight* neighbours during
filling — just not to detect occlusion in the first place.

### Filling

Occluded voxels can optionally be estimated from the reliable ones by
**LAD-kriging** (Soma et al. 2020), a kriging variant that treats each donor
voxel's own sampling variance as a known measurement error, so better-measured
neighbours count for more. Filled voxels stay marked as interpolations and
their leaf area is reported apart from the measured total — treating a fill as
data is the very bias the screening exists to remove.

## References

- Pimont, F. et al. (2018). Estimators and confidence intervals for plant area
  density at voxel scale with T-LiDAR. *Remote Sensing of Environment*
  **215**, 343–370.
- Soma, M. et al. (2020). Mitigating occlusion effects in leaf area density
  estimates from terrestrial LiDAR through a specific kriging method. *Remote
  Sensing of Environment* **245**, 111836.
- Soma, M., Pimont, F. & Dupuy, J.-L. (2021). Sensitivity of voxel-based
  estimations of leaf area density with terrestrial LiDAR to vegetation
  structure and sampling limitations. *Remote Sensing of Environment*
  **257**, 112354.

See [Estimate leaf area density](../workflows/estimate-leaf-area-density.md)
for the step-by-step workflow.
