"""Per-scan length units: detection, and normalisation to metres.

Every physically-dimensioned constant in main.py assumes metres — CSF's cloth
resolution and its ALS regime switch, LAD's m²/m³, QSM's 4.23 mm twig radius,
ICP's voxel floors. Units make that assumption TRUE rather than hoped-for, by
scaling a non-metre source at import.

Two properties carry most of the risk and are pinned hardest here:

  * a METRE cloud must scale by exactly 1.0 and come out bit-identical. The
    common path silently changing is the real danger in this change, not the
    feet case.
  * scaling must happen BEFORE the intermediate LAS write, whose
    `header.scales = [0.001]*3` is expressed in SOURCE units — a 1 mm quantum
    for metres but a 1 METRE quantum for a kilometre-unit cloud.
"""

import math
import sys
from typing import Optional
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (  # noqa: E402
    _UNIT_TO_METRES,
    PointCloudPreviewRequest,
    _detect_source_units,
    _is_angular_unit,
    _read_las_georef,
    _scale_positions_to_metres,
    _unit_slug_from_name,
    preview_pointcloud,
)

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "e2e" / "fixtures"
FEET_LAS = FIXTURES / "feet-mast.las"


# ── The conversion table ───────────────────────────────────────────────────

class TestUnitTable:
    def test_metre_is_exactly_one(self):
        # Not "close to" 1.0 — exactly, or a metre cloud is perturbed by a
        # float multiply it should never have seen.
        assert _UNIT_TO_METRES["m"] == 1.0

    def test_us_survey_foot_differs_from_international_foot(self):
        # 1200/3937 vs 0.3048 — a 7th-significant-figure difference that is
        # ~2 mm over a 1 km survey. Collapsing them would be a silent error in
        # exactly the datasets that bother to declare the distinction.
        assert _UNIT_TO_METRES["ftUS"] != _UNIT_TO_METRES["ft"]
        assert _UNIT_TO_METRES["ftUS"] == pytest.approx(0.30480060960121924, abs=1e-15)
        assert _UNIT_TO_METRES["ft"] == 0.3048

    @pytest.mark.parametrize("slug,expected", [
        ("mm", 0.001), ("cm", 0.01), ("km", 1000.0), ("in", 0.0254),
    ])
    def test_metric_and_imperial_factors(self, slug, expected):
        assert _UNIT_TO_METRES[slug] == pytest.approx(expected, rel=1e-12)


class TestUnitNameMapping:
    @pytest.mark.parametrize("name,slug", [
        ("metre", "m"), ("Metre", "m"), ("METER", "m"),
        ("US survey foot", "ftUS"), ("us survey foot", "ftUS"),
        ("foot", "ft"), ("  foot  ", "ft"),
    ])
    def test_maps_case_and_whitespace_insensitively(self, name, slug):
        assert _unit_slug_from_name(name) == slug

    def test_unknown_name_is_none_not_a_guess(self):
        assert _unit_slug_from_name("furlong") is None
        assert _unit_slug_from_name(None) is None
        assert _unit_slug_from_name("") is None


# ── Detection ──────────────────────────────────────────────────────────────

class TestLasDetection:
    def test_reads_us_survey_feet_from_a_real_crs(self):
        # The fixture declares EPSG:2229 (CA State Plane V, US survey feet).
        # This is the whole point of using a real CRS rather than a stub: it
        # exercises laspy.parse_crs -> pyproj, the path a survey file takes.
        assert FEET_LAS.exists(), f"missing fixture {FEET_LAS}"
        epsg, slug, factor = _read_las_georef(FEET_LAS)
        assert epsg == 2229
        assert slug == "ftUS"
        assert factor == pytest.approx(0.30480060960121924, abs=1e-12)

    def test_detect_reports_feet_as_certain(self):
        slug, factor, certain = _detect_source_units(FEET_LAS)
        assert slug == "ftUS"
        assert factor == pytest.approx(0.3048006096, abs=1e-9)
        # Certain, because the FILE said so — the wizard shows this rather than
        # asking.
        assert certain is True

    def test_non_las_returns_nothing(self):
        assert _read_las_georef(FIXTURES / "scalars.xyz") == (None, None, None)

    def test_missing_file_does_not_raise(self):
        # Detection runs during preview; it must never block an import.
        assert _read_las_georef(FIXTURES / "does-not-exist.las") == (None, None, None)


