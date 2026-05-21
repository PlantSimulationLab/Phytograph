"""Health / version endpoint tests.

These guard the version-lock contract documented in CLAUDE.md: if the backend
version drifts from src/shared/constants.ts EXPECTED_BACKEND_VERSION, the
Electron supervisor refuses to start.
"""

import json
from pathlib import Path

import main


def test_root_returns_running_message_and_version(client):
    res = client.get("/")
    assert res.status_code == 200
    body = res.json()
    assert body["version"] == main.BACKEND_VERSION
    assert "running" in body["message"].lower()


def test_version_endpoint_shape(client):
    res = client.get("/version")
    assert res.status_code == 200
    assert res.json() == {"version": main.BACKEND_VERSION}


def test_health_endpoint_reports_healthy(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "healthy"
    assert body["version"] == main.BACKEND_VERSION


def test_backend_version_matches_frontend_constant():
    """Locks main.BACKEND_VERSION to src/shared/constants.ts EXPECTED_BACKEND_VERSION.

    This is the pair the Electron supervisor (src/main/backend.ts) actually
    enforces at runtime: a mismatch causes the supervisor to kill the port
    and respawn the bundled binary. If this fails, bump them together — see
    CLAUDE.md "Version-lock contract". (package.json version is part of the
    same contract but is not load-bearing for the supervisor; see the
    companion test below.)
    """
    repo_root = Path(__file__).resolve().parents[2]
    constants = (repo_root / "src" / "shared" / "constants.ts").read_text()

    import re
    m = re.search(r"EXPECTED_BACKEND_VERSION\s*=\s*['\"]([^'\"]+)['\"]", constants)
    assert m, "EXPECTED_BACKEND_VERSION not found in constants.ts"
    expected = m.group(1)
    assert main.BACKEND_VERSION == expected, (
        f"backend BACKEND_VERSION={main.BACKEND_VERSION} does not match "
        f"frontend EXPECTED_BACKEND_VERSION={expected}. See CLAUDE.md "
        f"version-lock contract."
    )


def test_package_json_version_matches_backend_version():
    """The third leg of the version-lock contract: package.json version.

    CLAUDE.md documents that all three (backend BACKEND_VERSION,
    EXPECTED_BACKEND_VERSION, package.json version) move together. Unlike
    the supervisor handshake, this one isn't enforced by code at runtime
    — but a drift means released installers ship with stale versioning.
    """
    repo_root = Path(__file__).resolve().parents[2]
    pkg = json.loads((repo_root / "package.json").read_text())
    assert pkg["version"] == main.BACKEND_VERSION, (
        f"package.json version={pkg['version']} does not match "
        f"backend BACKEND_VERSION={main.BACKEND_VERSION}. "
        f"See CLAUDE.md \"Version-lock contract\"."
    )
