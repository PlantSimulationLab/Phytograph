# Separate leaf and wood

For plant-architecture work — skeletons, QSMs, branch geometry — the
**woody structure** (trunk and branches) needs to be separated from the
**leaves**. Phytograph classifies each point as wood or leaf from its local
3-D geometry alone, with no machine learning and no training step, so it runs
locally on any ground-cropped cloud.

The method reads two cues that hold across species: wood is **vertical and
locally compact** (trunk and branches are smooth cylinders), while foliage
**scatters the local neighbourhood in 3-D** and hangs at varied angles. It does
*not* rely on points being "linear", because branches and many leaves
(needles, narrow blades) are both linear — that cue can't tell them apart.

## Segment

1. Crop the ground first (see [Segment ground points](segment-ground.md)) —
   the tool expects a cloud of plant material, not soil.
2. Select a single point cloud.
3. Click **Segment Wood / Leaf** (the tree icon in the tool column), or open
   the command palette and choose **Segment Wood / Leaf**.
4. Adjust the parameters if needed (the defaults work across broadleaf and
   conifer scans):
    - **Wood sensitivity (0–1)** — the wood/leaf decision threshold. Raise it
      to classify more points as wood (catches thin twigs at the cost of some
      leaf bleed); lower it to be stricter about what counts as wood.
    - **Neighbourhood size** — how many neighbours define each point's local
      geometry. Larger is smoother but slower; the default suits typical TLS
      densities.
    - **Smoothing** — how aggressively isolated misclassifications are cleaned
      up by a majority vote over neighbours. **0** disables it.
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
    maple, pine, spruce) the classifier reaches roughly **80–90 %** overall
    accuracy. Fine twigs embedded in dense foliage are the usual error source.
    For the best woody reconstruction, run it before skeleton/QSM extraction and
    spot-check the result in the viewer.

!!! note "Large clouds"
    Clouds imported from XYZ files stream from disk as an octree. Wood/leaf
    segmentation re-reads the original file at full resolution, so the
    classification covers every point — not a downsampled subset. For very large
    clouds the backend can voxel-downsample, classify, and propagate labels back
    to full resolution.
