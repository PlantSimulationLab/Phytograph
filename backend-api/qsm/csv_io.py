"""Read a QSM back from a per-cylinder CSV table.

The inverse of the renderer's ``qsmToCylinderCsv`` (src/renderer/lib/qsmExport.ts):
Phytograph writes a SimpleForest-compatible cylinder table, and this module reads
it back into the same ``QSM`` dataclass the reconstruction pipeline produces. That
makes the export/import round trip lossless -- every field of ``Cylinder`` is in
the file, and ``Shoot`` is fully reconstructible from it (see below).

The reader is deliberately tolerant of the wider SimpleForest/TreeQSM/rTwig family,
not just Phytograph's own header: column names match case- and separator-
insensitively (``parentID`` == ``parent_id`` == ``ParentId``), the delimiter is
sniffed, and unknown columns are ignored. Only the columns that carry information
we cannot derive are required.

Derived-on-read columns
-----------------------
``axisX/Y/Z`` and ``length`` are present in Phytograph's export but are *ignored*
here: both are exact functions of ``start``/``end`` and are recomputed by the
``Cylinder.axis`` / ``Cylinder.length`` properties. Keeping start/end authoritative
means a hand-edited or third-party file can never disagree with itself.

Shoot reconstruction
--------------------
The CSV has no shoot table, but a shoot is recoverable in full:

- ``cylinder_ids`` -- group rows by shoot id **in file row order**. Row order is
  the only encoding of base->tip ordering in the file, so rows are never sorted.
- ``parent_cyl_id`` -- the ``parentID`` of the shoot's first cylinder. A shoot's
  first cylinder attaches at the fork, so that column *is* the fork cylinder; no
  nearest-neighbour heuristic is needed (unlike ``validation.gt_io``, which exists
  for JSON ground truth that omits ``parent_id`` entirely).
- ``parent_shoot_id`` -- from ``parentSegmentID`` when present, else the shoot of
  that parent cylinder.
- ``child_shoot_ids`` -- always derived by inverting ``parent_shoot_id``.

No pandas: the rest of the ``qsm`` package is dependency-light and stdlib ``csv``
is entirely sufficient for a table of this shape.
"""

from __future__ import annotations

import csv
import io
from pathlib import Path

from .model import NO_PARENT, Cylinder, QSM, Shoot


class QSMCsvError(ValueError):
    """A QSM CSV that cannot be read. Carries a user-facing message.

    Subclasses ValueError so callers can catch either; ``main.py`` turns it into
    an HTTP 400 with the message shown to the user.
    """


# Canonical column name -> the aliases we accept, all pre-normalized. Aliases
# cover the SimpleForest/TreeQSM/rTwig spellings seen in the wild alongside our
# own export's header.
_ALIASES: dict[str, tuple[str, ...]] = {
    "id": ("id", "cylinderid", "cylid"),
    "parent_id": ("parentid", "parent"),
    "branch_id": ("branchid", "branch"),
    "branch_order": ("branchorder", "order", "rank"),
    "segment_id": ("segmentid", "segment"),
    "parent_segment_id": ("parentsegmentid", "parentsegment"),
    "start_x": ("startx", "startxm", "x1"),
    "start_y": ("starty", "startym", "y1"),
    "start_z": ("startz", "startzm", "z1"),
    "end_x": ("endx", "endxm", "x2"),
    "end_y": ("endy", "endym", "y2"),
    "end_z": ("endz", "endzm", "z2"),
    "radius": ("radius", "radiusm", "rad"),
    "surf_cov": ("surfacecoverage", "surfcov"),
    "mad": ("meanabsdeviation", "meandeviation", "mad"),
}

# Without these we cannot reconstruct the model at all.
_REQUIRED = (
    "id",
    "parent_id",
    "branch_order",
    "start_x", "start_y", "start_z",
    "end_x", "end_y", "end_z",
    "radius",
)


def _normalize(name: str) -> str:
    """Fold a header cell to its comparison key: lowercase alphanumerics only.

    Collapses ``parentID`` / ``parent_id`` / ``Parent Id`` / ``parent-id`` to
    ``parentid``, and strips a UTF-8 BOM that Excel-written files carry on the
    first cell.
    """
    return "".join(ch for ch in name.strip().lstrip("﻿").lower() if ch.isalnum())


