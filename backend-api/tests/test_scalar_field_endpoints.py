"""Endpoint tests for the Scalar Fields tool.

These run against a REAL CloudSession (no mocks) and cover the parts
test_scalar_fields.py deliberately does not: session mutation, the miss/deleted
mask, the full-length column contract, and the management guards.

`defer_octree=True` throughout — PotreeConverter is not what is under test here,
and skipping it keeps the suite fast.
"""

import numpy as np
import pytest

import main


@pytest.fixture
def sess(monkeypatch):
    """A small in-RAM session with a miss, a deleted point, and two scalars.

    Built directly rather than through an import so the fixture states exactly
    what it contains. Layout (8 points):

        idx 0..5  hits, alive
        idx 6     hit, DELETED
        idx 7     MISS (is_miss=1), alive

    `intensity_col` is an extras column (not the dedicated uint16 array) so the
    arithmetic paths see a plain float scalar field.
    """
    n = 8
    positions = np.zeros((n, 3), dtype=np.float64)
    positions[:, 2] = np.arange(n, dtype=np.float64)          # z = 0..7
    # The miss sits ~1 km out, as a real one does.
    positions[7] = [0.0, 0.0, 1000.0]

    deleted = np.zeros(n, dtype=bool)
    deleted[6] = True

    is_miss = np.zeros(n, dtype=np.float32)
    is_miss[7] = 1.0

    extras = {
        "intensity_col": np.array([1, 2, 3, 4, 5, 6, 7, 999],
                                  dtype=np.float32),
        main._MISS_SLUG: is_miss,
    }
    meta = [{"slug": "intensity_col", "label": "Intensity Col"},
            {"slug": main._MISS_SLUG, "label": "Miss"}]

    s = main.CloudSession(
        session_id="test-sf", source_path="", ascii_format=None,
        column_plan=None, positions=positions, colors=None, intensity=None,
        extras=extras, extra_dims_meta=meta, deleted=deleted,
        deleted_history=[], octree_cache_id=None, created_at=0.0,
    )
    main._cloud_sessions[s.session_id] = s
    yield s
    main._cloud_sessions.pop(s.session_id, None)


def compute(client, sess, expression, slug, **kw):
    body = {"expression": expression, "slug": slug,
            "defer_octree": True, "acknowledge_cost": True}
    body.update(kw)
    return client.post(
        f"/api/cloud/session/{sess.session_id}/scalar_fields/compute", json=body)


# ── Listing ─────────────────────────────────────────────────────────────────

def test_listing_reports_fields_and_editability(client, sess):
    res = client.get(f"/api/cloud/session/{sess.session_id}/scalar_fields")
    assert res.status_code == 200, res.text
    body = res.json()
    by_slug = {f["slug"]: f for f in body["fields"]}

    assert by_slug["intensity_col"]["editable"] is True
    # is_miss is read by name by LAD and by every reconstruction tool.
    assert by_slug[main._MISS_SLUG]["editable"] is False
    # x/y/z are readable in an expression but are not extras rows.
    for axis in ("x", "y", "z"):
        assert by_slug[axis]["kind"] == "builtin"
        assert by_slug[axis]["editable"] is False

    assert body["point_count"] == 8
    # Alive AND a real return: 8 - 1 deleted - 1 miss.
    assert body["visible_count"] == 6
    assert "sqrt" in body["functions"]
    assert "mean" in body["aggregates"]


# ── Statistics ──────────────────────────────────────────────────────────────

def test_stats_exclude_misses_and_deleted_points(client, sess):
    """The single most important property of the stats endpoint.

    `z` runs 0..7 with the deleted point at 6 and a MISS at 1000. Over the six
    visible hits the mean is 2.5. Include the miss and it is ~143; include the
    deleted point too and the column is a different cloud from the one on
    screen. Same mask as the colorbar (`_session_editable_mask_locked`), so the
    numbers here can never disagree with the legend beside them.
    """
    res = client.get(f"/api/cloud/session/{sess.session_id}/scalar_fields/z/stats")
    assert res.status_code == 200, res.text
    stats = res.json()["stats"]
    assert stats["count"] == 6
    assert stats["mean"] == pytest.approx(2.5)
    assert stats["max"] == pytest.approx(5.0)      # not 1000, not 6


