"""Crown fitting: shape geometry + the /api/fit/crown session path.

Exercises the REAL fit (open3d/scipy, no mocks) on a synthetic tree cloud built
in numpy — a ground disk + trunk line + leaf blob, with ground_class / wood_class
/ tree_instance / is_miss columns and a couple of far-field miss points to prove
they're filtered (not left to inflate the extent ~1000x and hang the fit).
"""
import asyncio
import json
import queue
import time

import numpy as np
import pytest

import main


# ---------------------------------------------------------------------------
# Synthetic tree cloud
# ---------------------------------------------------------------------------

def _make_tree(center_xy, tree_id, rng, leaf_center_z=6.0, leaf_radii=(2.0, 2.0, 3.0)):
    """Return (positions (N,3), tree_ids, wood, ground) for one tree: a flat
    ground disk (ground_class=1, wood=0), a vertical trunk line (wood=1), and an
    ellipsoidal leaf blob (wood=2). All non-ground points carry `tree_id`."""
    cx, cy = center_xy
    # Ground disk at z=0.
    n_g = 300
    ga = rng.uniform(0, 2 * np.pi, n_g)
    gr = np.sqrt(rng.uniform(0, 1, n_g)) * 4.0
    ground = np.column_stack([cx + gr * np.cos(ga), cy + gr * np.sin(ga), np.zeros(n_g)])
    # Trunk: vertical line 0..4 m.
    n_t = 100
    tz = rng.uniform(0, 4.0, n_t)
    trunk = np.column_stack([cx + rng.normal(0, 0.05, n_t), cy + rng.normal(0, 0.05, n_t), tz])
    # Leaf blob: ellipsoid centered at leaf_center_z.
    n_l = 1500
    u = rng.normal(size=(n_l, 3))
    u /= np.linalg.norm(u, axis=1, keepdims=True)
    rr = rng.uniform(0, 1, (n_l, 1)) ** (1 / 3)
    leaf = u * rr * np.array(leaf_radii) + np.array([cx, cy, leaf_center_z])

    pos = np.vstack([ground, trunk, leaf])
    ground_col = np.concatenate([np.ones(n_g), np.full(n_t, 2.0), np.full(n_l, 2.0)])  # 1=ground
    wood_col = np.concatenate([np.zeros(n_g), np.ones(n_t), np.full(n_l, 2.0)])        # 1=wood,2=leaf
    tree_col = np.full(len(pos), float(tree_id))
    # Ground points aren't part of any tree instance.
    tree_col[:n_g] = 0.0
    return pos, tree_col, wood_col, ground_col


def _make_session(session_id="crown-test", two_trees=False, world_shift=None):
    rng = np.random.default_rng(42)
    p1, t1, w1, g1 = _make_tree((0.0, 0.0), 1, rng, leaf_center_z=6.0, leaf_radii=(2.0, 2.0, 3.0))
    parts = [(p1, t1, w1, g1)]
    if two_trees:
        p2, t2, w2, g2 = _make_tree((30.0, 0.0), 2, rng, leaf_center_z=5.0, leaf_radii=(1.5, 1.5, 2.0))
        parts.append((p2, t2, w2, g2))
    pos = np.vstack([p[0] for p in parts])
    tree = np.concatenate([p[1] for p in parts])
    wood = np.concatenate([p[2] for p in parts])
    ground = np.concatenate([p[3] for p in parts])

    # Two far-field MISS points ~1 km out. If not filtered they blow the extent up
    # ~1000x; every metric would be wrong and open3d would choke.
    miss = np.array([[1000.0, 1000.0, 1000.0], [-1000.0, -1000.0, -1000.0]])
    pos = np.vstack([pos, miss])
    tree = np.concatenate([tree, [0.0, 0.0]])
    wood = np.concatenate([wood, [0.0, 0.0]])
    ground = np.concatenate([ground, [2.0, 2.0]])
    is_miss = np.concatenate([np.zeros(len(pos) - 2), [1.0, 1.0]])

    if world_shift is not None:
        pos = pos - np.asarray(world_shift)  # session stores shifted; world = stored+shift

    n = len(pos)
    sess = main.CloudSession(
        session_id=session_id,
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=np.asarray(pos, dtype=np.float64),
        colors=None,
        intensity=None,
        extras={
            main.TREE_INSTANCE_SLUG: tree.astype(np.float32),
            main.WOOD_CLASS_SLUG: wood.astype(np.float32),
            main.GROUND_CLASS_SLUG: ground.astype(np.float32),
            main._MISS_SLUG: is_miss.astype(np.float32),
        },
        extra_dims_meta=[
            {"slug": main.TREE_INSTANCE_SLUG, "label": "Tree"},
            {"slug": main.WOOD_CLASS_SLUG, "label": "Wood"},
            {"slug": main.GROUND_CLASS_SLUG, "label": "Ground"},
            {"slug": main._MISS_SLUG, "label": "Miss"},
        ],
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
        world_shift=None if world_shift is None else np.asarray(world_shift, dtype=np.float64),
    )
    return sess