def _build_column_map(header: list[str]) -> dict[str, int]:
    """Map canonical column name -> column index, for the columns present.

    First match wins, so a file carrying both ``branchOrder`` and ``rank`` uses
    ``branchOrder`` (the earlier alias).
    """
    normalized = [_normalize(h) for h in header]
    seen: dict[str, int] = {}
    for idx, key in enumerate(normalized):
        if key and key not in seen:
            seen[key] = idx

    colmap: dict[str, int] = {}
    for canonical, aliases in _ALIASES.items():
        for alias in aliases:
            if alias in seen:
                colmap[canonical] = seen[alias]
                break
    return colmap


def _sniff_delimiter(sample: str) -> str:
    """Pick the delimiter from the header line. Falls back to comma.

    csv.Sniffer is easily confused by a single-column sample, so restrict it to
    the delimiters that actually appear in QSM tables and fall back rather than
    letting it raise.
    """
    header_line = sample.split("\n", 1)[0]
    try:
        return csv.Sniffer().sniff(header_line, delimiters=",;\t").delimiter
    except csv.Error:
        return ","


def _cell(row: list[str], idx: int | None) -> str:
    if idx is None or idx >= len(row):
        return ""
    return row[idx].strip()


def _req_float(row: list[str], idx: int, rownum: int, field: str) -> float:
    raw = _cell(row, idx)
    if raw == "":
        raise QSMCsvError(f"row {rownum}: missing value for '{field}'")
    try:
        return float(raw)
    except ValueError:
        raise QSMCsvError(f"row {rownum}: '{field}' is not a number: {raw!r}") from None


def _req_int(row: list[str], idx: int, rownum: int, field: str) -> int:
    raw = _cell(row, idx)
    if raw == "":
        raise QSMCsvError(f"row {rownum}: missing value for '{field}'")
    try:
        # Written as a float by some exporters ("3.0"); int("3.0") raises, so go
        # through float. Reject a genuine fraction rather than truncating it.
        val = float(raw)
    except ValueError:
        raise QSMCsvError(f"row {rownum}: '{field}' is not an integer: {raw!r}") from None
    if val != int(val):
        raise QSMCsvError(f"row {rownum}: '{field}' is not an integer: {raw!r}")
    return int(val)


def _opt_float(row: list[str], idx: int | None, rownum: int, field: str) -> float | None:
    """Optional quality column. Empty cell -> None (our exporter writes '' for null)."""
    raw = _cell(row, idx)
    if raw == "":
        return None
    try:
        return float(raw)
    except ValueError:
        raise QSMCsvError(f"row {rownum}: '{field}' is not a number: {raw!r}") from None


def parse_qsm_csv(text: str, source: str = "QSM CSV") -> QSM:
    """Parse QSM CSV text into a QSM. Raises QSMCsvError on malformed input."""
    if not text.strip():
        raise QSMCsvError(f"{source}: file is empty")

    reader = csv.reader(io.StringIO(text), delimiter=_sniff_delimiter(text))
    try:
        header = next(reader)
    except StopIteration:
        raise QSMCsvError(f"{source}: file is empty") from None

    colmap = _build_column_map(header)
    missing = [name for name in _REQUIRED if name not in colmap]
    if missing:
        raise QSMCsvError(
            f"{source}: not a QSM cylinder table -- missing required column(s): "
            + ", ".join(missing)
        )

    cylinders: list[Cylinder] = []
    # Shoot id per cylinder, parallel to `cylinders`; resolved after the read so a
    # file with no shoot column can fall back to deriving them from topology.
    raw_shoot_ids: list[int | None] = []
    # shoot id -> parent shoot id, from parentSegmentID where the file supplies it.
    declared_parent_shoot: dict[int, int] = {}

    for rownum, row in enumerate(reader, start=2):  # row 1 is the header
        if not any(cell.strip() for cell in row):
            continue  # blank line (trailing newline, or a gap in a hand-edited file)

        cyl_id = _req_int(row, colmap["id"], rownum, "ID")
        parent_id = _req_int(row, colmap["parent_id"], rownum, "parentID")
        rank = _req_int(row, colmap["branch_order"], rownum, "branchOrder")
        cylinders.append(Cylinder(
            cyl_id=cyl_id,
            start=[
                _req_float(row, colmap["start_x"], rownum, "startX"),
                _req_float(row, colmap["start_y"], rownum, "startY"),
                _req_float(row, colmap["start_z"], rownum, "startZ"),
            ],
            end=[
                _req_float(row, colmap["end_x"], rownum, "endX"),
                _req_float(row, colmap["end_y"], rownum, "endY"),
                _req_float(row, colmap["end_z"], rownum, "endZ"),
            ],
            radius=_req_float(row, colmap["radius"], rownum, "radius"),
            parent_id=parent_id,
            rank=rank,
            surf_cov=_opt_float(row, colmap.get("surf_cov"), rownum, "surfaceCoverage"),
            mad=_opt_float(row, colmap.get("mad"), rownum, "meanAbsDeviation"),
        ))

        # Shoot membership: segmentID is the continuous axis our exporter writes;
        # branchID is the SimpleForest equivalent. Either serves.
        shoot_idx = colmap.get("segment_id", colmap.get("branch_id"))
        if shoot_idx is not None and _cell(row, shoot_idx) != "":
            shoot_id = _req_int(row, shoot_idx, rownum, "segmentID")
            raw_shoot_ids.append(shoot_id)
            parent_seg_idx = colmap.get("parent_segment_id")
            if parent_seg_idx is not None and _cell(row, parent_seg_idx) != "":
                declared_parent_shoot.setdefault(
                    shoot_id, _req_int(row, parent_seg_idx, rownum, "parentSegmentID")
                )
        else:
            raw_shoot_ids.append(None)

    if not cylinders:
        raise QSMCsvError(f"{source}: no cylinder rows found")

    _check_unique_ids(cylinders, source)
    shoot_ids = _resolve_shoot_ids(cylinders, raw_shoot_ids)
    for cyl, sid in zip(cylinders, shoot_ids):
        cyl.shoot_id = sid

    qsm = QSM(
        cylinders=cylinders,
        shoots=_build_shoots(cylinders, declared_parent_shoot),
        units="meters",
        meta={"source": source},
    )
    _validate(qsm, source)
    return qsm


