# The backend API version this client speaks. Must equal BACKEND_VERSION in
# backend-api/main.py, EXPECTED_BACKEND_VERSION in src/shared/constants.ts and
# "version" in package.json and python/pyproject.toml — the version-lock contract
# (CLAUDE.md). `test_version_lock_quintet` in python/tests/test_backend.py pins all five.
EXPECTED_BACKEND_VERSION = "0.97.0"
__version__ = EXPECTED_BACKEND_VERSION
