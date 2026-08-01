"""Decide, cheaply, what KIND of scene a point cloud is.

Not a general classifier. Its only job is to check the scene type the user
picked against what the geometry actually looks like, so that choosing
"agriculture" for a street full of buildings is caught before the expensive
landmark extraction runs — and so the check itself never becomes a nag that
users click through.

Two measurements, both chosen because they were MEASURED to separate the cases
rather than because they sounded plausible:

* **Planarity** — the fraction of points whose local neighbourhood is flat.
  Buildings are assemblies of large continuous planes; foliage is volumetric and
  never flat at any scale. Measured: 0.85 on a built scene against 0.12-0.14 on
  vegetation. A ~6x gap with no overlap, which is what makes a threshold here
  defensible instead of arbitrary.

* **Spacing regularity** (coefficient of variation of plant-to-plant distance) —
  separates a *planted* stand from a *natural* one. A crop or orchard is set out
  on a grid, so plant spacing barely varies; a forest is self-seeded and does not.
  Measured: CV 0.08 for a planting against 0.49 for a natural stand.

Deliberately cheap: it runs on a subsample before any segmentation, so a wrong
scene type costs about a second rather than a minute of CSF and TreeIso.
"""

from typing import Optional, Tuple

import numpy as np

# Thresholds sit in the empty space between the measured clusters, not at the
# edge of either — so ordinary variation cannot flip the answer.
#   planarity:  vegetation ~0.12-0.14 | built ~0.85
#   spacing CV: planted ~0.08         | natural ~0.49
_PLANAR_BUILT = 0.45          # above this, the scene is dominated by flat surfaces
_PLANAR_VEGETATION = 0.30     # below this, it is confidently NOT built
_CV_PLANTED = 0.25            # below this, spacing is regular enough to be planted
_CV_NATURAL = 0.40            # above this, spacing is irregular enough to be natural

_PROBE_POINTS = 2000          # neighbourhood tests are the cost; cap them
_NEIGHBOURS = 20


def _local_shape(points: np.ndarray) -> Tuple[float, float]:
    """(planar_fraction, vertical_fraction) over a subsample.

    `planar` asks whether each point's neighbourhood collapses onto a plane —
    the smallest eigenvalue of the local covariance being negligible next to the
    largest. `vertical` further asks whether that plane stands upright, which
    distinguishes walls from ground and roofs; it is reported for diagnostics
    rather than used as a gate, since ground can be planar too.
    """
    from scipy.spatial import cKDTree

    if len(points) < _NEIGHBOURS + 1:
        return 0.0, 0.0

    idx = np.linspace(0, len(points) - 1, min(_PROBE_POINTS, len(points))).astype(int)
    tree = cKDTree(points)
    k = min(_NEIGHBOURS, len(points))

    planar = vertical = tested = 0
    for i in idx:
        _, nb = tree.query(points[i], k=k)
        P = points[nb] - points[nb].mean(axis=0)
        cov = P.T @ P / len(P)
        w, V = np.linalg.eigh(cov)          # ascending
        if w[2] <= 0:
            continue
        tested += 1
        if w[0] / max(w[2], 1e-12) < 0.01:  # thin in one direction => a plane
            planar += 1
            if abs(V[:, 0][2]) < 0.3:       # that plane's normal is horizontal => wall
                vertical += 1
    if tested == 0:
        return 0.0, 0.0
    return planar / tested, vertical / tested


def _spacing_regularity(anchors: np.ndarray) -> Optional[float]:
    """Coefficient of variation of nearest-neighbour distance between plants.

    None when there are too few landmarks to say anything, which must be treated
    as "no opinion" rather than as evidence either way.
    """
    if anchors is None or len(anchors) < 5:
        return None
    from scipy.spatial import cKDTree

    d, _ = cKDTree(anchors[:, :2]).query(anchors[:, :2], k=2)
    nn = d[:, 1]
    nn = nn[np.isfinite(nn) & (nn > 0)]
    if len(nn) < 4 or nn.mean() <= 0:
        return None
    return float(nn.std() / nn.mean())


