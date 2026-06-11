# Adjust leaf angles

Make a foliated QSM's leaves follow the **real leaf-angle distribution** measured
from a leaf-on LiDAR scan. After [adding leaves](add-leaves.md), their angles are
set only by the phyllotaxis and a fixed pitch. This tool rotates each leaf so
that, **per voxel cell**, the reconstructed leaves match the inclination and
azimuth distribution the scanner actually saw.

!!! info "Phase 2 — measured leaf angles"
    This is the second phase of leaf reconstruction. It uses a **Helios
    triangulation of a leaf-on scan** to measure the per-cell leaf-angle
    distribution, then rotates the QSM's leaves to match it via optimal
    assignment (the "Hungarian" method, after Bailey & Mahaffee). Each leaf
    rotates rigidly **about its base**, so it stays attached where it was placed.

## What you need first

1. A **QSM with leaves** — run [Add leaves to a QSM](add-leaves.md) first.
2. A **leaf-on Helios triangulation with a voxel grid** that overlaps the QSM:
    - Import the leaf-on scan and [build a voxel grid](estimate-leaf-area-density.md)
      around the canopy.
    - Run a [Helios triangulation](triangulate.md) of that scan **with the grid
      selected**. The grid is what splits the leaf surfaces into per-cell
      distributions.

The QSM and the triangulation should be of the **same tree** in the **same world
coordinates** (both come straight from the backend in world space, so a QSM and a
triangulation of the same scan already align).

## How the matching works

For each voxel cell that contains triangulated leaf surface:

1. Phytograph fits the cell's measured leaf angles to a **Beta** distribution
   (inclination) and an **ellipsoidal** distribution (azimuth) — the same forms
   the Helios plant model uses.
2. It samples one target angle per reconstructed leaf in that cell from those
   fitted distributions.
3. It solves the **optimal assignment** between the current leaf normals and the
   sampled targets — the pairing that needs the least total rotation.
4. Each leaf is rotated about its base to its assigned target.

The result is a leaf reconstruction whose leaf-angle distribution matches the scan
at the voxel scale. Leaves in **cells with no measured leaf surface** (or outside
the grid) keep their current angles.

## Run it

1. On the QSM row (with leaves already added), click the **compass** button —
   *Adjust leaf angles*. It appears only when the QSM has leaves **and** at least
   one eligible leaf-on Helios grid triangulation overlaps it.
2. In the dialog, pick the **leaf-on triangulation** to match. The dialog shows
   how many voxel cells and triangles it carries.
3. Optionally set a **random seed** (same seed → reproducible sampling).
4. Click **Adjust Angles**. The leaves are re-placed and rotated to the measured
   distribution; the QSM's leaf mesh updates in place (the leaf count is
   unchanged, and the foliage stays visible).

You can re-run it — against a different triangulation, or with a different seed —
as many times as you like.

## Tips

- **Nothing changed?** Check that the triangulation's grid actually overlaps the
  QSM and that its cells contain leaf triangles — empty cells leave their leaves
  alone. A coarser grid (fewer, larger cells) gives each cell more measured
  leaves to fit.
- **The match looks noisy:** with only a few leaves per cell the fitted Beta /
  ellipsoidal parameters are uncertain. Use a grid sized so each cell holds a
  representative sample of leaf surface.

## What's next

- Read the [QSM concept page](../concepts/qsm.md) for how leaves attach to the
  woody structure.
- Export the foliated, angle-matched model via the QSM export tools.
