# Crown metrics

A **crown fit** approximates a tree's foliage envelope with a simple
geometric shape and derives structural metrics from it. It answers
questions a bounding box or raw point cloud can't summarise at a glance:
*how tall is the tree, how much space does its crown occupy, where is it
centred, and how wide is it?*

Crown fitting is the geometric counterpart to a
[QSM](qsm.md): a QSM reconstructs the **woody** structure cylinder by
cylinder, while a crown fit characterises the **foliage** as a single
bounding solid. Both are computed per tree.

## The shapes

Four shapes trade off tightness against simplicity:

| Shape | Volume | Notes |
|-------|--------|-------|
| **Ellipsoid** | `4⁄3·π·a·b·c` | Independent X, Y, Z semi-axes from the crown's per-axis spread. Smooth, forgiving. |
| **Rectangular prism** | box volume | The axis-aligned bounding box of the crown. Dimensions are its edge lengths. |
| **Cone** | `1⁄3·π·r²·h` | Upright, apex at the crown top; base radius from the widest (lower) part of the crown. Suits conifers. |
| **Alpha shape** | mesh volume (convex-hull fallback) | A smooth, watertight concave hull that hugs the crown outline — the most faithful shape. The radius auto-grows until the surface closes into one connected component; override it to hug more or less tightly. |

All four shapes are **axis-aligned** — the parametric shapes (ellipsoid,
prism, cone) are fit upright and square to the world axes, so their
reported **dimensions** read directly as *width × depth × height*.

## The metrics

Every fitted crown reports metrics computed from the **fitted shape's
geometry** (so they describe the solid you see, consistently across all
four shapes):

- **Tree height** — the crown top minus the **ground baseline**. When the
  scan carries `ground_class` labels the baseline is the minimum height of
  the labelled ground; otherwise it's the tree's own lowest point. (This
  is measured from the crown *points* — the real tree height — since a
  fitted shape's top can clip, e.g. a cone tip.)
- **Crown volume** — the fitted shape's volume (see the table above).
  Analytic formulas are used for the parametric shapes; the alpha shape
  uses its watertight mesh volume, falling back to the convex-hull volume
  when the mesh isn't closed. The value is never negative.
- **Crown center** — the center of the fitted shape (its bounding-box
  center), in world coordinates.
- **Crown dimensions** — the width, depth, and height of the fitted
  shape's bounding box.
- **Surface area** and the **number of points** the fit used.

## Fuzzy trimming

Real crowns have the occasional branch shooting well outside the general
foliage envelope. If the shape had to bound those outliers it would
enclose a lot of empty space, over-stating the volume and dimensions. The
**fuzziness** parameter controls how aggressively such outliers are
trimmed before fitting:

Fuzziness ranges from `0` to `0.5` (default `0.2`):

- At `0`, the shape **fully encloses** the crown — every point lies on or
  inside the fitted surface, so nothing protrudes.
- As it rises toward `0.5`, the outermost points are dropped more
  aggressively, so a lone branch no longer inflates the fit (the shape may
  then clip that branch).

!!! note "Cones and the crown tip"
    A cone narrows to a point at its apex, so the tapering **top** of a
    crown — where foliage still spreads laterally — can't be enclosed by
    any cone without the base radius exploding. The cone therefore encloses
    everything below the top sliver and clips that tip, by design. The
    ellipsoid, prism, and alpha shape enclose the full crown at
    fuzziness `0`.

The trim works **per vertical slice**: within each horizontal band of the
crown, points whose lateral distance from the vertical axis exceeds a
percentile (set by the fuzziness) are dropped. Trimming by lateral
distance *within a slice* — rather than by raw distance to the centroid —
preserves a crown's natural vertical taper, so a tall or conical crown
isn't decapitated. A floor guarantees the trim can never collapse the
crown to too few points.

## Which points form the crown

- If the scan has **leaf/wood labels** (`wood_class`), the crown is fit to
  the **leaf** points only — the cleanest definition.
- Otherwise the crown is fit to **all non-ground** points, so it includes
  the trunk and branches. (You're warned about this in the setup modal.)

See [Fit a crown & metrics](../workflows/fit-crown.md) to run it, and
[Separate leaf and wood](../workflows/segment-wood.md) to produce the
labels for a leaf-only crown.
