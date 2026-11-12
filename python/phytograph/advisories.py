"""Machine-readable advisories: a stable code, a message, and the step.

An advisory is a result that passed a recipe's checks but deserves a look
(the app would show a warning toast). A harness that makes someone
acknowledge each one needs to match them by ``code``, which never changes
for a given condition; the ``message`` is for people and may be reworded.

Every code a recipe can emit is in :data:`ADVISORIES`. Warnings raised with
the :mod:`warnings` module while a recipe runs are captured into its record
too: a :class:`PhytographWarning` under its own ``code``, any other warning as
``python.warning`` with the category in the message. Deprecation warnings are
not recorded: they describe code, not results.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional

#: code -> what it means. A new code must be added here (a test enforces it).
ADVISORIES: Dict[str, str] = {
    "clean.noise_fraction_high":
        "More than 3% of points were flagged as noise; real scanner noise is 0.1-3%.",
    "ground.dem_sparse":
        "Fewer than half of the DEM cells have ground; consider fill_voids=True.",
    "inventory.tool_warning":
        "tree_inventory reported a warning (the message carries it).",
    "inventory.no_stem":
        "Some trees have no stem fitted: merged with a neighbour or occluded.",
    "qsm.inferred_radius":
        "Most cylinder radii come from the taper model, not from the points "
        "(surface coverage below the threshold).",
    "qsm.tree_failed":
        "The QSM failed for one tree; that tree is missing from the result.",
    "registration.zero_rmse":
        "ICP reported zero RMSE, which can mean the clouds do not overlap at all.",
    "registration.scene":
        "The registration's scene-type advisory (the message carries it).",
    "backend.warning":
        "A non-fatal warning from a backend tool (the message carries it).",
    "backend.quality_warning":
        "A backend tool's result-quality warning (the message carries it).",
    "backend.fusion_warning":
        "Tree segmentation found more than one trunk in a segment: trees merged, "
        "so the count is a minimum.",
    "backend.ground_warning":
        "Tree segmentation ran without usable ground labels.",
    "backend.cost_acknowledged":
        "A tool stopped at the backend's cost estimate and the script confirmed it "
        "automatically (confirm_costly=True); the message carries the estimate.",
    "python.warning":
        "A Python warning raised while the recipe ran (the category is in the message).",
}


@dataclass(frozen=True)
class Advisory:
    code: str
    message: str
    step: Optional[str] = None

    def __post_init__(self):
        if self.code not in ADVISORIES:
            raise ValueError(f"unregistered advisory code {self.code!r}; add it to ADVISORIES")

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def line(self) -> str:
        """One line for a log or stderr: ``PHYTOGRAPH ADVISORY [code] (step): message``.
        Newlines in the message are escaped so a parser can split on lines."""
        msg = self.message.replace("\\", "\\\\").replace("\r", "\\r").replace("\n", "\\n")
        step = f" ({self.step})" if self.step else ""
        return f"{STDERR_PREFIX} [{self.code}]{step}: {msg}"


STDERR_PREFIX = "PHYTOGRAPH ADVISORY"


class PhytographWarning(UserWarning):
    """A warning a recipe records under a stable advisory ``code``."""
    code = "python.warning"


class CostAcknowledgedWarning(PhytographWarning):
    """A tool's cost gate was confirmed automatically (``confirm_costly=True``)."""
    code = "backend.cost_acknowledged"


class QSMFailedWarning(PhytographWarning):
    """``tree_qsms``: one tree's QSM failed and is missing from the result."""
    code = "qsm.tree_failed"
