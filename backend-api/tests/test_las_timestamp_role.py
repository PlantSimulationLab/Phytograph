"""The LAS time dimension must be detected as the canonical `timestamp` role.

`role_for` in `_preview_las` mapped only x/y/z/rgb/intensity and let everything
else fall through to 'extra'. So a LAS/LAZ whose per-point times live in the
STANDARD `gps_time` dimension imported with no `timestamp` column at all — the
wizard offered an opaque `gps_time` scalar, and Backfill Misses then refused the
scan ("no column 'timestamp'") even though it plainly had per-point times.

The collision case is the subtle one: Phytograph itself used to export real
times in a float32 `timestamp` EXTRA dim while leaving the standard gps_time
field at zero. Both columns then claim the role, and the wizard's first-wins
dedup would let the all-zero standard dimension win and demote the real column
to 'skip' — importing zeros. The explicit column has to take precedence.
"""

import laspy
import numpy as np
import pytest

import main


def _roles(path):
    cols = main._preview_las(str(path), 3).model_dump()["columns"]
    return {c["header_name"]: c["detected_role"] for c in cols}


def _base_header():
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    return header


def test_standard_gps_time_is_the_timestamp_role(tmp_path):
    """The plain case: times in the standard dimension, no extra dim."""
    las = laspy.LasData(_base_header())
    las.x = np.array([0.1, 0.2, 0.3])
    las.y = np.array([0.1, 0.2, 0.3])
    las.z = np.array([0.1, 0.2, 0.3])
    las.gps_time = np.array([85.15, 132.07, 233.57])
    p = tmp_path / "std.las"
    las.write(str(p))

    assert _roles(p)["gps_time"] == "timestamp"


def test_explicit_timestamp_extra_dim_wins_over_gps_time(tmp_path):
    """Phytograph's own historical export shape: real times in a float32
    `timestamp` extra dim, standard gps_time left at zero.

    Exactly one column may claim the role, and it must be the one holding data —
    otherwise the wizard's first-wins dedup imports the zeros.
    """
    header = _base_header()
    header.add_extra_dim(laspy.ExtraBytesParams(name="timestamp", type=np.float32))
    las = laspy.LasData(header)
    las.x = np.array([0.1, 0.2, 0.3])
    las.y = np.array([0.1, 0.2, 0.3])
    las.z = np.array([0.1, 0.2, 0.3])
    las.gps_time = np.zeros(3)                       # degenerate, as exported
    las.timestamp = np.array([85.15, 132.07, 233.57], dtype=np.float32)
    p = tmp_path / "both.las"
    las.write(str(p))

    roles = _roles(p)
    assert roles["timestamp"] == "timestamp"
    assert roles["gps_time"] == "extra", "the all-zero standard dim must not claim the role"
    # Exactly one claimant, or the wizard demotes the loser to 'skip'.
    assert sum(1 for r in roles.values() if r == "timestamp") == 1


def test_timestamp_extra_dim_alone_is_the_timestamp_role(tmp_path):
    """A file with only the extra dim (no usable standard field)."""
    header = _base_header()
    header.add_extra_dim(laspy.ExtraBytesParams(name="timestamp", type=np.float32))
    las = laspy.LasData(header)
    las.x = np.array([0.1, 0.2])
    las.y = np.array([0.1, 0.2])
    las.z = np.array([0.1, 0.2])
    las.timestamp = np.array([85.15, 233.57], dtype=np.float32)
    p = tmp_path / "extra.las"
    las.write(str(p))

    assert _roles(p)["timestamp"] == "timestamp"


def test_other_dims_are_untouched(tmp_path):
    """The new branch must not steal roles from anything else."""
    las = laspy.LasData(_base_header())
    las.x = np.array([0.1]); las.y = np.array([0.1]); las.z = np.array([0.1])
    roles = _roles(tmp_path / "plain.las") if False else None
    p = tmp_path / "plain.las"
    las.write(str(p))
    roles = _roles(p)
    assert roles["X"] == "x" and roles["Y"] == "y" and roles["Z"] == "z"
    assert roles["intensity"] == "intensity"
    assert roles["classification"] == "extra"
