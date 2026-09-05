"""One canonical name→slug table, and every consumer resolves through it.

A scalar column is only useful to Phytograph's tools once it lands under a
canonical slug (Backfill Misses looks for `timestamp`; LAD's multi-return path
for timestamp/target_index/target_count; the miss filter for `is_miss`). Source
files spell these however their vendor pleased.

That knowledge used to live in SIX independent copies — two `aliases` dicts in
the LAD readers, `_normalise_miss_alias`, `_normalise_origin_alias`,
`_role_from_header_name`, and `role_for` in `_preview_las`. Fixing one left the
others stale, which is how a `gps-time` column could be offered by the colour-by
picker and simultaneously be invisible to Backfill Misses.
"""

import re

import laspy
import numpy as np
import pytest

import main


# ── The table itself ────────────────────────────────────────────────────────

@pytest.mark.parametrize("name,expected", [
    # The spelling that started all this.
    ("gps_time", "timestamp"), ("gps-time", "timestamp"),
    ("GpsTime", "timestamp"), ("GPS Time", "timestamp"),
    # The user's hypothetical: "if the user's file uses a different name (e.g. time)".
    ("time", "timestamp"), ("Timestamp[s]", "timestamp"), ("timestamp", "timestamp"),
    # Unit suffixes and case, as real scanner exports write them.
    ("Reflectance[dB]", "reflectance"), ("Reflectance", "reflectance"),
    ("reflectivity", "reflectance"), ("Intensity", "intensity"),
    # Multi-return, LAS spellings and ours.
    ("return_number", "target_index"), ("targetIndex", "target_index"),
    ("number_of_returns", "target_count"), ("numReturns", "target_count"),
    # Grid indices, miss flag, beam origins.
    ("scan_row", "row_index"), ("rasterColumn", "column_index"),
    ("sky", "is_miss"), ("is_miss", "is_miss"), ("miss", "is_miss"),
    ("ox", "origin_x"), ("beamOriginY", "origin_y"), ("z_origin", "origin_z"),
    # Positions and colour (255-scale roles, per the pipeline's convention).
    ("easting", "x"), ("northing", "y"), ("elevation", "z"),
    ("Red", "r255"), ("green", "g255"), ("B", "b255"),
])
def test_canonical_slug_resolution(name, expected):
    assert main._canonical_slug_for_name(name) == expected


@pytest.mark.parametrize("name", ["refl", "Amplitude", "Deviation", "foo", "", "  "])
def test_unrecognised_names_return_none(name):
    """None means 'carry it as a plain scalar', never 'drop it'. Amplitude and
    Deviation are real RIEGL columns with no canonical role — they must stay
    importable as ordinary scalars."""
    assert main._canonical_slug_for_name(name) is None


def test_no_alias_claimed_by_two_slugs():
    """Resolution must not depend on dict ordering. main.py asserts this at
    import time; this pins it as a test so the failure is legible."""
    seen = {}
    for slug, names in main._CANONICAL_NAME_ALIASES.items():
        for n in names:
            assert n not in seen or seen[n] == slug, (
                f"{n!r} claimed by both {seen.get(n)!r} and {slug!r}")
            seen[n] = slug


def test_aliases_are_stored_pre_normalised():
    """Entries are matched against `_normalise_column_name` output, so a table
    entry containing punctuation or capitals could never match anything."""
    for slug, names in main._CANONICAL_NAME_ALIASES.items():
        for n in names:
            assert n == main._normalise_column_name(n), (
                f"alias {n!r} for {slug!r} is not in normalised form")


def test_table_is_the_only_definition():
    """Guards the consolidation: a new local `aliases = {` mapping slugs to name
    tuples is how the six-copy drift started. Fail loudly if one reappears."""
    src = (main.__file__ or "").replace(".pyc", ".py")
    with open(src, encoding="utf-8") as f:
        body = f.read()
    # Local dicts literally named `aliases` were the duplicated form.
    offenders = re.findall(r"^\s+aliases = \{\s*$", body, re.MULTILINE)
    assert not offenders, (
        f"{len(offenders)} local `aliases = {{` dict(s) reintroduced; "
        "resolve through _canonical_slug_for_name instead")


# ── Deterministic precedence when a file carries two spellings ──────────────

def _write_las(path, *, extra_dims=(), **cols):
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    for name in extra_dims:
        header.add_extra_dim(laspy.ExtraBytesParams(name=name, type=np.float32))
    las = laspy.LasData(header)
    n = len(next(iter(cols.values())))
    las.x = np.linspace(0, 1, n); las.y = np.linspace(0, 1, n); las.z = np.linspace(0, 1, n)
    for k, v in cols.items():
        setattr(las, k, np.asarray(v))
    las.write(str(path))
    return path