@pytest.fixture(autouse=True)
def _clean_sessions():
    with main._cloud_session_lock:
        before = dict(main._cloud_sessions)
    yield
    with main._cloud_session_lock:
        main._cloud_sessions.clear()
        main._cloud_sessions.update(before)


def _register(sess):
    with main._cloud_session_lock:
        main._cloud_sessions[sess.session_id] = sess


def _run(session_id, **body):
    """Call the endpoint, drain the streaming response, return the JSON tail."""
    sess_src = main.PointSource(session_id=session_id)
    req = main.CrownFitRequest(source=sess_src, **body)

    class _Req:
        async def is_disconnected(self):
            return False

    resp = main.fit_crown_endpoint(req, _Req())
    resp = asyncio.run(resp) if asyncio.iscoroutine(resp) else resp

    async def _collect():
        return b"".join([
            c if isinstance(c, (bytes, bytearray)) else c.encode()
            async for c in resp.body_iterator
        ])

    raw = asyncio.run(_collect())
    i = 0
    while i + 8 <= len(raw) and raw[i:i + 4] == b"PHP1":
        mlen = int.from_bytes(raw[i + 4:i + 8], "little")
        i += 8 + mlen
    while i < len(raw) and raw[i:i + 1] in (b" ", b"\n", b"\t"):
        i += 1
    return json.loads(raw[i:])


# ---------------------------------------------------------------------------
# Geometry (crown_fit.fit_crown directly)
# ---------------------------------------------------------------------------

def _leaf_blob(rng, center=(10, 20, 5), radii=(2, 3, 4), n=2000):
    u = rng.normal(size=(n, 3))
    u /= np.linalg.norm(u, axis=1, keepdims=True)
    r = rng.uniform(0, 1, (n, 1)) ** (1 / 3)
    return u * r * np.array(radii) + np.array(center)


@pytest.mark.parametrize("shape", ["ellipsoid", "prism", "cone", "alpha"])
def test_each_shape_fits_with_positive_volume(shape):
    import crown_fit as cf
    rng = np.random.default_rng(0)
    pts = _leaf_blob(rng)
    res = cf.fit_crown(pts, shape, 0.5, baseline_z=0.0)
    m = res["metrics"]
    assert res["vertices"].shape[1] == 3
    assert res["triangles"].shape[1] == 3
    assert len(res["triangles"]) > 0
    assert m["crown_volume_m3"] > 0
    assert np.isfinite(m["crown_volume_m3"])
    # Blob spans z in [1,9] (center 5, z-radius 4); height from ground ~9.
    assert 8.0 < m["tree_height_m"] < 10.0


def test_prism_is_the_loosest_bound():
    """A rectangular prism circumscribes the crown, so its volume should exceed
    the ellipsoid's for the same points (sanity that the fits differ meaningfully)."""
    import crown_fit as cf
    rng = np.random.default_rng(1)
    pts = _leaf_blob(rng)
    prism = cf.fit_crown(pts, "prism", 0.0, 0.0)["metrics"]["crown_volume_m3"]
    ellip = cf.fit_crown(pts, "ellipsoid", 0.0, 0.0)["metrics"]["crown_volume_m3"]
    assert prism > ellip


@pytest.mark.parametrize("shape", ["ellipsoid", "prism", "cone", "alpha"])
def test_center_and_dims_come_from_the_fitted_mesh(shape):
    """crown_center and crown_dims_m are derived from the FITTED MESH geometry
    (its axis-aligned bounding box), not the point cloud — consistently for every
    shape. Verified by re-deriving the bbox from the returned vertices, and by the
    internal consistency crown_dims_m[2] == crown_top_z - crown_base_z."""
    import crown_fit as cf
    rng = np.random.default_rng(1)
    pts = _leaf_blob(rng, center=(10, 20, 5), radii=(2, 3, 4), n=2000)
    res = cf.fit_crown(pts, shape, 0.2, 0.0)
    v = res["vertices"]
    lo, hi = v.min(axis=0), v.max(axis=0)
    m = res["metrics"]
    # Center = mesh bbox center.
    exp_center = (lo + hi) / 2.0
    assert np.allclose(m["crown_center"], exp_center, atol=1e-6)
    # Dims = mesh bbox extent.
    assert np.allclose(m["crown_dims_m"], hi - lo, atol=1e-6)
    # base/top Z = mesh Z-extent; height dim is consistent with them.
    assert abs(m["crown_base_z"] - lo[2]) < 1e-6
    assert abs(m["crown_top_z"] - hi[2]) < 1e-6
    assert abs(m["crown_dims_m"][2] - (m["crown_top_z"] - m["crown_base_z"])) < 1e-6


