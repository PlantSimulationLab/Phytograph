"""The backend's canonical roles and the wizard's dropdown must not drift.

Phase 4 of the scalar-roles work. The two lists are maintained in different
languages and files:

  - `main._CANONICAL_NAME_ALIASES` — what the importer can RESOLVE a column to.
  - `ROLE_OPTIONS` in PointCloudImportWizard.tsx — what the user can CHOOSE.

Merging them into one generated artifact was considered and rejected: the
renderer list also carries display labels and the generic 'extra'/'label'/'skip'
tokens, which have no place in a name→slug table. Instead this test pins the
invariant that actually matters — every canonical role is offerable, and the
wizard offers nothing the backend cannot honour.

Without this, adding a role on one side is silent: a backend-only role can never
be picked, and a renderer-only role produces an override the importer ignores,
which is precisely the class of mismatch that made `timestamp` unreachable.
"""

import re
from pathlib import Path

import pytest

import main

_WIZARD = (Path(__file__).resolve().parents[2]
           / "src/renderer/components/PointCloudImportWizard.tsx")

# Roles that exist only in the wizard, by design.
#   extra/label — how the renderer COLOURS a scalar (gradient vs discrete);
#                 not a canonical slug, and never sent as an override.
#   skip        — a dropped column; travels in `droppedSlugs`.
#   r/g/b       — the wizard exposes plain channels and handles 0-255 vs 0-1
#                 with a separate per-scan toggle, so the backend's r255/g255/
#                 b255 fold onto these (see `_canonicalise_exclusive_role`).
_WIZARD_ONLY = {"extra", "label", "skip", "r", "g", "b"}
# The backend-side spellings those RGB roles correspond to.
_BACKEND_RGB = {"r255", "g255", "b255"}


def _wizard_roles() -> set:
    src = _WIZARD.read_text(encoding="utf-8")
    block = src.split("const ROLE_OPTIONS")[1].split("];")[0]
    roles = set(re.findall(r"value: '([a-z_0-9]+)'", block))
    assert roles, "could not parse ROLE_OPTIONS — did the declaration change?"
    return roles


def test_every_canonical_role_is_offerable():
    """A role the importer can resolve to but the wizard never offers is
    unreachable for any file whose column name we fail to auto-detect."""
    backend = set(main._CANONICAL_NAME_ALIASES) - _BACKEND_RGB
    missing = backend - _wizard_roles()
    assert not missing, (
        f"canonical role(s) {sorted(missing)} are not in ROLE_OPTIONS, so a user "
        "cannot assign them to an unrecognised column")


def test_wizard_offers_nothing_the_backend_cannot_honour():
    """A role the wizard offers but the importer does not know produces an
    override that is silently ignored — the user picks it and nothing happens."""
    extra = _wizard_roles() - set(main._CANONICAL_NAME_ALIASES) - _WIZARD_ONLY
    assert not extra, (
        f"ROLE_OPTIONS offers {sorted(extra)}, which _CANONICAL_NAME_ALIASES "
        "does not define — the override would be dropped on the floor")


def test_rgb_convention_is_intact():
    """The one deliberate spelling difference. If the backend ever stops folding
    r255→r, the wizard's plain r/g/b would stop resolving."""
    for plain, wide in (("r", "r255"), ("g", "g255"), ("b", "b255")):
        assert wide in main._CANONICAL_NAME_ALIASES
        assert main._canonicalise_exclusive_role(wide) == plain


@pytest.mark.parametrize("role", sorted(
    set(main._CANONICAL_NAME_ALIASES) - _BACKEND_RGB - {"x", "y", "z"}))
def test_each_assignable_role_survives_an_override(role):
    """Every role a user can pick must actually rename a column (or, for
    timestamp, be reported for promotion). A role in the table that no override
    path handles would be a dead menu entry."""
    import numpy as np
    extras = {"src": np.array([1.0, 2.0], dtype=np.float32)}
    meta = [{"slug": "src", "label": "src"}]
    e, m, ts = main._apply_role_overrides(extras, meta, {"src": role})
    if role == "timestamp":
        assert ts == "src", "timestamp override was not reported to the caller"
    else:
        assert role in e, f"override to {role!r} did not rename the column"
        assert {x["slug"] for x in m} == set(e), "extras/meta fell out of lockstep"
