// QSM CSV import detection. Pure functions, no DOM/IPC beyond a Blob read, so the
// header logic stays unit-testable. The actual parsing happens in the backend
// (POST /api/qsm/import) — the renderer only needs to decide whether a .csv is a
// QSM cylinder table or a point cloud.
//
// This exists because `.csv` is an ambiguous container, exactly like `.ply`: it is
// already claimed by the point-cloud path (OCTREE_DROP_EXTENSIONS in App.tsx), so
// an auto-detected import needs a content probe to route a QSM CSV correctly.
// Mirrors the plyHasFaces precedent in pointCloudParsers.ts.

// Column names that together identify a per-cylinder QSM table. A point-cloud CSV
// carries x/y/z (+ intensity/rgb/classification) and never these, so the pair
// branchID + branchOrder alone is already decisive; requiring ID and parentID too
// keeps false positives at zero.
//
// Kept deliberately narrower than the backend reader's alias table (qsm/csv_io.py):
// this only has to recognize the files Phytograph and the SimpleForest family
// write. Anything it misses is still importable via File → Import → QSM CSV…,
// which skips detection entirely.
const REQUIRED_COLUMNS = ['id', 'parentid', 'branchid', 'branchorder'];

// Matches _normalize() in backend-api/qsm/csv_io.py: lowercase alphanumerics only,
// so parentID / parent_id / "Parent Id" / parent-id all fold together. Also drops
// the UTF-8 BOM Excel writes on the first cell.
function normalizeColumn(name: string): string {
  return name
    .trim()
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Split a header line on whichever delimiter it actually uses. QSM exporters emit
// comma (Phytograph, SimpleForest), semicolon (locale-aware rTwig/TreeQSM), or tab.
function splitHeader(line: string): string[] {
  let best: string[] = [];
  for (const delimiter of [',', ';', '\t']) {
    const parts = line.split(delimiter);
    if (parts.length > best.length) best = parts;
  }
  return best;
}

// True when a CSV header line describes a QSM cylinder table.
export function isQsmCsvHeader(firstLine: string): boolean {
  if (!firstLine || !firstLine.trim()) return false;
  const columns = new Set(splitHeader(firstLine).map(normalizeColumn));
  return REQUIRED_COLUMNS.every(c => columns.has(c));
}

// Peek at a file's first line to decide whether it's a QSM CSV. Never throws —
// an unreadable file is simply "not a QSM" and falls through to the normal
// point-cloud path, which surfaces its own errors.
export async function isQsmCsvFile(file: File): Promise<boolean> {
  try {
    // 64 KB is far more than one header line; matches the plyHasFaces budget.
    const text = await file.slice(0, 64 * 1024).text();
    return isQsmCsvHeader(text.split('\n', 1)[0] ?? '');
  } catch {
    return false;
  }
}
