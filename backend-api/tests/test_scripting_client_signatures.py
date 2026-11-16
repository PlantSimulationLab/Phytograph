"""The Python scripting client's tool signatures match the backend's request models.

The request models ignore keys they do not know, so a client keyword the model
lacks would be dropped in silence, and a client default that differs from the
model's would make the API disagree with itself. The client
(`python/phytograph`) spells every tool's parameters out so an agent can read
them from `help()`; this file pins each one against the model it is sent to:

* every client keyword is a field of the model;
* every concrete client default equals the model's default (``None`` in the
  client means "the backend decides", which the docstring states);
* every model field is exposed, or listed in EXCLUDED with the reason;
* every keyword is described in the docstring;
* the client's per-method keyword table names only real methods.
"""
from __future__ import annotations

import inspect
import sys
from pathlib import Path

import pytest

import main

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
import phytograph as pg  # noqa: E402

# Fields every tool leaves out on purpose.
_INPUT = {
    "points": "inline input; the client always sends its session",
    "source": "the client sends its own session",
    "sources": "aggregate input from several clouds: app only",
    "ground_class": "ignored on the session route (reads the ground_class column)",
    "reflectance": "inline input; session clouds re-read the scalar (scalar_slug)",
}

# (client callable, backend model, keywords that map to other request keys,
#  model fields deliberately not exposed -> reason)
TOOLS = [
    (pg.Cloud.segment_trees, main.SessionTreeSegmentRequest, {"seeds": "seed_points"}, {
        **_INPUT,
        "acknowledge_cost": "sent by the transport's cost gate (Backend(confirm_costly=...))",
    }),
    (pg.Cloud.segment_wood, main.SessionWoodSegmentRequest, {}, {
        **_INPUT, "defer_octree": "always True: a script never renders the octree",
    }),
    (pg.Cloud.denoise, main.SessionDenoiseRequest, {}, {}),
    (pg.Cloud.tree_inventory, main.TreeInventoryRequest, {}, {}),
    (pg.Cloud.tree_qsms, main.TreeQSMRequest, {}, {}),
    (pg.Cloud.qsm, main.QSMBuildRequest, {}, dict(_INPUT)),
    (pg.Cloud.skeleton, main.SkeletonRequest, {}, {
        **_INPUT, "dominant_axis": "legacy, unused by the algorithm",
    }),
    (pg.Cloud.triangulate, main.TriangulationRequest, {}, {
        **_INPUT,
        "crop_box": "frame-sensitive app feature (crop to the LAD grid); use Cloud.extract(box=)",
        "crop_box_rotation_deg": "goes with crop_box",
        "grid": "pins the mesh to a LAD grid for reuse: app only",
        "frame_origin": "the renderer's stored-frame choice; the client adds the returned "
                        "vertex_origin back in float64, so any frame gives world coordinates",
    }),
    (pg.Cloud.fit_crown, main.CrownFitRequest, {}, {"source": "the client sends its session"}),
    (pg.Cloud.register_to, main.CloudToCloudICPRequest, {}, {
        "target_points": "inline input", "source_points": "inline input",
        "target_source": "from `target`", "source_source": "this cloud",
    }),
    (pg.Cloud.register_to, main.GlobalRegisterRequest, {}, {
        "target_points": "inline input", "source_points": "inline input",
        "target_source": "from `target`", "source_source": "this cloud",
    }),
    (pg.Backend.lad, main.LADComputeRequest, {}, {
        "scans": "positional `scans` (pg.Scan)", "grid": "positional `grid` (pg.Grid)",
        "theta_min": "request-level fallback; every pg.Scan sends its own theta/phi",
        "theta_max": "request-level fallback; every pg.Scan sends its own theta/phi",
        "phi_min": "request-level fallback; every pg.Scan sends its own theta/phi",
        "phi_max": "request-level fallback; every pg.Scan sends its own theta/phi",
    }),
]

# Keywords that steer the client itself and are never request fields.
CLIENT_ONLY = {"self", "method", "apply", "target", "scans", "grid", "shape"}

