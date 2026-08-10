"""Frozen snapshot of `_format_points_as_text` as it was BEFORE the formatting
optimisation (np.savetxt, row-by-row).

Used by test_text_formatting_matches_the_previous_implementation to prove the
faster formatter is byte-identical. Kept as a snapshot rather than read from git
at test time because a `git` subprocess segfaults once the native stack
(open3d/pyhelios) is loaded in-process.

Do NOT "fix" or optimise this file — its whole value is being the old behaviour.
"""
from typing import Optional

import numpy as np


def _format_points_as_text(
    fmt: str,
    points: np.ndarray,
    colors: Optional[np.ndarray],
    intensity: Optional[np.ndarray],
) -> str:
    """Format an (N,3) point array (+ optional 0-1 colors, intensity) as XYZ /
    TXT / CSV / PLY / OBJ text. Column conventions match the renderer's flat
    text export exactly: 6-decimal positions, colors as 0-255 ints, intensity
    4-decimal.

    Vectorised with `np.savetxt` rather than a per-point Python f-string loop —
    on a multi-million-point octree cloud the old loop dominated export time and
    held the whole formatted string list in RAM. Output is byte-identical to the
    previous loop (same precision, separators, headers, and no trailing newline).
    """
    import io

    n = len(points)
    has_colors = colors is not None and len(colors) == n
    has_int = intensity is not None and len(intensity) == n
    rgb = np.clip(np.rint(colors * 255.0), 0, 255).astype(int) if has_colors else None

    def _savetxt(cols: list, fmts: list, sep: str) -> str:
        """np.savetxt the column-stacked `cols` with per-column `fmts`, joined by
        `sep`, returning the body WITHOUT the trailing newline savetxt appends."""
        buf = io.StringIO()
        np.savetxt(buf, np.column_stack(cols), fmt=sep.join(fmts), delimiter=sep)
        return buf.getvalue().rstrip("\n")

    pos_fmt = ["%.6f", "%.6f", "%.6f"]

    if fmt == "xyz":
        return _savetxt([points[:, 0], points[:, 1], points[:, 2]], pos_fmt, " ")

    if fmt in ("txt", "csv"):
        sep = "," if fmt == "csv" else " "
        head = ["X", "Y", "Z"]
        cols = [points[:, 0], points[:, 1], points[:, 2]]
        fmts = list(pos_fmt)
        if has_colors:
            head += ["R", "G", "B"]
            cols += [rgb[:, 0], rgb[:, 1], rgb[:, 2]]
            fmts += ["%d", "%d", "%d"]
        if has_int:
            head += ["Intensity"]
            cols += [np.asarray(intensity, dtype=np.float64)]
            fmts += ["%.4f"]
        body = _savetxt(cols, fmts, sep)
        # Match the old loop exactly: header only (no trailing newline) when empty.
        return sep.join(head) + ("\n" + body if body else "")

    if fmt == "ply":
        header = ["ply", "format ascii 1.0", f"element vertex {n}",
                  "property float x", "property float y", "property float z"]
        cols = [points[:, 0], points[:, 1], points[:, 2]]
        fmts = list(pos_fmt)
        if has_colors:
            header += ["property uchar red", "property uchar green", "property uchar blue"]
            cols += [rgb[:, 0], rgb[:, 1], rgb[:, 2]]
            fmts += ["%d", "%d", "%d"]
        header.append("end_header")
        body = _savetxt(cols, fmts, " ")
        return "\n".join(header) + ("\n" + body if body else "")

    if fmt == "obj":
        header = ["# Point cloud exported from Phytograph", f"# {n} points"]
        # The 'v ' prefix is the first format field (a literal column).
        body = _savetxt(
            [points[:, 0], points[:, 1], points[:, 2]],
            ["v %.6f", "%.6f", "%.6f"], " ",
        )
        return "\n".join(header) + ("\n" + body if body else "")

    raise HTTPException(status_code=400, detail=f"Unsupported text export format: {fmt}")
