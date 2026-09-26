# Stand metrics

A [tree inventory](tree-inventory.md) measures trees one at a time. Stand
metrics summarise the whole plot: how many stems per hectare, how much
basal area, how tall the canopy is, how much ground the crowns cover, how
crowded each tree is by its neighbours, and (optionally) how much biomass
the plot holds. This page is the method specification; every definition
names its source. See [Run a tree inventory](../workflows/tree-inventory.md#stand-summary)
for the steps.

## Which trees count

The stand figures use the trees that have a DBH at or above the **minimum
DBH** (default 5 cm, a setting). Trees you have marked **dead** in the Tree
Table are left out unless you untick *Exclude dead trees*. Every figure
updates as you change these, or as you edit a tree's status.

Inventories use different minimum diameters, and stems/ha in particular
depends strongly on the threshold. Compare stands only at the same minimum.

## Plot area

Every per-hectare figure divides by the plot area `A` (m²). By default
Phytograph measures it as the area of the **convex hull of the plot's
ground points** (or of all its points, when there are no ground labels).
If your plot has a known surveyed area, enter it instead. The summary says
which area it used.

!!! warning "Edge effects"
    A scanned plot has no clean edge. Trees near the boundary have crowns
    and competitors outside it, and the scanned area rarely matches a
    surveyed plot exactly. The treatment of trees and crowns cut by the plot
    edge measurably changes plot-level estimates, and the effect grows as
    plots get smaller (Mascaro et al., 2011). For small plots, prefer an
    entered surveyed area. Treat the edge-flagged competition values (see
    below) as underestimates.

## Stand summary

With `N` trees of diameter `dᵢ` (m), basal area `gᵢ = π/4 · dᵢ²` and
height `hᵢ`:

| Metric | Definition | Source |
|--------|------------|--------|
| **Stems per hectare** | `N / A · 10⁴` | Kershaw et al. (2016); West (2009) |
| **Basal area per hectare** | `Σgᵢ / A · 10⁴` (m²/ha) | Kershaw et al. (2016); West (2009) |
| **Quadratic mean diameter (QMD)** | `√(Σdᵢ² / N)`: the diameter of the tree of mean basal area | Curtis & Marshall (2000) |
| **Lorey's mean height** | `Σgᵢhᵢ / Σgᵢ`: height weighted by basal area | Lorey (1878), as given by Curtis & Marshall (2000) |
| **Mean** and **maximum height** | arithmetic mean and maximum of `hᵢ` | — |

QMD rather than the arithmetic mean diameter is the diameter that relates
directly to basal area: `BA = N · π/4 · QMD²`. It is always at least the
arithmetic mean, since `QMD² = mean² + variance` (Curtis & Marshall, 2000).
Lorey's height weights big trees more, which makes it the right mean height
for stand volume (Curtis & Marshall, 2000).

**Diameter and height distributions** are histograms of the stand trees in
classes of a chosen width: 5 cm DBH and 2 m height by default.

## Canopy cover

**Canopy cover** is the area of ground covered by the vertical projection
of the canopy (Jennings, Brown & Sheil, 1999), as a fraction of the plot:

```text
canopy cover = area(union of crown projections ∩ plot) / A
```

The crown projections are the convex hulls from the tree inventory. Each
is clipped to the plot, and their union is measured on a 0.1 m raster, so
the error is at most one cell width along the crowns' outline. On a very
large plot, over about 20 million cells at 0.1 m, the cell grows to keep
memory bounded. The cell used is reported with the result. Every measured crown counts, whatever the stand
filters, because cover describes the canopy, not the tree list.

Canopy cover is not canopy *closure*, which is the fraction of the sky
hemisphere obscured when viewed from one point (Jennings et al., 1999). The
summary also reports the **summed crown area**, `Σ crown projection area`.
It exceeds the union wherever crowns overlap.

## Competition

Each tree gets three measures of how crowded it is.

**Hegyi's index** (Hegyi, 1974), in the form stated by Lorimer (1983):

```text
CIᵢ = Σⱼ (Dⱼ / Dᵢ) / distᵢⱼ
```

The sum runs over every other tree `j` with a DBH whose stem base lies
within the **search radius** of tree `i`'s stem base. Competition and canopy
cover need every tree, so a run restricted to some trees skips them. `D` is DBH, and
`dist` is the horizontal distance between stem bases in metres (floored at
0.1 m). Large, near neighbours raise the index; a tree that dominates its
neighbours has a low one. The search radius is a setting (default 6 m; the
default is ours). The index depends on it, so compare indices only at the
same radius. `n_competitors` counts the trees inside the radius.

**Crown overlap.** `crown_overlap_m2` is the sum of the areas where this
tree's crown projection overlaps each other tree's. The crowns are convex,
so each overlap is an exact convex-polygon intersection.
`crown_overlap_fraction` is the share of this tree's own crown projection
covered by at least one other crown (sampled on a 0.1 m grid). Crown overlap
here is a geometric description of the projections. TLS studies of crown
competition model crowns in 3-D (Seidel et al., 2011; Metz et al., 2013).
The classic field index from overlapping zones of influence is
Bella's (1971).

**Edge flag.** `edge` is true when the search circle reaches past the plot
boundary. Competitors outside the plot are then missing, so the index is an
underestimate (see *Edge effects* above).

## Biomass (optional)

Above-ground biomass (AGB, kg oven-dry mass) per tree, summed to the stand
and divided by the plot area for Mg/ha. Choose one method; it applies to
every tree:

**Chave et al. (2014), pantropical:**

```text
AGB = 0.0673 · (ρ D² H)^0.976
```

`D` is DBH in cm, `H` height in m, and `ρ` wood density in g/cm³. It is
fitted to 4,004 harvested trees from 58 tropical sites, with D from 5 to
212 cm. It is for **tropical** trees, and underestimates by about 20% for
the very largest (over 30 Mg) (Chave et al., 2014).

**Jenkins et al. (2003), United States species groups:**

```text
AGB = exp(β₀ + β₁ ln D)
```

`D` is DBH in cm. The equations cover trees of 2.5 cm DBH and up. Choose
one of the ten species groups; its coefficients (Jenkins et al., 2003,
Table 4) apply to every tree:

| Group | β₀ | β₁ | Max DBH (cm) |
|-------|----|----|--------------|
| Aspen / alder / cottonwood / willow | −2.2094 | 2.3867 | 70 |
| Soft maple / birch | −1.9123 | 2.3651 | 66 |
| Mixed hardwood | −2.4800 | 2.4835 | 56 |
| Hard maple / oak / hickory / beech | −2.0127 | 2.4342 | 73 |
| Cedar / larch | −2.0336 | 2.2592 | 250 |
| Douglas-fir | −2.2304 | 2.4435 | 210 |
| True fir / hemlock | −2.5384 | 2.4814 | 230 |
| Pine | −2.5356 | 2.4349 | 180 |
| Spruce | −2.0773 | 2.3323 | 250 |
| Woodland (juniper / oak / mesquite) | −0.7152 | 1.7029 | 78 |

No log-bias correction is applied, as in the published equations. Trees
larger than the group's maximum DBH are still estimated, but the tree
count beyond that range is reported. Chojnacky, Heath & Jenkins (2014)
update these equations with more groups.

**QSM volume × wood density:**

```text
AGB = V · ρ · 1000
```

`V` is the tree's woody volume in m³ from its
[QSM](qsm.md) (see *Batch QSM* below), and `ρ` is the basic wood density in
g/cm³. On 65 harvested eucalypts this estimate agreed with the weighed
biomass far better than allometric equations did (concordance 0.98 against
0.68–0.78; Calders et al., 2015). It needs a QSM per tree, and a QSM needs
a well-scanned woody structure.

`ρ` is one value for the whole stand (a setting, default 0.5 g/cm³). In a
mixed stand it is an average, and biomass inherits its error.

A tree the chosen method cannot estimate (no DBH, no height, no QSM) is
left out of the total, and the summary says how many were.

## Batch QSM

A [QSM](qsm.md) can be built for every segmented tree in one run. Each tree
is read from the cloud separately (as in the inventory). If the cloud
carries [leaf/wood labels](../workflows/segment-wood.md), only the **wood**
points are used, since a QSM models the woody structure. A tree with more
points than the per-tree budget (default 60,000, as for a single QSM) is
thinned on a voxel grid, which keeps the point spacing even; taking every
k-th point would keep the scan's near-range density bias. The QSM
reconstruction itself is the same pipeline as a single QSM. Each tree's
metrics (woody volume, trunk diameter, height, branch counts) join its
table row and export as a QSM metrics CSV, and each model is added to the
scene.

## References

- Bella, I.E. (1971). A new competition model for individual trees.
  *Forest Science* 17(3):364–372.
- Calders, K., Newnham, G., Burt, A., Murphy, S., Raumonen, P., Herold, M.,
  Culvenor, D., Avitabile, V., Disney, M., Armston, J. & Kaasalainen, M.
  (2015). Nondestructive estimates of above-ground biomass using
  terrestrial laser scanning. *Methods in Ecology and Evolution*
  6(2):198–208.
- Chave, J. et al. (2014). Improved allometric models to estimate the
  aboveground biomass of tropical trees. *Global Change Biology*
  20(10):3177–3190.
- Chojnacky, D.C., Heath, L.S. & Jenkins, J.C. (2014). Updated generalized
  biomass equations for North American tree species. *Forestry*
  87(1):129–151.
- Curtis, R.O. & Marshall, D.D. (2000). Technical note: Why quadratic mean
  diameter? *Western Journal of Applied Forestry* 15(3):137–139.
- Hegyi, F. (1974). A simulation model for managing jack-pine stands. In:
  Fries, J. (ed.) *Growth Models for Tree and Stand Simulation*. Royal
  College of Forestry, Stockholm, Research Notes 30, pp. 74–90.
- Jenkins, J.C., Chojnacky, D.C., Heath, L.S. & Birdsey, R.A. (2003).
  National-scale biomass estimators for United States tree species.
  *Forest Science* 49(1):12–35.
- Jennings, S.B., Brown, N.D. & Sheil, D. (1999). Assessing forest
  canopies and understorey illumination: canopy closure, canopy cover and
  other measures. *Forestry* 72(1):59–74.
- Kershaw, J.A., Ducey, M.J., Beers, T.W. & Husch, B. (2016). *Forest
  Mensuration*, 5th ed. Wiley-Blackwell.
- Lorey, T. (1878). Die mittlere Bestandeshöhe. *Allgemeine Forst- und
  Jagdzeitung* 54:149–155.
- Lorimer, C.G. (1983). Tests of age-independent competition indices for
  individual trees in natural hardwood stands. *Forest Ecology and
  Management* 6:343–360.
- Mascaro, J., Detto, M., Asner, G.P. & Muller-Landau, H.C. (2011).
  Evaluating uncertainty in mapping forest carbon with airborne LiDAR.
  *Remote Sensing of Environment* 115(12):3770–3774.
- Metz, J., Seidel, D., Schall, P., Scheffer, D., Schulze, E.-D. &
  Ammer, C. (2013). Crown modeling by terrestrial laser scanning as an
  approach to assess the effect of aboveground intra- and interspecific
  competition on tree growth. *Forest Ecology and Management* 310:275–288.
- Seidel, D., Leuschner, C., Müller, A. & Krause, B. (2011). Crown
  plasticity in mixed forests — quantifying asymmetry as a measure of
  competition using terrestrial laser scanning. *Forest Ecology and
  Management* 261(11):2123–2132.
- West, P.W. (2009). *Tree and Forest Measurement*, 2nd ed. Springer.
