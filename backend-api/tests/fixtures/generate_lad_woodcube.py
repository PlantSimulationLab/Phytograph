"""Generate the committed LAD leaf+WOOD point-cloud fixture.

Run once to (re)produce `lad-woodcube/woodcube.xyz` + `woodcube.xml`. The sibling
of `generate_lad_leafcube.py`, and the only LAD fixture whose WOOD area is known
analytically -- which is what makes it able to gate the leaf/wood split rather
than merely exercise it.

What this fixture is FOR
------------------------
It is the leaf/wood split's STRESS CASE, not a measure of its accuracy. All the
wood is concentrated in solid full-height tubes among diffuse leaves -- the
maximally SEGREGATED arrangement -- which is the one situation the split handles
worst, because each tube saturates its own footprint and takes nearly every
return there. A well-mixed canopy recovers both areas to well under 1% (proved
directly in `test_well_mixed_media_recover_absolute_areas`).

So the gates built on this fixture assert the split MECHANICS (both classes
present, interception conserved, totals consistent, the pooled G(theta)
estimator noticing the all-vertical axes) and pin the segregated case's numbers
so a change is visible -- not that the recovered areas match the truth.

The scene
---------
A 1x1x1 m box at (0, 0, 0.5) containing:

  * LEAVES  -- flat square patches at random positions and random orientations,
               i.e. a spherical leaf-angle distribution, so G_leaf == 0.5 and the
               leaf side matches the existing leafcube's analytic case.
  * WOOD    -- vertical cylinders (tubes), so the branch-axis distribution is
               known exactly too.

Both populations' areas come from `Context.getPrimitiveArea`, summed per class,
so the truth is measured off the geometry rather than derived from the nominal
dimensions (a tube is tessellated, so its true area is slightly under the ideal
2*pi*r*L, and the tessellated value is what the beams actually saw).

One scan, labelled geometrically
--------------------------------
Nothing in the LiDAR plugin reports which PRIMITIVE a return hit, so the class
has to be recovered some other way. The obvious shortcut -- scan the leaves and
the wood separately and tag each pass -- was tried and REJECTED: with the two
populations scanned apart neither occludes the other, so wood returns come back
over-represented (measured 0.316 of returns against an expected 0.147) and the
fixture cannot gate the split it exists to test.

So the scene is scanned ONCE, with both populations present and occluding each
other as they would in a real acquisition, and each return is then labelled by
its distance to the known tube axes. The tubes are vertical cylinders at known
(x, y) with a known radius, so "within radius + tolerance of an axis, and inside
the tube's z-span" is exact up to the tessellation -- there is no classifier in
the loop, and therefore no classifier error folded into the truth.

The labelling tolerance is deliberately tight; a return that cannot be resolved
confidently is dropped from the cloud rather than guessed at, and the generator
reports how many that was.

Usage (from repo root, with the backend venv active and libhelios built):
    cd pyhelios/helios-core
    python ../../backend-api/tests/fixtures/generate_lad_woodcube.py
"""

import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYHELIOS = os.path.abspath(os.path.join(_HERE, "..", "..", "..", "pyhelios"))
sys.path.insert(0, _PYHELIOS)

import numpy as np  # noqa: E402
from pyhelios import LiDARCloud, Context  # noqa: E402
from pyhelios.wrappers.DataTypes import vec2, vec3, SphericalCoord  # noqa: E402

ORIGIN = (-5.0, 0.0, 0.5)
NTHETA, NPHI = 1400, 2800        # ~1/3 the leafcube's, to keep the file small
GRID_CENTER = [0.0, 0.0, 0.5]
GRID_SIZE = [1.0, 1.0, 1.0]

N_LEAVES = 900
LEAF_SIZE = 0.05                 # square patch edge (m)
N_TRUNKS = 7
TRUNK_RADIUS = 0.02
TRUNK_NDIVS = 10
TRUNK_Z0, TRUNK_Z1 = 0.05, 0.95
# Half the leaf edge: a return this close to a tube wall cannot be
# attributed confidently, so it is dropped rather than guessed.
WOOD_TOL = 0.5 * LEAF_SIZE

SEED = 20260920

OUT_DIR = os.environ.get("LAD_WOODCUBE_OUT",
                         os.path.join(_HERE, "lad-woodcube"))


def _add_leaves(ctx, rng):
    """Flat patches, random position and random orientation => spherical leaf
    angles (G == 0.5). Returns their UUIDs."""
    uuids = []
    for _ in range(N_LEAVES):
        c = vec3(*(rng.uniform(-0.45, 0.45, 3) + np.array([0.0, 0.0, 0.5])))
        # Uniform on the sphere: zenith from arccos(U) so the normals are
        # isotropic rather than clustered at the poles.
        zenith = math.acos(rng.uniform(-1.0, 1.0))
        azimuth = rng.uniform(0.0, 2.0 * math.pi)
        rot = SphericalCoord(1.0, 0.5 * math.pi - zenith, azimuth)
        uuids.append(ctx.addPatch(c, vec2(LEAF_SIZE, LEAF_SIZE), rot))
    return uuids


