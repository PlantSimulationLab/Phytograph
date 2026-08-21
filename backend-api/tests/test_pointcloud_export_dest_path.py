"""Point-cloud export to a caller-chosen destination path.

The regression these guard: /api/pointcloud/export used to ALWAYS return the
file base64-encoded inside a JSON body. Base64 inflates ~1.33x on top of the
text itself, so a 25 M-point XYZ export produced a body near 1 GB — past V8's
~512 MB string-length cap, where the renderer's `response.json()` fails with
"Unexpected end of JSON input" no matter how long it waits. It is not a timeout
and no amount of retrying helps.

`dest_path` makes the backend write the file itself and return only metadata,
which removes the size ceiling entirely (and avoids holding a second full copy
in renderer memory).
"""
import io
import json
import time
from pathlib import Path

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


@pytest.fixture
def xyz_cloud(tmp_path: Path) -> Path:
    """A small ASCII cloud on disk, the shape an octree-backed export reads."""
    pts = np.array(
        [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0], [-4.5, 5.5, 6.25], [7.0, -8.0, 9.5]],
        dtype=float,
    )
    p = tmp_path / "cloud.xyz"
    with open(p, "w") as f:
        f.write("# x y z\n")
        np.savetxt(f, pts, fmt="%.6f")
    return p


@pytest.fixture
def xyz_session(make_file_session, xyz_cloud):
    """`xyz_cloud` registered as a real in-RAM session — the shape the app sends.
    Export refuses a file-only source (the file does not reflect edits)."""
    return make_file_session(xyz_cloud, "x y z")


