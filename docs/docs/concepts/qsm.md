# QSM (Quantitative Structure Model)

A **QSM** is a reconstruction of a woody plant as a set of connected
**cylinders** with fitted **radii** and a rooted **topology**. Where a
[skeleton](skeletons.md) captures the centerline graph, a QSM puts real
wood on it: every segment has a measured radius, so the model carries
volume, surface area, taper, and per-branch diameter — the quantities you
report when you phenotype a tree.

Phytograph's QSM adds one thing many QSM tools don't emphasise:
**continuous shoots classified by shoot rank**.

## Cylinders, shoots, and rank

| Term | What it is |
|---|---|
| **Cylinder** | One short woody segment with two endpoints, a radius, and a parent cylinder. The atomic unit of the model. |
| **Shoot** | A **continuous botanical axis** — a maximal chain of cylinders that follow the same axis straight through every fork where smaller branches peel off. One shoot = one axis. |
| **Shoot rank** | The branching order of a shoot, with **axis continuation**: the **trunk is rank 0**, the **primary scaffolds that leave it are rank 1**, secondaries are rank 2, and so on. |

The defining idea is **axis continuation**. At a fork, one child
*continues* the parent axis (and keeps its rank); the others *branch off*
(and get rank + 1). So a long trunk that has dozens of side branches is
**one** rank-0 shoot, not dozens of trunk segments at escalating orders.

!!! note "Shoot rank is not the Strahler order"
    [Skeletons](skeletons.md) report a **Strahler** branch order, which
    counts from the twigs inward and changes at every junction. **Shoot
    rank** counts from the base outward and stays constant along a
    continuous axis. They answer different questions — Strahler is a
    stream-ordering measure; shoot rank is a horticultural one ("is this
    the trunk, a scaffold, or a secondary?").

## What gets reported

A finished QSM yields a whole-tree horticultural summary and a per-shoot
breakdown:

- **Trunk diameter** and **TCSA** (trunk cross-sectional area) — vigor.
- **Tree height** and **canopy** extent.
- **Scaffold count** — the number of rank-1 shoots.
- **Woody volume**, split into **stem** (rank 0) and **branch** (rank ≥ 1).
- **Per rank**: shoot count, total and mean shoot length,
  length-weighted mean diameter, mean crotch angle, woody volume.
- **Per shoot**: rank, length, and mean diameter.
- **Per cylinder**: endpoints, radius, and two quality numbers — surface
  coverage (how much of it the scanner saw) and fit residual.

## How it's built

The build is a **clean-room, non-ML, deterministic** pipeline — geodesic
skeleton → shoot segmentation and ranking → robust cylinder fitting →
radius correction → metrics. The headline rank assignment uses a
**largest-subtree continuation rule**, and the radius model combines a
monotone per-shoot taper with a pipe-model lower bound so heavily occluded
trunks stay realistically thick.

The full algorithm, design decisions, and hard-coded parameters are
documented in the workflow: [Build a QSM → How it works](../workflows/build-qsm.md#how-it-works).

## Adding leaves (procedural, Phase 1)

A QSM models only the **woody** structure. You can foliate it by placing
leaves on its **terminal shoots** (shoots with no children — the tips of
last year's growth) following the tree's phyllotaxis. The phyllotactic
angle is auto-detected from the branching geometry, since branches emerge
in the same pattern as leaves. This is a forward, procedural step — it adds
biologically plausible foliage from the topology and a few parameters
(spacing, size, pitch), rendered from a leaf texture or 3D model.

That first step places the leaves geometrically. You can then
[adjust their angles](../workflows/adjust-leaf-angles.md) to match the
**measured leaf-angle distribution** from a leaf-on Helios triangulation,
per voxel cell, via optimal assignment.
See [Add leaves to a QSM](../workflows/add-leaves.md).

## QSM vs. skeleton vs. mesh

All three describe a plant's structure, but they answer different
questions:

| Question | Use |
|---|---|
| What's the total branch length / topology? | Skeleton or QSM |
| What's the woody **volume**? | **QSM** |
| What's the **diameter** of each scaffold? | **QSM** |
| Which axis is the trunk vs. a scaffold? | **QSM** (shoot rank) |
| What's the leaf area? | Mesh |
| How does it look in a render? | Mesh |
| How well do two scans align? | Mesh (denser) |

A common workflow on a dormant tree: remove the ground, separate and keep
the wood, then **build a QSM** for the structural metrics — keeping the
cloud in the scene to check the fit against it.

See [Build a QSM](../workflows/build-qsm.md) for the full walkthrough.
