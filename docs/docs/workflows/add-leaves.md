# Add leaves to a QSM

Turn a bare [QSM](build-qsm.md) into a **foliated reconstruction**: leaves
are placed on the tree's terminal shoots following its phyllotaxis, using a
leaf texture (or 3D model) you choose. This is a procedural,
forward-modelling step — it adds biologically plausible foliage on top of
the measured woody structure.

!!! info "Phase 1 — procedural placement"
    This first phase places leaves **geometrically** from the QSM topology and a
    few parameters, with angles set by the phyllotaxis and a fixed pitch. To then
    match the leaves to a **measured leaf-angle distribution** from a leaf-on
    scan, continue with [Adjust leaf angles](adjust-leaf-angles.md). The leaf
    orientation conventions here follow the Helios plant-architecture plugin, so
    that step slots in cleanly.

## Where leaves go

Leaves are placed on the **current-year growth** of every shoot — the
distal stretch from its furthest-out branch fork to the tip. A shoot with no
branches is leafed end to end; a shoot that forks midway is leafed only on
the bare portion *beyond its last branch*, while the older wood below the
forks stays bare. This captures the outermost twigs, the terminating tip of
a lower-rank axis (such as the central leader's own tip), **and** the leafy
tip of a branch that itself carries sub-branches. Along each leafed stretch,
leaves are spaced at a fixed interval and rotated around the shoot by the
**phyllotactic angle**, and are pushed just clear of the branch surface so
the blades don't intersect the tube.

## Inputs

You need a **built QSM** in the scene. Build one first if you haven't — see
[Build a QSM](build-qsm.md). Leaves attach to that QSM and travel with it
(hide or delete the QSM and its leaves go too).

## Run it

1. In the **QSM** results panel, find your QSM row and click the **+**
   (Add leaves) button.
2. The **Add Leaves** dialog opens and immediately **auto-detects the
   phyllotaxis** from the branching geometry (see below). The detected
   angle and leaves-per-node are pre-filled and remain editable.
3. Choose the leaf appearance:
    - **Built-in texture** — pick a tree leaf from the curated list
      (almond, apple, walnut, pistachio, olive, grape, redbud). The leaf is
      drawn as a flat, texture-mapped blade with the image's transparency
      cutting out its silhouette.
    - **Upload PNG** — supply your own leaf image (transparent background
      recommended; the alpha channel is the cutout).
    - **Upload OBJ** — supply a 3D leaf model (with its materials/textures).
      The model is instanced at every leaf position.
4. Set the parameters:
    - **Leaf spacing (m)** — distance between successive leaf nodes along a
      shoot.
    - **Leaf size (m)** — physical leaf length (the width follows the
      texture's aspect ratio).
    - **Leaf pitch (°)** — the leaf's angle from the shoot axis; 90° points
      straight out from the branch, 0° lies along it.
    - **Leaves per node** — 1 for alternate/spiral, 2 for opposite or
      decussate (inferred from the detected pattern, editable).
    - **Phyllotactic angle (°)** — the azimuthal turn between successive
      nodes.
5. The footer shows an **estimated leaf count** from the terminal-shoot
   lengths and spacing. Click **Add Leaves** to generate them.

The leaves render on the QSM, and the QSM row gains a leaf count and a
**leaf-visibility toggle** (the sprout icon) so you can show or hide the
foliage independently of the woody model.

## Phyllotaxis auto-detection

Branches emerge in the same phyllotactic pattern as leaves, so the QSM
already encodes the angle — Phytograph reads it back. For each branching
point, it measures the azimuths of the child shoots around the parent axis
and finds which canonical angle best explains them:

| Angle | Pattern | Leaves per node |
|---|---|---|
| 180° | Opposite | 2 |
| 137.5° | Spiral (golden angle) | 1 |
| 144° / 150° | Spiral | 1 |
| 90° | Decussate | 2 |

Because **not every vegetative bud breaks**, some lattice positions are
empty — a branch may be missing where a leaf would have been. The detector
accounts for this (a skipped bud is treated as an absent lattice point, not
a wrong angle), so a sparse branch sample still recovers the right pattern.
A **confidence** is reported alongside the angle; spiral angles in
particular are hard to pin down from only a few branches, so the value is
always editable — override it if you know the species' phyllotaxis.

## Tips

- **Too many leaves / slow:** increase the leaf spacing. The estimate in
  the footer updates live.
- **Leaves look too big or too small:** adjust *Leaf size*; it sets the
  blade length directly in meters.
- **Foliage hides the wood:** use the sprout toggle on the QSM row to hide
  the leaves while you inspect the cylinders.

## What's next

- [Adjust the leaf angles](adjust-leaf-angles.md) to match a measured leaf-angle
  distribution from a leaf-on Helios triangulation.
- Read the [QSM concept page](../concepts/qsm.md) for how shoots and ranks
  define which shoots are terminal.
- Export the foliated model via the QSM export tools.
