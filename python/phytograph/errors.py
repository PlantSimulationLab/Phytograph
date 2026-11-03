"""Exceptions raised by the Phytograph client."""
from __future__ import annotations

from typing import Any, Optional


class PhytographError(Exception):
    """A request the backend refused or a run that failed."""

    def __init__(self, message: str, *, status: Optional[int] = None, detail: Any = None):
        super().__init__(message)
        self.status = status
        self.detail = detail


class BackendNotFound(PhytographError):
    """No backend executable could be located."""


class BackendStartError(PhytographError):
    """The backend process did not come up."""


class VersionMismatch(PhytographError):
    """The backend speaks a different API version than this client."""


class Canceled(PhytographError):
    """The run was canceled (Ctrl-C, or `/api/cancel` from elsewhere)."""


class CostWarning(PhytographError):
    """The backend estimated the run is expensive and the client was created
    with ``confirm_costly=False``. ``detail`` holds the backend's estimate."""