def read_qsm_csv(path: str | Path) -> QSM:
    """Read a QSM from a CSV file on disk."""
    p = Path(path)
    # utf-8-sig transparently drops the BOM Excel prepends when it saves a CSV.
    text = p.read_text(encoding="utf-8-sig", errors="replace")
    return parse_qsm_csv(text, source=p.name)


def _check_unique_ids(cylinders: list[Cylinder], source: str) -> None:
    seen: set[int] = set()
    for c in cylinders:
        if c.cyl_id in seen:
            raise QSMCsvError(f"{source}: duplicate cylinder ID {c.cyl_id}")
        seen.add(c.cyl_id)


def _resolve_shoot_ids(
    cylinders: list[Cylinder], raw: list[int | None]
) -> list[int]:
    """Final shoot id per cylinder, deriving them when the file carries none.

    Derivation (for dialects with neither segmentID nor branchID): walk the parent
    chain: a cylinder continues its parent's shoot when it has the same rank and is
    the parent's *first* such child; anything else starts a new shoot. That
    reproduces the axis-continuation rule the reconstruction pipeline uses, where a
    shoot is a maximal chain of continuation-linked cylinders of equal rank.
    """
    if all(sid is not None for sid in raw):
        return [int(sid) for sid in raw]  # type: ignore[arg-type]

    by_id = {c.cyl_id: c for c in cylinders}
    index_of = {c.cyl_id: i for i, c in enumerate(cylinders)}
    resolved: list[int | None] = list(raw)
    continued: set[int] = set()  # parents that already handed their shoot on
    next_shoot = 0

    # Visit parents before children. File order is usually already base->tip, but
    # nothing guarantees it -- a third-party table may list a child first, and
    # inheriting from a not-yet-resolved parent would leave a None shoot id. The
    # traversal below fixes an order rather than trusting the file's. Ties break on
    # file order, so a well-ordered file behaves exactly as before.
    children: dict[int, list[int]] = {}
    roots: list[int] = []
    for c in cylinders:
        if c.parent_id != NO_PARENT and c.parent_id in by_id:
            children.setdefault(c.parent_id, []).append(c.cyl_id)
        else:
            roots.append(c.cyl_id)

    order: list[int] = []
    stack = list(reversed(roots))
    while stack:
        cid = stack.pop()
        order.append(cid)
        # Reversed so the first-listed child is processed first, which is what
        # decides who CONTINUES the parent's shoot.
        stack.extend(reversed(children.get(cid, [])))

    # A parent cycle leaves its members unreachable from any root. _validate
    # reports that properly, but it runs after this, so append the stragglers in
    # file order to keep every cylinder resolved until it does.
    if len(order) < len(cylinders):
        seen_order = set(order)
        order.extend(c.cyl_id for c in cylinders if c.cyl_id not in seen_order)

    for cid in order:
        i = index_of[cid]
        if resolved[i] is not None:
            continue
        c = by_id[cid]
        parent = by_id.get(c.parent_id) if c.parent_id != NO_PARENT else None
        parent_shoot = resolved[index_of[parent.cyl_id]] if parent is not None else None
        if (
            parent is not None
            and parent_shoot is not None
            and parent.rank == c.rank
            and parent.cyl_id not in continued
        ):
            continued.add(parent.cyl_id)
            resolved[i] = parent_shoot
        else:
            resolved[i] = next_shoot
            next_shoot += 1

    # A partially-populated column would leave the derived ids colliding with the
    # declared ones; that file is ambiguous, so treat it as malformed rather than
    # silently merging two shoots.
    declared = {sid for sid in raw if sid is not None}
    derived = {sid for sid, orig in zip(resolved, raw) if orig is None}
    if declared & derived:
        raise QSMCsvError(
            "shoot id column is only filled on some rows; either fill it on every "
            "row or omit it entirely"
        )
    return [int(sid) for sid in resolved]  # type: ignore[arg-type]


