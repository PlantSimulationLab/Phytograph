"""QSM.to_treeqsm_csv: the app's TreeQSM-layout export, from Python."""
from __future__ import annotations

import csv
import json

import pytest

from phytograph import QSM, recipes
from phytograph.results import TREEQSM_CSV_HEADER, _js_number
from conftest import E2E_FIXTURES, ROOT

CONTRACT = json.loads((ROOT / "src" / "shared" / "qsmTreeqsmCsv.contract.json").read_text())
FOREST = E2E_FIXTURES / "forest-plot.xyz"


def test_writes_exactly_what_the_app_writes(tmp_path):
    """The same document pins src/renderer/lib/qsmExport.ts (vitest)."""
    q = QSM(cylinders=CONTRACT["qsm"]["cylinders"], shoots=CONTRACT["qsm"]["shoots"], metrics={})
    out = q.to_treeqsm_csv(tmp_path / "q.csv")
    assert out.read_bytes() == CONTRACT["csv"].encode()


def test_the_header_is_the_one_heliades_reads():
    assert TREEQSM_CSV_HEADER == (
        "ID,parentID,branchID,branchOrder,segmentID,parentSegmentID,startX,startY,startZ,"
        "endX,endY,endZ,axisX,axisY,axisZ,radius,length,surfaceCoverage,meanAbsDeviation")


@pytest.mark.parametrize("value,js", [
    (1.0, "1"), (0.1, "0.1"), (1e-7, "1e-7"), (1e-6, "0.000001"), (1e21, "1e+21"),
    (1.2345678901234568e20, "123456789012345680000"), (-0.5, "-0.5"), (0.0, "0"),
    (float("nan"), ""), (float("inf"), ""),
])
def test_numbers_are_spelled_as_javascript_spells_them(value, js):
    assert _js_number(value) == js


def test_round_trips_through_the_engine_reader(backend, tmp_path):
    with backend.open(FOREST) as c:
        recipes.plot_trees(c)
        trees = c.split("tree_instance")
        try:
            tree = max(trees.values(), key=len)
            q, _ = recipes.tree_qsm(tree, wood_method=None, max_points=4000)
        finally:
            for t in trees.values():
                t.close()
    path = q.to_treeqsm_csv(tmp_path / "tree.csv")
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == len(q.cylinders)

    back = backend._transport.post_json("/api/qsm/import", {"path": str(path)})
    got = {c["cyl_id"]: c for c in back["cylinders"]}
    assert len(got) == len(q.cylinders)
    for c in q.cylinders:
        g = got[c["cyl_id"]]
        assert g["parent_id"] == c["parent_id"]
        assert g["shoot_id"] == c["shoot_id"]
        assert g["rank"] == c["rank"]
        assert g["start"] == pytest.approx(c["start"], abs=1e-12)
        assert g["end"] == pytest.approx(c["end"], abs=1e-12)
        assert g["radius"] == pytest.approx(c["radius"], abs=1e-12)
    assert back["metrics"]["tree_height_m"] == pytest.approx(q.metrics["tree_height_m"], abs=1e-9)
