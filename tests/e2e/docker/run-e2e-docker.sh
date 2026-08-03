#!/usr/bin/env bash
# Run the E2E suite (or any command) inside a headless-Linux container that
# mirrors CI's `heavy` job, so CI-only failures can be reproduced and debugged
# locally instead of through 45-minute round-trips.
#
#   tests/e2e/docker/run-e2e-docker.sh                      # whole suite
#   tests/e2e/docker/run-e2e-docker.sh tests/e2e/foo.spec.ts   # one spec
#   tests/e2e/docker/run-e2e-docker.sh --shell              # interactive shell
#
# DESIGN — why the layout is what it is:
#
#   * The repo is bind-mounted read-write at /work, so edits on the host are
#     visible immediately and traces/reports land back in the repo.
#   * BUT the Linux build artifacts must never overwrite the host's macOS ones.
#     node_modules, backend-api/venv, resources/phytograph_backend, dist-*,
#     pyhelios/pyhelios_build and PotreeConverter are therefore mounted as
#     named volumes that SHADOW the host paths. A Linux .node/.so landing in
#     the host's node_modules would break `npm run dev` on macOS immediately.
#   * Those volumes persist between runs, so the expensive native builds
#     (libhelios, the PyInstaller bundle) are paid for once.
#
# First run compiles Helios + the backend bundle and takes a while (tens of
# minutes under x86_64 emulation on Apple silicon). Later runs reuse the volumes.
#
# SCOPE — use this for TARGETED specs, not the whole suite.
#
# Under x86_64 emulation on Apple silicon this runs several times slower than
# CI's native runner, and the compute-heavy specs then blow their timeouts even
# with the machine to itself (measured at load average ~50 on 12 cores, 415%
# container CPU). Three that fail here and pass on real CI:
#
#     spec                          macOS    real CI    this container
#     crop-polygon.spec.ts:193      4.0s ✓   11.5s ✓    41.6s ✘
#     generate-dem.spec.ts:138      5.4s ✓   22.3s ✓    1.5m  ✘
#     helios-triangulate-sphere:20  30.5s ✓  45.4s ✓    53.2s ✘
#
# So a failure here is only evidence of a real bug once you have checked how the
# same spec behaves on CI — otherwise you are measuring the emulator. What this
# environment IS good for is reproducing a known CI-only failure and iterating on
# it in ~5 minutes instead of a 45-minute CI round trip; it reproduced eight of
# them exactly. Do NOT use it as a green/red gate for the full suite: run
# `npm run test:e2e` on the host for that, and let CI cover Linux.
#
# Also: do not run this at the same time as a host `npm run test:e2e`. Two
# 2-worker suites (four Electron apps + four backends) starve each other, and
# the resulting failures look like real ones — several came back in 55-182ms,
# far too fast to have run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE=phytograph-e2e-linux
VOL_PREFIX=phytograph-e2e

cd "$REPO_ROOT"

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not running (start Docker Desktop)" >&2
  exit 1
fi

echo "==> building image $IMAGE (linux/amd64)"
docker build --platform linux/amd64 -t "$IMAGE" tests/e2e/docker

# Named volumes shadowing host build output. See DESIGN above.
VOLUME_ARGS=(
  -v "${VOL_PREFIX}-node-modules:/work/node_modules"
  -v "${VOL_PREFIX}-venv:/work/backend-api/venv"
  # resources/ as a WHOLE (nothing under it is tracked): PyInstaller's COLLECT
  # stage does `Removing dir resources/phytograph_backend` before writing, and
  # you cannot rmdir a mount point — mounting the bundle dir itself fails the
  # build with "OSError: [Errno 16] Device or resource busy". Mounting the
  # parent keeps the bundle a plain directory the build can delete and recreate,
  # while still caching it (plus potree/) between runs.
  -v "${VOL_PREFIX}-resources:/work/resources"
  # NOTE: pyhelios/pyhelios_build/ is NOT purely generated — it holds three
  # submodule-tracked sources (CMakeLists.txt, cmake/PluginSelection.cmake,
  # main.cpp) next to the build tree. Shadowing the whole directory hides them
  # and the Helios build dies with "PyHelios build CMakeLists.txt not found".
  # Mount only the generated build/ subdirectory.
  -v "${VOL_PREFIX}-pyhelios-build:/work/pyhelios/pyhelios_build/build"
  -v "${VOL_PREFIX}-dist-main:/work/dist-main"
  -v "${VOL_PREFIX}-dist-preload:/work/dist-preload"
  -v "${VOL_PREFIX}-dist-renderer:/work/dist-renderer"
)