def test_alpha_hull_is_single_component_and_watertight():
    """The alpha shape must be a SMOOTH WATERTIGHT concave hull — one connected
    surface, not the disconnected fragments + sliver appendages a raw open3d
    alpha complex leaves on clustered crown points. Regression: the fit used the
    raw alpha shape (holey, multi-component); the fix keeps the largest component
    and auto-grows alpha until it closes."""
    import open3d as o3d
    import crown_fit as cf
    rng = np.random.default_rng(3)
    # Several separated leaf blobs — the input that makes a raw alpha fragment.
    blobs = []
    for cx, cy, cz in [(0, 0, 6), (1.5, 0.5, 7), (-1, 1, 6.5), (0.5, -1.5, 5.5)]:
        u = rng.normal(size=(500, 3))
        u /= np.linalg.norm(u, axis=1, keepdims=True)
        r = rng.uniform(0, 1, (500, 1)) ** (1 / 3)
        blobs.append(u * r * 1.6 + np.array([cx, cy, cz]))
    pts = np.vstack(blobs)

    res = cf.fit_crown(pts, "alpha", 0.2, 0.0)
    m = o3d.geometry.TriangleMesh()
    m.vertices = o3d.utility.Vector3dVector(res["vertices"])
    m.triangles = o3d.utility.Vector3iVector(res["triangles"])
    _labels, counts, _ = m.cluster_connected_triangles()
    n_components = len(np.asarray(counts))
    assert n_components == 1, f"alpha hull has {n_components} disconnected components"
    assert m.is_watertight(), "alpha hull is not watertight"
    assert res["metrics"]["crown_volume_m3"] > 0


def test_strictness_zero_encloses_all_points_including_a_branch():
    """At strictness 0 the fitted shape must fully enclose the crown — a
    protruding branch should NOT poke through. Regression: sizing each ellipsoid
    semi-axis to the per-axis max left points outside the (stricter) ellipsoid
    surface (a moderate-on-all-axes point escaped). The fix scales the ellipsoid
    up until it contains every point; the prism (AABB) contains them by
    construction. Enclosure is checked against the RETURNED MESH GEOMETRY (what
    the user sees), which is the shape's true center + extent."""
    import crown_fit as cf
    rng = np.random.default_rng(7)
    blob = _leaf_blob(rng, center=(0, 0, 5), radii=(2.5, 2.5, 3.5), n=2000)
    # A lateral branch protruding mid-crown (well below the apex tip).
    branch = np.array([[4.0, 0.0, 4.0], [3.5, 1.0, 3.8]])
    pts = np.vstack([blob, branch])

    # Ellipsoid: recover the mesh's center (mean of its verts) + per-axis semi-axis
    # (half its vertex extent), then verify every point is on/inside the surface.
    er = cf.fit_crown(pts, "ellipsoid", 0.0, 0.0)
    ev = er["vertices"]
    center = (ev.min(axis=0) + ev.max(axis=0)) / 2.0
    semi = (ev.max(axis=0) - ev.min(axis=0)) / 2.0
    rho = (((pts - center) / semi) ** 2).sum(axis=1)
    assert rho.max() <= 1.02, f"ellipsoid leaves points outside: max ρ²={rho.max():.3f}"

    # Prism: the mesh's axis-aligned box contains every point.
    pv = cf.fit_crown(pts, "prism", 0.0, 0.0)["vertices"]
    lo, hi = pv.min(axis=0), pv.max(axis=0)
    assert np.all(pts >= lo - 1e-6) and np.all(pts <= hi + 1e-6), \
        "prism leaves points outside its box"


def test_strictness_trims_points_and_shrinks_volume():
    import crown_fit as cf
    rng = np.random.default_rng(2)
    pts = _leaf_blob(rng, n=3000)
    # Add a few far lateral "branch" spikes that a strict fit should reject.
    spikes = np.array([[10 + 8, 20, 5], [10 - 8, 20, 5], [10, 20 + 9, 5]], dtype=float)
    pts = np.vstack([pts, spikes])
    loose = cf.fit_crown(pts, "ellipsoid", 0.0, 0.0)["metrics"]
    strict = cf.fit_crown(pts, "ellipsoid", 1.0, 0.0)["metrics"]
    assert strict["num_points_used"] < loose["num_points_used"]
    assert strict["crown_volume_m3"] < loose["crown_volume_m3"]


def test_strictness_floor_never_collapses_crown():
    import crown_fit as cf
    rng = np.random.default_rng(3)
    pts = _leaf_blob(rng, n=200)
    strict = cf.fit_crown(pts, "ellipsoid", 1.0, 0.0)["metrics"]
    # Floor keeps >= max(20, N/2) points.
    assert strict["num_points_used"] >= 100


