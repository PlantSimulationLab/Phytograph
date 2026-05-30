#!/usr/bin/env bash
# Convenience wrapper around scripts/build-pyhelios.mjs — builds the PyHelios
# native library from the source submodule and installs it editable.
#
# This exists so the backend's auto-rebuild staleness check (backend-api/main.py)
# and humans have a stable shell entry point; all the real logic (plugin
# selection, python resolution, verification) lives in the Node driver so there
# is a single source of truth across dev / build / CI.
#
# Usage: scripts/build_pyhelios.sh [--debug] [--clean]
# Prerequisites: Node, cmake, a C++ compiler, Python 3.10+ (Xcode CLT on macOS).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

exec node "$PROJECT_ROOT/scripts/build-pyhelios.mjs" "$@"
