# Tree inventory measurements

A **tree inventory** turns a segmented forest plot into a tree list: one
row per tree, holding the measurements a forester records in the field
(stem position, DBH, height, crown base, crown size), plus the quality
evidence behind each number. This page is the method specification. Every
measurement below names the definition it follows and the published method
it uses. The defaults are ours, tuned on synthetic stems of known size. See
[Run a tree inventory](../workflows/tree-inventory.md) for the steps.

Each tree is measured from the points that
[tree segmentation](../workflows/segment-trees.md) gave the same
`tree_instance` id. Sky/miss points and deleted points are never used.
All coordinates are **world** coordinates, so any global shift applied at
import has already been added back.

## Ground under the tree

Every height on this page is measured from the **terrain surface (DTM)**,
not from the tree's lowest point. On a slope, the lowest point of a stem
is on its downhill side, so measuring from it would bias every height.
The terrain elevation at any point under a tree comes from the first source that has a value there:

1. **Height above ground.** If [Generate DEM](../workflows/generate-dem.md)
   has written the `height_above_ground` column, each point already
   carries the terrain elevation beneath it (`z − height_above_ground`).
   The ground elevation at the stem comes from a least-squares plane fitted
   through that value for the tree's points within 0.5 m (horizontally) of
   the stem and below 1 m, evaluated at the stem. A median is not used,
   because on a slope the stem points around the base sit unevenly up- and
   downslope of it, which biases a median.
2. **Ground-labeled points.** If only
   [ground segmentation](../workflows/segment-ground.md) has run, the
   ground points are averaged on a 0.5 m grid. The elevation at the stem is
   that grid, inverse-distance weighted over the occupied cells within 2 m.
3. **The tree's own lowest point.** This is the last resort. The row is
   flagged `ground_from_tree_min`, because the value is biased on slopes.

