"""The multi-scan endpoint: register a set of scans, validated by loop closure.

Why this endpoint exists rather than repeated pairwise calls: on a repetitive
planting a wrong pose fits its own pair BETTER than the correct one (measured on
a real vineyard, a row-shifted alignment scored inlier RMSE 0.3265 against the
truth's 0.3622). Only a graph with cycles can tell them apart.
"""

import math

import numpy as np
import pytest

import main


def _rot_z(deg):
    th = math.radians(deg)
    c, s = math.cos(th), math.sin(th)
    M = np.eye(4)
    M[:2, :2] = [[c, -s], [s, c]]
    return M


def _rigid(deg, t):
    M = _rot_z(deg)
    M[:3, 3] = t
    return M


def _plant(centre, n, rng, spread=0.45):
    return np.asarray(centre) + rng.normal(0, spread, size=(n, 3))


def _scene(seed=4):
    """A planting with enough per-plant variation to be registrable."""
    rng = np.random.default_rng(seed)
    out = []
    for i in range(5):
        for j in range(4):
            h = 3.0 + rng.uniform(-0.8, 0.8)
            out.append(_plant((i * 4.0, j * 4.0, h), 500, rng,
                              spread=0.4 + rng.uniform(0, 0.2)))
    return np.vstack(out)


def _views(scene, poses, keep=0.75, seed=0):
    """One partial view per pose, each in ITS OWN frame.

    Building views by transforming a shared array would give every pair exact
    correspondences and hide the problem this endpoint solves.
    """
    rng = np.random.default_rng(seed)
    views = []
    for k, P in enumerate(poses):
        sub = scene[rng.random(len(scene)) < keep]
        inv = np.linalg.inv(P)
        views.append(sub @ inv[:3, :3].T + inv[:3, 3])
    return views


def _request(views, **kw):
    return main.MultiScanRegisterRequest(
        scan_points=[v.ravel().tolist() for v in views], **kw)


def test_registers_a_three_scan_set_onto_the_reference():
    poses = [np.eye(4), _rigid(12.0, [3.0, -2.0, 0.1]), _rigid(-9.0, [-4.0, 3.0, -0.2])]
    views = _views(_scene(), poses, seed=1)

    result = main._do_multi_scan_register(_request(views), progress=None)
    assert result["success"], result.get("error")
    assert result["reference"] == 0
    assert result["loops_checked"], "three scans form a triangle; it must be checked"

    for i in (1, 2):
        M = np.asarray(result["transformation_matrices"][str(i)],
                       dtype=np.float64).reshape(4, 4)
        moved = views[i] @ M[:3, :3].T + M[:3, 3]
        want = views[i] @ poses[i][:3, :3].T + poses[i][:3, 3]
        err = float(np.mean(np.linalg.norm(moved - want, axis=1)))
        assert err < 1.0, f"scan {i} landed {err:.2f} m from its true pose"


def test_two_scans_are_registered_but_reported_unvalidated():
    """With no cycle there is nothing to cross-check, and it must say so.

    A two-scan result is exactly as trustworthy as a pairwise one. Reporting it
    as validated would imply a check that did not happen.
    """
    poses = [np.eye(4), _rigid(10.0, [2.0, -1.0, 0.0])]
    views = _views(_scene(), poses, seed=2)

    result = main._do_multi_scan_register(_request(views), progress=None)
    assert result["success"], result.get("error")
    assert result["validated"] is False
    assert result["loops_checked"] is False
    assert result["loops"] == []
    assert "1" in result["transformation_matrices"]


def test_the_reference_scan_is_not_moved():
    poses = [np.eye(4), _rigid(8.0, [2.0, 1.0, 0.0]), _rigid(-6.0, [-3.0, 2.0, 0.0])]
    views = _views(_scene(), poses, seed=3)

    result = main._do_multi_scan_register(_request(views, reference=1), progress=None)
    assert result["success"], result.get("error")
    assert result["reference"] == 1
    assert np.allclose(
        np.asarray(result["transformation_matrices"]["1"]).reshape(4, 4), np.eye(4))


def test_rejects_a_set_too_small_to_register():
    one = [_scene()[:5000]]
    result = main._do_multi_scan_register(_request(one), progress=None)
    assert not result["success"]
    assert "at least 2" in result["error"]


def test_rejects_an_out_of_range_reference():
    poses = [np.eye(4), _rigid(5.0, [1.0, 0.0, 0.0])]
    views = _views(_scene(), poses, seed=6)
    result = main._do_multi_scan_register(_request(views, reference=7), progress=None)
    assert not result["success"]
    assert "reference" in result["error"]


def test_progress_is_monotonic_and_ends_at_one():
    """Mirrors the ICP worker's contract so the cancel pill behaves."""
    poses = [np.eye(4), _rigid(7.0, [2.0, -1.0, 0.0]), _rigid(-5.0, [-2.0, 2.0, 0.0])]
    views = _views(_scene(), poses, seed=8)

    seen = []
    main._do_multi_scan_register(_request(views),
                                 progress=lambda f, m=None: seen.append(f))
    assert seen, "worker emitted no progress"
    assert seen == sorted(seen), f"progress went backwards: {seen}"
    assert seen[-1] == pytest.approx(1.0)


def test_an_oversized_inline_payload_is_refused_not_processed():
    """Inline points past the limit must be REJECTED, not quietly decimated.

    A Python list of floats costs ~32 bytes per value against 8 for a numpy
    array, and pydantic copies `List[List[float]]` during validation. Sending
    three full scans that way was measured at a 45 GB physical footprint with
    36 GB swapped -- on a machine with 26 GB of swap.

    `max_points_per_scan` cannot prevent that: the cost is paid in the CALLER
    and in validation, before the worker sees the request. So the worker refuses
    and names the cheap alternative rather than accepting a payload that already
    hurt to build.
    """
    over = main._MULTI_MAX_INLINE_POINTS + 1000
    result = main._do_multi_scan_register(main.MultiScanRegisterRequest(
        scan_points=[[0.0] * (over * 3), [0.0] * 300, [0.0] * 300],
    ), progress=None)

    assert not result["success"]
    assert "past the" in result["error"]
    # The message has to say what to do instead, or it is just a wall.
    assert "session-backed" in result["error"]


def test_an_inline_payload_within_the_limit_is_accepted():
    """The guard must not block ordinary use.

    A cloud small enough to send inline is exactly the case inline exists for;
    rejecting it would push every caller to sessions for no reason.
    """
    poses = [np.eye(4), _rigid(9.0, [2.0, -1.0, 0.0]), _rigid(-7.0, [-2.0, 2.0, 0.0])]
    views = _views(_scene(), poses, seed=11)
    assert all(len(v) < main._MULTI_MAX_INLINE_POINTS for v in views)

    result = main._do_multi_scan_register(_request(views), progress=None)
    assert result["success"], result.get("error")
