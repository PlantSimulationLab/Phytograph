"""LocalRequestGuard: the backend only answers this app.

The backend reads and overwrites any path the user can, so a request reaching
it is as good as local file access. These send what a browser would send for
each attack (a rebound Host, a foreign Origin) to the real app, and assert on
the effect as well as the status: the file must actually be unread/unchanged.
"""
import json

import pytest
from fastapi.testclient import TestClient

import main


LOCAL = "http://127.0.0.1:18000"


@pytest.fixture
def local(monkeypatch):
    monkeypatch.delenv("PHYTOGRAPH_BACKEND_TOKEN", raising=False)
    monkeypatch.delenv("PHYTOGRAPH_EXTRA_ALLOWED_HOSTS", raising=False)
    return TestClient(main.app, base_url=LOCAL)


@pytest.fixture
def secret_file(tmp_path):
    f = tmp_path / "secret.txt"
    f.write_text("1.0 2.0 3.0\n4.0 5.0 6.0\n")
    return f


def _preview(client, path, **headers):
    return client.post("/api/pointcloud/preview", json={"file_path": str(path)}, headers=headers)


def _export_over(client, path, **headers):
    return client.post("/api/pointcloud/export", headers=headers, json={
        "points": [[0.0, 0.0, 0.0]], "format": "las", "filename": "x", "dest_path": str(path)})


def test_a_rebound_domain_cannot_read_a_file(local, secret_file):
    res = _preview(local, secret_file, host="evil.example:18000")
    assert res.status_code == 403
    assert "1.0" not in res.text


def test_a_rebound_domain_cannot_overwrite_a_file(local, secret_file):
    before = secret_file.read_bytes()
    assert _export_over(local, secret_file, host="evil.example:18000").status_code == 403
    assert secret_file.read_bytes() == before


def test_a_name_merely_starting_with_a_loopback_name_is_refused(local, secret_file):
    assert _preview(local, secret_file, host="localhost.evil.example").status_code == 403
    assert _preview(local, secret_file, host="127.0.0.1.evil.example:80").status_code == 403


@pytest.mark.parametrize("host", ["127.0.0.1:18000", "localhost:18000", "[::1]:18000", "[::1]", "localhost"])
def test_loopback_hosts_pass(local, host):
    assert local.get("/health", headers={"host": host}).status_code == 200


@pytest.mark.parametrize("origin", [
    "https://evil.example",
    "null",                      # what a sandboxed iframe on any website sends
    "http://localhost:3000",     # some other local web server's page
    "http://127.0.0.1:3000",
])
def test_a_foreign_origin_cannot_run_a_request(local, secret_file, origin):
    """CORS would only hide the response. The write has to not happen."""
    before = secret_file.read_bytes()
    res = _export_over(local, secret_file, origin=origin)
    assert res.status_code == 403
    assert "access-control-allow-origin" not in res.headers
    assert secret_file.read_bytes() == before


def test_the_packaged_renderer_origin_passes(local):
    res = local.get("/api/token-check", headers={"origin": "file://"})
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == "file://"


def test_the_dev_renderer_origin_passes_only_on_its_own_port(local, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_RENDERER_PORT", "15123")
    assert local.get("/api/token-check", headers={"origin": "http://localhost:15123"}).status_code == 200
    assert local.get("/api/token-check", headers={"origin": "http://localhost:15124"}).status_code == 403


def test_a_foreign_preflight_is_refused_and_ours_may_send_the_token(local):
    ask = {"access-control-request-method": "POST", "access-control-request-headers": "x-phytograph-token"}
    assert local.options("/api/pointcloud/export", headers={"origin": "https://evil.example", **ask}).status_code == 400
    ok = local.options("/api/pointcloud/export", headers={"origin": "file://", **ask})
    assert ok.status_code == 200
    assert "x-phytograph-token" in ok.headers["access-control-allow-headers"].lower()


class TestToken:
    @pytest.fixture(autouse=True)
    def _token(self, local, monkeypatch):
        monkeypatch.setenv("PHYTOGRAPH_BACKEND_TOKEN", "s3cret")

    def test_no_token_cannot_read_a_file(self, local, secret_file):
        res = _preview(local, secret_file)
        assert res.status_code == 401
        assert "1.0" not in res.text

    def test_wrong_token_cannot_overwrite_a_file(self, local, secret_file):
        before = secret_file.read_bytes()
        assert _export_over(local, secret_file, **{"x-phytograph-token": "wrong"}).status_code == 401
        assert secret_file.read_bytes() == before

    def test_right_token_reaches_the_endpoint(self, local, secret_file):
        res = _preview(local, secret_file, **{"x-phytograph-token": "s3cret"})
        assert res.status_code not in (401, 403), res.text
        assert local.get("/api/token-check", headers={"x-phytograph-token": "s3cret"}).status_code == 200

    def test_a_refusal_is_readable_by_our_renderer(self, local):
        """Otherwise it surfaces as a bare 'Failed to fetch'."""
        res = local.get("/api/token-check", headers={"origin": "file://"})
        assert res.status_code == 401
        assert res.headers["access-control-allow-origin"] == "file://"
        assert "token" in json.loads(res.text)["detail"]

    @pytest.mark.parametrize("path", ["/health", "/version"])
    def test_launch_probes_need_no_token_but_still_need_a_local_host(self, local, path):
        assert local.get(path).status_code == 200
        assert local.get(path, headers={"host": "evil.example"}).status_code == 403
