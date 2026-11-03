"""Pins backend-api/param_defaults.py to src/shared/parameterDefaults.contract.json,
which src/renderer/lib/parameterDefaults.contract.test.ts pins the renderer's
TypeScript copy to as well. See the module docstring."""
import json
from pathlib import Path

import pytest

import param_defaults as d

CONTRACT = json.loads((Path(__file__).resolve().parents[2] / "src" / "shared"
                       / "parameterDefaults.contract.json").read_text())


@pytest.mark.parametrize("case", CONTRACT["ground"], ids=lambda c: str(c["args"]))
def test_ground(case):
    assert d.ground_defaults(*case["args"]) == case["expected"]


@pytest.mark.parametrize("case", CONTRACT["dem"], ids=lambda c: str(c["args"]))
def test_dem(case):
    assert d.dem_defaults(*case["args"]) == case["expected"]


@pytest.mark.parametrize("case", CONTRACT["tree"], ids=lambda c: str(c["args"]))
def test_tree(case):
    assert d.tree_defaults(*case["args"]) == case["expected"]


def test_contract_exercises_every_branch():
    """A contract that only hit the flat branch would let the others drift."""
    ground = [c["expected"] for c in CONTRACT["ground"]]
    assert {g["rigidness"] for g in ground} == {1, 2, 3}
    cells = [c["expected"]["cell_size"] for c in CONTRACT["dem"]]
    assert min(cells) == 0.02 and max(cells) == 2.0