def _trunk_axes(rng):
    """(x, y) of each vertical trunk. Returned separately from the geometry so
    the labelling below uses the SAME numbers the tubes were built from."""
    return [tuple(rng.uniform(-0.40, 0.40, 2)) for _ in range(N_TRUNKS)]


def _add_wood(ctx, axes):
    """Vertical tubes spanning the box: a known, all-vertical branch-axis
    distribution. Returns the UUIDs of every primitive they tessellate into."""
    uuids = []
    for x, y in axes:
        nodes = [vec3(float(x), float(y), TRUNK_Z0), vec3(float(x), float(y), TRUNK_Z1)]
        uuids.extend(ctx.addTube(nodes, TRUNK_RADIUS, ndivs=TRUNK_NDIVS))
    return uuids


def _area(ctx, uuids):
    return float(sum(ctx.getPrimitiveArea(u) for u in uuids))


def _classify(xyz, axes):
    """Label each return WOOD / LEAF / ambiguous by its distance to the known
    trunk axes.

    Returns (labels, n_ambiguous) where labels holds WOOD=1, LEAF=2, and 0 for a
    return too close to the boundary to call. The tubes are vertical cylinders of
    radius TRUNK_RADIUS, tessellated into TRUNK_NDIVS facets, so a wood return
    sits at a radius between the inscribed radius (cos(pi/ndivs) * r) and r.

    A return is WOOD when its horizontal distance to some axis is within the
    tessellation band widened by WOOD_TOL and its z is inside the tube's span;
    LEAF when it is comfortably OUTSIDE every band; otherwise ambiguous and
    dropped. Nothing here guesses: an unresolvable return leaves the fixture.
    """
    xy = xyz[:, :2]
    z = xyz[:, 2]
    r_in = TRUNK_RADIUS * math.cos(math.pi / TRUNK_NDIVS)
    near = np.zeros(len(xyz), dtype=bool)   # inside the wood band
    far = np.ones(len(xyz), dtype=bool)     # clear of every band
    for x, y in axes:
        d = np.hypot(xy[:, 0] - x, xy[:, 1] - y)
        in_z = (z >= TRUNK_Z0 - WOOD_TOL) & (z <= TRUNK_Z1 + WOOD_TOL)
        near |= (d <= TRUNK_RADIUS + WOOD_TOL) & (d >= r_in - WOOD_TOL) & in_z
        # "Clear" means outside the whole cylinder plus a margin -- a leaf just
        # inside the tube's radius would be occluded anyway, but if one is
        # sampled it must not be mistaken for wood.
        far &= (d > TRUNK_RADIUS + 2.0 * WOOD_TOL) | ~in_z
    labels = np.zeros(len(xyz))
    labels[near] = 1.0                      # WOOD
    labels[far & ~near] = 2.0               # LEAF
    return labels, int((labels == 0).sum())