# register_to talks to two models; each keyword belongs to one of them.
_SPLIT = {main.CloudToCloudICPRequest: "icp", main.GlobalRegisterRequest: "global"}


def _ids(t):
    return f"{t[0].__qualname__}->{t[1].__name__}"


def _keywords(fn, model):
    sig = inspect.signature(fn)
    names = [n for n in sig.parameters if n not in CLIENT_ONLY]
    if model in _SPLIT:
        by = fn._tool_by_method
        names = [n for n in names if n in by[_SPLIT[model]]]
    return sig, names


@pytest.mark.parametrize("tool", TOOLS, ids=_ids)
def test_every_client_keyword_is_a_model_field_with_the_same_default(tool):
    fn, model, renamed, _ = tool
    sig, names = _keywords(fn, model)
    fields = model.model_fields
    for n in names:
        field = renamed.get(n, n)
        assert field in fields, f"{fn.__qualname__}({n}=) is not a field of {model.__name__}"
        client_default = sig.parameters[n].default
        if client_default is None:
            continue    # the backend (or the cloud's extent) decides; docstring says what
        assert client_default == fields[field].default, (
            f"{fn.__qualname__}({n}={client_default!r}) but {model.__name__}.{field} "
            f"defaults to {fields[field].default!r}")


@pytest.mark.parametrize("tool", TOOLS, ids=_ids)
def test_every_model_field_is_exposed_or_excluded_with_a_reason(tool):
    fn, model, renamed, excluded = tool
    _, names = _keywords(fn, model)
    exposed = {renamed.get(n, n) for n in names}
    missing = set(model.model_fields) - exposed - set(excluded) - {"method", "shape"}
    assert not missing, (f"{model.__name__} fields {sorted(missing)} are neither "
                         f"keywords of {fn.__qualname__} nor EXCLUDED with a reason")
    stale = set(excluded) - set(model.model_fields) - set(_INPUT)
    assert not stale, f"EXCLUDED names {sorted(stale)}, which {model.__name__} no longer has"


@pytest.mark.parametrize("fn", sorted({t[0] for t in TOOLS}, key=lambda f: f.__qualname__),
                         ids=lambda f: f.__qualname__)
def test_every_keyword_is_documented(fn):
    doc = inspect.getdoc(fn) or ""
    for n in inspect.signature(fn).parameters:
        if n in ("self",):
            continue
        assert n in doc, f"{fn.__qualname__} does not describe `{n}` in its docstring"


def test_the_method_tables_name_real_methods():
    from typing import get_args
    by = pg.Cloud.segment_wood._tool_by_method
    assert set(by) == set(get_args(main.WoodSegmentationRequest.model_fields["method"].annotation))
    by = pg.Cloud.segment_trees._tool_by_method
    assert set(by) == set(get_args(main.TreeSegmentationRequest.model_fields["method"].annotation))
    assert set(by["chm"]) == set(main._CHM_PARAM_FIELDS)
    import denoise
    assert tuple(pg.Cloud.denoise._tool_by_method) == denoise.METHODS
    # denoise's own table of which method reads which parameter.
    for m, keys in pg.Cloud.denoise._tool_by_method.items():
        full = main.SessionDenoiseRequest(method=m, **{k: 1 for k in
                                                       main.SessionDenoiseRequest.model_fields
                                                       if k != "method"})
        assert set(full.criterion_params()) == set(keys), m
    assert set(pg.Cloud.register_to._tool_by_method["global"]) <= set(
        main.GlobalRegisterRequest.model_fields)
    assert set(pg.Cloud.register_to._tool_by_method["icp"]) <= set(
        main.CloudToCloudICPRequest.model_fields)


def test_scene_types_and_estimators_in_the_docstring_are_the_backends():
    doc = inspect.getdoc(pg.Cloud.register_to)
    for v in (*main._SCENE_TYPES, *main._GLOBAL_ESTIMATORS):
        assert f'"{v}"' in doc, v
