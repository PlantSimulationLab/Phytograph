"""`docker run` refused by a transient image-store race is retried.

Reported from the packaged app: Docker Desktop had just started, the stale-image
heal rebuilt the reader image, and the `docker run` in that same second failed
with exit 125 and

    apply layer error for "": failed to prepare extraction snapshot ...:
    NotFound: parent snapshot sha256:... does not exist: not found

while the identical run a minute later worked. The container never started, so
re-running it is safe; these tests drive the real spawn path with a fake docker
CLI that fails that way a set number of times.
"""

import json
import os

import pytest

import main

_RACE = (
    'docker: Error response from daemon: apply layer error for "": failed to '
    'prepare extraction snapshot "extract-738528343-AE3J sha256:dde7": '
    "NotFound: parent snapshot sha256:8f2a does not exist: not found"
)


def _fake_docker(tmp_path, monkeypatch, *, races, then_stdout="", then_exit=0,
                 then_stderr=""):
    """A docker CLI that fails `races` times with the race, then behaves."""
    if not hasattr(os, "posix_spawn"):
        pytest.skip("POSIX-only")
    counter = tmp_path / "calls"
    counter.write_text("0")
    script = tmp_path / "fake-docker"
    script.write_text(f"""#!/bin/sh
n=$(cat '{counter}'); n=$((n+1)); echo $n > '{counter}'
if [ $n -le {races} ]; then echo '{_RACE}' 1>&2; exit 125; fi
printf '%s' '{then_stdout}'
echo '{then_stderr}' 1>&2
exit {then_exit}
""")
    script.chmod(0o755)
    monkeypatch.setenv("PHYTOGRAPH_RIEGL_RUNTIME", "docker")
    monkeypatch.setattr(main, "_docker_exe", lambda: str(script))
    monkeypatch.setattr(main, "_RIEGL_START_RACE_RETRY_DELAYS_S", (0.0, 0.0))
    return lambda: int(counter.read_text())


def test_classifier_is_narrow():
    assert main._is_docker_start_race(125, _RACE)
    # Same text, but the container ran: not a refusal to start.
    assert not main._is_docker_start_race(1, _RACE)
    # Other exit-125 failures are real and must surface immediately.
    assert not main._is_docker_start_race(
        125, "docker: Error response from daemon: invalid mount config"
    )
    assert not main._is_docker_start_race(
        125, "Unable to find image 'phytograph-riegl:latest' locally"
    )


def test_inspect_retries_then_returns_the_reader_output(tmp_path, monkeypatch):
    doc = json.dumps({"scans": [{"name": "ScanPos001"}]})
    calls = _fake_docker(tmp_path, monkeypatch, races=2, then_stdout=doc)
    out = main._run_riegl_container(["inspect", "/project"],
                                    [(str(tmp_path), "/project", "ro")],
                                    timeout_s=60.0)
    assert json.loads(out) == {"scans": [{"name": "ScanPos001"}]}
    assert calls() == 3


def test_inspect_gives_up_with_the_docker_error(tmp_path, monkeypatch):
    calls = _fake_docker(tmp_path, monkeypatch, races=99)
    with pytest.raises(main.HTTPException) as exc:
        main._run_riegl_container(["inspect", "/project"],
                                  [(str(tmp_path), "/project", "ro")],
                                  timeout_s=60.0)
    assert calls() == 3
    assert "parent snapshot" in exc.value.detail
    assert "Restarting Docker Desktop" in exc.value.detail


def test_other_exit_125_is_not_retried(tmp_path, monkeypatch):
    calls = _fake_docker(tmp_path, monkeypatch, races=0, then_exit=125,
                         then_stderr="docker: invalid mount config")
    with pytest.raises(main.HTTPException) as exc:
        main._run_riegl_container(["inspect", "/project"],
                                  [(str(tmp_path), "/project", "ro")],
                                  timeout_s=60.0)
    assert calls() == 1
    assert "invalid mount config" in exc.value.detail


def test_stream_retries_and_reports_the_childs_own_failure(tmp_path, monkeypatch):
    """The import path. Before this, a container docker refused to start was
    reported as "stream ended early" -- the docker error never surfaced."""
    calls = _fake_docker(tmp_path, monkeypatch, races=1, then_exit=3,
                         then_stderr="READER_BLEW_UP")
    out = tmp_path / "out"
    out.mkdir()
    with pytest.raises(main.HTTPException) as exc:
        main._stream_riegl_container(["stream", "/project", "--out", "/out"],
                                     [(str(tmp_path), "/project", "ro"),
                                      (str(out), "/out", "rw")],
                                     out, timeout_s=60.0)
    assert calls() == 2
    assert "exit 3" in exc.value.detail
    assert "READER_BLEW_UP" in exc.value.detail
