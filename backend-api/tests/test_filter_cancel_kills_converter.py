"""Applying a permanent filter must be CANCELLABLE, and the cancel must reach
the PotreeConverter child rather than merely detaching the client's fetch.

Why this test exists: the filter endpoint used to be a plain blocking JSON
route. It minted no run_id, so `/api/cancel/{run_id}` had nothing to target, and
it passed no cancel event into the octree rebuild. A user who hit "Filter
(remove points)" on a large plot got no progress signal at all, clicked again
(each click queueing ANOTHER full filter + reconversion), and had no way to stop
the work once started.

Two links are pinned here, because the second one is the silent kind:

  1. The route registers a cancel token and streams its run_id, so the pill has
     something to cancel.
  2. `_do_session_filter` threads a LIVE cancel event down into
     `_run_potree_converter`. The converter's own kill loop is already covered
     by test_import_cancel_kills_converter; what breaks silently is the handoff
     — the cancel protocol is duck-typed, so a reporter that doesn't expose the
     event degrades a hard kill into an uncancellable run with NO error.
"""

import json
import threading

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


@pytest.fixture
def cache_root(tmp_path, monkeypatch):
    """Isolated octree cache. Without it a previous run's entry for this tiny
    cloud is a CACHE HIT, `_build_octree_from_las` returns before spawning
    anything, and a converter-wiring assertion silently tests nothing."""
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@pytest.fixture
def class_session():
    """In-RAM session with a categorical column, no file and no octree."""
    n = 40
    xyz = np.column_stack([
        np.arange(n, dtype=float), np.zeros(n), np.zeros(n),
    ])
    cls = np.repeat(np.arange(4, dtype=np.float32), n // 4)
    sess = main.CloudSession(
        session_id="filter_cancel_sess",
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=xyz,
        colors=None,
        intensity=None,
        extras={"tree_instance": cls},
        extra_dims_meta=[{"slug": "tree_instance", "label": "Tree Instance"}],
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=__import__("time").time(),
    )
    main._cloud_sessions[sess.session_id] = sess
    try:
        yield sess
    finally:
        main._cloud_sessions.pop(sess.session_id, None)


def test_filter_hands_a_live_cancel_event_to_the_converter(class_session, cache_root, monkeypatch):
    """THE decisive link: the event the converter polls must be the same one
    `/api/cancel/{run_id}` sets. A `None` here is the silent failure — the
    filter still succeeds, so nothing looks wrong until a user tries to cancel.
    """
    seen = {}

    def fake_converter(input_las, out_dir, cancel_event=None, poll=0.2):
        seen["event"] = cancel_event
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "metadata.json").write_text(
            json.dumps({"points": 0, "attributes": [], "boundingBox": {}}))

    monkeypatch.setattr(main, "_run_potree_converter", fake_converter)

    run_id, cancel_event = main._new_cancel_token()
    reporter = main._ProgressReporter(__import__("queue").Queue(), cancel_event)
    req = main.SessionFilterRequest(
        scalar_filters=[main.ScalarFilter(slug="tree_instance", values=[3])],
        rebuild=True,
    )
    main._do_session_filter(class_session.session_id, req, reporter)

    assert "event" in seen, "the converter was never invoked"
    assert seen["event"] is not None, (
        "the filter passed no cancel event to PotreeConverter — Cancel would "
        "detach the fetch and leave the reconversion running")
    # Same object, so cancelling the RUN stops THIS converter.
    assert seen["event"] is cancel_event
    assert not seen["event"].is_set()
    main._cancel_run(run_id)
    assert seen["event"].is_set(), (
        "/api/cancel/{run_id} does not reach the event the converter polls")


def test_filter_route_streams_a_cancellable_run_id(client, class_session, cache_root, monkeypatch):
    """The pill can only cancel a run it can name, so the route must register a
    token and emit it in a PHP1 marker ahead of the JSON tail."""
    def fake_converter(input_las, out_dir, cancel_event=None, poll=0.2):
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "metadata.json").write_text(
            json.dumps({"points": 0, "attributes": [], "boundingBox": {}}))

    monkeypatch.setattr(main, "_run_potree_converter", fake_converter)

    raw = client.post(
        f"/api/cloud/session/{class_session.session_id}/filter",
        json={"scalar_filters": [{"slug": "tree_instance", "values": [3]}],
              "rebuild": True},
    ).content

    head = raw[:raw.index(b'{"session_id"')]
    assert b'"run_id"' in head, "no run_id streamed; the filter is uncancellable"
    body = decode_streamed_json(raw)
    assert body["rebuilt"] is True


def test_a_cancelled_filter_does_not_commit_a_rebuild(class_session, cache_root, monkeypatch):
    """A cancel raised inside the converter must propagate out rather than be
    swallowed into a 'successful' filter with a half-built octree."""
    run_id, cancel_event = main._new_cancel_token()

    def cancelling_converter(input_las, out_dir, cancel_event=None, poll=0.2):
        # Mirror the real converter: the event is already set, so it bails.
        assert cancel_event is not None
        raise main.ScanCancelled()

    monkeypatch.setattr(main, "_run_potree_converter", cancelling_converter)
    cancel_event.set()

    reporter = main._ProgressReporter(__import__("queue").Queue(), cancel_event)
    req = main.SessionFilterRequest(
        scalar_filters=[main.ScalarFilter(slug="tree_instance", values=[3])],
        rebuild=True,
    )
    with pytest.raises(main.ScanCancelled):
        main._do_session_filter(class_session.session_id, req, reporter)
