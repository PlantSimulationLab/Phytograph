# Separate leaf and wood

For plant-architecture work — skeletons, QSMs, branch geometry — the
**woody structure** (trunk and branches) needs to be separated from the
**leaves**. Phytograph classifies each point as wood or leaf with no machine
learning and no training step, so it runs locally on any ground-cropped cloud.

There are three methods (see **Method** below):

- **Branch-segment** (the default, recommended) builds a skeleton, breaks it into
  individual **branch segments**, and classifies each *whole segment* by how well
  it fits a cylinder — a real branch wraps a tight cylinder, a clump of leaves
  does not. Classifying segments rather than individual points recovers the thin
  branches a point-wise method drops, without over-segmenting the leaves around
  them. It **requires the ground to be removed** (the skeleton roots at the
  lowest points).
- **Connectivity** roots a skeleton at the trunk base and traces each branch back
  to it (wood = on a continuous path to the trunk). Also needs the ground removed.
- **Geometric** is the original point-wise classifier — each point judged by its
  local 3-D shape (vertical and compact = wood; scattered = leaf). Use it when the
  cloud can't be cleanly ground-removed.

## Segment

1. Crop the ground first (see [Segment ground points](segment-ground.md)) —
   the tool expects a cloud of plant material, not soil.
2. Select a single point cloud.
3. Click **Segment Wood / Leaf** (the tree icon in the tool column), or open
   the command palette and choose **Segment Wood / Leaf**.
4. Adjust the parameters if needed (the defaults work across broadleaf and
   conifer scans):
    - **Method** — **Branch-segment** (default; segment-wise cylinder-fit, best on
      real trees, needs the ground removed), **Connectivity** (skeleton backbone),
      or **Geometric** (local shape only). Use Geometric if the cloud can't be
      cleanly ground-removed, or for a quick shape-based pass on a
      partial/disconnected cloud where a single rooted tree can't be traced.
    - **Wood sensitivity (0–1)** — the wood/leaf decision threshold. Raise it
      to classify more points as wood (catches thin twigs at the cost of some
      leaf bleed); lower it to be stricter about what counts as wood.
    - **Neighbourhood size** — how many neighbours define each point's local
      geometry. Larger is smoother but slower; the default suits typical TLS
      densities.
    - **Smoothing** — how aggressively isolated misclassifications are cleaned
      up by a majority vote over neighbours. **0** disables it.
    - **Use reflectance assist** — *only shown when the cloud carries a
      reflectance or intensity value per point* (e.g. a Riegl `Reflectance`
      column, auto-detected on import). When ticked, the brightest returns —
      which at the scanner wavelength are almost always wood — are recovered as
      wood even where the geometry alone missed them. It is ticked on by default
      when available; see the note below for when to turn it off.
5. Choose the **Output**:
    - **Label in place** — keep every point, add a **Wood Class** attribute,
      and recolour by it.
    - **Split into wood + leaf clouds** — additionally emit two new clouds,
      `… (wood)` and `… (leaf)`, alongside the classified original.
    - **Remove wood (keep leaves only)** — drop the wood points, leaving a
      leaf-only cloud (the classic "wood removal" result).
6. Click **Segment Wood / Leaf**.

### Multiple scans

If you select **more than one scan**, a chooser appears:

- **Segment scans together** — the selected scans are combined into one dense
  cloud, segmented once, and the wood/leaf labels are written back to each
  scan in place. Use this for several **views of a single tree**: merging the
  views gives each point a fuller local neighbourhood, which the classifier
  reads more reliably than a thin single-view cloud. The scans must already be
  in a common coordinate frame — [register](register-compare.md) them first if
  they aren't. (In-memory clouds only; if a selection streams from an octree,
  each is segmented separately.)
- **Segment each scan separately** — classify every selected scan
  independently, in sequence. Use this for **separate trees** that each happen
  to be selected, where each scan is already a complete cloud.

When it finishes, the cloud is recoloured by the **Wood Class** attribute
(dark brown for wood, green for leaf) with a legend in the corner. In
*Label* and *Split* modes the original points are never deleted.

## Inspect and use the result

The classification is stored as a scalar attribute named **Wood Class**. Switch
back to it any time from the **Color by** picker in the Display panel — it shows
discrete colours, not a continuous gradient.

If you chose **Split**, run skeleton extraction or QSM building on the
`… (wood)` cloud alone; if you chose **Remove wood**, the surviving cloud is the
leaves, ready for leaf-area analysis.

!!! note "How accurate is it?"
    On manually-labelled terrestrial-laser scans of real trees (oak, beech,
    maple, pine, spruce) both methods reach roughly **80–90 %** overall accuracy.
    Fine twigs embedded in dense foliage are the usual error source — and that is
    exactly where **Connectivity** helps: by tracing branches back to the trunk it
    recovers thin twigs the geometric method drops, which matters most when the
    result feeds skeleton/QSM extraction (a missed twig breaks a branch). The
    trade is that on very dense crowns it can be slightly less precise overall, so
    if you only need a coarse leaf-removal, **Geometric** can be a touch cleaner.
    Run wood/leaf separation before skeleton/QSM extraction and spot-check in the
    viewer either way.

!!! note "Reflectance assist — when it helps"
    Many terrestrial scanners (e.g. Riegl, 1550 nm) record a **reflectance** or
    intensity value per return, and at that wavelength **wood reflects more
    strongly than foliage**. When the cloud carries that value, the optional
    **reflectance assist** uses only the *brightest* returns — the part of the
    range that is reliably woody — to recover wood the geometry missed (thin
    branches and twigs especially). It never reclassifies a point *away* from
    wood, so it can only help, not flood the result.

    The catch is **species**: the wood-vs-leaf brightness gap is large for some
    species (oak, beech) and weak for others (almond, redbud). On weak-contrast
    species the assist has little signal to work with — it stays mild rather than
    helping, and you may prefer to **untick it**. The classifier auto-limits its
    influence so it is safe to leave on by default, but for a species you know to
    be low-contrast, geometry alone is the better choice. It is not a substitute
    for geometry — it supplements it.

!!! note "Large clouds"
    Clouds imported from XYZ files stream from disk as an octree. Wood/leaf
    segmentation re-reads the original file at full resolution, so the
    classification covers every point — not a downsampled subset. For very large
    clouds the backend can voxel-downsample, classify, and propagate labels back
    to full resolution. The **Connectivity** method builds its skeleton on that
    reduced set, so on very heavily downsampled clouds the traced backbone is
    coarser; for the finest twig recovery, segment before any aggressive
    decimation.