def test_stats_of_an_extras_column(client, sess):
    res = client.get(
        f"/api/cloud/session/{sess.session_id}/scalar_fields/intensity_col/stats")
    stats = res.json()["stats"]
    assert stats["count"] == 6
    assert stats["mean"] == pytest.approx(3.5)     # 1..6, not 7 (deleted) or 999
    assert "histogram" in stats


def test_stats_of_unknown_field_is_404(client, sess):
    res = client.get(
        f"/api/cloud/session/{sess.session_id}/scalar_fields/nope/stats")
    assert res.status_code == 404


# ── Compute ─────────────────────────────────────────────────────────────────

def test_compute_creates_a_first_class_field(client, sess):
    res = compute(client, sess, "intensity_col * 2", "doubled")
    assert res.status_code == 200, res.text

    # It is a real extras column, in lockstep with extra_dims_meta.
    assert "doubled" in sess.extras
    assert any(ed["slug"] == "doubled" for ed in sess.extra_dims_meta)
    np.testing.assert_allclose(sess.extras["doubled"],
                               sess.extras["intensity_col"] * 2)
    # And it records its provenance.
    assert sess.derived_fields["doubled"] == "intensity_col * 2"


def test_computed_column_is_full_length_including_deleted_rows(client, sess):
    """Arithmetic must NOT use the survivor-aligned chokepoint.

    `_session_add_extra_column` zero-fills deleted rows. For an elementwise
    expression that is wrong: the value is defined for a deleted row, and
    `reset_edits` can bring that row back — at which point a zero would be
    indistinguishable from a genuine 0. Index 6 is deleted and must still carry
    7*2.
    """
    compute(client, sess, "intensity_col * 2", "doubled")
    assert len(sess.extras["doubled"]) == 8
    assert sess.extras["doubled"][6] == pytest.approx(14.0)   # NOT 0
    assert sess.extras["doubled"][7] == pytest.approx(1998.0)


def test_restored_points_keep_their_derived_value(client, sess):
    """The end-to-end version of the test above, through the real undo path."""
    compute(client, sess, "intensity_col * 2", "doubled")
    # Delete two more points, then roll the edits back.
    sess.deleted_history.append(np.array([0, 1], dtype=np.int64))
    sess.deleted[[0, 1]] = True
    res = client.post(f"/api/cloud/session/{sess.session_id}/reset_edits",
                      json={"steps": 0})
    assert res.status_code == 200, res.text
    np.testing.assert_allclose(sess.extras["doubled"][[0, 1]], [2.0, 4.0])


def test_aggregates_are_measured_over_visible_points_only(client, sess):
    """`mean(z)` inside a formula must equal the mean the Stats tab shows."""
    res = compute(client, sess, "z - mean(z)", "centred")
    assert res.status_code == 200, res.text
    # Visible mean of z is 2.5 (see test_stats_exclude_misses_and_deleted_points).
    assert sess.extras["centred"][0] == pytest.approx(-2.5)


def test_compute_returns_stats_for_the_new_field(client, sess):
    body = compute(client, sess, "intensity_col * 2", "doubled").json()
    assert body["stats"]["mean"] == pytest.approx(7.0)     # 2*(1..6)/6
    assert body["expression"] == "intensity_col * 2"
    assert body["octree_deferred"] is True


def test_compute_can_reference_a_previously_derived_field(client, sess):
    """A derived field is an ordinary field, including as an expression input."""
    compute(client, sess, "intensity_col * 2", "doubled")
    res = compute(client, sess, "doubled + 1", "plus_one")
    assert res.status_code == 200, res.text
    np.testing.assert_allclose(sess.extras["plus_one"],
                               sess.extras["intensity_col"] * 2 + 1)