def test_dims_for_slug_prefers_the_explicit_column(tmp_path):
    """Phytograph's historical export: real times in a float32 `timestamp` extra
    dim, standard `gps_time` left at zero. `dims` is a SET, so without an
    explicit order the reader could pick the all-zero column and import zeros."""
    p = _write_las(tmp_path / "both.las", extra_dims=("timestamp",),
                   gps_time=np.zeros(3), timestamp=np.array([85.1, 132.0, 233.5]))
    dims = set(laspy.read(str(p)).point_format.dimension_names)
    assert main._dims_for_slug(dims, "timestamp")[0] == "timestamp"


def test_dims_for_slug_falls_back_to_the_standard_name(tmp_path):
    """With only the standard dimension present, it is the right answer."""
    p = _write_las(tmp_path / "std.las", gps_time=np.array([85.1, 132.0, 233.5]))
    dims = set(laspy.read(str(p)).point_format.dimension_names)
    assert main._dims_for_slug(dims, "timestamp") == ("gps_time",)


def test_preview_never_assigns_one_role_twice(tmp_path):
    """Only one column may hold an exclusive role. A file carrying both
    spellings of timestamp AND of the multi-return pair must still produce a
    single claimant each — otherwise the wizard's first-wins dedup silently
    demotes the column that actually holds the data."""
    p = _write_las(
        tmp_path / "dupes.las",
        extra_dims=("timestamp", "target_index", "target_count"),
        gps_time=np.zeros(3), return_number=np.zeros(3, dtype=np.uint8),
        number_of_returns=np.zeros(3, dtype=np.uint8),
        timestamp=np.array([85.1, 132.0, 233.5]),
        target_index=np.array([1.0, 2.0, 1.0]),
        target_count=np.array([2.0, 2.0, 1.0]),
    )
    cols = main._preview_las(str(p), 3).model_dump()["columns"]
    roles = [c["detected_role"] for c in cols if c["detected_role"] != "extra"]
    assert len(roles) == len(set(roles)), f"duplicate exclusive roles: {roles}"

    by_name = {c["header_name"]: c["detected_role"] for c in cols}
    # The data-bearing extra dims win; the all-zero standard dims demote.
    assert by_name["timestamp"] == "timestamp"
    assert by_name["gps_time"] == "extra"
    assert by_name["target_index"] == "target_index"
    assert by_name["return_number"] == "extra"


# ── Fixed-layout previews report canonical roles too ────────────────────────

def test_riproject_preview_reports_canonical_roles(tmp_path):
    """A .riproject's scalar columns hardcoded `detected_role='extra'`, so the
    wizard showed "Scalar" even for columns that ARE first-class roles —
    reflectance, target_index, target_count, timestamp. Those are exactly the
    names downstream tools key off (multi-return pulse grouping, the reflectance
    colour mode, the LAD/backfill timestamp join), so describing them as
    anonymous scalars misrepresented what the import would produce.

    Columns with no canonical role (amplitude, deviation, facet, …) must still
    fall back to 'extra' — they are carried, just not first-class.
    """
    (tmp_path / "ScanPos001").mkdir()
    preview = main._preview_riproject(str(tmp_path))
    roles = {c.header_name: c.detected_role for c in preview.columns}

    assert roles["timestamp"] == "timestamp"
    assert roles["reflectance"] == "reflectance"
    assert roles["target_index"] == "target_index"
    assert roles["target_count"] == "target_count"
    assert roles["intensity"] == "intensity"
    # No canonical role → carried as a plain scalar, never dropped.
    assert roles["amplitude"] == "extra"
    assert roles["deviation"] == "extra"
    assert roles["facet"] == "extra"


def test_riproject_preview_keeps_its_drop_names(tmp_path):
    """The role is informational; `suggested_slug` is what the import actually
    drops by. Changing the reported role must not change the slug, or unticking
    a column would send a name the backend doesn't recognise."""
    (tmp_path / "ScanPos001").mkdir()
    preview = main._preview_riproject(str(tmp_path))
    slugs = {c.header_name: c.suggested_slug for c in preview.columns}
    for name in ("timestamp", "reflectance", "target_index", "target_count",
                 "amplitude", "facet"):
        assert slugs[name] == name


# ── Phase 2: LAS extra-dim slugs land canonical ────────────────────────────

def test_las_extra_dim_slug_is_canonicalised(tmp_path):
    """A LAS ExtraBytes name is an arbitrary vendor string. RIEGL writes
    `Reflectance`; carrying that verbatim as the slug meant an ordinary
    reflectance column was invisible to every tool that keys off `reflectance`,
    purely because of a capital R.

    The file's own spelling survives as the LABEL, so the UI still shows the
    user what their file called the column.
    """
    p = _write_las(tmp_path / "vendor.las", extra_dims=("Reflectance", "Amplitude"),
                   Reflectance=np.array([1.0, 2.0, 3.0]),
                   Amplitude=np.array([4.0, 5.0, 6.0]))
    r = main._read_las_into_arrays(p)

    assert "reflectance" in r.extras, "capitalised Reflectance did not canonicalise"
    assert "Reflectance" not in r.extras
    labels = {e["slug"]: e["label"] for e in r.extra_dims_meta}
    assert labels["reflectance"] == "Reflectance", "file's own spelling lost"

    # No canonical role → carried untouched under its own name.
    assert "Amplitude" in r.extras
    assert labels["Amplitude"] == "Amplitude"


