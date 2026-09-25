# Stem detection and tiled tree segmentation

[Tree segmentation](../workflows/segment-trees.md) gives every point a tree
id. On a large plot two things get hard. Nobody wants to click a seed on
hundreds of trunks, and one segmentation over the whole plot outgrows memory
and time. This page specifies the two answers: **automatic stem seeds**, and
**tiled segmentation** that stitches per-tile results into one set of trees.

## Automatic stem seeds

A seed marks one trunk, and each seed becomes exactly one tree (see
[Seeding trunks](../workflows/segment-trees.md#seeding-trunks-optional)).
Automatic seeding finds the trunks for you. It uses the approach TLS stem
detection is built on: in a thin horizontal layer near breast height, stems
are compact, vertical, circular clusters of points, and can be found by
clustering the layer and fitting circles to the clusters (Liang et al.,
2016; Olofsson, Holmgren & Olsson, 2014). The circle fit is the same one the
[tree inventory](tree-inventory.md#circle-fitting) uses for DBH.

**Input.** Real (non-miss), non-ground points whose height above ground is
between **1.0 and 2.0 m**. This needs the `height_above_ground` column from
[Generate DEM](../workflows/generate-dem.md), because a trunk must be found
at a fixed height above the **terrain**, not at a fixed elevation. On a
slope, one elevation cuts one stem at its base and the next at its crown.

1. **Cluster.** Grid the layer's points into 5 cm cells in x, y. Occupied
   cells that touch (8-connectivity) form a cluster. A trunk's cross-section
   is one cluster, and trunks more than a cell apart stay separate.
2. **Screen.** Keep clusters with at least 20 points that are no wider than
   twice the maximum stem diameter (default 3 m).
3. **Vertical continuity.** Split the layer into four 0.25 m sub-layers. A
   stem runs through the whole layer, so a cluster must hold points in at
   least three of them. This rejects a low branch or a clump of leaves that
   touches the layer.
4. **Circle.** Fit a circle to the cluster's x, y points with the robust
   stem fit (RANSAC, then Taubin, then a geometric fit). Accept it when the
   radius is 0.02–1.5 m, the fit is not flagged `high_residual`, it has at
   least 15 inliers, and at least 30% of the cluster's points lie on it.
5. **Same axis twice.** Fit the lower and upper halves of the layer
   separately. A trunk gives two circles whose centres are within
   `max(0.10 m, r)` of each other. A shrub or a leaning branch does not.
   This test is ours, a direct form of the vertical-continuity assumption.
6. **One seed per trunk.** Merge seeds closer than `max(0.30 m, r₁ + r₂)`,
   keeping the one with more inliers.

Each seed sits at the circle's centre, at 1.3 m above the ground. The
detected seeds fill the panel's seed list for you to review, move or delete
before segmenting. Detection misses trunks the scan could not see at breast
height (occluded or cut by the plot edge), and can seed a large dead branch
or a post. It is a first draft for a human, not a final answer.

## Tiled segmentation

Segmentation cost grows with the number of voxels it works on, and one
stage grows with the square of the number of segments. Holding a whole plot
to a manageable voxel count forces coarse voxels on every tree. Tiling
instead cuts the plot into square x, y **tiles**. Each tile is segmented
together with a **buffer** (collar) of its neighbours' points, and every
tree is then kept from exactly one tile. This is the standard way to run a
neighbourhood algorithm over a large extent: process buffered chunks, keep
each chunk's own (core) results, and merge (see
[Large clouds](../developers/architecture/large-clouds.md) for the tile engine).
For trees, "the core's results" has to mean whole trees, not points,
because a tree crosses tile lines:

1. **Anchor.** Every tree found in a tile has an anchor: its seed when
   segmenting with seeds, otherwise the x, y centroid of its lowest 1 m of
   points, which is where its stem meets the ground.
2. **Ownership.** A tree is kept only from the tile whose **core**
   contains its anchor. Cores tile the plane without overlap, so every
   anchor has exactly one owner. A tree cut off by the edge of a tile's
   buffer is thrown away there and kept whole from its own tile.
3. **Claims.** A kept tree claims all its points, including those in
   neighbouring cores. When two kept trees claim one point (two tiles
   disagreeing about a crown boundary), the point goes to the tree from
   the tile in which it lay **farthest from the buffer's outer edge**.
   There the segmentation saw the most of its surroundings.
4. **Ids.** Kept trees are numbered 1..N across the plot. With seeds, a
   tree's id is its seed's number, as in untiled segmentation. Points no
   kept tree claims stay 0 (unassigned).

**The buffer must be wider than any crown's reach from its stem** (default
10 m). A kept tree with points within 0.5 m of its tile's buffer edge may
have been cut off there, unless that edge is the plot's own edge, and the
run reports how many trees that happened to. If the count is not zero,
raise the buffer.

**Consistency across tiles.** Every tile uses the same segmentation
parameters, including the voxel sizes. These are measured once from the
point spacing. Tiling does not coarsen them to fit the whole plot, because
each tile is small enough already.

**When it tiles.** With **Tiling: auto** (the default), segmentation tiles
when the whole plot would exceed the voxel guideline (2 M). **On** always
tiles and **Off** never does. Tiles run in parallel on the worker pool,
within the memory budget. A plot over the guideline is still a long run in
total, so it still asks for confirmation first, saying roughly how many
tiles it will use. You can cancel while it runs.

## References

- Liang, X., Kankare, V., Hyyppä, J., Wang, Y., Kukko, A., Haggrén, H.,
  Yu, X., Kaartinen, H., Jaakkola, A., Guan, F., Holopainen, M. &
  Vastaranta, M. (2016). Terrestrial laser scanning in forest inventories.
  *ISPRS Journal of Photogrammetry and Remote Sensing* 115:63–77.
- Olofsson, K., Holmgren, J. & Olsson, H. (2014). Tree stem and height
  measurements using terrestrial laser scanning and the RANSAC algorithm.
  *Remote Sensing* 6(5):4323–4344.