def test_a_constant_expression_fills_the_whole_column(client, sess):
    """Seeding a field with a constant is a legitimate thing to want."""
    res = compute(client, sess, "pi * 2", "twopi")
    assert res.status_code == 200, res.text
    assert len(sess.extras["twopi"]) == 8
    np.testing.assert_allclose(sess.extras["twopi"], np.float32(np.pi * 2), rtol=1e-6)


def test_nonfinite_results_are_reported_not_fatal(client, sess):
    body = compute(client, sess, "1 / (z - 1)", "recip").json()
    assert body["inf_count"] == 1
    assert "recip" in sess.extras


@pytest.mark.parametrize("expr", ['__import__("os")', "z.__class__", "lambda: 1"])
def test_dangerous_expressions_are_400_not_500(client, sess, expr):
    res = compute(client, sess, expr, "evil")
    assert res.status_code == 400, res.text
    assert "evil" not in sess.extras


def test_expression_error_carries_a_column_offset(client, sess):
    res = compute(client, sess, "z + bogus", "x1")
    assert res.status_code == 400
    assert res.json()["detail"]["col"] == len("z + ")


@pytest.mark.parametrize("slug,status", [
    ("is_miss", 400),          # reserved: LAD reads it by name
    ("nx", 400),               # reserved: normals contract
    ("ground_class", 400),     # reserved: categorical scheme + LAS promotion
    # Reserved because `_export_session_to_las` promotes the first class column
    # it finds into the standard LAS `classification` byte, by name.
    ("las_classification", 400),
    ("intensity_col", 400),    # already exists
    ("time", 400),             # canonical import alias
    ("elevation", 400),        # canonical import alias for z
    ("1bad", 400),             # malformed
    ("has space", 400),
])
def test_bad_slugs_are_rejected(client, sess, slug, status):
    res = compute(client, sess, "z * 1", slug)
    assert res.status_code == status, res.text


def test_overwrite_only_applies_to_derived_fields(client, sess):
    compute(client, sess, "z * 1", "mine")
    # Re-deriving your own field is the normal edit-the-formula loop.
    res = compute(client, sess, "z * 2", "mine", overwrite=True)
    assert res.status_code == 200, res.text
    np.testing.assert_allclose(sess.extras["mine"], sess.positions[:, 2] * 2)
    # An imported column is a measurement; overwriting it would invalidate
    # anything already computed from it, silently.
    res = compute(client, sess, "z * 3", "intensity_col", overwrite=True)
    assert res.status_code == 400
    assert "not created by the calculator" in res.text


def test_recompute_keeps_the_column_position(client, sess):
    """Export column order follows extra_dims_meta, so a re-derive must not
    move the field to the end of every exported file."""
    compute(client, sess, "z * 1", "mine")
    compute(client, sess, "z * 5", "another")
    before = [ed["slug"] for ed in sess.extra_dims_meta]
    compute(client, sess, "z * 2", "mine", overwrite=True)
    assert [ed["slug"] for ed in sess.extra_dims_meta] == before


# ── Management ──────────────────────────────────────────────────────────────

def manage(client, sess, **body):
    body.setdefault("defer_octree", True)
    return client.post(
        f"/api/cloud/session/{sess.session_id}/scalar_fields/manage", json=body)


def test_rename_preserves_values_and_order(client, sess):
    compute(client, sess, "intensity_col * 2", "doubled")
    before = [ed["slug"] for ed in sess.extra_dims_meta]
    values = np.array(sess.extras["doubled"])

    res = manage(client, sess, action="rename", slug="doubled",
                 new_slug="twice", new_label="Twice")
    assert res.status_code == 200, res.text
    assert "doubled" not in sess.extras
    np.testing.assert_allclose(sess.extras["twice"], values)
    # Same position, so the export column order is unchanged.
    assert [ed["slug"] for ed in sess.extra_dims_meta] == \
        [("twice" if s == "doubled" else s) for s in before]
    assert list(sess.extras).index("twice") == before.index("doubled")
    # Provenance follows the rename.
    assert sess.derived_fields["twice"] == "intensity_col * 2"


