"""Advisories carry stable codes, and recipes capture warnings into their record."""
from __future__ import annotations

import ast
import json
import warnings
from pathlib import Path

import pytest

from phytograph import advisories, recipes
from phytograph._transport import Transport
from phytograph.advisories import ADVISORIES, Advisory, QSMFailedWarning
from phytograph.errors import PhytographError

PKG = Path(advisories.__file__).resolve().parent


def _emitted_codes():
    """Every code literal passed to _advise/Advisory, every `code = "..."` on a
    warning class, and every value of recipes._ADVISORY_KEYS."""
    codes = set(recipes._ADVISORY_KEYS.values())
    for path in PKG.glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = getattr(node.func, "attr", getattr(node.func, "id", None))
                if name in ("_advise", "Advisory") and node.args and \
                        isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    codes.add(node.args[0].value)
            if isinstance(node, ast.ClassDef):
                for stmt in node.body:
                    if isinstance(stmt, ast.Assign) and any(
                            getattr(t, "id", None) == "code" for t in stmt.targets) \
                            and isinstance(stmt.value, ast.Constant):
                        codes.add(stmt.value.value)
    return codes


def test_every_emitted_code_is_registered():
    codes = _emitted_codes()
    assert "qsm.inferred_radius" in codes and "qsm.tree_failed" in codes   # the scan works
    assert codes <= set(ADVISORIES), sorted(codes - set(ADVISORIES))


def test_an_unregistered_code_is_refused():
    with pytest.raises(ValueError, match="unregistered"):
        Advisory("made.up", "x")


def test_the_stderr_line_is_one_parseable_line():
    line = Advisory("backend.warning", "two\nlines", "segment_wood").line()
    assert line == "PHYTOGRAPH ADVISORY [backend.warning] (segment_wood): two\\nlines"
    assert "\n" not in line


def test_response_fields_map_to_codes():
    got = recipes._advisories({"warnings": ["w1"], "ground_warning": True,
                               "fusion_warning": "two trunks", "scene_advisory": "orchard?",
                               "points": 5})
    assert ("backend.warning", "w1") in got
    assert ("backend.fusion_warning", "two trunks") in got
    assert ("registration.scene", "orchard?") in got
    assert any(code == "backend.ground_warning" for code, _ in got)
    assert len(got) == 4


def _record():
    return recipes.RecipeRecord(recipe="t", params={}, phytograph_version="0", backend_version=None,
                                input={})


def test_a_dropped_tree_lands_in_the_record_and_is_still_shown():
    @recipes._records_warnings
    def recipe():
        warnings.warn("QSM failed for tree 3: too few points", QSMFailedWarning)
        warnings.warn("something generic", RuntimeWarning)
        return None, _record()

    with warnings.catch_warnings(record=True) as shown:
        warnings.simplefilter("always")
        _, rec = recipe()
    codes = {a["code"]: a["message"] for a in rec.advisories}
    assert codes["qsm.tree_failed"] == "QSM failed for tree 3: too few points"
    assert codes["python.warning"] == "RuntimeWarning: something generic"
    assert {w.category for w in shown} == {QSMFailedWarning, RuntimeWarning}
    json.dumps(rec.to_dict())


def test_a_failing_recipe_carries_its_warnings_in_the_error():
    @recipes._records_warnings
    def recipe():
        rec = _record()
        warnings.warn("QSM failed for tree 1: x", QSMFailedWarning)
        raise rec._fail("nothing usable")

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with pytest.raises(recipes.RecipeError) as e:
            recipe()
    assert any(a["code"] == "qsm.tree_failed" for a in e.value.detail["advisories"])


def test_an_auto_confirmed_cost_gate_is_a_coded_warning():
    t = Transport("http://127.0.0.1:1", None)
    sent = []

    def send(body):
        sent.append(body)
        if not body.get("acknowledge_cost"):
            raise PhytographError("x", status=409, detail={"cost_warning": {"message": "~5 min"},
                                                           "message": "~5 min"})
        return {"ok": True}

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        assert t._with_cost_gate("/api/x", {}, send) == {"ok": True}
    assert [w.category.code for w in caught] == ["backend.cost_acknowledged"]
    assert sent[-1]["acknowledge_cost"] is True


def test_deprecations_are_shown_but_not_recorded():
    @recipes._records_warnings
    def recipe():
        warnings.warn("old API", DeprecationWarning)
        return None, _record()

    with warnings.catch_warnings(record=True) as shown:
        warnings.simplefilter("always")
        _, rec = recipe()
    assert rec.advisories == []
    assert [w.category for w in shown] == [DeprecationWarning]