def main():
    rng = np.random.default_rng(SEED)
    os.makedirs(OUT_DIR, exist_ok=True)

    volume = GRID_SIZE[0] * GRID_SIZE[1] * GRID_SIZE[2]
    axes = _trunk_axes(np.random.default_rng(SEED + 1))

    # ONE scan of the combined scene, so the two populations occlude each other
    # exactly as they would in a real acquisition.
    with Context() as ctx:
        leaf_uuids = _add_leaves(ctx, rng)
        wood_uuids = _add_wood(ctx, axes)
        leaf_area = _area(ctx, leaf_uuids)
        wood_area = _area(ctx, wood_uuids)

        cloud = LiDARCloud()
        cloud.disableMessages()
        cloud.addScan(origin=list(ORIGIN), Ntheta=NTHETA,
                      theta_range=(0.0, math.pi), Nphi=NPHI,
                      phi_range=(0.0, 2 * math.pi),
                      exit_diameter=0.0, beam_divergence=0.0)
        cloud.syntheticScan(ctx, record_misses=True)
        pos, _ = cloud.getHitsXYZRGB()
        miss = np.asarray(cloud.getHitDataAll("is_miss"), dtype=float)
        xyz = np.array([[p.x, p.y, p.z] for p in pos], dtype=float)
        del cloud

    is_miss = (miss != 0)
    labels, n_ambiguous = _classify(xyz, axes)
    # A miss intercepted nothing, so it carries no class -- mirroring the real
    # classifier, which only ever labels hit survivors.
    labels[is_miss] = 0.0
    # Drop only the ambiguous HITS; every miss is kept (they are the Beer's-law
    # transmission denominator).
    keep = is_miss | (labels > 0)
    xyz, labels, is_miss = xyz[keep], labels[keep], is_miss[keep]

    xyz_path = os.path.join(OUT_DIR, "woodcube.xyz")
    with open(xyz_path, "w") as f:
        for (x, y, z), m, c in zip(xyz, is_miss, labels):
            f.write(f"{x:.4f} {y:.4f} {z:.4f} {1.0 if m else 0.0:.1f} {c:.1f}\n")

    n_wood = int((labels == 1.0).sum())
    n_leaf = int((labels == 2.0).sum())
    n_miss = int(is_miss.sum())
    # What the count-based split SHOULD converge on: returns sample each medium in
    # proportion to its PROJECTED area, not its physical area.
    proj_w, proj_l = wood_area * 0.25, leaf_area * 0.5
    expected_count_frac = proj_w / (proj_w + proj_l)

    xml_path = os.path.join(OUT_DIR, "woodcube.xml")
    with open(xml_path, "w") as f:
        f.write(
            '<?xml version="1.0"?>\n\n'
            '<!--\n'
            '  Single synthetic scan of a 1x1x1 m box holding BOTH randomly-oriented\n'
            '  leaf patches (spherical leaf angles, G=0.5) and vertical wooden tubes\n'
            '  (all-vertical branch axes). Used to test the leaf/wood split of the\n'
            '  LAD inversion. Returns are labelled by distance to the known tube\n'
            '  axes, so the wood_class column is exact, not a classifier output.\n'
            '\n'
            f'  True one-sided LEAF area   {leaf_area:.4f} m^2'
            f'  -> LAD {leaf_area / volume:.4f} m^2/m^3\n'
            f'  True total WOOD surface    {wood_area:.4f} m^2'
            f'  -> WAD {wood_area / volume:.4f} m^2/m^3\n'
            f'  wood share of PROJECTED area {expected_count_frac:.4f}\n'
            f'  wood share of RETURNS        '
            f'{n_wood / max(n_wood + n_leaf, 1):.4f}\n'
            '  The return share estimates the EXTINCTION ratio, which for well-mixed\n'
            '  media equals the projected-area share above. Here it does not: the\n'
            '  wood is 7 solid full-height tubes among diffuse leaves, i.e. the\n'
            '  maximally SEGREGATED case, so each tube saturates its own footprint\n'
            '  and takes nearly every return there. This fixture is deliberately\n'
            '  the stress case, not a measure of the method accuracy; a mixed\n'
            '  canopy recovers both areas to well under 1%.\n'
            f'  Generated by generate_lad_woodcube.py ({NTHETA}x{NPHI}).\n'
            '-->\n\n'
            '<helios>\n\n'
            '<scan>\n'
            '  <filename> woodcube.xyz </filename>\n'
            '  <ASCII_format> x y z is_miss wood_class </ASCII_format>\n'
            f'  <origin> {ORIGIN[0]:.6f} {ORIGIN[1]:.6f} {ORIGIN[2]:.6f} </origin>\n'
            f'  <size> {NTHETA} {NPHI} </size>\n'
            '</scan>\n\n'
            '</helios>\n')

    # '--' is ILLEGAL inside an XML comment (XML 1.0 sec 2.5), and the importer
    # rejects the WHOLE file when it appears -- which is exactly how this fixture
    # first failed its E2E. Assert it here so a future edit to the header text
    # cannot silently reintroduce it.
    header = open(xml_path, encoding="utf-8").read()
    body = header[header.index("<!--") + 4:header.index("-->")]
    if "--" in body:
        raise SystemExit(
            "XML comment contains '--', which is invalid XML and makes the "
            "importer reject the file. Use ';' or an en-dash instead.")

    size_kb = os.path.getsize(xyz_path) / 1024
    print(f"Wrote {len(xyz)} points to {xyz_path} ({size_kb:.1f} KB)")
    print(f"  wood {n_wood}  leaf {n_leaf}  miss {n_miss}  "
          f"(dropped {n_ambiguous} ambiguous hits)")
    print(f"  TRUE leaf area {leaf_area:.4f} m^2 (LAD {leaf_area / volume:.4f})")
    print(f"  TRUE wood area {wood_area:.4f} m^2 (WAD {wood_area / volume:.4f})")
    print(f"  observed wood count frac {n_wood / max(n_wood + n_leaf, 1):.4f}  "
          f"vs projected-area frac {expected_count_frac:.4f}")
    print(f"Wrote scan wrapper {xml_path}")


if __name__ == "__main__":
    main()