def test_las_extra_dim_values_follow_the_renamed_slug(tmp_path):
    """The rename must move the DATA, not just the key — a slug pointing at the
    wrong array would be worse than the original bug."""
    p = _write_las(tmp_path / "vals.las", extra_dims=("Reflectance",),
                   Reflectance=np.array([-40.5, 0.0, 28.25]))
    r = main._read_las_into_arrays(p)
    np.testing.assert_allclose(r.extras["reflectance"], [-40.5, 0.0, 28.25], atol=1e-5)


def test_las_extra_dim_collision_keeps_both_columns(tmp_path):
    """A file carrying BOTH `Reflectance` and `reflectance` must not have one
    clobber the other — first writer wins, the loser keeps its raw name, and no
    data is silently lost."""
    p = _write_las(tmp_path / "clash.las", extra_dims=("reflectance", "Reflectance"),
                   reflectance=np.array([1.0, 1.0, 1.0]),
                   Reflectance=np.array([2.0, 2.0, 2.0]))
    r = main._read_las_into_arrays(p)
    assert len(r.extras) == 2, f"a column was lost: {sorted(r.extras)}"
    # extras and extra_dims_meta must stay in lockstep — _session_to_las indexes
    # extras by every declared slug and would KeyError otherwise.
    assert {e["slug"] for e in r.extra_dims_meta} == set(r.extras)


def test_riegl_stream_attrs_are_already_canonical():
    """The .riproject reader names its columns itself, so they must be written
    in canonical form at the source — otherwise Phase 2's LAS-side mapping and
    the RIEGL path would disagree about the same quantity."""
    for slug in main._RIEGL_STREAM_ATTRS:
        canonical = main._canonical_slug_for_name(slug)
        assert canonical in (None, slug), (
            f"_RIEGL_STREAM_ATTRS carries {slug!r} but its canonical form is "
            f"{canonical!r}")


# ── Phase 3: user-assigned roles on fixed-layout formats ───────────────────

def _extras(**cols):
    return {k: np.asarray(v, dtype=np.float32) for k, v in cols.items()}


def _meta(*slugs):
    return [{"slug": s, "label": s} for s in slugs]


def test_role_override_renames_a_column(tmp_path):
    """The feature: a column whose vendor name we cannot recognise is promoted
    to a canonical slug because the user said so."""
    extras = _extras(refl=[1.0, 2.0], foo=[3.0, 4.0])
    meta = _meta("refl", "foo")
    e, m, ts = main._apply_role_overrides(extras, meta, {"refl": "reflectance"})

    assert "reflectance" in e and "refl" not in e
    np.testing.assert_allclose(e["reflectance"], [1.0, 2.0])
    assert ts is None
    # The file's own spelling survives as the label.
    assert {x["slug"]: x["label"] for x in m}["reflectance"] == "refl"


def test_role_override_keeps_extras_and_meta_in_lockstep():
    """`_session_to_las` indexes extras by every declared slug and KeyErrors on
    a mismatch, so this invariant is load-bearing, not tidiness."""
    extras = _extras(a=[1.0], b=[2.0], c=[3.0])
    e, m, _ = main._apply_role_overrides(extras, _meta("a", "b", "c"),
                                         {"a": "reflectance", "b": "target_index"})
    assert {x["slug"] for x in m} == set(e)


def test_timestamp_override_is_reported_not_renamed():
    """`timestamp` is float64 in its own session field, never a float32 extra —
    a float32 cast has a 62 ms step at full GPS week-seconds, which would
    destroy multi-return pulse grouping. So the caller moves it; this function
    only reports which column was chosen."""
    extras = _extras(shot_time=[85.1, 233.5])
    e, m, ts = main._apply_role_overrides(extras, _meta("shot_time"),
                                          {"shot_time": "timestamp"})
    assert ts == "shot_time"
    # Still present here — the caller promotes and removes it.
    assert "shot_time" in e


def test_exclusive_role_claimed_once():
    """Two columns cannot both be `reflectance`; first claim wins, matching the
    wizard's own dedupeExclusiveRoles."""
    extras = _extras(a=[1.0], b=[2.0])
    e, _, _ = main._apply_role_overrides(extras, _meta("a", "b"),
                                         {"a": "reflectance", "b": "reflectance"})
    assert "reflectance" in e
    assert len(e) == 2, "a column was destroyed by the losing claim"


