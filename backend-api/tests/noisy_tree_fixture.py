"""Synthetic noisy tree — the fixture that encodes the noise-filter design argument.

Deliberately BIMODAL in density, because that is the property that separates the
three noise methods:

  * trunk   — a dense cylinder shell at 1 cm spacing (the dense mode)
  * twigs   — 12 thin branches at 5 cm spacing (the SPARSE mode: ~10% of points,
              5x coarser). This is the fine peripheral structure a plant app must
              not lose, and the population SOR at std_ratio=2.0 destroys.
  * flyers  — 25 isolated points, each >= 1 m from anything else. Genuine noise:
              every method must flag exactly these.
  * clump   — 8 points in a 2 cm ball, 1 m off the tree. Noise that SUPPORTS
              ITSELF, so neither ROR nor the voxel rule flags it. Documents the
              known gap that small-cluster removal would close.

Deterministic: no RNG, everything on a fixed lattice.

Run as a script to (re)generate the E2E fixture:
    python -m tests.noisy_tree_fixture ../tests/e2e/fixtures/noisy-tree.xyz
"""

from __future__ import annotations

import numpy as np

TRUNK_RADIUS = 0.10
TRUNK_HEIGHT = 0.50
TRUNK_SPACING = 0.01

N_BRANCHES = 12
BRANCH_POINTS = 30
BRANCH_SPACING = 0.05

N_FLYERS = 25
CLUMP_POINTS = 8
CLUMP_RADIUS = 0.02


def build_noisy_tree() -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Return ``(points (N,3), groups)`` where `groups` maps each population name
    to the row indices it occupies. Row order is trunk, twigs, flyers, clump."""
    parts: list[np.ndarray] = []

    # --- trunk: dense cylinder shell -----------------------------------------
    n_ring = int(round(2 * np.pi * TRUNK_RADIUS / TRUNK_SPACING))
    n_rows = int(round(TRUNK_HEIGHT / TRUNK_SPACING))
    theta = np.arange(n_ring) * (2 * np.pi / n_ring)
    z = np.arange(n_rows) * TRUNK_SPACING
    tt, zz = np.meshgrid(theta, z, indexing="ij")
    trunk = np.column_stack([
        TRUNK_RADIUS * np.cos(tt).ravel(),
        TRUNK_RADIUS * np.sin(tt).ravel(),
        zz.ravel(),
    ])
    parts.append(trunk)

    # --- twigs: sparse branches fanning out and up from the trunk top ---------
    twigs = []
    for b in range(N_BRANCHES):
        phi = b * (2 * np.pi / N_BRANCHES)
        # unit direction: outward and upward
        d = np.array([np.cos(phi), np.sin(phi), 1.0])
        d /= np.linalg.norm(d)
        base = np.array([TRUNK_RADIUS * np.cos(phi), TRUNK_RADIUS * np.sin(phi),
                         TRUNK_HEIGHT])
        s = (np.arange(BRANCH_POINTS) + 1) * BRANCH_SPACING
        twigs.append(base[None, :] + s[:, None] * d[None, :])
    twigs = np.vstack(twigs)
    parts.append(twigs)

    # --- flyers: isolated, on a coarse lattice well clear of the tree ---------
    # 5x5 grid at 1.5 m pitch, lifted above the canopy so nothing is near it.
    gx, gy = np.meshgrid(np.arange(5) * 1.5 - 3.0, np.arange(5) * 1.5 - 3.0,
                         indexing="ij")
    flyers = np.column_stack([gx.ravel(), gy.ravel(),
                              np.full(gx.size, 4.0) + np.arange(gx.size) * 0.03])
    assert len(flyers) == N_FLYERS
    parts.append(flyers)

    # --- clump: self-supporting noise -----------------------------------------
    ang = np.arange(CLUMP_POINTS) * (2 * np.pi / CLUMP_POINTS)
    clump = np.column_stack([
        6.0 + CLUMP_RADIUS * np.cos(ang),
        6.0 + CLUMP_RADIUS * np.sin(ang),
        np.full(CLUMP_POINTS, 1.0),
    ])
    parts.append(clump)

    points = np.vstack(parts)
    sizes = [len(p) for p in parts]
    bounds = np.cumsum([0] + sizes)
    groups = {
        name: np.arange(bounds[i], bounds[i + 1])
        for i, name in enumerate(("trunk", "twigs", "flyers", "clump"))
    }
    return points, groups


if __name__ == "__main__":
    import sys

    pts, grp = build_noisy_tree()
    out = sys.argv[1] if len(sys.argv) > 1 else "noisy-tree.xyz"
    # Bare column header only — no comment lines. The import wizard parses the
    # first row as column names, and the composition is documented HERE rather
    # than in a header the parser would have to special-case.
    with open(out, "w") as fh:
        fh.write("X Y Z\n")
        for x, y, z in pts:
            fh.write(f"{x:.4f} {y:.4f} {z:.4f}\n")
    print(f"wrote {out}: {len(pts)} points  {dict((k, len(v)) for k, v in grp.items())}")
