"""Tests for the Helios Lmax-suggestion endpoint (`POST /api/triangulate/helios/suggest`).

Two layers:
  * The Otsu separability core (`_otsu_threshold_eta`) is pure numpy — tested directly,
    fast, no native build: bimodal log-data must score high separability with the
    threshold in the valley; unimodal data must score low.
  * The end-to-end suggestion + merged-cloud guard (`_do_helios_suggest`) needs a
    compiled pyhelios; skipped when unavailable. A single coherent surface must NOT be
    flagged merged; a cloud of many tight clusters seen from one origin (long inter-cluster
    bridges over short intra-cluster edges — the signature of a merged multi-scan cloud)
    must be flagged.
"""

import math

import numpy as np
import pytest

from main import _otsu_threshold_eta, _do_helios_suggest, _SUGGEST_MERGED_RATIO
from main import HeliosTriangulationRequest, HeliosScanEntry


# ---------------------------------------------------------------------------
# Otsu separability core (no native build needed)
# ---------------------------------------------------------------------------

def test_otsu_eta_high_and_in_valley_for_bimodal():
    rng = np.random.default_rng(0)
    # Two well-separated modes in log space (e.g. ~1cm intra vs ~50cm bridges).
    lo = rng.normal(math.log(0.01), 0.15, 4000)
    hi = rng.normal(math.log(0.5), 0.15, 4000)
    thr_log, eta = _otsu_threshold_eta(np.concatenate([lo, hi]))
    assert eta > 0.8, f"expected clean separation, got eta={eta}"
    # Threshold sits between the two mode centres (in the valley).
    assert math.log(0.01) < thr_log < math.log(0.5)


def test_otsu_eta_low_for_unimodal():
    rng = np.random.default_rng(1)
    # A single Gaussian still admits a best split (eta ~0.65), but it must score well
    # below a cleanly bimodal distribution (>0.8) -- that gap is the usable signal.
    _, eta = _otsu_threshold_eta(rng.normal(math.log(0.02), 0.2, 8000))
    assert eta < 0.72, f"unimodal data should not look cleanly separable, got eta={eta}"


# ---------------------------------------------------------------------------
# End-to-end suggestion + merged guard (needs the native triangulation)
# ---------------------------------------------------------------------------

pytest.importorskip("pyhelios", reason="pyhelios native build required")


def _entry_from_points(pts: np.ndarray, origin=(0.0, 0.0, 0.0)) -> HeliosScanEntry:
    """Points-mode scan entry with angular bounds computed from the points so the
    triangulation grid actually covers them (Helios convention: zenith = acos(dz/r),
    azimuth = atan2(dx, dy))."""
    o = np.asarray(origin, dtype=float)
    d = pts - o
    r = np.linalg.norm(d, axis=1)
    zen = np.degrees(np.arccos(np.clip(d[:, 2] / r, -1, 1)))
    # Helios azimuth is atan2(x, y) in [0, 360); the loader rejects phiMin < 0.
    az = np.degrees(np.arctan2(d[:, 0], d[:, 1])) % 360.0
    n = len(pts)
    n_axis = max(int(math.sqrt(n * 1.4)), 16)
    return HeliosScanEntry(
        points=pts.tolist(), origin=list(o),
        n_theta=n_axis, n_phi=n_axis,
        theta_min=max(float(zen.min()) - 0.5, 0.1), theta_max=min(float(zen.max()) + 0.5, 179.9),
        phi_min=max(float(az.min()) - 0.5, 0.0), phi_max=min(float(az.max()) + 0.5, 360.0),
    )


def _suggest(pts: np.ndarray) -> dict:
    req = HeliosTriangulationRequest(scans=[_entry_from_points(pts)],
                                     lmax=0.1, max_aspect_ratio=4.0)
    return _do_helios_suggest(req)


def test_single_surface_not_flagged_merged():
    """A dense, evenly sampled surface patch (one viewpoint): candidate edges are all
    ~the point spacing, so it must triangulate, return a positive Lmax + in-range
    confidence, and NOT be flagged as a merged cloud."""
    g = np.linspace(-0.5, 0.5, 90)
    xx, yy = np.meshgrid(g, g)
    # Gently curved patch ~3 m out in +x, ~1 m up: zenith ~72 deg, azimuth ~90 deg
    # (clear of the 0/360 seam that the XML loader rejects).
    pts = np.column_stack([3.0 + 0.05 * yy.ravel(), xx.ravel(), 1.0 + yy.ravel()])
    r = _suggest(pts)

    assert r["success"], r.get("error")
    assert r["suggested_lmax"] > 0
    assert 0.0 <= r["confidence"] <= 1.0
    assert r["confidence_label"] in ("High", "Medium", "Low")
    assert r["candidate_count"] > 1000
    assert r["merged_warning"] is False


def test_merged_two_depth_layers_flagged():
    """Two dense surfaces over the SAME angular window but ~0.5 m apart in depth, half-step
    interleaved — exactly what a single scan that merges two scanner positions looks like.
    From one origin the angular Delaunay connects across the layers, so most candidate
    edges are ~0.5 m bridges over ~cm intra-layer spacing. Must be flagged merged."""
    g = np.linspace(-0.5, 0.5, 64)
    xx, yy = np.meshgrid(g, g)
    step = g[1] - g[0]
    near = np.column_stack([np.full(xx.size, 3.0), xx.ravel(), 1.0 + yy.ravel()])
    # Second layer 0.5 m deeper, offset half a grid step so the two interleave in angle.
    far = np.column_stack([np.full(xx.size, 3.5),
                           xx.ravel() + 0.5 * step, 1.0 + yy.ravel() + 0.5 * step])
    r = _suggest(np.concatenate([near, far]))

    assert r["success"], r.get("error")
    assert r["merged_warning"] is True
    assert r["merged_message"] and "merged" in r["merged_message"].lower()


def test_merged_ratio_constant_is_sane():
    # Guard the tuned threshold (real redbud: ~4-5x single, ~16x merged).
    assert 6.0 < _SUGGEST_MERGED_RATIO < 14.0


def test_suggest_endpoint_http(client):
    """Exercise the real HTTP route end to end (StreamingResponse + keepalive
    whitespace must still parse as JSON, the way the renderer consumes it)."""
    g = np.linspace(-0.5, 0.5, 70)
    xx, yy = np.meshgrid(g, g)
    pts = np.column_stack([3.0 + 0.05 * yy.ravel(), xx.ravel(), 1.0 + yy.ravel()])
    entry = _entry_from_points(pts)
    req = HeliosTriangulationRequest(scans=[entry], lmax=0.1, max_aspect_ratio=4.0)

    res = client.post("/api/triangulate/helios/suggest", json=req.model_dump())
    assert res.status_code == 200
    body = res.json()  # json.loads tolerates the leading keepalive whitespace
    assert body["success"] is True
    assert body["suggested_lmax"] > 0
    assert 0.0 <= body["confidence"] <= 1.0
    assert body["merged_warning"] is False