class TestGeographicCrsIsNotALength:
    """A lat/long CRS must never be treated as a length unit.

    This is the sharpest failure mode in the whole feature. pyproj reports a
    geographic CRS's axis as unit "degree" with `unit_conversion_factor` =
    0.017453292519943295 — that is RADIANS PER DEGREE, an angular conversion,
    not metres per unit. Consuming it as a length factor multiplies every
    coordinate by 1/57.3: a 25 m tree becomes 0.44 m, and the numbers stay
    plausible enough that nothing downstream complains.

    Degrees also cannot be converted to metres by ANY constant, because the
    metres-per-degree of longitude varies with latitude. So the only correct
    answer is "unknown unit, do not scale".
    """

    def _geographic_las(self, tmp_path, epsg: int):
        import laspy
        import pyproj
        hdr = laspy.LasHeader(point_format=3, version="1.4")
        hdr.add_crs(pyproj.CRS.from_epsg(epsg))
        hdr.offsets = np.array([0.0, 0.0, 0.0])
        hdr.scales = np.array([1e-7, 1e-7, 0.001])   # degrees need fine scaling
        las = laspy.LasData(hdr)
        las.x = np.array([-121.7405, -121.7404])
        las.y = np.array([38.5449, 38.5450])
        las.z = np.array([0.0, 25.0])                # height IS metres
        p = tmp_path / f"geo{epsg}.las"
        las.write(p)
        return p

    @pytest.mark.parametrize("epsg", [4326, 4269])
    def test_reports_no_factor_for_a_lat_long_cloud(self, tmp_path, epsg):
        path = self._geographic_las(tmp_path, epsg)
        _e, slug, factor = _read_las_georef(path)
        assert factor is None, (
            "a geographic CRS must yield NO length factor — its "
            "unit_conversion_factor is radians-per-degree, and applying it "
            "would shrink every coordinate by 1/57"
        )
        assert slug is None

    def test_detection_reports_uncertain_so_the_wizard_asks(self, tmp_path):
        path = self._geographic_las(tmp_path, 4326)
        slug, factor, certain = _detect_source_units(path)
        assert (slug, factor) == (None, None)
        # Not certain: we genuinely do not know a LENGTH unit for this file, so
        # the wizard asks rather than silently choosing.
        assert certain is False

    def test_the_angular_factor_would_have_wrecked_a_real_tree(self):
        # States the damage numerically, so the guard above is never "simplified"
        # away by someone who doesn't know what the factor means.
        import pyproj
        bad = pyproj.CRS.from_epsg(4326).axis_info[0].unit_conversion_factor
        assert bad == pytest.approx(0.017453292519943295, abs=1e-15)
        assert 25.0 * bad == pytest.approx(0.4363, abs=1e-3)

    @pytest.mark.parametrize("name", [
        "degree", "Degree", " DEGREES ", "radian", "grad", "arc-second",
    ])
    def test_angular_unit_names_never_map_to_a_length_slug(self, name):
        assert _unit_slug_from_name(name) is None

    def test_a_projected_crs_is_still_measured_normally(self, tmp_path):
        # The guard must not over-reach: a projected CRS in feet still converts.
        assert _read_las_georef(FEET_LAS)[2] == pytest.approx(0.3048006096, abs=1e-9)