# ---------------------------------------------------------------------------
# Endpoint (session read-back path)
# ---------------------------------------------------------------------------

def test_endpoint_fits_single_tree_leaf_only():
    sess = _make_session()
    _register(sess)
    out = _run(sess.session_id, shape="ellipsoid", strictness=0.5,
               use_leaf_only=True, tree_instance_ids=[1],
               ground_baseline="ground_class")
    assert out["success"], out
    assert len(out["crowns"]) == 1
    m = out["crowns"][0]["metrics"]
    # Leaf blob centered z=6, z-radius 3 → top ~9, height from ground(0) ~9.
    assert 8.0 < m["tree_height_m"] < 10.0
    assert m["crown_volume_m3"] > 0


def test_endpoint_excludes_far_field_misses():
    """The ~1 km miss points must be filtered — otherwise the crown center /
    dimensions blow up. Center must stay near the true leaf blob, not ~1 km out."""
    sess = _make_session()
    _register(sess)
    out = _run(sess.session_id, shape="prism", strictness=0.3,
               use_leaf_only=True, tree_instance_ids=[1],
               ground_baseline="ground_class")
    assert out["success"], out
    c = out["crowns"][0]["metrics"]["crown_center"]
    assert abs(c[0]) < 10 and abs(c[1]) < 10 and abs(c[2]) < 20  # not ~1000


def test_endpoint_multi_tree_yields_one_crown_each():
    sess = _make_session(two_trees=True)
    _register(sess)
    out = _run(sess.session_id, shape="cone", strictness=0.4,
               use_leaf_only=True, tree_instance_ids=[1, 2],
               ground_baseline="ground_class")
    assert out["success"], out
    assert len(out["crowns"]) == 2
    ids = sorted(c["tree_instance_id"] for c in out["crowns"])
    assert ids == [1, 2]


def test_endpoint_leaf_only_uses_fewer_points_than_all_nonground():
    sess = _make_session()
    _register(sess)
    leaf = _run(sess.session_id, shape="ellipsoid", strictness=0.0,
                use_leaf_only=True, tree_instance_ids=[1], ground_baseline="min_z")
    allp = _run(sess.session_id, shape="ellipsoid", strictness=0.0,
                use_leaf_only=False, tree_instance_ids=[1], ground_baseline="min_z")
    # All-non-ground includes the trunk, so more points than leaf-only.
    assert allp["crowns"][0]["metrics"]["num_points_used"] > \
        leaf["crowns"][0]["metrics"]["num_points_used"]


def test_endpoint_world_shift_returns_world_frame_center():
    """With a world shift, the session stores shifted coords but the returned
    crown center must be in WORLD coords (shift added back), matching how the
    renderer places meshes.

    The tree is built at world XY (0,0); a shift of (500,600) means the session
    STORES it near (-500,-600) and recovery must add the shift back → center ~0.
    Without the add-back the center would come back near (-500,-600), so this
    pins the world-frame contract."""
    shift = [500.0, 600.0, 0.0]
    sess = _make_session(session_id="crown-shift", world_shift=shift)
    _register(sess)
    # Sanity: the session really is storing shifted coords (near -500,-600).
    assert sess.positions[:-2, 0].mean() < -400  # exclude the two far misses
    out = _run(sess.session_id, shape="ellipsoid", strictness=0.5,
               use_leaf_only=True, tree_instance_ids=[1],
               ground_baseline="ground_class")
    assert out["success"], out
    c = out["crowns"][0]["metrics"]["crown_center"]
    # World frame recovered: center back near the true world origin (0,0), NOT
    # the stored (-500,-600).
    assert abs(c[0]) < 10 and abs(c[1]) < 10


def test_cancel_interrupts_the_fit_before_any_tree_is_fitted():
    """A cancelled run must NOT keep fitting silently. With the cancel Event
    already set, the worker raises ScanCancelled at its first checkpoint and fits
    nothing — proving cancellation actually interrupts the compute (cooperative,
    since the numpy/open3d fit runs off-thread and can't be force-killed)."""
    sess = _make_session(two_trees=True)
    _register(sess)
    # A reporter whose run is already cancelled (mirrors the client POSTing
    # /api/cancel/{run_id} the instant Fit starts).
    event = main.threading.Event()
    event.set()
    reporter = main._ProgressReporter(queue.Queue(), event)
    req = main.CrownFitRequest(
        source=main.PointSource(session_id=sess.session_id),
        shape="ellipsoid", strictness=0.2, use_leaf_only=True,
        tree_instance_ids=[1, 2], ground_baseline="ground_class",
    )
    with pytest.raises(main.ScanCancelled):
        main._do_crown_fit(req, progress=reporter)
