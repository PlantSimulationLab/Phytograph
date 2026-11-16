// Which rows of a flat cloud its DISPLAY copy holds.
//
// A flat (in-memory) cloud keeps an unapplied erase and an uncommitted
// translation as edit state, and the viewer's `getDisplayData` builds the copy
// that tools compute on: erased (and crop-previewed-out) rows dropped,
// translation added. Two things went wrong with that copy:
//  - it dropped every scalar field, so `collectHitPoints` saw no `is_miss`
//    column and sent sky/miss points to the tools as hits;
//  - tools wrote their result back as `{ ...displayCopy, scalarFields }`,
//    replacing the cloud with the compacted, translated copy plus ONE column,
//    while the edit state still held the erase indices and the translation:
//    every other column was lost, the wrong rows were hidden, and the
//    translation was applied twice.
// So the copy carries its scalar fields (gathered by the same row map), the
// map is kept here, keyed by the copy itself (never stored on the data, so it
// cannot leak into a cloud built from the copy), and results go back onto the
// ORIGINAL cloud through `columnsToSourceRows`.
import type { PointCloudData, ScalarField } from './pointCloudTypes';

const displayRows = new WeakMap<object, Uint32Array>();

/** Record that `display` holds the source rows `rows` (display row k = source row rows[k]). */
export function recordDisplayRows(display: object, rows: Uint32Array): void {
  displayRows.set(display, rows);
}

/** The source rows a display copy holds, or undefined when it holds every row in order. */
export function displayRowsOf(display: object): Uint32Array | undefined {
  return displayRows.get(display);
}

/** Scalar fields restricted to `rows`, in that order. */
export function gatherScalarFields(
  fields: Record<string, ScalarField> | undefined, rows: Uint32Array,
): Record<string, ScalarField> | undefined {
  if (!fields) return fields;
  const out: Record<string, ScalarField> = {};
  for (const [name, field] of Object.entries(fields)) {
    const values = new Float32Array(rows.length);
    for (let k = 0; k < rows.length; k++) values[k] = field.values[rows[k]];
    out[name] = { ...field, values };
  }
  return out;
}

/**
 * Per-point columns computed on a display copy, expanded to the source cloud's
 * `sourceCount` rows. Rows the copy did not hold (erased, cropped out) take
 * `fill`, the convention a miss already gets (0 is outside every class range).
 */
export function columnsToSourceRows(
  columns: Record<string, ScalarField>, display: PointCloudData, sourceCount: number, fill = 0,
): Record<string, ScalarField> {
  const rows = displayRowsOf(display);
  const out: Record<string, ScalarField> = {};
  for (const [name, field] of Object.entries(columns)) {
    if (!rows) {
      out[name] = field;
      continue;
    }
    const values = new Float32Array(sourceCount);
    if (fill !== 0) values.fill(fill);
    for (let k = 0; k < rows.length; k++) values[rows[k]] = field.values[k];
    out[name] = { ...field, values };
  }
  return out;
}