class TestMixedAxisUnits:
    """A CRS whose axes disagree cannot be described by one scale factor.

    Horizontal US survey feet with vertical metres (EPSG:2229+5703) is a
    standard US survey configuration. Scaling all three axes by the FIRST axis's
    factor divides every elevation by 3.28 while leaving XY correct — a 30 m
    tree becomes 9.14 m, and XY/Z end up in different units, which silently
    breaks every distance, slope and volume the app computes.
    """

    def test_pyproj_really_does_report_disagreeing_axes(self):
        # The premise, asserted rather than assumed — if pyproj ever normalised
        # compound axes this guard would be dead code and should be revisited.
        import pyproj
        comp = pyproj.CRS.from_string("EPSG:2229+5703")
        factors = [a.unit_conversion_factor for a in comp.axis_info]
        assert len(set(round(f, 12) for f in factors)) > 1, factors

    # A compound CRS cannot be written through laspy's GeoTIFF VLR path
    # ("Projected CRS without epsg is not supported"), so these drive the
    # detection logic against the CRS object directly — the same `crs.axis_info`
    # walk `_read_las_georef` performs on whatever `parse_crs()` returns. A real
    # survey LAS carries such a CRS in a WKT VLR, which laspy reads back fine;
    # it is only the WRITE path that refuses.
    @staticmethod
    def _factor_for(crs) -> Optional[float]:
        """The factor `_read_las_georef` would derive from this CRS."""
        if crs.is_geographic:
            return None
        factors = []
        for ax in crs.axis_info:
            if _is_angular_unit(ax.unit_name):
                return None
            factors.append(float(ax.unit_conversion_factor))
        if not factors:
            return None
        if not all(math.isclose(f, factors[0], rel_tol=1e-12) for f in factors):
            return None
        return factors[0] if 1e-6 < factors[0] < 1e6 else None

    def test_disagreeing_axes_yield_no_factor(self):
        import pyproj
        mixed = pyproj.CRS.from_string("EPSG:2229+5703")   # ftUS horiz, m vert
        assert self._factor_for(mixed) is None, (
            "a CRS with disagreeing axis units must not yield a single factor — "
            "one scalar cannot convert XY-feet and Z-metres together"
        )

    def test_an_all_feet_crs_still_converts(self):
        import pyproj
        assert self._factor_for(pyproj.CRS.from_epsg(2229)) == pytest.approx(
            0.30480060960121924, abs=1e-12)

    def test_a_metre_crs_still_converts(self):
        import pyproj
        assert self._factor_for(pyproj.CRS.from_epsg(32611)) == 1.0

    def test_the_helper_matches_the_shipped_reader_on_a_real_file(self):
        # Pins the helper above against the production function, so a change to
        # `_read_las_georef` that this class stops reflecting is caught rather
        # than silently diverging into a parallel implementation.
        import laspy
        with laspy.open(str(FEET_LAS)) as r:
            crs = r.header.parse_crs()
        assert self._factor_for(crs) == pytest.approx(_read_las_georef(FEET_LAS)[2], abs=1e-15)


class TestSpecFixedFormats:
    @pytest.mark.parametrize("name", ["structured-scan.e57"])
    def test_e57_is_metres_by_specification(self, name):
        # E57 mandates metres for Cartesian coordinates — its cartesianX/Y/Z
        # nodes carry no unit attribute because there is no unit to declare.
        # So it is answered without opening the file.
        slug, factor, certain = _detect_source_units(FIXTURES / name)
        assert (slug, factor, certain) == ("m", 1.0, True)

    def test_riegl_is_metres_by_specification(self, tmp_path):
        p = tmp_path / "scan.rxp"
        p.write_bytes(b"")
        assert _detect_source_units(p) == ("m", 1.0, True)


class TestUnknownFormats:
    @pytest.mark.parametrize("name", ["scalars.xyz", "cube-mesh.ply", "raster-grid.xyz"])
    def test_formats_without_a_unit_field_report_uncertain(self, name):
        slug, factor, certain = _detect_source_units(FIXTURES / name)
        assert certain is False
        assert slug is None and factor is None


# ── Normalisation ──────────────────────────────────────────────────────────