def test_delete_removes_from_both_dicts(client, sess):
    compute(client, sess, "z * 1", "tmp")
    res = manage(client, sess, action="delete", slug="tmp")
    assert res.status_code == 200, res.text
    assert "tmp" not in sess.extras
    assert not any(ed["slug"] == "tmp" for ed in sess.extra_dims_meta)
    assert "tmp" not in sess.derived_fields


def test_duplicate_is_independent(client, sess):
    compute(client, sess, "z * 1", "orig")
    res = manage(client, sess, action="duplicate", slug="orig", new_slug="copy")
    assert res.status_code == 200, res.text
    np.testing.assert_allclose(sess.extras["copy"], sess.extras["orig"])
    # A view would alias the memmap on a store-backed session.
    sess.extras["copy"][0] = 12345.0
    assert sess.extras["orig"][0] != 12345.0


@pytest.mark.parametrize("slug", ["is_miss"])
def test_reserved_fields_cannot_be_deleted_or_renamed(client, sess, slug):
    """Deleting is_miss would silently break LAD's Beer's-law denominator and
    the miss filter every reconstruction tool depends on."""
    assert manage(client, sess, action="delete", slug=slug).status_code == 400
    assert manage(client, sess, action="rename", slug=slug,
                  new_slug="whatever").status_code == 400
    assert slug in sess.extras


def test_rename_to_a_taken_or_reserved_name_is_rejected(client, sess):
    compute(client, sess, "z * 1", "tmp")
    assert manage(client, sess, action="rename", slug="tmp",
                  new_slug="intensity_col").status_code == 400
    assert manage(client, sess, action="rename", slug="tmp",
                  new_slug="is_miss").status_code == 400
    assert manage(client, sess, action="rename", slug="tmp",
                  new_slug="z").status_code == 400
    assert "tmp" in sess.extras


def test_manage_unknown_field_is_404(client, sess):
    assert manage(client, sess, action="delete", slug="nope").status_code == 404


def test_manage_returns_the_updated_listing(client, sess):
    compute(client, sess, "z * 1", "tmp")
    body = manage(client, sess, action="delete", slug="tmp").json()
    assert "tmp" not in {f["slug"] for f in body["fields"]}


# ── Export integration ──────────────────────────────────────────────────────

def test_derived_field_is_exportable(client, sess, tmp_path):
    """The point of the whole feature: a derived field is an ordinary column.

    `_resolve_export_columns` builds its `available` map from `extras`, so a
    field written through the session dicts needs no export-side change — this
    asserts that is actually true rather than assuming it.
    """
    compute(client, sess, "intensity_col * 2", "doubled")
    dest = tmp_path / "out.csv"
    res = client.post("/api/pointcloud/export", json={
        "format": "csv",
        "dest_path": str(dest),
        "source": {"session_id": sess.session_id},
        "columns": ["x", "y", "z", "doubled"],
    })
    assert res.status_code == 200, res.text
    text = dest.read_text()
    assert "doubled" in text.splitlines()[0]
    # Spot-check one value survived the round trip.
    rows = [r for r in text.splitlines()[1:] if r.strip()]
    assert float(rows[0].split(",")[-1]) == pytest.approx(2.0)


# ── Aggregate statistics across sessions ────────────────────────────────────