The stem base elevation (the terrain at the stem center) is the reference
for tree height and for the stem curve's heights. Breast height has its own
reference, the uphill side of the stem (see [DBH](#diameter-at-breast-height-dbh)).

The sources are tried in this order for every lookup. A DEM that covers
only part of the plot therefore hands the trees it missed to the ground
labels, not to the last resort. The row's `ground_source` column records
which source gave the stem base.

## Stem axis, stem base and lean

**Stem curve.** A stem curve is the list of stem diameters, and their
center positions, at a series of heights up the stem. Liang et al. (2014)
measure it from TLS by fitting circles to thin cross-sections of the stem.
We do the same in two passes.

1. **Horizontal pass (to find the axis).** Take 0.10 m thick horizontal
   slices every 0.25 m, from 0.5 m to 2.5 m above ground. Fit a circle to
   each slice (see [Circle fitting](#circle-fitting)). The median center of
   the successful fits is the **seed**. Then track the stem upward: each
   slice is searched only within `1.5·r + 0.10 m` of the previous center,
   and a fit is accepted only if its radius stays within 0.5–1.5× the
   previous one and it is not flagged `high_residual`. Tracking stops after two failed slices in a row.
2. **Stem axis.** Fit a straight line through the accepted slice centers
   up to 4 m above ground, by least squares of center x and y on height.
   With fewer than three accepted centers, the axis is vertical through
   the seed.
3. **Perpendicular pass (the reported stem curve).** Cut slices
   **perpendicular to the axis** every 0.5 m of distance along it,
   starting at 0.5 m. A horizontal cut through a leaning cylinder is an
   ellipse, not a circle, and a circle fitted to it overstates the diameter
   by 1/cos(lean). A cut perpendicular to the axis is a true circle. The
   search window follows the previous center, so a gently curved stem is
   still tracked.

**Stem base position.** The stem base is where the stem axis meets the
terrain. It is solved by intersecting the axis with the ground elevation at
the axis's own x, y, by three fixed-point iterations. Its x, y is the
tree's position in the tree list. Stem-mapping from the fitted stem, rather
than from the point centroid, follows Liang et al. (2016) and
Olofsson et al. (2014).

**Lean** is the angle between the stem axis and the vertical:
`lean = atan(√(bx² + by²))`, where `bx`, `by` are the axis slopes
(meters of horizontal offset per meter of height). The **lean azimuth** is
the compass direction the stem leans toward: degrees clockwise from +y
(grid north). It is left blank when the lean is below 0.5°.

## Diameter at breast height (DBH)

**Breast height is 1.3 m** above the ground, the convention in countries
using SI units. The US convention of 4.5 ft (1.37 m) is a setting
(Kershaw et al., 2016; West, 2009). The textbook rules for where to measure
are followed:

- **On a slope**, breast height is measured from the ground on the
  **uphill side** of the tree (Kershaw et al., 2016), that is, from the
  highest ground level at its base (West, 2009). The uphill ground is the
  highest DTM elevation around the stem's perimeter, sampled at 16 points
  on a circle of the stem's radius around the stem base. It is reported as
  `breast_height_ref_z`.
- **On a leaning tree**, breast height is measured parallel to the lean,
  and the diameter perpendicular to the stem's axis (Kershaw et al., 2016).
  The DBH slice is therefore centered on the stem axis, 1.3 m **along the
  axis** from the axis point level with the uphill ground, and cut
  **perpendicular to the axis**.

On flat ground with a vertical stem, all of this reduces to a horizontal
slice 1.3 m above the stem base.

The breast-height slice is 0.10 m thick. If it holds fewer than 20 points,
it is widened to 0.20 m and then to 0.30 m, and the thickness used is
reported.

### Circle fitting

Stem cross-sections are circles contaminated by branches, leaves, and the
occluded back of the stem. The fit therefore has two stages: a robust
search that finds the stem's points, then a precise fit to those points.

1. **Robust search.** One of two methods, chosen in the tool:
    - **RANSAC** (Fischler & Bolles, 1981), the default. Repeatedly fit a
      circle exactly through 3 random points and count the points within
      the inlier distance (default 0.02 m) of it. Keep the circle with the
      most inliers. The number of trials adapts to the best inlier ratio
      *w* found so far, `N = log(1 − 0.99) / log(1 − w³)`, capped at 2000.
    - **Randomized Hough transform** (Xu, Oja & Kultanen, 1990). Map 3
      random points to one point `(a, b, r)` in parameter space and vote
      for its cell in a sparse accumulator (cell 0.01 m). Take the cell with
      the most votes after 2000 samples as the candidate. Its inliers are
      the points within the inlier distance of it.

    Both reject candidate circles with radii outside 0.02–1.5 m. Both use
    a fixed random seed, so the same tree always gives the same answer.

2. **Precise fit on the inliers.**
    - **Taubin's algebraic fit** (Taubin, 1991) gives the starting circle.
      Algebraic fits have a closed form, but Kåsa's fit (Kåsa, 1976)
      underestimates the radius when only part of the circle is visible.
      Taubin's fit has a much smaller bias (Al-Sharadqah & Chernov, 2009),
      which matters for TLS stems, where the far side of the trunk is
      always occluded.
    - The **geometric fit** then minimizes the sum of squared orthogonal
      distances `Σ(‖pᵢ − c‖ − r)²` by Levenberg–Marquardt, starting from
      Taubin's circle (Chernov & Lesort, 2005; Chernov, 2010). This is
      the reported circle.
    - Inliers are recomputed against the geometric circle and the
      geometric fit is repeated once.

### Quality evidence

Every circle (DBH and each stem-curve slice) reports:

| Field | Meaning |
|-------|---------|
| `rms_m` | Root-mean-square orthogonal residual of the inliers, in meters. |
| `arc_coverage` | Fraction of 36 angular sectors (10° each) around the fitted center that hold at least one inlier. 1.0 = the whole circumference was seen. |
| `max_gap_deg` | Largest empty angular gap between inliers, in degrees. |
| `n_points`, `n_inliers` | Points in the slice, and inliers of the fit. |

A circle fitted to a short arc is poorly constrained. As the arc shrinks,
the bias and instability of every circle fit grow (Chernov & Lesort, 2005;
Al-Sharadqah & Chernov, 2009), and the radius can trade off against the
position of the center. Arc coverage is therefore reported for every fit.
Arc coverage and the flag thresholds below are our own quality measures,
tuned on synthetic stems; they are not taken from a published standard.
DBH carries these flags:

| Flag | Raised when |
|------|-------------|
| `few_points` | fewer than 20 inliers |
| `partial_arc` | arc coverage below 0.5 (less than half the circumference seen) |
| `high_residual` | `rms_m` above `max(0.01 m, 0.1·r)` |
| `no_stem` | no circle could be fitted at breast height; DBH is blank |

A flagged DBH is still reported. The flag is the warning, and the value is
not silently dropped.

A stem-curve row is `ok = false` when its fit has `few_points` or
`high_residual`, or when its radius is outside 0.5–1.5× the previous ok
slice's radius (a jump no stem makes in 0.5 m, usually a branch or a
neighbor's stem). `partial_arc` does **not** make a slice not-ok. Seeing
about half of each stem is the normal case for a single scan position, and
the fits stay accurate there. Only ok slices steer the tracking up the
stem, and only ok slices define the stem radius that separates stem from
crown.

## Height

Tree height is the highest point of the tree minus the ground elevation at
the stem base. TLS tends to underestimate height, because the top of a tall
tree is often occluded or only sparsely hit (Liang et al., 2018). The value
is what the points show. It is not corrected.

## Crown

The crown is the tree's points that are **not stem**. A point is stem if
its perpendicular distance to the stem axis is within the stem radius at
its height plus `max(0.10 m, 0.5·r)`. The stem radius at a given height is
interpolated from the stem curve, and the last radius is held above it.
This test uses only geometry, so it works on leaf-off scans and does not
need [leaf/wood labels](../workflows/segment-wood.md).

**Crown base height.** Definitions of the crown base vary. One convention
in the mensuration literature is the first whorl of branches with live
foliage in **at least 3 of the 4 quadrants** around the stem
(Kershaw et al., 2016). LiDAR methods find the crown base from the vertical
distribution of a tree's returns (Popescu & Zhao, 2008). We combine the
two, with a decision rule of our own:

1. Bin the crown points by height (0.2 m bins). A bin is "occupied" if it
   holds at least 5% as many points as the fullest bin.
2. Walk down from the top occupied bin. Stop at the first empty stretch of
   **1.0 m or more**. The occupied bins above that stretch are the
   continuous crown. Isolated low branches below such a gap are excluded.
3. Within the continuous crown, the base is the lowest bin whose points
   occupy **at least 3 of the 4 quadrants** around the stem axis. A
   quadrant counts when it holds at least 5% of that bin's points. This
   keeps a one-sided branch just below the crown from becoming its base.

The value is reported as height above the stem-base ground.

**Crown projected area** is the area of the convex hull of the crown
points projected onto the horizontal plane. It is the laser-scanning
counterpart of the field crown projection (Fleck et al., 2011), and convex
hulls are an established way to compute it from point clouds
(Lin et al., 2017).

**Crown diameter.** Two values are reported:

- `crown_diameter_mean_m` is the mean of the widest crown width and the
  width at right angles to it. This follows the field convention of
  measuring the crown at its widest point and again at right angles, and
  averaging the two (Kershaw et al., 2016). The two widths are reported as
  `crown_max_width_m` and `crown_perp_width_m`.
- `crown_diameter_equiv_m` is the diameter of the circle with the same
  area as the projection, `2·√(A/π)`.

**Crown eccentricity.** Two meanings are in use, and both are reported:

- `crown_offset_m` / `crown_offset_azimuth_deg` give the horizontal
  distance, and direction, from the stem base to the centroid of the crown
  projection. Crown asymmetry, in both direction and degree, is used as a
  measure of competition between trees (Seidel et al., 2011). This offset is
  our way of expressing it.
- `crown_ellipse_eccentricity` describes the shape of the projection. It
  is `√(1 − λ₂/λ₁)`, where λ₁ ≥ λ₂ are the principal second moments of the
  hull polygon. 0 is a circle, and values near 1 are a long, narrow crown.

**Voxel crown volume.** Divide space into cubes (default 0.10 m) and count
the cubes that hold at least one crown point. Multiply the count by the
volume of one cube (Hosoi & Omasa, 2006). The result depends on the cube
size: smaller cubes approach the volume actually occupied by returns, and
larger cubes approach an envelope. The cube size is reported with the
result.

## Derived per-tree values

- **Basal area** `g = π/4 · DBH²` (m², DBH in meters). This is the
  cross-sectional area of the stem at breast height (Kershaw et al., 2016).
- **Slenderness** is the ratio of total height to DBH
  (Wang, Titus & LeMay, 1998), both in meters, so it has no units.

Both are left blank when DBH has the `no_stem` flag.

## References

- Al-Sharadqah, A. & Chernov, N. (2009). Error analysis for circle fitting
  algorithms. *Electronic Journal of Statistics* 3:886–911.
- Chernov, N. (2010). *Circular and Linear Regression: Fitting Circles
  and Lines by Least Squares*. CRC Press.
- Chernov, N. & Lesort, C. (2005). Least squares fitting of circles.
  *Journal of Mathematical Imaging and Vision* 23(3):239–252.
- Fischler, M.A. & Bolles, R.C. (1981). Random sample consensus: a
  paradigm for model fitting with applications to image analysis and
  automated cartography. *Communications of the ACM* 24(6):381–395.
- Fleck, S. et al. (2011). Comparison of conventional eight-point crown
  projections with LIDAR-based virtual crown projections in a temperate
  old-growth forest. *Annals of Forest Science* 68(7):1173–1185.
- Hosoi, F. & Omasa, K. (2006). Voxel-based 3-D modeling of individual
  trees for estimating leaf area density using high-resolution portable
  scanning lidar. *IEEE Transactions on Geoscience and Remote Sensing*
  44(12):3610–3618.
- Kåsa, I. (1976). A circle fitting procedure and its error analysis.
  *IEEE Transactions on Instrumentation and Measurement* IM-25(1):8–14.
- Kershaw, J.A., Ducey, M.J., Beers, T.W. & Husch, B. (2016). *Forest
  Mensuration*, 5th ed. Wiley-Blackwell.
- Lin, W., Meng, Y., Qiu, Z., Zhang, S. & Wu, J. (2017). Measurement and
  calculation of crown projection area and crown volume of individual
  trees based on 3D laser-scanned point-cloud data. *International Journal
  of Remote Sensing* 38(4):1083–1100.
- Liang, X. et al. (2014). Automated stem curve measurement using
  terrestrial laser scanning. *IEEE Transactions on Geoscience and Remote
  Sensing* 52(3):1739–1748.
- Liang, X. et al. (2016). Terrestrial laser scanning in forest
  inventories. *ISPRS Journal of Photogrammetry and Remote Sensing*
  115:63–77.
- Liang, X. et al. (2018). International benchmarking of terrestrial
  laser scanning approaches for forest inventories. *ISPRS Journal of
  Photogrammetry and Remote Sensing* 144:137–179.
- Olofsson, K., Holmgren, J. & Olsson, H. (2014). Tree stem and height
  measurements using terrestrial laser scanning and the RANSAC algorithm.
  *Remote Sensing* 6(5):4323–4344.
- Popescu, S.C. & Zhao, K. (2008). A voxel-based lidar method for
  estimating crown base height for deciduous and pine trees. *Remote
  Sensing of Environment* 112(3):767–781.
- Seidel, D. et al. (2011). Crown plasticity in mixed forests — quantifying
  asymmetry as a measure of competition using terrestrial laser scanning.
  *Forest Ecology and Management* 261(11):2123–2132.
- Taubin, G. (1991). Estimation of planar curves, surfaces, and nonplanar
  space curves defined by implicit equations with applications to edge
  and range image segmentation. *IEEE Transactions on Pattern Analysis and
  Machine Intelligence* 13(11):1115–1138.
- Wang, Y., Titus, S.J. & LeMay, V.M. (1998). Relationships between tree
  slenderness coefficients and tree or stand characteristics for major
  species in boreal mixedwood forests. *Canadian Journal of Forest
  Research* 28(8):1171–1183.
- West, P.W. (2009). *Tree and Forest Measurement*, 2nd ed. Springer.
- Xu, L., Oja, E. & Kultanen, P. (1990). A new curve detection method:
  randomized Hough transform (RHT). *Pattern Recognition Letters*
  11(5):331–338.
