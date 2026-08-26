"""Shared pytest fixtures.

`main.py` lives in the parent directory; tests is a sibling. Add the parent
to sys.path so `import main` works without needing an editable install.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture(autouse=True)
def _riegl_image_stamp_is_current(monkeypatch):
    """Keep the RIEGL image-staleness probe out of the test machine's Docker.

    The probe shells out to `docker image inspect` to read the identity stamp
    off phytograph-riegl:latest. Tests that fake "the image is built" (by
    patching `_riegl_image_built`) must not then have the verdict swing on
    whether the machine running pytest happens to have a real image, and a
    hermetic suite must not shell out to a daemon at all.

    So the default is "the built image matches the sources on disk", which is
    what every pre-existing test means by "built". A test about staleness itself
    overrides this with its own monkeypatch — see test_riegl_status.py.
    """
    import main

    monkeypatch.setattr(
        main, "_riegl_image_stamp", lambda: main._riegl_expected_stamp()
    )


@pytest.fixture(scope="session")
def client():
    """FastAPI TestClient bound to the real app. No mocks."""
    from fastapi.testclient import TestClient
    import main

    return TestClient(main.app)


@pytest.fixture
def cylinder_points() -> np.ndarray:
    """A thin vertical cylinder, r=0.3, h=1.5, 60 points (matches tests/e2e/fixtures/tiny.xyz)."""
    pts = []
    for ring in range(5):
        z = ring * 0.375
        for k in range(12):
            theta = k * (2 * np.pi / 12)
            pts.append([0.3 * np.cos(theta), 0.3 * np.sin(theta), z])
    return np.array(pts, dtype=np.float64)


@pytest.fixture
def make_file_session():
    """Register a real in-RAM CloudSession from a point-cloud file, WITHOUT
    building an octree, and return its session_id.

    Downstream compute/export endpoints refuse a file-only `source` — a cloud is
    read from disk once at import, and its session arrays are the source of truth
    thereafter (see `_read_points_from_source`). Tests that exercise those
    endpoints therefore need a session, but `/api/cloud/session/create` also runs
    PotreeConverter, which many of these tests deliberately avoid depending on.

    This builds the same session the import would (positions + colours +
    intensity + extras, read through the SAME `_load_pointcloud_arrays` loader),
    minus the derived octree cache. Sessions are removed again at teardown so
    they don't leak between tests.
    """
    import time
    import uuid
    import numpy as np
    import main

    created: list = []

    def _make(source_path, ascii_format=None, extras=None):
        positions, colors, intensity = main._load_pointcloud_arrays(
            str(source_path), ascii_format
        )
        n = len(positions)
        sess = main.CloudSession(
            session_id=uuid.uuid4().hex,
            source_path=str(source_path),
            ascii_format=ascii_format,
            column_plan=None,
            positions=np.asarray(positions, dtype=np.float64),
            # The session stores colours/intensity at LAS uint16 scale; the
            # loader returns 0-1 floats, so scale up to match a real import.
            colors=(np.clip(np.asarray(colors), 0, 1) * 65535).astype(np.uint16)
            if colors is not None else None,
            intensity=(np.clip(np.asarray(intensity), 0, 1) * 65535).astype(np.uint16)
            if intensity is not None else None,
            extras=dict(extras or {}),
            extra_dims_meta=[],
            deleted=np.zeros(n, dtype=bool),
            deleted_history=[],
            octree_cache_id=None,
            created_at=time.time(),
        )
        with main._cloud_session_lock:
            main._cloud_sessions[sess.session_id] = sess
        created.append(sess.session_id)
        return sess.session_id

    yield _make

    with main._cloud_session_lock:
        for sid in created:
            main._cloud_sessions.pop(sid, None)


@pytest.fixture(scope="session")
def git_reference_formatter():
    """The `_format_points_as_text` implementation as committed at HEAD.

    Lets a test pin the current (optimised) formatter against the real previous
    one byte-for-byte, rather than against a hand-rebuilt equivalent that could
    re-derive the same mistake.

    Reads the blob through `dulwich`-free plumbing: a plain `git show` subprocess
    segfaults once this process has loaded the native stack (open3d/pyhelios), so
    the file is recovered by shelling out BEFORE those are imported is not an
    option either — instead we read the committed copy that `conftest` stashes on
    disk at collection time. Falls back to skipping when it isn't available.
    """
    import ast
    import typing

    import numpy as np

    ref_path = BACKEND_DIR / "tests" / "_reference_format_points.py"
    if not ref_path.is_file():
        pytest.skip(
            "reference formatter snapshot missing — regenerate with:\n"
            "  git show HEAD:backend-api/main.py > /tmp/h.py && "
            "python backend-api/tests/_make_reference.py /tmp/h.py"
        )

    src = ref_path.read_text(encoding="utf-8")
    ns = {"np": np, "Optional": typing.Optional}
    exec(compile(ast.parse(src), str(ref_path), "exec"), ns)
    return ns["_format_points_as_text"]