@pytest.fixture
def sess_b(monkeypatch):
    """A SECOND session, deliberately different from `sess`, for pooling.

    Same deliberate layout (hits / one deleted / one miss) so the mask has
    something to exclude on both sides, but different values and a different
    length — so a pooled statistic cannot coincidentally equal either session's
    own, and a test asserting the pooled number fails against a backend that
    returns just one of them.

    Layout (5 points):

        idx 0..2  hits, alive   intensity_col = 10, 20, 30
        idx 3     hit, DELETED  intensity_col = 40
        idx 4     MISS          intensity_col = 999
    """
    n = 5
    positions = np.zeros((n, 3), dtype=np.float64)
    positions[:, 2] = np.arange(n, dtype=np.float64)
    positions[4] = [0.0, 0.0, 1000.0]

    deleted = np.zeros(n, dtype=bool)
    deleted[3] = True

    is_miss = np.zeros(n, dtype=np.float32)
    is_miss[4] = 1.0

    extras = {
        "intensity_col": np.array([10, 20, 30, 40, 999], dtype=np.float32),
        "only_b": np.arange(n, dtype=np.float32),
        main._MISS_SLUG: is_miss,
    }
    meta = [{"slug": "intensity_col", "label": "Reflectance [dB]"},
            {"slug": "only_b", "label": "Only B"},
            {"slug": main._MISS_SLUG, "label": "Miss"}]

    s = main.CloudSession(
        session_id="test-sf-b", source_path="", ascii_format=None,
        column_plan=None, positions=positions, colors=None, intensity=None,
        extras=extras, extra_dims_meta=meta, deleted=deleted,
        deleted_history=[], octree_cache_id=None, created_at=0.0,
    )
    main._cloud_sessions[s.session_id] = s
    yield s
    main._cloud_sessions.pop(s.session_id, None)


def agg(client, session_ids, slug, **kw):
    body = {"session_ids": session_ids, "slug": slug}
    body.update(kw)
    return client.post("/api/cloud/scalar_fields/stats", json=body)


def test_pooled_stats_equal_stats_over_the_concatenation(client, sess, sess_b):
    """The defining property: pooling is describe() over the concatenation.

    The expected array is built here by hand from the two fixtures rather than
    read back from the endpoint, so this fails if the handler reorders,
    re-masks, or (the classic) averages the two sessions' means.
    """
    import scalar_fields

    a = sess.extras["intensity_col"][
        main._session_editable_mask_locked(sess)].astype(np.float64)
    b = sess_b.extras["intensity_col"][
        main._session_editable_mask_locked(sess_b)].astype(np.float64)
    expected = scalar_fields.describe(np.concatenate([a, b]))

    res = agg(client, [sess.session_id, sess_b.session_id], "intensity_col")
    assert res.status_code == 200, res.text
    got = res.json()["stats"]

    for key in ("count", "finite_count", "min", "max", "mean", "std",
                "median", "p25", "p75"):
        assert got[key] == pytest.approx(expected[key]), key

    # And it is genuinely a POOL, not either input: 6 alive hits (1..6, sum 21)
    # plus 3 alive hits (10, 20, 30, sum 60) = 9 values summing to 81, mean 9.0.
    assert got["count"] == 9
    assert got["mean"] == pytest.approx(9.0)
    # Neither session alone produces that.
    assert got["mean"] != pytest.approx(float(np.mean(a)))
    assert got["mean"] != pytest.approx(float(np.mean(b)))
    # Nor does the mean of the two means — the tempting wrong implementation.
    assert got["mean"] != pytest.approx(
        (float(np.mean(a)) + float(np.mean(b))) / 2.0)


def test_pooled_stats_exclude_misses_and_deleted(client, sess, sess_b):
    """Masking must happen per session BEFORE the concatenation.

    Both fixtures park a miss at intensity_col=999 and delete one ordinary
    point. If the handler concatenated raw columns and masked afterwards (or
    not at all), 999 would set the maximum and the count would be 13.
    """
    res = agg(client, [sess.session_id, sess_b.session_id], "intensity_col")
    assert res.status_code == 200, res.text
    got = res.json()["stats"]

    assert got["max"] == pytest.approx(30.0)      # not 999
    assert got["count"] == 9                      # not 13 (8 + 5)

    # The per-source counts add up to it, and each excludes its own miss +
    # deleted point.
    sources = res.json()["sources"]
    assert [s["count"] for s in sources] == [6, 3]
    assert sum(s["count"] for s in sources) == got["count"]