class TestScaling:
    def test_metre_cloud_is_returned_UNTOUCHED(self):
        # The single most important assertion in this file. Every existing
        # import is metres; if this change perturbs them at all it is a
        # regression affecting all current data, not a feature.
        #
        # Asserted as OBJECT IDENTITY, not value equality. `x * 1.0` is exact in
        # IEEE754, so an array_equal check passes even when the short-circuit is
        # removed and every coordinate is needlessly multiplied and copied — it
        # cannot tell "untouched" from "recomputed identically". Identity can,
        # and it is also the thing worth guaranteeing: no copy of a multi-
        # million-point array on the overwhelmingly common path.
        pos = np.array([
            [1.5, -2.25, 3.125],
            [545000.3, 4183000.0, 100.7],   # UTM-scale, where a stray multiply shows
            [0.0, 0.0, 0.0],
        ], dtype=np.float64)
        out = _scale_positions_to_metres(pos, 1.0)
        assert out is pos, "a 1.0 scale must return the input array itself, not a copy"

    def test_metre_cloud_values_are_unchanged(self):
        # The weaker value check kept alongside the identity one, so a future
        # refactor that legitimately copies still has to preserve the numbers.
        pos = np.array([[545000.3, 4183000.0, 100.7]], dtype=np.float64)
        assert np.array_equal(_scale_positions_to_metres(pos.copy(), 1.0), pos)

    def test_ten_feet_becomes_3048_millimetres(self):
        pos = np.array([[0.0, 0.0, 0.0], [0.0, 0.0, 10.0]], dtype=np.float64)
        out = _scale_positions_to_metres(pos, _UNIT_TO_METRES["ftUS"])
        span = float(out[1, 2] - out[0, 2])
        assert span == pytest.approx(3.048006096, abs=1e-9)

    def test_five_thousand_millimetres_becomes_five_metres(self):
        pos = np.array([[0.0, 0.0, 0.0], [5000.0, 0.0, 0.0]], dtype=np.float64)
        out = _scale_positions_to_metres(pos, _UNIT_TO_METRES["mm"])
        assert float(out[1, 0]) == pytest.approx(5.0, abs=1e-12)

    def test_scales_every_axis_not_just_z(self):
        pos = np.array([[2.0, 3.0, 4.0]], dtype=np.float64)
        out = _scale_positions_to_metres(pos, 0.5)
        assert out[0].tolist() == [1.0, 1.5, 2.0]

    def test_returns_float64_regardless_of_input_dtype(self):
        # float32 at UTM scale collapses distinct coordinates; the scaled array
        # must not be the place that reintroduces that.
        pos = np.array([[1.0, 2.0, 3.0]], dtype=np.float32)
        out = _scale_positions_to_metres(pos, 0.3048)
        assert out.dtype == np.float64

    def test_empty_cloud_is_handled(self):
        pos = np.zeros((0, 3), dtype=np.float64)
        assert _scale_positions_to_metres(pos, 0.3048).shape == (0, 3)

    def test_none_and_non_positive_scales_are_refused(self):
        pos = np.array([[1.0, 2.0, 3.0]], dtype=np.float64)
        # A None/0/negative factor means detection went wrong. Silently
        # applying it would mangle the cloud, so it is treated as "no scaling"
        # rather than trusted.
        assert np.array_equal(_scale_positions_to_metres(pos, None), pos)
        assert np.array_equal(_scale_positions_to_metres(pos, 0.0), pos)
        assert np.array_equal(_scale_positions_to_metres(pos, -1.0), pos)