def test_override_never_clobbers_an_untouched_column():
    """Renaming onto a slug another column already holds would silently destroy
    data. The rename is skipped instead."""
    extras = _extras(reflectance=[1.0], other=[2.0])
    e, _, _ = main._apply_role_overrides(extras, _meta("reflectance", "other"),
                                         {"other": "reflectance"})
    assert len(e) == 2
    np.testing.assert_allclose(e["reflectance"], [1.0])


def test_override_for_a_missing_column_is_ignored():
    """A plan naming a column this file lacks must not invent or crash."""
    extras = _extras(a=[1.0])
    e, m, ts = main._apply_role_overrides(extras, _meta("a"), {"nope": "reflectance"})
    assert set(e) == {"a"} and ts is None


def test_no_overrides_is_a_passthrough():
    """A no-edit import must be byte-identical to the previous behaviour."""
    extras = _extras(a=[1.0], b=[2.0])
    meta = _meta("a", "b")
    for arg in (None, {}):
        e, m, ts = main._apply_role_overrides(extras, meta, arg)
        assert e is extras and m is meta and ts is None


def test_extra_and_label_are_not_renames():
    """They pick gradient vs discrete colouring, not a canonical slug."""
    extras = _extras(a=[1.0])
    e, _, ts = main._apply_role_overrides(extras, _meta("a"), {"a": "extra"})
    assert set(e) == {"a"} and ts is None


def test_incomplete_origin_triple_keeps_its_raw_names(tmp_path):
    """Beam-origin slugs are only meaningful as a COMPLETE triple.

    The reader consumes ox/oy/oz together into float64 `beam_origins`; a partial
    set (a lone `ox`, or ox+oy with no oz) is deliberately left as ordinary
    scalars. Canonicalising those to `origin_x`/`origin_y` would advertise a
    triple that does not exist and that nothing downstream can consume —
    regression caught by test_beam_origins.py::test_partial_origin_triple_ignored.
    """
    p = _write_las(tmp_path / "partial.las", extra_dims=("ox", "oy"),
                   ox=np.full(3, 5.0), oy=np.full(3, 6.0))
    r = main._read_las_into_arrays(p)

    assert r.beam_origins is None
    assert "ox" in r.extras and "oy" in r.extras
    assert "origin_x" not in r.extras and "origin_y" not in r.extras


def test_fixed_layout_previews_lock_geometry_and_open_scalars(tmp_path):
    """The Phase 3 contract, asserted on BOTH fixed-layout previews so they
    can't drift apart: geometry is fixed by the reader and must stay locked;
    every scalar is assignable, because its name is a vendor string we may not
    recognise and only the user knows what it means."""
    (tmp_path / "ScanPos001").mkdir()
    rip = {c.header_name: c for c in main._preview_riproject(str(tmp_path)).columns}
    for geo in ("x", "y", "z"):
        assert rip[geo].role_assignable is False, f"{geo} must stay locked"
    for scalar in ("intensity", "reflectance", "timestamp", "amplitude", "facet"):
        assert rip[scalar].role_assignable is True, f"{scalar} should be assignable"

    p = _write_las(tmp_path / "cmp.las", extra_dims=("Reflectance",),
                   gps_time=np.array([1.0, 2.0]),
                   Reflectance=np.array([3.0, 4.0]))
    las = {c.header_name: c for c in main._preview_las(str(p), 2).columns}
    for geo in ("X", "Y", "Z"):
        assert las[geo].role_assignable is False
    for scalar in ("intensity", "gps_time", "Reflectance"):
        assert las[scalar].role_assignable is True


def test_role_override_handles_a_swap():
    """Two columns exchanging roles. The clobber guard must not read the swap as
    "the target is taken" and drop both — nor let one overwrite the other. This
    is the case where a naive guard silently loses a column."""
    extras = _extras(reflectance=[1.0], other=[2.0])
    e, m, _ = main._apply_role_overrides(
        extras, _meta("reflectance", "other"),
        {"reflectance": "target_index", "other": "reflectance"})
    assert len(e) == 2, "a column was lost in the swap"
    np.testing.assert_allclose(e["target_index"], [1.0])
    np.testing.assert_allclose(e["reflectance"], [2.0])
    assert {x["slug"] for x in m} == set(e)


def test_role_override_handles_a_chain():
    """Independent renames in one plan must all land."""
    extras = _extras(a=[1.0], b=[2.0])
    e, m, _ = main._apply_role_overrides(
        extras, _meta("a", "b"), {"a": "reflectance", "b": "target_index"})
    assert len(e) == 2
    np.testing.assert_allclose(e["reflectance"], [1.0])
    np.testing.assert_allclose(e["target_index"], [2.0])
    assert {x["slug"] for x in m} == set(e)