def test_pooled_single_session_matches_the_single_session_route(client, sess):
    """One id must give exactly what the per-session route gives.

    Guards the two implementations against drifting apart.
    """
    one = client.get(
        f"/api/cloud/session/{sess.session_id}/scalar_fields/intensity_col/stats")
    assert one.status_code == 200, one.text
    many = agg(client, [sess.session_id], "intensity_col")
    assert many.status_code == 200, many.text
    assert many.json()["stats"] == one.json()["stats"]


@pytest.mark.parametrize("slug", ["x", "y", "z"])
def test_pooled_coordinates_refused_across_sessions(client, sess, sess_b, slug):
    """Coordinates live in each session's own frame, so pooling them is wrong.

    Refused rather than warned about: the pooled mean of two clouds at
    different global shifts looks like a perfectly ordinary number.
    """
    res = agg(client, [sess.session_id, sess_b.session_id], slug)
    assert res.status_code == 400, res.text
    detail = res.json()["detail"]
    assert slug in detail and "frame" in detail.lower()


@pytest.mark.parametrize("slug", ["x", "y", "z"])
def test_pooled_coordinates_allowed_for_one_session(client, sess, slug):
    """The refusal is about MIXING frames, so a single cloud is unaffected."""
    res = agg(client, [sess.session_id], slug)
    assert res.status_code == 200, res.text
    assert res.json()["stats"]["count"] == 6


def test_pooled_reports_sessions_missing_the_field(client, sess, sess_b):
    """A field on only one cloud still measures, and says who lacked it.

    200 rather than 400: the renderer only offers intersection fields, so
    reaching here means a race (a sibling's field deleted between the listing
    and this call), and degrading beats blanking the tab.
    """
    res = agg(client, [sess.session_id, sess_b.session_id], "only_b")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["missing_session_ids"] == [sess.session_id]
    assert [s["session_id"] for s in body["sources"]] == [sess_b.session_id]
    assert body["stats"]["count"] == 3


def test_pooled_field_on_no_session_is_404(client, sess, sess_b):
    res = agg(client, [sess.session_id, sess_b.session_id], "nonexistent")
    assert res.status_code == 404, res.text


def test_pooled_requires_at_least_one_session(client):
    res = agg(client, [], "intensity_col")
    assert res.status_code == 400, res.text


def test_pooled_requires_a_slug(client, sess):
    res = agg(client, [sess.session_id], "   ")
    assert res.status_code == 400, res.text


def test_pooled_unknown_session_is_404(client, sess):
    res = agg(client, [sess.session_id, "no-such-session"], "intensity_col")
    assert res.status_code == 404, res.text


def test_pooled_duplicate_session_ids_counted_once(client, sess):
    """A doubled id must not double that cloud's weight.

    The mean survives duplication unchanged, which is exactly why this needs
    its own test — the histogram and the counts do not.
    """
    res = agg(client, [sess.session_id, sess.session_id], "intensity_col")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["session_ids"] == [sess.session_id]
    assert body["stats"]["count"] == 6
    assert len(body["sources"]) == 1


def test_pooled_label_comes_from_the_first_session_carrying_the_field(
        client, sess, sess_b):
    """Labels can disagree between clouds; one is chosen and both are reported."""
    res = agg(client, [sess.session_id, sess_b.session_id], "intensity_col")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["label"] == "Intensity Col"          # sess's label, listed first
    assert [s["label"] for s in body["sources"]] == [
        "Intensity Col", "Reflectance [dB]"]