def classify_scene(points: np.ndarray,
                   anchors: Optional[np.ndarray] = None) -> dict:
    """Describe the scene: {'scene_type', 'confidence', 'planarity', 'spacing_cv'}.

    `scene_type` is one of 'urban', 'agriculture', 'natural', or None when the
    geometry does not support a call. `confidence` is 'strong' or 'weak' and is
    what decides whether a mismatch blocks the run or merely warns — a weak
    reading must never interrupt someone.

    `anchors` (per-plant landmarks, when already available) sharpens the
    agriculture/natural split; without them this can still separate built from
    vegetated, which is the distinction that changes the algorithm.
    """
    out = {"scene_type": None, "confidence": "weak",
           "planarity": None, "spacing_cv": None, "vertical": None}
    points = np.asarray(points, dtype=np.float64)
    points = points[np.isfinite(points).all(axis=1)]
    if len(points) < 50:
        return out

    # Ground is planar in every scene, so it would drag the planarity of a field
    # up toward a building's. Drop it before measuring.
    z = points[:, 2]
    cut = float(np.percentile(z, 2)) + max(0.3, (np.percentile(z, 98) - np.percentile(z, 2)) * 0.05)
    above = points[z > cut]
    if len(above) < 50:
        above = points

    planar, vertical = _local_shape(above)
    out["planarity"] = round(planar, 3)
    out["vertical"] = round(vertical, 3)

    if planar >= _PLANAR_BUILT:
        out["scene_type"] = "urban"
        out["confidence"] = "strong"
        return out

    if planar > _PLANAR_VEGETATION:
        # Between the clusters: flat-ish but not obviously built. Say vegetation
        # (the tool's home ground) but only weakly, so it cannot block a run.
        out["scene_type"] = "natural"
        return out

    # Confidently vegetated. Note this is a STRONG reading on its own: planarity
    # alone settles built-vs-vegetated, which is the distinction that changes the
    # algorithm. Anchors only refine planted-vs-natural, so their absence must
    # not weaken the part we already know — an earlier version reported
    # `weak` whenever anchors were unavailable, which silently downgraded a
    # genuine built/vegetated mismatch into a note nobody would see.
    out["confidence"] = "strong"

    cv = _spacing_regularity(anchors)
    out["spacing_cv"] = None if cv is None else round(cv, 3)
    if cv is None:
        # Vegetated for certain; which KIND is undecided. Report the vegetated
        # default without claiming to have distinguished planted from natural.
        out["scene_type"] = "natural"
        out["vegetated_only"] = True
        return out
    if cv <= _CV_PLANTED:
        out["scene_type"] = "agriculture"
        out["confidence"] = "strong"
    elif cv >= _CV_NATURAL:
        out["scene_type"] = "natural"
        out["confidence"] = "strong"
    else:
        out["scene_type"] = "agriculture" if cv < (_CV_PLANTED + _CV_NATURAL) / 2 else "natural"
    return out


def check_scene_type(chosen: str, observed: dict) -> Optional[dict]:
    """Compare what the user chose against what the cloud looks like.

    Returns None when they agree (or the reading is too weak to argue), else
    {'severity': 'strong'|'weak', 'observed', 'message'}.

    Only a **strong** disagreement that would change the ALGORITHM is severe
    enough to interrupt: picking a vegetation type for a built scene, or the
    reverse, sends the run down a different code path entirely. Confusing
    agriculture with natural forest picks different tuning within the same path,
    so it is worth a note and never worth a modal dialog.
    """
    seen = observed.get("scene_type")
    if not seen or seen == chosen:
        return None
    # The reading established "vegetated" but not which kind, so it has no
    # opinion on agriculture-vs-natural and must stay quiet about it.
    if observed.get("vegetated_only") and chosen in ("agriculture", "natural"):
        return None

    built_mismatch = ("urban" in (chosen, seen)) and chosen != seen
    severity = "strong" if (built_mismatch and observed.get("confidence") == "strong") else "weak"

    if built_mismatch and seen == "urban":
        message = (
            "This looks like a built scene — most surfaces are flat, like walls "
            "and roofs, rather than foliage. Matching individual plants will "
            "probably fail here; the urban setting matches surface shape instead."
        )
    elif built_mismatch and chosen == "urban":
        message = (
            "This looks like a vegetated scene rather than a built one. Matching "
            "individual plants is usually far more reliable here than matching "
            "surface shape."
        )
    else:
        message = (
            f"The plant spacing looks more like {seen} than {chosen}. Either will "
            "work; the setting only changes how the plants are matched."
        )
    return {"severity": severity, "observed": seen, "message": message}
