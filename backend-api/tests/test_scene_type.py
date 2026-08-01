"""Scene-type selection and its sanity check.

The user chooses the scene type explicitly — nothing is auto-detected behind
their back, so the algorithm that runs is always their decision. The classifier
exists only to CHECK that choice against the geometry, and it has to earn the
right to interrupt: a check that fires on reasonable inputs becomes a dialog
people dismiss reflexively, which is worse than no check.

Thresholds here are placed in the empty space between measured clusters
(planarity ~0.12-0.14 vegetated vs ~0.85 built; spacing CV ~0.08 planted vs
~0.49 natural), not at the edge of either.
"""

import numpy as np
import pytest

import main
from scene_classify import classify_scene, check_scene_type


def _building(w=20, d=12, h=8, n=6000, seed=0):
    """Walls plus a flat roof — large CONTINUOUS planes, the thing foliage never
    produces at any scale."""
    r = np.random.default_rng(seed)
    q = n // 4
    return np.vstack([
        np.column_stack([r.uniform(0, w, q), np.zeros(q), r.uniform(0, h, q)]),
        np.column_stack([r.uniform(0, w, q), np.full(q, d), r.uniform(0, h, q)]),
        np.column_stack([np.zeros(q), r.uniform(0, d, q), r.uniform(0, h, q)]),
        np.column_stack([r.uniform(0, w, q), r.uniform(0, d, q), np.full(q, h)]),
    ])


def _built_scene(seed=0):
    out = [_building(seed=seed + i) + [x, y, 0]
           for i, (x, y) in enumerate([(0, 0), (35, 0), (0, 30), (40, 35)])]
    g = np.meshgrid(np.arange(-5, 60, 1.0), np.arange(-5, 55, 1.0))
    out.append(np.column_stack([g[0].ravel(), g[1].ravel(), np.zeros(g[0].size)]))
    return np.vstack(out)


def _planting():
    from tests.test_global_register import _realistic_planting, _with_ground
    return _with_ground(_realistic_planting(seed=21))


def test_built_and_vegetated_scenes_are_told_apart():
    """The distinction that changes the ALGORITHM, so the one that must be
    reliable. Buildings are planar; foliage is volumetric."""
    built = classify_scene(_built_scene())
    plants = classify_scene(_planting())

    assert built["scene_type"] == "urban", built
    assert plants["scene_type"] != "urban", plants
    # A clear gap, not a photo finish — otherwise the threshold is arbitrary.
    assert built["planarity"] > 2 * plants["planarity"], (
        f"planarity did not separate: built={built['planarity']} "
        f"vegetated={plants['planarity']}")


def test_planted_and_natural_spacing_are_told_apart():
    """Regular spacing is what makes a planting a planting."""
    from tests.test_global_register import _realistic_planting, _with_ground
    from anchor_extraction import extract_anchors

    scene = _with_ground(_realistic_planting(seed=21))
    ext = main._robust_cloud_diagonal(scene)
    anchors, _ = extract_anchors(scene, "crown", ext)
    planted = classify_scene(scene, anchors)

    rng = np.random.default_rng(5)
    scattered = np.column_stack([rng.uniform(0, 40, 30), rng.uniform(0, 40, 30),
                                 np.zeros(30)])
    natural = classify_scene(scene, scattered)

    assert planted["spacing_cv"] is not None
    assert natural["spacing_cv"] is not None
    assert planted["spacing_cv"] < natural["spacing_cv"], (
        f"planted CV {planted['spacing_cv']} not below natural {natural['spacing_cv']}")


def test_only_an_algorithm_changing_mismatch_is_severe():
    """Two tiers, and the reason for them.

    Vegetated-vs-built picks a different pipeline, so it is worth interrupting
    for. Planted-vs-natural only tunes the same pipeline, so it must never be
    more than a note — a prompt there would be a nag."""
    built = classify_scene(_built_scene())

    hard = check_scene_type("agriculture", built)
    assert hard and hard["severity"] == "strong", hard

    soft = check_scene_type("natural", {"scene_type": "agriculture",
                                        "confidence": "strong"})
    assert soft and soft["severity"] == "weak", soft

    assert check_scene_type("urban", built) is None, "agreement must not warn"


def test_wrong_scene_type_blocks_before_the_expensive_work():
    """The check has to come FIRST. Its whole value is that picking the wrong
    scene type costs a moment instead of a minute of CSF and TreeIso — and it
    must be dismissible, or it becomes a wall."""
    built = _built_scene()
    req = dict(target_points=built.ravel().tolist(),
               source_points=built.ravel().tolist(),
               scene_type="agriculture")

    blocked = main._do_global_register(main.GlobalRegisterRequest(**req), progress=None)
    assert blocked.get("needs_scene_confirmation") is True
    assert blocked.get("observed_scene_type") == "urban"
    assert "transformation_matrix" not in blocked, "should stop before registering"

    # Confirming proceeds with the user's choice — their decision stands.
    proceeded = main._do_global_register(
        main.GlobalRegisterRequest(**req, scene_type_confirmed=True), progress=None)
    assert proceeded.get("needs_scene_confirmation") is not True
    assert proceeded.get("success") is True


def test_built_scene_uses_surface_matching_and_says_so():
    """`urban` is a different pipeline, not a preset: no landmark stage at all.
    Skipping CSF/TreeIso is most of why it is fast, and the response must name
    the path so the user knows what produced their result."""
    from tests.test_global_register import _rigid, _rot_z, _apply, _pose_error

    built = _built_scene()
    applied = _rigid(_rot_z(20.0), [2.0, -1.5, 0.0])
    result = main._do_global_register(main.GlobalRegisterRequest(
        target_points=built.ravel().tolist(),
        source_points=_apply(built, applied).ravel().tolist(),
        scene_type="urban"), progress=None)

    assert result["success"] is True, result.get("error")
    assert result["match_path"] == "raw-surface"
    assert result["scene_type_used"] == "urban"
    assert result["num_anchors_target"] == 0, "urban must not run landmark extraction"
    rot_err, trans_err = _pose_error(result["transformation_matrix"], applied)
    assert rot_err < 3.0 and trans_err < 1.0, f"{rot_err:.2f}° / {trans_err:.2f} m"
    # A built scene registered by its intended method is a normal good result.
    assert result["confident"] is True


def test_unknown_scene_type_is_rejected():
    pts = _planting()
    result = main._do_global_register(main.GlobalRegisterRequest(
        target_points=pts.ravel().tolist(), source_points=pts.ravel().tolist(),
        scene_type="swamp"), progress=None)
    assert result["success"] is False
    assert "scene_type" in (result.get("error") or "")


def test_built_vs_vegetated_is_strong_even_without_landmarks():
    """Regression: the check must not need anchors to be sure.

    Planarity alone settles built-vs-vegetated, which is the distinction that
    changes the algorithm. An earlier version only ever reported `strong` once
    plant spacing had also been measured, so a genuine mismatch — asking for a
    built site on an orchard — was silently downgraded to a note nobody sees,
    and the prompt never appeared. Anchors refine planted-vs-natural; they are
    not evidence about whether the scene is built."""
    observed = classify_scene(_planting())          # deliberately no anchors

    assert observed["confidence"] == "strong", observed
    hard = check_scene_type("urban", observed)
    assert hard and hard["severity"] == "strong", hard

    # ...but with no spacing measured it must NOT take sides between the two
    # vegetation types, or it would nag about a distinction it cannot see.
    assert check_scene_type("agriculture", observed) is None
    assert check_scene_type("natural", observed) is None