class TestPreviewIntegration:
    """The REAL preview endpoint, not a re-implementation of it.

    The previous version of this class did the arithmetic inline
    (`[float(np.floor(v * f)) for v in raw_shift]`) — a copy of the production
    line, not a call to it. It asserted that `*` and `np.floor` work, and stayed
    green with the scaling deleted. These call `preview_pointcloud` and assert
    on what it actually returns.
    """

    def test_reports_the_detected_unit_for_a_feet_survey(self):
        resp = preview_pointcloud(PointCloudPreviewRequest(file_path=str(FEET_LAS)))
        assert resp.detected_units == "ftUS"
        assert resp.units_certain is True

    def test_reports_no_unit_for_an_ascii_file(self):
        resp = preview_pointcloud(
            PointCloudPreviewRequest(file_path=str(FIXTURES / "scalars.xyz")))
        assert resp.detected_units is None
        # Not certain -> the wizard asks, defaulting to metres.
        assert resp.units_certain is False

    def test_the_suggested_shift_is_reported_in_RAW_file_units(self, tmp_path):
        """The wizard scales the suggestion by the unit the user finally picks.

        This contract matters because the backend cannot know that unit for a
        format that declares none: the user chooses it AFTER this response is
        built. Scaling here would be right for a CRS-detected file and wrong for
        every other, so the raw value is the only answer valid in both cases.
        """
        import laspy
        import pyproj
        hdr = laspy.LasHeader(point_format=3, version="1.4")
        hdr.add_crs(pyproj.CRS.from_epsg(2229))
        hdr.offsets = np.array([0.0, 0.0, 0.0])
        hdr.scales = np.array([0.01, 0.01, 0.01])
        las = laspy.LasData(hdr)
        # Well past _SHIFT_SUGGEST_THRESHOLD (1e4) so a shift is suggested.
        las.x = np.array([6_500_000.0, 6_500_010.0])
        las.y = np.array([1_800_000.0, 1_800_000.0])
        las.z = np.array([0.0, 10.0])
        p = tmp_path / "big-feet.las"
        las.write(p)

        resp = preview_pointcloud(PointCloudPreviewRequest(file_path=str(p)))
        assert resp.suggested_shift is not None, "premise: coords are large enough"
        # RAW feet, not metres: 6.5e6, not 6.5e6 * 0.3048 = 1.98e6.
        assert resp.suggested_shift[0] == pytest.approx(6_500_000.0, abs=1.0)
        assert resp.suggested_shift[0] > 5e6, (
            "the suggestion must be in SOURCE units — the wizard converts it by "
            "the chosen unit, and pre-scaling here would double-apply"
        )

    def test_a_metre_cloud_suggestion_is_unchanged(self, tmp_path):
        # The common path: a UTM metre LAS suggests its own floor(min) and
        # nothing rescales it, before or after.
        import laspy
        import pyproj
        hdr = laspy.LasHeader(point_format=3, version="1.4")
        hdr.add_crs(pyproj.CRS.from_epsg(32611))
        # offset = floor(min), or UTM-scale values overflow LAS's int32 storage
        # at a 1 mm scale (the same trap the importer's writers hit).
        hdr.offsets = np.array([545_000.0, 4_183_000.0, 0.0])
        hdr.scales = np.array([0.001, 0.001, 0.001])
        las = laspy.LasData(hdr)
        las.x = np.array([545_000.3, 545_010.0])
        las.y = np.array([4_183_000.0, 4_183_000.0])
        las.z = np.array([100.0, 110.0])
        p = tmp_path / "utm-m.las"
        las.write(p)

        resp = preview_pointcloud(PointCloudPreviewRequest(file_path=str(p)))
        assert resp.detected_units == "m"
        assert resp.suggested_shift is not None
        assert resp.suggested_shift[0] == pytest.approx(545_000.0, abs=1.0)

    def test_preview_never_raises_on_an_unreadable_file(self, tmp_path):
        # Detection runs inside preview; a failure there must not block import.
        bad = tmp_path / "truncated.las"
        bad.write_bytes(b"LASF" + b"\x00" * 32)
        resp = preview_pointcloud(PointCloudPreviewRequest(file_path=str(bad)))
        assert resp is not None   # an error response, not an exception


class TestQuantisationRationale:
    """Why normalisation must precede the intermediate LAS write.

    Those writers hardcode `header.scales = [0.001]*3`, which is 0.001 in
    SOURCE units. These tests state the consequence numerically so the ordering
    constraint is recorded as arithmetic rather than as a comment someone can
    reorder past.
    """

    @pytest.mark.parametrize("slug,quantum_mm", [
        ("m", 1.0),
        ("ftUS", 0.30480060960121924),
        ("mm", 0.001),
        ("km", 1000.0),           # a full METRE of quantisation error
    ])
    def test_unscaled_las_quantum_varies_by_three_orders_of_magnitude(self, slug, quantum_mm):
        got = 0.001 * _UNIT_TO_METRES[slug] * 1000.0
        assert got == pytest.approx(quantum_mm, rel=1e-9)

    def test_after_scaling_every_unit_shares_the_one_millimetre_quantum(self):
        for slug in _UNIT_TO_METRES:
            pos = np.array([[1.0, 1.0, 1.0]], dtype=np.float64)
            scaled = _scale_positions_to_metres(pos, _UNIT_TO_METRES[slug])
            # Post-scaling the array is in metres, so 0.001 really is 1 mm.
            quantised = np.round(scaled / 0.001) * 0.001
            assert abs(float(quantised[0, 0] - scaled[0, 0])) <= 0.0005 + 1e-12
