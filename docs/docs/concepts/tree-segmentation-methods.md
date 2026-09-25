# Tree segmentation methods

[Segment Trees](../workflows/segment-trees.md) offers two ways to split a cloud
into individual trees. They answer the same question from opposite ends of the
tree, and which one works depends on which end the scan saw.

## TreeIso — from the stems up

TreeIso (Xi & Hopkinson, 2022) runs in three stages:

1. **3D over-segmentation.** The cloud is voxel-decimated and cut into many
   small clusters by cut-pursuit, a graph method that groups points that are
   close together.
2. **2D grouping.** A second cut-pursuit, in plan view, assembles those
   clusters into candidate trees. The **2D reg. strength (λ₂)** controls how
   large these groups grow.
3. **Merging by similarity.** Groups that look like fragments (no stem-like
   base, a small height span) are merged into the neighbour they most resemble.

It relies on seeing trunks and branches, which a terrestrial scan records well.
An airborne scan of a closed canopy records almost none of either. Stage 2 is
then left grouping crown fragments by how close they are in plan view, and
touching crowns are merged. On a 40 × 40 m plantation plot with trees about
3.5 m apart, stage 2 reduced 4,706 well-formed stage-1 clusters to 16 groups
for roughly 90 trees. Of seven settings tried, the best kept 60 of 91 trees
separate, and only by breaking many others into pieces.

## Canopy height — from the crowns down

The canopy height (CHM) method finds each tree where an airborne scan sees it
best, at the top of its crown:

1. **Height above ground.** Every point's height above the terrain. The terrain
   comes from the cloud's labelled ground points when it has them. Otherwise it
   comes from its lowest returns on a 5 m grid, taking the lowest return within
   one cell in each direction, so a cell under an unbroken crown borrows a
   neighbour's ground return instead of reading the crown's underside as ground.
2. **Canopy height model (CHM).** A grid holding the highest point in each
   cell. The cell is one seventh of **Min tree spacing**, fine enough to resolve
   the dip between two neighbouring crowns. It follows the crown size, not the
   point density: a coarser cell for sparser data would merge exactly the trees
   a sparse scan most needs kept apart. Cells no return landed in are filled
   from their nearest neighbour when the hole is at most 1 m wide; wider holes
   are real gaps in the canopy. Small pits, where a pulse slipped through the
   canopy, are filled, and the grid is lightly smoothed (one cell).
3. **Treetops.** Every cell that is the highest within **Min tree spacing** of
   itself, and taller than **Min tree height**, is a treetop. A flat top counts
   as one.
4. **Crowns.** A *watershed* grows each crown outward and downward from its
   treetop until it meets a neighbouring crown in the valley between them. A
   small distance penalty keeps a tall crown from spilling across a shallow
   valley into a shorter neighbour's top.
5. **Points.** Every point takes the ID of the crown above it, so trunks and
   understory under a crown join that tree. Points under no crown (lower than
   **Min tree height**, or in a gap) stay unassigned (`0`).

It needs no trunks and works on the whole cloud in one pass. The
8.4-million-point, 150 × 170 m plantation above takes about 7 seconds.

### What it assumes

- **One top per tree.** A crown with several separate leaders (a multi-stemmed
  tree, a wide flat-topped crown) can be split into several trees. Raise
  **Min tree spacing**, or seed it once.
- **Trees are not stacked.** A tree growing under another's crown is part of
  the taller tree. It is invisible from above, and the CHM is built from above.
- **Crown boundaries are one cell wide.** Points are assigned by the grid cell
  they fall in, so a strip about one **CHM cell** wide along each boundary can
  land in the neighbouring tree.

### Seeds

A seed replaces the automatic treetops within **Min tree spacing** of it, and
all other automatic treetops are kept. So you only need to seed the trees that
came out wrong: two seeds on a merged pair split it, and one seed on a split
crown joins it. A seed on a trunk rather than the exact top still works, as long
as it is inside the crown. Seeded trees are numbered `1`…`n` in the order the
seeds were placed, and the automatic ones follow.

TreeIso seeds differ: each segment is given to its nearest seed, so a seed can
join pieces but cannot split a segment that already holds several trees.

## Which one?

| | TreeIso | Canopy height |
|---|---|---|
| Needs | Visible stems and branches | Visible crown tops |
| Suits | Terrestrial / mobile scans; understorey trees | Airborne / drone scans; closed canopies |
| Fails when | Crowns touch and stems are unseen — trees merge | Trees overtop each other; multi-leader crowns split |
| Speed | Tens of seconds to minutes; tiles large plots | Seconds, any size |
| Main knob | 2D reg. strength (λ₂) | Min tree spacing |

The multi-trunk warning ("instance(s) contain more than one trunk") is a TreeIso
diagnostic. It counts stems in each instance's base, which only means something
when the scan records stems, so it is not run for Canopy height.