def test_export_writes_to_dest_path_and_returns_no_base64(client, xyz_session, tmp_path):
    """With dest_path set, the file lands on disk and `data` comes back null."""
    dest = tmp_path / "out" / "exported.xyz"
    dest.parent.mkdir()

    resp = client.post("/api/pointcloud/export", json={
        "source": {"session_id": xyz_session},
        "format": "xyz",
        "dest_path": str(dest),
    })
    assert resp.status_code == 200, resp.text
    body = decode_streamed_json(resp.content)

    assert body["success"] is True
    assert body["point_count"] == 4
    # The payload must NOT ride back in the response — that's the whole point.
    assert body["data"] is None
    assert body["filename"] == "exported.xyz"

    # The real file is on disk with the real points.
    assert dest.is_file()
    lines = [l for l in dest.read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert len(lines) == 4
    first = [float(v) for v in lines[0].split()]
    assert first == pytest.approx([0.0, 0.0, 0.0])
    last = [float(v) for v in lines[-1].split()]
    assert last == pytest.approx([7.0, -8.0, 9.5])


def test_export_response_stays_tiny_regardless_of_cloud_size(client, xyz_session, tmp_path):
    """The response body must be metadata-sized, not payload-sized.

    This is the property that makes a 25 M-point export possible: the response
    size must be independent of the point count. Asserting an absolute ceiling
    (rather than a ratio) is what catches a regression to base64-in-JSON, since
    that would scale the body with the cloud.
    """
    dest = tmp_path / "big.xyz"
    resp = client.post("/api/pointcloud/export", json={
        "source": {"session_id": xyz_session},
        "format": "xyz",
        "dest_path": str(dest),
    })
    assert resp.status_code == 200
    assert len(resp.content) < 1024, (
        f"export response is {len(resp.content)} B — it should carry only metadata, "
        "not the file payload (base64-in-JSON blows V8's 512 MB string cap on a large cloud)"
    )
    # And the bytes really did go to disk rather than nowhere.
    assert dest.stat().st_size > 0


def test_export_las_writes_to_dest_path(client, xyz_session, tmp_path):
    """The laspy branch honours dest_path too (it used to always temp-file + base64)."""
    dest = tmp_path / "out.las"
    resp = client.post("/api/pointcloud/export", json={
        "source": {"session_id": xyz_session},
        "format": "las",
        "dest_path": str(dest),
    })
    assert resp.status_code == 200, resp.text
    body = decode_streamed_json(resp.content)
    assert body["success"] is True
    assert body["data"] is None
    assert dest.is_file()
    # A real LAS file starts with the LASF signature.
    assert dest.read_bytes()[:4] == b"LASF"

    import laspy
    las = laspy.read(str(dest))
    assert len(las.x) == 4


def test_export_without_dest_path_still_returns_base64(client, xyz_session):
    """The legacy in-body path is kept for callers with no filesystem target."""
    resp = client.post("/api/pointcloud/export", json={
        "source": {"session_id": xyz_session},
        "format": "xyz",
    })
    assert resp.status_code == 200, resp.text
    body = decode_streamed_json(resp.content)
    assert body["success"] is True
    assert body["data"], "legacy callers still expect base64 in `data`"

    import base64
    text = base64.b64decode(body["data"]).decode("utf-8")
    assert len([l for l in text.splitlines() if l.strip()]) == 4


def test_export_rejects_a_relative_dest_path(client, xyz_session):
    """A relative path would resolve against the backend's cwd, not the user's
    chosen folder — reject rather than silently writing somewhere surprising."""
    resp = client.post("/api/pointcloud/export", json={
        "source": {"session_id": xyz_session},
        "format": "xyz",
        "dest_path": "relative/out.xyz",
    })
    assert resp.status_code == 400
    assert "absolute" in resp.json()["detail"].lower()


def test_export_rejects_a_missing_destination_directory(client, xyz_session, tmp_path):
    """The save dialog always yields an existing folder, so a missing parent means
    the path isn't what we think it is. Fail loudly instead of creating it."""
    dest = tmp_path / "does" / "not" / "exist" / "out.xyz"
    resp = client.post("/api/pointcloud/export", json={
        "source": {"session_id": xyz_session},
        "format": "xyz",
        "dest_path": str(dest),
    })
    assert resp.status_code == 400
    assert "directory does not exist" in resp.json()["detail"].lower()
    assert not dest.exists()


def test_export_streams_real_progress_for_a_large_text_export(client, make_file_session, tmp_path):
    """A text export must report a real percentage, not just spin.

    Formatting is ~97% of a text export's wall time and used to be one opaque
    np.savetxt call, so the UI could only show an indeterminate pill. The
    formatter now chunks (see _TEXT_EXPORT_CHUNK_ROWS) and reports per chunk.
    The cloud here is deliberately larger than one chunk — at or below the chunk
    size there is nothing to report and the formatter stays monolithic.
    """
    from tests.binframe import decode_progress_markers

    n = main._TEXT_EXPORT_CHUNK_ROWS * 2 + 1_000
    pts = np.random.default_rng(0).uniform(-10, 10, (n, 3))
    src = tmp_path / "big.xyz"
    with open(src, "w") as f:
        f.write("# x y z\n")
        np.savetxt(f, pts, fmt="%.6f")

    dest = tmp_path / "big_out.xyz"
    resp = client.post("/api/pointcloud/export", json={
        "source": {"session_id": make_file_session(src, "x y z")},
        "format": "xyz",
        "dest_path": str(dest),
    })
    assert resp.status_code == 200, resp.text
    body = decode_streamed_json(resp.content)
    assert body["success"] is True
    assert body["point_count"] == n

    markers = decode_progress_markers(resp.content)
    fractions = [m["progress"] for m in markers if m.get("progress") is not None]
    # More than one determinate tick — a single 0/1 pair would still leave the
    # user staring at an effectively indeterminate bar.
    assert len(fractions) >= 3, f"expected several progress ticks, got {fractions}"
    # Monotonic and bounded: a bar that goes backwards reads as a stall.
    assert fractions == sorted(fractions), f"progress must not go backwards: {fractions}"
    assert all(0.0 <= f <= 1.0 for f in fractions), fractions
    assert fractions[-1] == pytest.approx(1.0)
    # At least one tick names the formatting stage, so the label is informative.
    assert any("Formatting" in (m.get("message") or "") for m in markers), markers


def test_chunked_formatting_is_byte_identical_to_monolithic():
    """Chunking exists only to make progress reportable — it must not change a
    single byte of any format's output, or every exported file silently shifts."""
    n = main._TEXT_EXPORT_CHUNK_ROWS + 5_000
    pts = np.random.default_rng(7).uniform(-50, 50, (n, 3))
    cols = np.random.default_rng(8).uniform(0, 1, (n, 3)).astype(np.float32)
    inten = np.random.default_rng(9).uniform(0, 1, n).astype(np.float32)

    for fmt in ("xyz", "txt", "csv", "ply", "obj"):
        mono = main._format_points_as_text(fmt, pts, cols, inten, progress=None)
        ticks = []
        chunked = main._format_points_as_text(
            fmt, pts, cols, inten, progress=lambda f, m: ticks.append(f))
        assert mono == chunked, f"{fmt} output changed when chunked"
        assert len(ticks) >= 2, f"{fmt} did not report progress ({ticks})"


def test_cancel_during_formatting_stops_before_writing_the_file(make_file_session, tmp_path):
    """A cancelled export must leave NO partial file.

    The subtlety this guards: the progress reporter's __call__ only queues a
    marker — it never raises. So the per-chunk formatting loop has to poll the
    cancel flag itself, or a cancel would not land until formatting finished,
    which for a large export is the whole operation. Cancellation must also fire
    BEFORE the write, so no truncated file is left on disk.
    """
    n = main._TEXT_EXPORT_CHUNK_ROWS * 3
    pts = np.random.default_rng(11).uniform(-10, 10, (n, 3))
    src = tmp_path / "cancel_me.xyz"
    with open(src, "w") as f:
        f.write("# x y z\n")
        np.savetxt(f, pts, fmt="%.6f")

    dest = tmp_path / "should_not_exist.xyz"

    class _Reporter:
        """Stands in for _ProgressReporter: queues (never raises) and reports
        cancellation once formatting is genuinely underway."""
        def __init__(self):
            self.calls = 0
        def __call__(self, fraction, message):
            self.calls += 1
        def should_cancel(self):
            return self.calls >= 2  # cancel partway through, not immediately

    reporter = _Reporter()
    request = main.PointCloudExportRequest(
        source=main.PointSource(session_id=make_file_session(src, "x y z")),
        format="xyz",
        dest_path=str(dest),
    )
    with pytest.raises(main.ScanCancelled):
        main._do_point_cloud_export(request, progress=reporter)

    assert not dest.exists(), "a cancelled export must not leave a partial file"
    # And it stopped early rather than formatting everything first.
    assert reporter.calls < n // main._TEXT_EXPORT_CHUNK_ROWS + 5


def test_text_formatting_matches_the_previous_implementation(git_reference_formatter):
    """The fast formatter must be byte-identical to the np.savetxt version.

    `_savetxt` deliberately does NOT use np.savetxt: that loops row-by-row in
    Python (~4 M interpreter calls per 1 M rows), so its cost is per-row dispatch
    rather than the formatting itself. One `%` over a whole chunk does the same
    conversion in a single C-level call — measured 2x faster and 13x lower peak
    RSS on 8 M points. Exported files ARE the product, so "faster" is only
    acceptable if the bytes are identical.

    The reference is the real previous implementation, lifted from git, rather
    than a hand-rebuilt equivalent — a rebuilt one would re-derive the same
    headers/prefixes and could agree with a bug. Sizes bracket the chunk
    boundary (plus empty / single-row), which is exactly where a chunk-join
    off-by-one newline would hide.
    """
    rng = np.random.default_rng(5)
    chunk = main._TEXT_EXPORT_CHUNK_ROWS

    for n in (0, 1, 999, chunk, chunk + 1, chunk * 2 + 7):
        pts = rng.uniform(-100, 100, (n, 3))
        colors = rng.uniform(0, 1, (n, 3)).astype(np.float32)
        intensity = rng.uniform(0, 1, n).astype(np.float32)
        for fmt in ("xyz", "txt", "csv", "ply", "obj"):
            expected = git_reference_formatter(fmt, pts, colors, intensity)
            produced = main._format_points_as_text(fmt, pts, colors, intensity)
            assert produced == expected, f"{fmt} n={n}: output diverged from np.savetxt"


def test_text_formatting_beats_the_row_by_row_implementation(git_reference_formatter):
    """Guards the optimisation itself: the fast path must stay faster.

    Asserts a RELATIVE speedup against the frozen np.savetxt implementation
    rather than an absolute rows/s figure. An absolute threshold either fails on
    slow CI hardware or (as a first attempt here did) sits so far below the
    regression point that reverting to np.savetxt still passes it. Timing both
    implementations back-to-back on the same machine cancels that out.

    The bar is 1.4x against a measured ~2.0x, leaving headroom for a noisy
    shared runner while still failing outright if the row-by-row loop returns.
    """
    n = 400_000
    pts = np.random.default_rng(3).uniform(-100, 100, (n, 3))

    # Warm both paths so neither pays one-off import/allocation costs.
    git_reference_formatter("xyz", pts[:1000], None, None)
    main._format_points_as_text("xyz", pts[:1000], None, None)

    t0 = time.perf_counter()
    old = git_reference_formatter("xyz", pts, None, None)
    t_old = time.perf_counter() - t0

    t0 = time.perf_counter()
    new = main._format_points_as_text("xyz", pts, None, None)
    t_new = time.perf_counter() - t0

    assert new == old, "the fast path must produce identical bytes"
    speedup = t_old / t_new
    assert speedup > 1.4, (
        f"formatting is only {speedup:.2f}x the row-by-row implementation "
        f"({t_new:.3f}s vs {t_old:.3f}s) — a per-row Python loop "
        "(e.g. np.savetxt) was likely reintroduced."
    )


def test_streaming_writer_matches_the_string_formatter_byte_for_byte():
    """The `dest_path` path streams chunks to disk instead of building one string.

    That is what keeps a 25 M-point export from holding a 780 MB string (plus a
    transient copy of the same size while joining chunks). The two writers share
    `_text_export_layout`, but they assemble headers and the trailing newline
    separately — which is exactly where they could silently drift, so pin them
    against each other at the chunk boundaries.
    """
    chunk = main._TEXT_EXPORT_CHUNK_ROWS
    rng = np.random.default_rng(9)

    for n in (0, 1, 999, chunk, chunk + 1, chunk * 2 + 7):
        pts = rng.uniform(-100, 100, (n, 3))
        colors = rng.uniform(0, 1, (n, 3)).astype(np.float32)
        intensity = rng.uniform(0, 1, n).astype(np.float32)

        for fmt in ("xyz", "txt", "csv", "ply", "obj"):
            import tempfile
            expected = main._format_points_as_text(fmt, pts, colors, intensity)
            path = Path(tempfile.mktemp(suffix=f".{fmt}"))
            try:
                main._write_points_as_text(path, fmt, pts, colors, intensity)
                assert path.read_text(encoding="utf-8") == expected, (
                    f"{fmt} n={n}: streamed file differs from the string formatter"
                )
            finally:
                if path.exists():
                    path.unlink()


def test_a_failed_stream_leaves_no_file_at_the_destination(tmp_path):
    """A partial write must never appear at the user's chosen path.

    Streaming puts bytes on disk before the export finishes, so a cancel or
    crash mid-write would otherwise leave a TRUNCATED file that looks like a
    completed export. The writer builds a `.part` sibling and renames only on
    success; this drives a failure partway through and checks both are gone.
    """
    n = main._TEXT_EXPORT_CHUNK_ROWS * 2
    pts = np.random.default_rng(4).uniform(-10, 10, (n, 3))
    dest = tmp_path / "out.xyz"

    calls = {"n": 0}

    def exploding_progress(fraction, message):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise main.ScanCancelled()

    with pytest.raises(main.ScanCancelled):
        main._write_points_as_text(dest, "xyz", pts, None, None,
                                   progress=exploding_progress)

    assert not dest.exists(), "a failed export must not leave a file at the destination"
    assert not (tmp_path / "out.xyz.part").exists(), "the temp file must be cleaned up"


def test_the_destination_is_never_a_partial_file_mid_write(tmp_path):
    """The destination path must not exist until the export is COMPLETE.

    Cleaning up after a failure is not enough: while the write is in flight the
    user's chosen path must still be absent, or another process (or the user)
    can observe a truncated file that looks finished. This is what the
    write-to-`.part`-then-rename gives, and it is why simply unlinking on error
    would not be equivalent — that leaves a window where `dest` is partial.
    """
    n = main._TEXT_EXPORT_CHUNK_ROWS * 3
    pts = np.random.default_rng(6).uniform(-10, 10, (n, 3))
    dest = tmp_path / "out.xyz"

    seen = {"dest_existed_mid_write": False, "ticks": 0}

    def watching_progress(fraction, message):
        seen["ticks"] += 1
        if fraction < 1.0 and dest.exists():
            seen["dest_existed_mid_write"] = True

    main._write_points_as_text(dest, "xyz", pts, None, None,
                               progress=watching_progress)

    assert seen["ticks"] >= 2, "expected several chunks for this size"
    assert not seen["dest_existed_mid_write"], (
        "the destination existed while the export was still writing — a reader "
        "would see a truncated file. Write to a temp sibling and rename."
    )
    assert dest.exists() and dest.stat().st_size > 0


def test_las_export_reports_progress_through_its_assembly_stages(client, make_file_session, tmp_path):
    """LAS/LAZ must report progress across the whole export, not just at the end.

    The reported bug: the pill sat at 2% "Reading points" for most of a large
    LAS/LAZ export, then jumped straight to 90% "Writing file". Assembling a LAS
    is vectorised but NOT free — at 25 M points the header/bounds, the quantising
    x/y/z assignment and the colour scaling total ~4 s, all of which used to run
    between those two markers with nothing emitted. Only `laspy.write()` is a
    genuinely opaque call, and it is a minority of the time.

    Asserts the SHAPE of the reporting (several distinct advancing stages), not
    timings, so it holds on any hardware.
    """
    from tests.binframe import decode_progress_markers

    n = 60_000
    pts = np.random.default_rng(12).uniform(-10, 10, (n, 3))
    src = tmp_path / "cloud.xyz"
    with open(src, "w") as f:
        f.write("# x y z\n")
        np.savetxt(f, pts, fmt="%.6f")

    for fmt in ("las", "laz"):
        dest = tmp_path / f"out.{fmt}"
        resp = client.post("/api/pointcloud/export", json={
            "source": {"session_id": make_file_session(src, "x y z")},
            "format": fmt,
            "dest_path": str(dest),
        })
        assert resp.status_code == 200, resp.text
        body = decode_streamed_json(resp.content)
        assert body["success"] is True, body
        assert dest.is_file() and dest.stat().st_size > 0

        markers = decode_progress_markers(resp.content)
        fractions = [m["progress"] for m in markers if m.get("progress") is not None]

        # Several advancing stages, not just "start" and "writing".
        assert len(fractions) >= 4, f"{fmt}: too few progress stages: {fractions}"
        assert fractions == sorted(fractions), f"{fmt}: progress went backwards: {fractions}"
        assert fractions[-1] == pytest.approx(1.0), fractions

        # The old behaviour was a single leap from ~0.02 straight to ~0.9. Assert
        # no gap that large remains, which is what made it read as a hang.
        biggest = max(b - a for a, b in zip(fractions, fractions[1:]))
        assert biggest < 0.5, (
            f"{fmt}: progress jumps by {biggest:.0%} in one step "
            f"({fractions}) — an unreported stage was reintroduced"
        )

        # And the labels name real stages rather than repeating one message.
        messages = {m.get("message") for m in markers if m.get("message")}
        assert len(messages) >= 3, f"{fmt}: stage labels are not informative: {messages}"