# -t only when stdin really is a terminal: passing it from a non-interactive
# caller (CI, a background job, a tool harness) fails with "the input device is
# not a TTY" before any of the work starts.
TTY_ARGS=()
if [ -t 0 ]; then TTY_ARGS=(-it); fi

# scripts/build-potree-converter.mjs calls the GitHub API (PR #686) and needs a
# token, exactly as CI's `env: GH_TOKEN` provides one. Borrow the host's gh
# credential rather than asking the user to export anything. Only needed on the
# first run in a fresh volume; after that the built binary is cached.
GH_ENV=()
if [ -z "${GH_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  GH_TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [ -n "${GH_TOKEN:-}" ]; then GH_ENV=(-e "GH_TOKEN=$GH_TOKEN"); fi

if [[ "${1:-}" == "--shell" ]]; then
  exec docker run --rm ${TTY_ARGS[@]+"${TTY_ARGS[@]}"} --platform linux/amd64 \
    -v "$REPO_ROOT:/work" "${VOLUME_ARGS[@]}" ${GH_ENV[@]+"${GH_ENV[@]}"} \
    -w /work "$IMAGE" /bin/bash
fi

SPECS=("$@")

exec docker run --rm ${TTY_ARGS[@]+"${TTY_ARGS[@]}"} --platform linux/amd64 \
  -v "$REPO_ROOT:/work" "${VOLUME_ARGS[@]}" ${GH_ENV[@]+"${GH_ENV[@]}"} \
  -w /work "$IMAGE" /bin/bash -lc '
set -euo pipefail

# --- one-time provisioning inside the persistent volumes -------------------
if [ ! -x node_modules/.bin/playwright ]; then
  echo "==> npm ci (first run in this volume)"
  npm ci
fi

if [ ! -x backend-api/venv/bin/python ]; then
  echo "==> creating python venv (first run in this volume)"
  python3.12 -m venv backend-api/venv
  backend-api/venv/bin/pip install --upgrade pip
  backend-api/venv/bin/pip install -r backend-api/requirements.txt pyinstaller
fi

# PYTHON must be ABSOLUTE: build-pyhelios.mjs spawns it from the pyhelios
# source dir, so a repo-relative path resolves against the wrong cwd and dies
# with a bare "spawnSync ... ENOENT".
VENV_PY=/work/backend-api/venv/bin/python

if [ ! -f pyhelios/pyhelios_build/build/lib/libhelios.so ]; then
  echo "==> building libhelios (slow, first run only)"
  PYTHON="$VENV_PY" node scripts/build-pyhelios.mjs --nogpu
fi

if [ ! -x resources/phytograph_backend/phytograph_backend ]; then
  echo "==> building PyInstaller backend bundle (slow, first run only)"
  PYTHON="$VENV_PY" npm run build:backend
fi

# PotreeConverter — CI builds this in its own step, and it is NOT optional:
# every octree import (the path almost every spec takes to get a cloud into the
# scene) calls create_cloud_session, which shells out to it. Without the
# linux-x64 binary the backend answers 503 and the import silently no-ops —
# the wizard still closes cleanly, so the only visible symptom is that the
# scan row never appears, which reads like a UI/timing bug rather than a
# missing dependency. The host tree only ever has its own platform build
# (e.g. darwin-arm64), so the Linux one must be built inside the container.
if [ ! -x resources/potree_converter/linux-x64/PotreeConverter ]; then
  echo "==> building PotreeConverter (slow, first run only)"
  node scripts/build-potree-converter.mjs
fi

echo "==> building renderer + main + preload"
npm run build

# --- run under xvfb at CI'"'"'s exact screen geometry ------------------------
# Start Xvfb EXPLICITLY rather than via `xvfb-run`, and call the local
# playwright binary rather than `npx playwright`. Both matter under x86_64
# emulation, and both fail the same misleading way — the run sits forever at
# "running E2E" with Xvfb up, no Electron, 0% CPU and no error, which reads
# exactly like the app failing to launch headless:
#   * `npx <bin>` contacts the npm registry before running an already-installed
#     binary, and that stalls indefinitely here.
#   * `xvfb-run` never execs its command at all: it ends up as PID 1 holding the
#     right argv with no child process. Starting Xvfb ourselves and exporting
#     DISPLAY is equivalent and actually runs.
echo "==> running E2E under xvfb (1920x1080x24)"
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 30); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 1; done
if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  echo "Xvfb failed to come up; log follows:" >&2; cat /tmp/xvfb.log >&2; exit 1
fi
export DISPLAY=:99
exec ./node_modules/.bin/playwright test '"${SPECS[*]:-}"'
'
