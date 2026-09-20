"""The Python half of the LAI cross-process contract.

``src/shared/ladLai.contract.json`` is the written-down definition of LAI for a
gridded LAD result. ``src/renderer/lib/ladProfile.contract.test.ts`` asserts the
same cases against ``computeLadProfile``, which is what the LAD Profile window
DISPLAYS; this file asserts them against ``_lad_statistics_bytes``, which is what
the summary ``.txt`` export WRITES.

The failure being prevented is silent by construction: an app that shows one LAI
and exports a different one from the same voxels raises no error, and the user
has no way to tell which is right.

These call the real writer and parse its actual output lines, so the test cannot
pass by reimplementing the rule.
"""
import json
import pathlib

import pytest

import main

CONTRACT = (pathlib.Path(__file__).resolve().parents[2]
            / "src" / "shared" / "ladLai.contract.json")


def _load_cases():
    with CONTRACT.open(encoding="utf-8") as fh:
        return json.load(fh)["cases"]


CASES = _load_cases()


def _request(case):
    """Contract case -> a real LADExportRequest, world-frame as the wire is."""
    origin = case["origin"]
    cs = case["cell_size"]
    cells = []
    for c in case["cells"]:
        cell = {
            "center": [origin[0] + cs[0] * (c["i"] + 0.5),
                       origin[1] + cs[1] * (c["j"] + 0.5),
                       origin[2] + cs[2] * (c["k"] + 0.5)],
            "size": list(cs),
            "lad": c["lad"],
            "leaf_area": c["leaf_area"],
            "gtheta": 0.5,
            "hit_count": 10 if c["lad"] else 0,
        }
        # Absent in the JSON stays absent on the cell -- that IS the legacy case
        # the contract's fourth entry pins, and defaulting it here would erase it.
        for key in ("solved", "under_sampled", "lad_filled"):
            if key in c:
                cell[key] = c[key]
        # Wood fields exist only on the leaf/wood case. Absent stays absent, so
        # every other case still exercises the no-classification path where the
        # summary must print no WAI/PAI at all.
        for key in ("wad", "wood_area"):
            if key in c:
                cell[key] = c[key]
        cells.append(cell)
    return main.LADExportRequest(
        format="txt",
        cells=cells,
        nx=case["nx"], ny=case["ny"], nz=case["nz"],
        origin=origin,
        cell_size=cs,
        variables=["lad"],
    )


def _summary_fields(case):
    """Run the SHIPPED summary writer and parse the numbers back out of it."""
    text = main._lad_statistics_bytes(_request(case)).decode("utf-8")
    out = {}
    for line in text.splitlines():
        if line.startswith("LAI "):
            out["lai"] = float(line.split()[1])
        elif line.startswith("total leaf area "):
            out["leaf_area"] = float(line.rsplit(" ", 1)[1])
        elif line.startswith("number of occluded voxels "):
            # Distinguish from "number of occluded voxels that were filled".
            tail = line[len("number of occluded voxels "):]
            if not tail.startswith("that were filled"):
                out["occluded"] = int(tail)
        elif line.startswith("filled leaf area "):
            out["filled_leaf_area"] = float(line.rsplit(" ", 1)[1])
        elif line.startswith("WAI "):
            out["wai"] = float(line.split()[1])
        elif line.startswith("PAI "):
            out["pai"] = float(line.split()[1])
        elif line.startswith("total wood area "):
            out["wood_area"] = float(line.rsplit(" ", 1)[1])
    return out


def test_contract_file_carries_the_cases_both_sides_assert():
    # A truncated contract must fail loudly rather than turn both sides' tests
    # into no-ops that pass.
    assert len(CASES) >= 5
    # The wood case must be present, or the leaf/wood half of the contract
    # silently stops being asserted on either side.
    assert any("wai" in c["expected"] for c in CASES)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_summary_export_lai_matches_the_contract(case):
    got = _summary_fields(case)
    exp = case["expected"]
    # Compare against the contract value put through the SAME rounding the
    # writer applies (LAI 3 dp, leaf area 1 dp), rather than against a tolerance
    # band. A tolerance either sits exactly on the rounding boundary (0.4375
    # prints as 0.438, which is 5e-4 away) or has to be loosened until it stops
    # discriminating; rounding both sides identically is exact and keeps the
    # assertion as tight as the printed number allows.
    assert got["lai"] == round(exp["lai"], 3), (
        f"{case['name']}: {case['why']}")
    assert got["leaf_area"] == round(exp["measured_leaf_area"], 1)
    assert got["occluded"] == exp["occluded_count"]
    if "filled_leaf_area" in exp:
        assert got["filled_leaf_area"] == round(exp["filled_leaf_area"], 1)

    if "wai" in exp:
        # Wood obeys the SAME measured-voxel rule as leaf. The wood case gives
        # its occluded voxel a large wood area deliberately, so an implementation
        # that excluded occluded LEAF but not occluded WOOD fails right here.
        assert got["wood_area"] == round(exp["measured_wood_area"], 1)
        assert got["wai"] == round(exp["wai"], 3)
        assert got["pai"] == round(exp["pai"], 3)
    else:
        # No classification => the summary must not print wood lines at all.
        # Printing 0 would claim there is no wood, a different statement.
        assert "wai" not in got and "pai" not in got and "wood_area" not in got


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_ground_area_is_the_full_grid_footprint(case):
    """LAI's denominator, checked independently of its numerator.

    The footprint has no line of its own in the summary, and it cannot be
    recovered by dividing the two printed numbers -- they are rounded to 1 and 3
    decimals, so on the small contract grids that quotient is off by up to 7%.
    Instead the numerator is held fixed and the FOOTPRINT is varied: doubling
    nx must halve LAI. A denominator that had quietly shrunk to the OCCUPIED
    columns (the error the third contract case exists to catch) would not move
    at all, since the added columns hold nothing.
    """
    got = _summary_fields(case)
    if got["lai"] == 0:
        pytest.skip("no leaf area in this case, so the footprint is unobservable")

    wider = dict(case, nx=case["nx"] * 2)
    got_wider = _summary_fields(wider)
    # Same leaf area over twice the ground.
    assert got_wider["leaf_area"] == got["leaf_area"]
    assert got_wider["lai"] == pytest.approx(got["lai"] / 2, abs=1e-3), (
        f"{case['name']}: LAI must scale with the FULL grid footprint")
