"""Recipes against a live backend, on the forest-plot fixture of KNOWN geometry
(see test_tools.py): every assertion is a measured number or a refusal."""
from __future__ import annotations

import json

import numpy as np
import pytest

import phytograph as pg
from phytograph import recipes
from conftest import E2E_FIXTURES

FOREST = E2E_FIXTURES / "forest-plot.xyz"
STEMS = [(0.0, 0.0, 0.36, 12.0), (7.0, 1.0, 0.24, 10.0), (2.0, 7.5, 0.30, 11.0)]


def test_plot_trees_finds_the_three_stems_and_records_the_order(backend):
    with backend.open(FOREST) as c:
        n, rec = recipes.plot_trees(c)
        assert n == 3
        ops = [s.op for s in rec.steps]
        # ground, then heights, then seeds, then segmentation: the order is the point.
        assert ops == ["ground_and_heights.segment_ground", "ground_and_heights.dem",
                       "detect_stems", "segment_trees"]
        assert rec.steps[0].params["auto_class_threshold"] is True
        assert rec.steps[2].summary["seeds"] == 3
        d = rec.to_dict()
        assert json.loads(json.dumps(d)) == d
        assert d["phytograph_version"] == pg.__version__
        assert d["backend_version"] == pg.EXPECTED_BACKEND_VERSION


def test_plot_inventory_measures_each_stem(backend):
    with backend.open(FOREST) as c:
        inv, rec = recipes.plot_inventory(c)
        assert len(inv) == 3
        heights = sorted(t["height_m"] for t in inv.trees)
        assert heights == pytest.approx(sorted(h for *_, h in STEMS), abs=0.5)
        assert rec.steps[-1].op == "tree_inventory"
        assert rec.steps[-1].summary["trees"] == 3


def test_tree_qsm_on_one_extracted_stem(backend):
    with backend.open(FOREST) as c:
        recipes.plot_trees(c)
        trees = c.split("tree_instance")
        try:
            tree = max(trees.values(), key=len)              # the 12 m stem at (0, 0)
            n_before = len(tree)
            # The fixture is bare stems: no leaves to remove, and no ML model needed.
            q, rec = recipes.tree_qsm(tree, wood_method=None, max_points=5000)
            assert q.metrics["tree_height_m"] == pytest.approx(12.0, abs=0.75)
            assert q.metrics["trunk_diameter_mm"] / 1000 == pytest.approx(0.36, rel=0.15)
            assert len(tree) == n_before, "the recipe must not modify its input"
            thin = next(s for s in rec.steps if s.op == "thin")
            assert thin.params["to"] == 5000 and thin.summary["points"] == 5000
        finally:
            for t in trees.values():
                t.close()


def test_tree_qsm_leaves_its_input_without_new_columns(backend):
    """Ground is segmented on a copy: the input gains no ground_class."""
    with backend.open(FOREST) as c:
        recipes.plot_trees(c)
        trees = c.split("tree_instance")
        try:
            fresh = backend.from_numpy(max(trees.values(), key=len).positions)
            with fresh:
                before = set(fresh.columns)
                assert "ground_class" not in before
                recipes.tree_qsm(fresh, wood_method=None, max_points=3000)
                assert set(fresh.columns) == before
        finally:
            for t in trees.values():
                t.close()


def test_tree_qsm_is_reproducible_from_its_seed(backend):
    with backend.open(FOREST) as c:
        recipes.plot_trees(c)
        trees = c.split("tree_instance")
        try:
            tree = max(trees.values(), key=len)
            a, _ = recipes.tree_qsm(tree, wood_method=None, max_points=4000, remove_ground=False)
            b, _ = recipes.tree_qsm(tree, wood_method=None, max_points=4000, remove_ground=False)
            assert a.metrics == b.metrics
        finally:
            for t in trees.values():
                t.close()


def test_clean_refuses_an_absurd_flag_rate_and_leaves_the_cloud(backend):
    with backend.open(FOREST) as c:
        n = len(c)
        # A radius far below the spacing isolates every point: that is a wrong
        # parameter, not noise, and the recipe must say so rather than delete.
        with pytest.raises(recipes.RecipeError, match="flagged as noise"):
            recipes.clean(c, method="ror", radius=1e-4, nb_points=8)
        assert len(c) == n


def test_herbaceous_organs_refuses_a_cloud_the_size_of_a_forest(backend):
    with backend.open(FOREST) as c:
        with pytest.raises(recipes.RecipeError, match="source_units"):
            recipes.herbaceous_organs(c)


def test_register_pair_recovers_a_known_offset(backend):
    with backend.open(FOREST) as target, backend.open(FOREST) as moving:
        moving.translate(0.05, -0.03, 0.02)
        reg, rec = recipes.register_pair(moving, target, global_first=False)
        assert reg.matrix[:3, 3] == pytest.approx([-0.05, 0.03, -0.02], abs=0.01)
        assert rec.steps[-1].summary["rmse_fraction"] < recipes.REGISTRATION_RMSE_FRACTION
        d = np.abs(moving.positions.mean(0) - target.positions.mean(0))
        assert d.max() < 0.01


def test_tree_qsm_spells_out_cloud_qsm_keywords_with_the_same_defaults():
    import inspect
    from phytograph import Cloud
    qsm = {k: p.default for k, p in inspect.signature(Cloud.qsm).parameters.items() if k != "self"}
    tq = inspect.signature(recipes.tree_qsm).parameters
    assert not any(p.kind is inspect.Parameter.VAR_KEYWORD for p in tq.values())
    assert {k: tq[k].default for k in qsm} == qsm
    with pytest.raises(TypeError):
        recipes.tree_qsm(None, fork_symetry=0.9)