def _build_shoots(
    cylinders: list[Cylinder], declared_parent_shoot: dict[int, int]
) -> list[Shoot]:
    """Reconstruct the shoot table from the cylinder rows.

    Cylinder order within a shoot is file order, which is base->tip -- the tube
    renderer depends on that ordering, and it is the only place the file encodes it.
    """
    by_id = {c.cyl_id: c for c in cylinders}

    ordered_ids: list[int] = []
    members: dict[int, list[int]] = {}
    for c in cylinders:
        if c.shoot_id not in members:
            members[c.shoot_id] = []
            ordered_ids.append(c.shoot_id)
        members[c.shoot_id].append(c.cyl_id)

    shoots: list[Shoot] = []
    for sid in ordered_ids:
        cyl_ids = members[sid]
        first = by_id[cyl_ids[0]]
        # The first cylinder of a shoot attaches at the fork, so its parent IS the
        # attach point -- exactly what parent_cyl_id means.
        parent_cyl_id = first.parent_id
        parent_cyl = by_id.get(parent_cyl_id) if parent_cyl_id != NO_PARENT else None
        # Prefer the file's own parentSegmentID; fall back to the parent cylinder's
        # shoot. A self-reference means "no parent" (some exporters write the shoot's
        # own id on the trunk row).
        parent_shoot_id = declared_parent_shoot.get(
            sid, parent_cyl.shoot_id if parent_cyl is not None else NO_PARENT
        )
        if parent_shoot_id == sid:
            parent_shoot_id = NO_PARENT
        if parent_shoot_id == NO_PARENT:
            parent_cyl_id = NO_PARENT
        shoots.append(Shoot(
            shoot_id=sid,
            rank=first.rank,
            cylinder_ids=cyl_ids,
            parent_shoot_id=parent_shoot_id,
            parent_cyl_id=parent_cyl_id,
        ))

    by_shoot = {s.shoot_id: s for s in shoots}
    for s in shoots:
        parent = by_shoot.get(s.parent_shoot_id)
        if parent is not None:
            parent.child_shoot_ids.append(s.shoot_id)
    return shoots


def _validate(qsm: QSM, source: str) -> None:
    """Structural checks on a parsed QSM.

    Deliberately says nothing about ranks. ``validation.gt_io._validate`` requires
    every child shoot to be exactly ``parent.rank + 1``, which contradicts the
    axis-continuation semantics documented in ``model.py``: at a fork the
    continuation child KEEPS the parent's rank. Applying that check here would
    reject Phytograph's own exports, so only genuine structural corruption --
    dangling parents, cycles, non-positive radii -- is rejected.
    """
    by_id = qsm.cylinder_by_id()

    for c in qsm.cylinders:
        if c.parent_id != NO_PARENT and c.parent_id not in by_id:
            raise QSMCsvError(
                f"{source}: cylinder {c.cyl_id} references unknown parentID {c.parent_id}"
            )
        if c.parent_id == c.cyl_id:
            raise QSMCsvError(f"{source}: cylinder {c.cyl_id} is its own parent")

    bad_radius = [c.cyl_id for c in qsm.cylinders if not (c.radius > 0)]
    if bad_radius:
        raise QSMCsvError(
            f"{source}: non-positive radius on cylinder(s) {bad_radius[:5]}"
        )

    # Cycle check. Walk each chain to the root; memoize the cylinders already known
    # to reach a root so the whole table costs O(n) rather than O(n * depth).
    safe: set[int] = set()
    for c in qsm.cylinders:
        chain: list[int] = []
        seen: set[int] = set()
        cur = c.cyl_id
        while cur != NO_PARENT and cur not in safe:
            if cur in seen:
                raise QSMCsvError(
                    f"{source}: cycle in the cylinder parent chain at ID {cur}"
                )
            seen.add(cur)
            chain.append(cur)
            cur = by_id[cur].parent_id
        safe.update(chain)
