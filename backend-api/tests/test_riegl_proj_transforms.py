"""RIEGL .PROJ layout discovery and the SOP transform chain.

Every test here is a PURE FUNCTION test — no Docker, no RiVLib, no point data.
That is the point: the reader's decode path is shared with .riproject and
already exercised, so what is genuinely new and genuinely easy to get silently
wrong is the metadata and the arithmetic.

The matrices in `fixtures/riegl_proj_sops.json` are verbatim from a real
VZ-2000i acquisition. `expected_prcs` comes from that project's own
projectmap.json and is NOT derived from the matrices, so reproducing it is an
independent check of the chain rather than a restatement of it.
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

# The reader runs inside the container and imports nothing from the backend, so
# it is not on the path by default.
READER_DIR = Path(__file__).resolve().parents[2] / "docker" / "riegl"
if str(READER_DIR) not in sys.path:
    sys.path.insert(0, str(READER_DIR))

import rxp_reader as R  # noqa: E402

FIXTURE = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "riegl_proj_sops.json").read_text()
)


def _write_sop(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc))


def _build_proj(root: Path, positions, *, vpp="Voxels1.VPP", manifest=True) -> Path:
    """Fabricate a minimal .PROJ tree.

    `positions` is a list of (name, kind, has_rxp) where kind is which sop
    sidecar to write ("plane" / "voxel" / "pose" / None), taken from the real
    fixture so the numbers are the instrument's own.
    """
    proj = root / "2024-07-18.PROJ"
    if vpp:
        _write_sop(proj / vpp / "VPP.vop", FIXTURE["vpp_vop"])

    entries = []
    for name, kind, has_rxp in positions:
        pos_dir = proj / f"{name}.SCNPOS"
        (pos_dir / "scans").mkdir(parents=True, exist_ok=True)
        if has_rxp:
            stem = "240718_102357"
            (pos_dir / "scans" / f"{stem}.rxp").write_bytes(b"\0" * 1470)
            # Companions that must never be picked as the main stream.
            (pos_dir / "scans" / f"{stem}.mon.rxp").write_bytes(b"\0" * 10)
            (pos_dir / "scans" / f"{stem}.residual.rxp").write_bytes(b"\0" * 10)
            (pos_dir / "scans" / f"{stem}.scn").write_text(json.dumps(FIXTURE["scn"]))
        if kind:
            fn = {
                "plane": "plane_registration.sopv",
                "voxel": "voxel_registration.sopv",
                "pose": "pose_estimation.sop",
            }[kind]
            _write_sop(pos_dir / fn, FIXTURE["positions"][name][kind])
        entries.append({"name": name, "scan": "240718_102357",
                        "success": kind == "plane", "vpp": vpp})

    if manifest:
        (proj / "project.json").write_text(json.dumps({
            "scanner": {"type": "VZ-2000i", "serialnumber": "H2228523"},
            "registration": {"scanpositions": entries},
        }))
    return proj


# ---------------------------------------------------------------------------
# Layout detection + discovery
# ---------------------------------------------------------------------------


def test_detects_the_proj_layout(tmp_path):
    proj = _build_proj(tmp_path, [("ScanPos001", "pose", True)])
    assert R.detect_layout(str(proj)) == R.LAYOUT_PROJ


def test_detects_a_riproject_as_before(tmp_path):
    # A flat ScanPos### folder with a .pat beside the .rxp and no manifest.
    proj = tmp_path / "old.riproject"
    (proj / "ScanPos001").mkdir(parents=True)
    (proj / "ScanPos001" / "180223_145028.rxp").write_bytes(b"\0")
    assert R.detect_layout(str(proj)) == R.LAYOUT_RIPROJECT


def test_discovery_is_filesystem_driven_not_manifest_driven(tmp_path):
    """A position absent from project.json still holds real point data.

    ScanPos019 of the reference project is an aborted acquisition: it has a
    17 MB .rxp and a .scn, no pose at all, and appears NOWHERE in the
    manifest's registration list. Driving discovery from the manifest would
    silently discard it.
    """
    proj = _build_proj(tmp_path, [("ScanPos001", "pose", True)])
    orphan = proj / "ScanPos019.SCNPOS" / "scans"
    orphan.mkdir(parents=True)
    (orphan / "240718_111419.rxp").write_bytes(b"\0" * 100)

    names = [p["name"] for p in R.find_scan_positions(str(proj))]
    assert names == ["ScanPos001", "ScanPos019"]
    orphan_pos = R.find_scan_positions(str(proj))[1]
    assert orphan_pos["registration"] == "none"
    assert orphan_pos["manifest_success"] is None


def test_a_position_with_no_rxp_is_skipped(tmp_path):
    # ScanPos025 of the reference project: the directory tree exists but
    # nothing was ever written into it.
    proj = _build_proj(tmp_path, [("ScanPos001", "pose", True)])
    (proj / "ScanPos025.SCNPOS" / "scans").mkdir(parents=True)
    (proj / "ScanPos025.SCNPOS" / "images").mkdir(parents=True)
    assert [p["name"] for p in R.find_scan_positions(str(proj))] == ["ScanPos001"]


def test_companion_streams_are_never_taken_as_the_scan(tmp_path):
    """.mon.rxp is housekeeping and .residual.rxp is MTA leftovers.

    Both sort BEFORE the main file's own name in some stems, so picking the
    first glob hit without filtering would import the wrong stream.
    """
    proj = _build_proj(tmp_path, [("ScanPos001", "pose", True)])
    pos = R.find_scan_positions(str(proj))[0]
    assert pos["rxp_path"].endswith("240718_102357.rxp")
    assert not pos["rxp_path"].endswith(".mon.rxp")
    assert not pos["rxp_path"].endswith(".residual.rxp")


def test_scan_positions_carry_the_scn_not_a_pat(tmp_path):
    proj = _build_proj(tmp_path, [("ScanPos001", "pose", True)])
    pos = R.find_scan_positions(str(proj))[0]
    assert pos["scn_path"] and pos["scn_path"].endswith(".scn")
    assert pos["pat_path"] is None


# ---------------------------------------------------------------------------
# .scn parsing
# ---------------------------------------------------------------------------


def test_parse_scn_matches_the_pat_contract(tmp_path):
    """A .scn and a .pat must produce the SAME dict, or downstream diverges.

    Everything past discovery — scan_params, the LAD raster, the Helios export —
    reads one shape. If the two parsers disagreed on key names or on the
    fencepost rule, a .PROJ would build a subtly different raster from an
    identical sweep.
    """
    scn = tmp_path / "a.scn"
    scn.write_text(json.dumps(FIXTURE["scn"]))
    pat = tmp_path / "a.pat"
    fov = FIXTURE["scn"]["fov"]
    pat.write_text(
        "SCN_SET_RECT_FOV({thetaStart:.4f}, {thetaStop:.4f}, {thetaIncrement:.6f}, "
        "{phiStart:.4f}, {phiStop:.4f}, {phiIncrement:.6f})\r\n".format(**fov)
    )

    from_scn = R.parse_scn(str(scn))
    from_pat = R.parse_pat(str(pat))
    assert set(from_scn) == set(from_pat)
    for key in from_scn:
        assert from_scn[key] == pytest.approx(from_pat[key], rel=1e-4), key

    # And the real numbers, so a convention slip is caught rather than just a
    # mismatch between two equally-wrong parsers. RIEGL theta is zenith from +Z,
    # which is already Phytograph's convention — no 90-degree flip.
    assert from_scn["theta_min"] == 30.0
    assert from_scn["theta_max"] == 130.0
    assert from_scn["phi_min"] == 0.0
    assert from_scn["phi_max"] == 360.0
    # phi wraps, so its last column coincides with the first: a sample count,
    # not a fencepost count. theta does not wrap, so it keeps the +1.
    assert from_scn["n_phi"] == 4500
    assert from_scn["n_theta"] == 2512


def test_parse_scn_survives_junk(tmp_path):
    bad = tmp_path / "b.scn"
    bad.write_text("not json")
    assert R.parse_scn(str(bad)) is None
    bad.write_text(json.dumps({"programName": "300 kHz"}))
    assert R.parse_scn(str(bad)) is None
    assert R.parse_scn(str(tmp_path / "missing.scn")) is None


# ---------------------------------------------------------------------------
# The SOP chain — the numeric core
# ---------------------------------------------------------------------------


def test_sop_chain_reproduces_the_projects_own_prcs_coordinates(tmp_path):
    """SOP = VPP.vop o plane_registration.sopv, checked against projectmap.json.

    This is the load-bearing assertion of the whole feature. `expected_prcs` is
    the instrument's own independent record of where each scanner stood, so
    agreement to a micron means the composition order and the matrix convention
    are both right. Getting either wrong misplaces every cloud.
    """
    positions = [(f"ScanPos{i:03d}", "plane", True) for i in range(2, 10)]
    proj = _build_proj(tmp_path, positions)

    for pos in R.find_scan_positions(str(proj)):
        expected = FIXTURE["expected_prcs"][pos["name"]]
        assert pos["registration"] == "registered"
        got = np.asarray(pos["sop"])[:3, 3]
        assert got == pytest.approx(np.asarray(expected), abs=1e-6), pos["name"]


def test_the_per_position_vop_is_not_part_of_the_chain(tmp_path):
    """Composing ScanPosNNN.vop in as well is wrong by 8-41 cm.

    The Voxels1.VPP directory holds a .vop PER POSITION alongside VPP.vop, which
    reads like it belongs in the chain. It does not — it is voxel bookkeeping.
    This test pins the difference so nobody "fixes" the chain by adding it.
    """
    name = "ScanPos007"
    proj = _build_proj(tmp_path, [(name, "plane", True)])
    sop, _ = R.load_sop(str(proj / f"{name}.SCNPOS"), str(proj / "Voxels1.VPP"))
    correct = np.asarray(sop)[:3, 3]
    expected = np.asarray(FIXTURE["expected_prcs"][name])
    assert correct == pytest.approx(expected, abs=1e-6)

    # Had the per-position .vop been folded in, the answer would be far off.
    vop = np.eye(4)
    vop[:3, :3] = FIXTURE["vpp_vop"]["matrix3x3"]
    t = FIXTURE["vpp_vop"]["translation"]
    vop[:3, 3] = [t["x"], t["y"], t["z"]]
    doubled = (vop @ np.asarray(sop))[:3, 3]
    assert np.linalg.norm(doubled - expected) > 0.05


def test_sop_resolution_prefers_the_best_available_pose(tmp_path):
    """plane > voxel > pose_estimation > identity, with the status to match.

    The order is an accuracy ranking: plane registration is millimetres, coarse
    voxel registration is centimetres, and the pose estimate is about a metre.
    Reporting a metre-level prior as "registered" would let that error pass for
    a survey.
    """
    name = "ScanPos007"
    for kind, expected_status in (("plane", "registered"),
                                  ("voxel", "registered"),
                                  ("pose", "prior"),
                                  (None, "none")):
        root = tmp_path / (kind or "bare")
        proj = _build_proj(root, [(name, kind, True)])
        _, status = R.load_sop(str(proj / f"{name}.SCNPOS"), str(proj / "Voxels1.VPP"))
        assert status == expected_status, kind

    # With both present the plane result wins, and it is NOT the coarse one.
    root = tmp_path / "both"
    proj = _build_proj(root, [(name, "plane", True)])
    _write_sop(proj / f"{name}.SCNPOS" / "voxel_registration.sopv",
               FIXTURE["positions"][name]["voxel"])
    sop, status = R.load_sop(str(proj / f"{name}.SCNPOS"), str(proj / "Voxels1.VPP"))
    assert status == "registered"
    assert np.asarray(sop)[:3, 3] == pytest.approx(
        np.asarray(FIXTURE["expected_prcs"][name]), abs=1e-6
    )


def test_the_reference_position_falls_back_to_its_pose_estimate(tmp_path):
    """ScanPos001 has NO .sopv — registration has nothing to register it against.

    Its pose_estimation.sop euler angles match its all_sopv.csv row exactly,
    which is how we know the fallback is the intended answer and not a gap.
    """
    proj = _build_proj(tmp_path, [("ScanPos001", "pose", True)])
    pos = R.find_scan_positions(str(proj))[0]
    assert pos["registration"] == "prior"
    ypr = R.decompose_sop(np.asarray(pos["sop"]))
    csv_row = FIXTURE["all_sopv_euler"]["ScanPos001"]
    # VPP.vop contributes its own 0.172 deg of yaw on top of the SOCS->VOCS
    # rotation the CSV reports, so the tolerance covers that and nothing more.
    assert ypr["roll_deg"] == pytest.approx(csv_row["roll_deg"], abs=0.02)
    assert ypr["pitch_deg"] == pytest.approx(csv_row["pitch_deg"], abs=0.02)
    assert ypr["yaw_deg"] == pytest.approx(csv_row["yaw_deg"] + 0.172, abs=0.02)


def test_a_missing_vpp_degrades_to_the_sopv_alone(tmp_path):
    # Without VPP.vop the position is still placed, just in VOCS rather than
    # PRCS — a fixed offset, not a scramble. Better than refusing to import.
    name = "ScanPos007"
    proj = _build_proj(tmp_path, [(name, "plane", True)], vpp=None)
    sop, status = R.load_sop(str(proj / f"{name}.SCNPOS"), None)
    assert status == "registered"
    t = FIXTURE["positions"][name]["plane"]["translation"]
    assert np.asarray(sop)[:3, 3] == pytest.approx([t["x"], t["y"], t["z"]], abs=1e-9)


# ---------------------------------------------------------------------------
# Decomposition + the phi window
# ---------------------------------------------------------------------------


def test_decompose_matches_the_projects_own_euler_table(tmp_path):
    """The registration's own all_sopv.csv is the reference for the convention.

    Everything the decomposition feeds — azimuth_offset_deg, the tilt fields,
    the phi counter-rotation — is silently wrong if the Z-Y-X order or a sign
    is off, and a wrong yaw rotates the LAD raster without erroring.
    """
    positions = [(f"ScanPos{i:03d}", "plane", True) for i in range(2, 10)]
    proj = _build_proj(tmp_path, positions)
    for pos in R.find_scan_positions(str(proj)):
        ypr = R.decompose_sop(np.asarray(pos["sop"]))
        row = FIXTURE["all_sopv_euler"][pos["name"]]
        assert ypr["roll_deg"] == pytest.approx(row["roll_deg"], abs=0.02)
        assert ypr["pitch_deg"] == pytest.approx(row["pitch_deg"], abs=0.02)
        assert ypr["yaw_deg"] == pytest.approx(row["yaw_deg"] + 0.172, abs=0.02)


def test_the_tilt_stays_small_which_is_why_the_ptx_rule_is_relaxed(tmp_path):
    """PRCS is a true ENU frame, so the residual roll/pitch IS the plumb tilt.

    _ptx_scan_params drops the azimuth sweep once roll or pitch reaches 0.5 deg
    because for a generic pose those angles are unmodellable. Here they are the
    inclinometer reading, and this test documents the magnitude that makes
    keeping the azimuth reasonable: under 2 degrees across the whole project.
    """
    positions = [(f"ScanPos{i:03d}", "plane", True) for i in range(2, 10)]
    proj = _build_proj(tmp_path, positions)
    for pos in R.find_scan_positions(str(proj)):
        ypr = R.decompose_sop(np.asarray(pos["sop"]))
        assert max(abs(ypr["roll_deg"]), abs(ypr["pitch_deg"])) < 2.0
        # ...while the yaw is an order of magnitude larger. That asymmetry is
        # the whole reason ScanParameters can represent these poses at all.
        assert abs(ypr["yaw_deg"]) > 20.0


def test_a_full_circle_sweep_is_not_rotated():
    # Rotating a full circle is a no-op, and shifting it would report an
    # arbitrary-looking window for a scan that plainly covers everything.
    params = {"phi_min": 0.0, "phi_max": 360.0}
    R._rotate_phi_window(params, -29.5)
    assert params == {"phi_min": 0.0, "phi_max": 360.0}


def test_a_partial_sweep_counter_rotates_by_the_yaw():
    """World phi = local phi - yaw, matching _ptx_scan_params' `90 - az - yaw`.

    LAD and gap-fill bin returns by WORLD-frame phi against this window, so
    after the cloud is rotated into PRCS the window has to move with it. Leaving
    it put sends every return to the wrong column.
    """
    params = {"phi_min": 10.0, "phi_max": 100.0}
    R._rotate_phi_window(params, 30.0)
    assert params["phi_min"] == pytest.approx(340.0)
    # The span is carried rather than re-normalised, so a sweep crossing north
    # stays contiguous instead of folding to 0..360.
    assert params["phi_max"] == pytest.approx(430.0)


def test_scan_params_carry_the_pose_only_in_the_registered_frame():
    sop = [[0.0, -1.0, 0.0, 5.0],
           [1.0, 0.0, 0.0, -2.0],
           [0.0, 0.0, 1.0, 0.5],
           [0.0, 0.0, 0.0, 1.0]]
    base = {
        "scan_params": {"theta_min": 30.0, "theta_max": 130.0,
                        "phi_min": 0.0, "phi_max": 360.0},
        "sop": sop,
        "origin_prior": [1.0, 1.0, 1.0],
        "instrument": {"model": "VZ-2000i"},
    }

    registered = json.loads(json.dumps(base))
    R._attach_scan_params_extras(registered, R.FRAME_REGISTERED)
    sp = registered["scan_params"]
    # The origin is where the instrument STOOD, i.e. the SOP translation — not
    # the GNSS prior, which would place the marker metres from its own cloud.
    assert sp["origin"] == [5.0, -2.0, 0.5]
    assert sp["azimuth_offset_deg"] == pytest.approx(90.0)
    assert sp["tilt_roll_deg"] == pytest.approx(0.0, abs=1e-9)
    assert sp["tilt_pitch_deg"] == pytest.approx(0.0, abs=1e-9)
    assert sp["scanner_model"] == "VZ-2000i"

    local = json.loads(json.dumps(base))
    R._attach_scan_params_extras(local, R.FRAME_LOCAL)
    sp = local["scan_params"]
    assert sp["origin"] == [1.0, 1.0, 1.0]
    # No pose was applied, so reporting a heading or a tilt would describe a
    # rotation the points did not receive.
    assert "azimuth_offset_deg" not in sp
    assert "tilt_roll_deg" not in sp


def test_a_riproject_entry_is_unaffected_by_asking_for_registered():
    # find_scan_positions gives a .riproject sop=None, so even an explicit
    # registered request falls back to the prior rather than inventing a pose.
    entry = {"scan_params": {"phi_min": 0.0, "phi_max": 360.0},
             "sop": None, "origin_prior": [3.0, 4.0, 5.0]}
    R._attach_scan_params_extras(entry, R.FRAME_REGISTERED)
    assert entry["scan_params"]["origin"] == [3.0, 4.0, 5.0]
    assert "azimuth_offset_deg" not in entry["scan_params"]


# ---------------------------------------------------------------------------
# GNSS from the pose sidecar
# ---------------------------------------------------------------------------


def test_pose_gnss_reads_the_fix_without_decoding_points(tmp_path):
    """A .PROJ states its GNSS as JSON; a .riproject hides it in the point stream.

    This is what lets a .PROJ preview skip decoding entirely — 24 positions at
    ~10 s each is four minutes of spinner otherwise.
    """
    pose = tmp_path / "final.pose"
    pose.write_text(json.dumps({
        "gnss": {"latitude": 39.604335683, "longitude": -122.258856603,
                 "altitude": 33.32170104980469, "coordinateSystem": "EPSG::4979",
                 "numSatellites": 17, "fixInfo": "Single"},
    }))
    fix = R._pose_gnss(str(pose))
    assert fix["latitude"] == pytest.approx(39.604335683)
    assert fix["longitude"] == pytest.approx(-122.258856603)
    # Ellipsoidal, matching what the hk path yields, so both feed gnss_to_enu.
    assert fix["height_m"] == pytest.approx(33.3217010498)
    assert fix["height_datum"] == "ellipsoidal"
    assert fix["satellites"] == 17


def test_pose_gnss_rejects_nonsense(tmp_path):
    pose = tmp_path / "final.pose"
    pose.write_text(json.dumps({"gnss": {"latitude": 999.0, "longitude": 0.0}}))
    assert R._pose_gnss(str(pose)) is None
    pose.write_text(json.dumps({"navigation": {}}))
    assert R._pose_gnss(str(pose)) is None
    assert R._pose_gnss(str(tmp_path / "nope.pose")) is None


# ---------------------------------------------------------------------------
# The sensor frame: levelling a .riproject with its own inclinometer
# ---------------------------------------------------------------------------
#
# Ground truth is RiSCAN PRO's own SOP for the same scan position, so these
# assert against the instrument's surveyed answer rather than against our own
# arithmetic. See the fixture's `_baseline_note` for why the final SOP is the
# right baseline even though that project ran Multi-Station Adjustment.

POSE_FIXTURE = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "riegl_pose_hr.json").read_text()
)


def _write_hk(path: Path, lines) -> str:
    path.write_text("\n".join(lines) + "\n")
    return str(path)


def test_scanner_pose_hr_is_parsed_in_degrees(tmp_path):
    entry = POSE_FIXTURE["positions"]["peach_2018_ScanPos001"]
    hk = _write_hk(tmp_path / "hk.txt", [entry["raw"]])
    pose = R.parse_scanner_pose_hr(hk)
    assert pose is not None
    # Already degrees on the wire — no scaling, unlike hk_incl's millidegrees.
    assert pose["roll_deg"] == pytest.approx(1.5258935689926147)
    assert pose["pitch_deg"] == pytest.approx(0.13434524834156036)
    assert pose["yaw_deg"] == pytest.approx(58.019416809082031)
    # The accuracy fields sit AFTER the two position accuracies. Reading them
    # positionally without that offset yields rAcc/pAcc of 1.19/1.56 and a yAcc
    # of 0.008 — a plausible-looking but exactly wrong answer, which is why the
    # field order is pinned here.
    assert pose["roll_acc_deg"] == pytest.approx(0.008, abs=1e-4)
    assert pose["pitch_acc_deg"] == pytest.approx(0.008, abs=1e-4)
    assert pose["yaw_acc_deg"] == pytest.approx(19.04, abs=0.01)


def test_the_leading_all_nan_pose_record_is_skipped(tmp_path):
    entry = POSE_FIXTURE["positions"]["peach_2018_ScanPos001"]
    hk = _write_hk(tmp_path / "hk.txt", [POSE_FIXTURE["nan_row"], entry["raw"]])
    pose = R.parse_scanner_pose_hr(hk)
    assert pose is not None
    assert pose["roll_deg"] == pytest.approx(1.5258935689926147)


def test_a_position_whose_pose_is_only_nan_has_none(tmp_path):
    # Not hypothetical: 4 of 8 positions in 2017-12-15.001 are like this.
    hk = _write_hk(tmp_path / "hk.txt", [POSE_FIXTURE["nan_row"]] * 5)
    assert R.parse_scanner_pose_hr(hk) is None


def test_hk_incl_counts_are_millidegrees_and_averaged(tmp_path):
    # ridataspec.hpp, struct hk_incl: ROLL/PITCH are int16 in [0.001 deg].
    hk = _write_hk(tmp_path / "hk.txt", [
        "hk_incl (10006.0), 1520, 130, 0, 0",
        "hk_incl (10006.0), 1540, 150, 0, 0",
    ])
    incl = R.parse_hk_inclination(hk)
    assert incl["roll_deg"] == pytest.approx(1.530)
    assert incl["pitch_deg"] == pytest.approx(0.140)
    # Averaged, not first-sampled: one reading throws away a ~160x noise
    # reduction that a non-drifting sensor gives for free.
    assert incl["sample_count"] == 2


def test_the_two_inclinometer_sources_agree(tmp_path):
    """hk_incl and scanner_pose_hr measure the same physical tilt.

    They are independent records off the same sensor, so a misparse of either
    (wrong scale, wrong field offset) shows up as disagreement here.
    """
    entry = POSE_FIXTURE["positions"]["peach_2018_ScanPos001"]
    hk = _write_hk(tmp_path / "hk.txt", [entry["raw"]])
    pose = R.parse_scanner_pose_hr(hk)
    ref = entry["hk_incl_mean"]
    assert pose["roll_deg"] == pytest.approx(ref["roll_deg"], abs=0.2)
    assert pose["pitch_deg"] == pytest.approx(ref["pitch_deg"], abs=0.2)


def _plane_tilt_deg(points):
    """Angle between a point set's best-fit plane and horizontal, in degrees.

    The same quantity measured on the real orchard clouds that exposed the
    sign error, so the unit test and the field check speak in one unit.
    """
    P = np.asarray(points, dtype=np.float64)
    coef, *_ = np.linalg.lstsq(
        np.c_[P[:, 0], P[:, 1], np.ones(len(P))], P[:, 2], rcond=None
    )
    normal = np.array([-coef[0], -coef[1], 1.0])
    normal /= np.linalg.norm(normal)
    return math.degrees(math.acos(min(1.0, abs(normal[2]))))


def _attitude(roll_deg, pitch_deg):
    """Ry(pitch) @ Rx(roll) — the body->world attitude the reading describes."""
    roll, pitch = math.radians(roll_deg), math.radians(pitch_deg)
    rx = np.array([[1, 0, 0],
                   [0, math.cos(roll), -math.sin(roll)],
                   [0, math.sin(roll), math.cos(roll)]])
    ry = np.array([[math.cos(pitch), 0, math.sin(pitch)],
                   [0, 1, 0],
                   [-math.sin(pitch), 0, math.cos(pitch)]])
    return ry @ rx


def test_sensor_level_matrix_levels_a_body_frame_ground_plane():
    """Level a plane that is FLAT IN THE WORLD, sampled in the scanner's frame.

    This is the geometry the feature exists for, and the reason it is written
    this way is that the previous test could not fail. It built its probe as
    `attitude @ [0,0,1]` — a vector already in WORLD coordinates — and asked
    the matrix to bring it back to vertical, which any exact inverse satisfies
    no matter which direction the points actually need. The matrix was the
    transpose of the correct one and the test passed anyway, while real imports
    came out with DOUBLE their original tilt (measured on 2018-02-23.002:
    2.90 deg -> 6.15 deg).

    A point arrives in SOCS, the body frame. Level ground seen from a tilted
    instrument is therefore `attitude.T @ p_world`, and levelling must undo
    exactly that. Feeding body-frame input is what makes the direction
    observable, so a transposed matrix now doubles the tilt here too.
    """
    roll, pitch = 1.526, 0.134
    attitude = _attitude(roll, pitch)
    matrix = R.sensor_level_matrix(roll, pitch)[:3, :3]

    # A patch of genuinely level ground, expressed in the tilted body frame.
    world = np.array([[x, y, 0.0] for x in (-20.0, 0.0, 20.0)
                      for y in (-20.0, 0.0, 20.0)])
    body = world @ attitude  # == (attitude.T @ p) for each row

    # The instrument really is tilted: the ground is off-level as it sees it.
    assert _plane_tilt_deg(body) == pytest.approx(1.532, abs=0.01)

    # Levelling brings it back to horizontal — and the transpose would take it
    # to ~3.06 deg, so this assertion is what distinguishes the two.
    assert _plane_tilt_deg(body @ matrix.T) == pytest.approx(0.0, abs=1e-9)


def test_sensor_level_matrix_transpose_would_double_the_tilt():
    """Pin the failure signature itself, so the sign can never drift back.

    Stated separately because "doubles the tilt" is the observable that named
    the bug in the field, and a future refactor that reintroduces the transpose
    should fail on a test that says so in those words.
    """
    roll, pitch = 1.315766, 2.972155  # ScanPos002 of 2018-02-23.002
    attitude = _attitude(roll, pitch)
    world = np.array([[x, y, 0.0] for x in (-20.0, 0.0, 20.0)
                      for y in (-20.0, 0.0, 20.0)])
    body = world @ attitude
    raw = _plane_tilt_deg(body)

    correct = R.sensor_level_matrix(roll, pitch)[:3, :3]
    assert _plane_tilt_deg(body @ correct.T) == pytest.approx(0.0, abs=1e-9)
    assert _plane_tilt_deg(body @ correct.T.T) == pytest.approx(2 * raw, abs=0.02)


def test_sensor_frame_reports_no_residual_tilt():
    """scan_params must describe the cloud as DELIVERED, which is plumb.

    tilt_roll/tilt_pitch orient the scanner marker and a Helios re-export, so
    emitting the raw inclinometer reading here would tilt both by the very
    angle levelling just removed — points and marker disagreeing. The reading
    is not lost; it stays in `sensor_pose`.
    """
    entry = {
        "name": "ScanPos001",
        "origin_prior": [1.0, 2.0, 3.0],
        "sensor_pose": {"roll_deg": 1.526, "pitch_deg": 0.134,
                        "source": "scanner_pose_hr"},
        "scan_params": {"phi_min": 0.0, "phi_max": 360.0},
    }
    R._attach_scan_params_extras(entry, R.FRAME_SENSOR)

    assert entry["scan_params"]["tilt_roll_deg"] == 0.0
    assert entry["scan_params"]["tilt_pitch_deg"] == 0.0
    # The measurement survives where it belongs.
    assert entry["sensor_pose"]["roll_deg"] == pytest.approx(1.526)
    # And the matrix that justifies the zeros is the one the backend applies.
    assert np.allclose(
        np.asarray(entry["sensor_matrix"])[:3, :3],
        _attitude(1.526, 0.134),
    )


def test_sensor_level_matrix_applies_no_heading():
    """Levelling must not rotate the cloud in azimuth.

    A horizontal vector may swing by the small amount implied by tipping the
    frame upright, but nothing resembling the 10-14 deg the compass would add.
    """
    matrix = R.sensor_level_matrix(1.526, 0.134)[:3, :3]
    worst = 0.0
    for az in range(0, 360, 5):
        v = np.array([math.cos(math.radians(az)), math.sin(math.radians(az)), 0.0])
        w = matrix @ v
        before = math.degrees(math.atan2(v[1], v[0]))
        after = math.degrees(math.atan2(w[1], w[0]))
        worst = max(worst, abs((after - before + 180.0) % 360.0 - 180.0))
    assert worst < 0.05


def test_sensor_level_matrix_carries_the_origin():
    matrix = R.sensor_level_matrix(0.5, 0.25, [1.5, -2.5, 3.0])
    assert matrix[:3, 3].tolist() == pytest.approx([1.5, -2.5, 3.0])
    assert matrix[3].tolist() == [0.0, 0.0, 0.0, 1.0]


# A NOTE ON ScanPos002 OF 2017-12-15.001, which does NOT match RiSCAN.
#
# That position holds TWO captures — 171215_152137.rxp and 171215_152751.rxp —
# and they are different tripod setups, not one scan split in two:
#
#     171215_152137  roll +0.502  pitch +0.436   <- _main_rxp picks this
#     171215_152751  roll +1.492  pitch +1.101   <- RiSCAN registered this
#     RiSCAN SOP     roll +1.496  pitch +1.070
#
# Each file's own inclinometer series is internally tight; the levelling code
# is right and the ~1 deg gap is a scan-SELECTION mismatch. `_main_rxp` takes
# the alphabetically first .rxp, so for a re-scanned position we import the
# earlier abandoned capture — which affects the POINTS as much as the tilt.
# Pre-existing and out of scope here; recorded so it is not rediscovered as a
# levelling bug.


def test_levelling_reproduces_riscans_own_attitude():
    """THE regression that matters: our levelling vs RiSCAN PRO's surveyed SOP.

    ScanPos004 of 2017-12-15.001 is the one position carrying both a finite
    scanner_pose_hr and a RiSCAN SOP. If the sign, axis order, or inverse
    direction were wrong, the roll/pitch would diverge by degrees.
    """
    entry = POSE_FIXTURE["positions"]["peach_2017_ScanPos004"]
    truth = R.decompose_sop(np.asarray(entry["riscan_sop"], dtype=np.float64))
    pose = entry["pose"]
    assert pose["roll_deg"] == pytest.approx(truth["roll_deg"], abs=0.1)
    assert pose["pitch_deg"] == pytest.approx(truth["pitch_deg"], abs=0.1)


def test_the_compass_heading_is_not_trustworthy_and_stays_unapplied():
    """Pins the measurement that justifies dropping yaw.

    If a future change starts applying the heading, this fails and points at
    the evidence rather than at a style preference.
    """
    entry = POSE_FIXTURE["positions"]["peach_2017_ScanPos004"]
    truth = R.decompose_sop(np.asarray(entry["riscan_sop"], dtype=np.float64))
    pose = entry["pose"]
    error = abs((truth["yaw_deg"] - pose["yaw_deg"] + 180.0) % 360.0 - 180.0)
    # ~14 deg wrong while the instrument self-reports 0.22 deg accuracy, so the
    # accuracy field cannot gate it either.
    assert error > 5.0
    assert pose["yaw_acc_deg"] < 1.0


def test_sensor_frame_emits_tilt_but_never_a_heading():
    entry = {
        "scan_params": {"phi_min": 10.0, "phi_max": 100.0},
        "sop": None,
        "origin_prior": [1.0, 2.0, 3.0],
        "sensor_pose": {"roll_deg": 1.5, "pitch_deg": -0.5,
                        "yaw_deg": 58.0, "source": "scanner_pose_hr"},
    }
    R._attach_scan_params_extras(entry, R.FRAME_SENSOR)
    sp = entry["scan_params"]
    assert sp["origin"] == [1.0, 2.0, 3.0]
    # The tilt was REMOVED from the points, so the delivered cloud has none —
    # see test_sensor_frame_reports_no_residual_tilt. The reading stays in
    # `sensor_pose`.
    assert sp["tilt_roll_deg"] == 0.0
    assert sp["tilt_pitch_deg"] == 0.0
    assert entry["sensor_pose"]["roll_deg"] == pytest.approx(1.5)
    # No heading was applied to the points, so none is reported and the sweep
    # still describes the scanner's own frame.
    assert "azimuth_offset_deg" not in sp
    assert sp["phi_min"] == pytest.approx(10.0)
    assert sp["phi_max"] == pytest.approx(100.0)
    # The 4x4 the backend will apply, emitted beside the angles describing it.
    assert np.asarray(entry["sensor_matrix"]).shape == (4, 4)


def test_a_position_with_no_sensor_pose_imports_unlevelled():
    entry = {"scan_params": {"phi_min": 0.0, "phi_max": 360.0},
             "sop": None, "origin_prior": [3.0, 4.0, 5.0]}
    R._attach_scan_params_extras(entry, R.FRAME_SENSOR)
    sp = entry["scan_params"]
    assert sp["origin"] == [3.0, 4.0, 5.0]
    assert "tilt_roll_deg" not in sp
    assert "sensor_matrix" not in entry


def test_levelled_and_unlevelled_describe_the_cloud_not_the_tripod():
    """The tilt fields must mean the same thing in BOTH frames.

    They report the tilt the delivered CLOUD has. So levelling — which takes
    the tilt out — reports zero, and declining to level reports the tilt the
    points kept. Asserted as a pair because the bug was the pair being
    inconsistent, not either value alone: the levelled branch emitted the raw
    inclinometer reading (so a plumb cloud was labelled tilted) while the
    unlevelled branch emitted nothing at all (so a genuinely tilted cloud was
    labelled level). Each read as the other's opposite, which is precisely
    backwards, and neither branch stated which frame it meant.
    """
    def build(frame):
        entry = {
            "scan_params": {"phi_min": 0.0, "phi_max": 360.0},
            "sop": None,
            "origin_prior": [3.0, 4.0, 5.0],
            "sensor_pose": {"roll_deg": 1.316, "pitch_deg": 2.972,
                            "source": "scanner_pose_hr"},
        }
        R._attach_scan_params_extras(entry, frame)
        return entry

    levelled = build(R.FRAME_SENSOR)["scan_params"]
    unlevelled = build(R.FRAME_LOCAL)["scan_params"]

    # Levelled: the tilt is gone from the points, so it is gone from the report.
    assert levelled["tilt_roll_deg"] == 0.0
    assert levelled["tilt_pitch_deg"] == 0.0

    # Unlevelled: the points kept it, so it is stated — never omitted, which
    # would render as "level" in the scan panel.
    assert unlevelled["tilt_roll_deg"] == pytest.approx(1.316)
    assert unlevelled["tilt_pitch_deg"] == pytest.approx(2.972)

    # Only ONE of the two carries a levelling matrix, and it is the one whose
    # tilt reads zero — the rotation and the claim about it stay in lockstep.
    assert "sensor_matrix" in build(R.FRAME_SENSOR)
    assert "sensor_matrix" not in build(R.FRAME_LOCAL)


def test_attach_sensor_pose_prefers_the_fused_pose_then_falls_back(tmp_path):
    raw = POSE_FIXTURE["positions"]["peach_2018_ScanPos001"]["raw"]
    incl = "hk_incl (10006.0), 1520, 130, 0, 0"

    both = {}
    R.attach_sensor_pose(both, _write_hk(tmp_path / "both.txt", [raw, incl]))
    assert both["sensor_pose"]["source"] == "scanner_pose_hr"

    only_incl = {}
    R.attach_sensor_pose(only_incl, _write_hk(tmp_path / "incl.txt", [incl]))
    assert only_incl["sensor_pose"]["source"] == "hk_incl"
    assert only_incl["sensor_pose"]["roll_deg"] == pytest.approx(1.520)
    # hk_incl has no compass at all.
    assert "yaw_deg" not in only_incl["sensor_pose"]

    neither = {}
    R.attach_sensor_pose(neither, _write_hk(tmp_path / "none.txt", ["hk_time (40.0), 1"]))
    assert "sensor_pose" not in neither


# ---------------------------------------------------------------------------
# The ENU anchor is a property of the PROJECT, not of the selection
# ---------------------------------------------------------------------------
#
# gnss_to_enu anchors at the CENTROID of the fixes it is handed, so whichever
# positions reach it define the origin. cmd_stream used to filter `positions`
# down to --scans before the metadata pass, which made the anchor a function of
# the user's selection: importing one position anchored on its own fix and
# placed it at exactly (0,0,0), throwing away the GNSS offset -- and importing
# the same position a second time alongside others put it somewhere else
# entirely. Two separately-imported scans landed on top of each other instead of
# metres apart, which is the opposite of what the prior is for.
#
# These drive the REAL cmd_stream (not a reimplementation of its selection
# logic) over a .PROJ, whose GNSS comes from JSON sidecars -- so the anchor
# arithmetic is exercised end to end with no RiVLib and no point data. Only the
# two things that genuinely need the library are stubbed: the ctypes handle and
# the per-position decode.

# Metres apart, so a collapsed anchor is unmistakable rather than a rounding
# difference. Latitude ~38.3 matches the peach/pear project these came from.
_GNSS_FIXTURE = {
    "ScanPos001": (38.325394, -121.5778907, -26.732),
    "ScanPos002": (38.325346, -121.5779133, -25.818),
    "ScanPos003": (38.3253674, -121.5779651, -25.486),
}


def _build_proj_with_gnss(root: Path) -> Path:
    proj = _build_proj(
        root, [(name, "pose", True) for name in _GNSS_FIXTURE]
    )
    for name, (lat, lon, alt) in _GNSS_FIXTURE.items():
        (proj / f"{name}.SCNPOS" / "final.pose").write_text(
            json.dumps(
                {"gnss": {"latitude": lat, "longitude": lon, "altitude": alt}}
            )
        )
    return proj


def _run_stream(proj: Path, out: Path, scans, monkeypatch) -> dict:
    """Run cmd_stream for real and return the header it emitted."""
    import argparse
    import io
    import struct as _struct

    monkeypatch.setattr(R, "_Scanifc", lambda *a, **k: _StubIfc())
    # Pass 2 needs RiVLib; the anchor under test is settled in pass 1.
    monkeypatch.setattr(
        R, "stream_scan",
        lambda *a, **k: {"point_count": 1, "columns": ["positions.f64"]},
    )
    monkeypatch.setattr(R, "_wait_for_consumption", lambda *a, **k: None)

    buf = io.BytesIO()

    class _Out:
        buffer = buf

    monkeypatch.setattr(sys, "stdout", _Out())
    args = argparse.Namespace(
        project=str(proj), out=str(out), scans=scans, hk_dir=str(out / "hk"),
        probe_points=R._ANCHOR_PROBE_POINTS, frame=R.FRAME_LOCAL,
    )
    assert R.cmd_stream(args) == 0
    raw = buf.getvalue()
    _ver, size = _struct.unpack("<II", raw[4:12])
    return json.loads(raw[12 : 12 + size])


class _StubIfc:
    def version(self):
        return "stub"


def _origins(header: dict) -> dict:
    return {s["name"]: s.get("origin_prior") for s in header["scans"]}


def test_one_selected_position_keeps_its_gnss_offset(tmp_path, monkeypatch):
    proj = _build_proj_with_gnss(tmp_path)

    everything = _run_stream(proj, tmp_path / "a", None, monkeypatch)
    alone = _run_stream(proj, tmp_path / "b", ["ScanPos001"], monkeypatch)

    # The regression: this was [0, 0, 0].
    assert alone["scans"][0]["origin_prior"] == pytest.approx(
        everything["scans"][0]["origin_prior"]
    )
    assert np.linalg.norm(alone["scans"][0]["origin_prior"]) > 1.0


def test_every_subset_places_a_position_identically(tmp_path, monkeypatch):
    proj = _build_proj_with_gnss(tmp_path)
    full = _origins(_run_stream(proj, tmp_path / "full", None, monkeypatch))

    for i, subset in enumerate(
        [["ScanPos002"], ["ScanPos001", "ScanPos003"],
         ["ScanPos003", "ScanPos002"]]
    ):
        got = _origins(_run_stream(proj, tmp_path / f"s{i}", subset, monkeypatch))
        assert sorted(got) == sorted(subset)
        for name in subset:
            assert got[name] == pytest.approx(full[name]), (
                f"{name} moved when imported as {subset}"
            )


def test_the_header_carries_only_the_selected_positions(tmp_path, monkeypatch):
    """Unselected positions anchor the frame and must not become scans.

    They are read in pass 1 purely for their fixes; the host builds one session
    per header entry, so leaking them here would import scans nobody asked for.
    """
    proj = _build_proj_with_gnss(tmp_path)
    header = _run_stream(proj, tmp_path / "one", ["ScanPos002"], monkeypatch)

    assert header["scan_count"] == 1
    assert [s["name"] for s in header["scans"]] == ["ScanPos002"]
    # The anchor still reflects all three fixes, which is why the offset holds.
    assert header["gnss_anchor"]["latitude"] == pytest.approx(
        sum(v[0] for v in _GNSS_FIXTURE.values()) / len(_GNSS_FIXTURE)
    )
