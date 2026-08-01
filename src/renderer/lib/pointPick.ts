// Point picker — pure logic behind the CloudCompare-style "click a point, get a
// labelled bubble" tool.
//
// The viewer's gizmo (components/viewer/gizmos/PointPicker.tsx) does the actual
// raycast/GPU pick and hands back a raw hit; everything that turns that hit into
// something a human can read lives here so it stays unit-testable:
//
//   * frame conversion (display → local → world),
//   * turning a bag of raw attribute values into labelled, formatted rows, and
//   * CSV/TSV serialisation for the copy buttons.
//
// Pure + stateless — no three.js, no React, no DOM.
import {
  categoricalSchemeForRange,
  type CategoricalScheme,
} from './classification';
import type { PointCloudData, ScalarField } from './pointCloudTypes';
import { OCTREE_BUILTIN_ATTRIBUTES } from './pointCloudHelpers';

export type Vec3 = [number, number, number];

// Where OctreePointCloud re-registers a tile's REAL intensity buffer before the
// scalar-colour path aliases the selected scalar into the `intensity` slot.
// potree's picker reports a value for every named attribute on the geometry, so
// without this backup the picker would read the aliased scalar and label it
// "intensity". Lives here (rather than in either component) because the
// renderer writes it and the picker reads it.
export const ORIG_INTENSITY_ATTRIBUTE = '__intensity_orig';

// One attribute row in a picked-point bubble. `value` is the raw number (kept
// for CSV export); `display` is what the bubble prints — for a categorical
// attribute that's "2 (Non-ground)", for a continuous one a formatted number.
export interface PickedAttribute {
  slug: string;
  label: string;
  value: number;
  display: string;
}

// A picked point, as displayed. Positions are stored in the two frames a user
// cares about; the render-only `displayOffset` is already removed (it is
// transient and would invalidate the label on the next import).
export interface PickedPoint {
  id: string;
  // Monotonic pick counter, used only to stagger the label's screen offset.
  // Deliberately NOT the array index: dismissing a label would otherwise
  // reshuffle every surviving label's position.
  seq: number;
  cloudId: string;
  cloudLabel: string;
  // True source-file coordinates: local + the cloud's import-time global shift.
  world: Vec3;
  // The frame the app itself works in (what the backend session stores).
  local: Vec3;
  // False when the cloud has no global shift, i.e. world === local and the
  // bubble should print a single coordinate block rather than two.
  hasShift: boolean;
  attributes: PickedAttribute[];
  // Original row index into the cloud's arrays. Flat clouds only — a Potree
  // octree reorders points by morton code and carries no original-index column,
  // so there is nothing stable to report for a streamed cloud.
  sourceIndex?: number;
}

// ── Pick tolerance sizing ──────────────────────────────────────────────────
//
// Both cloud kinds want a click tolerance expressed in SCREEN PIXELS, but the
// mechanisms differ: the octree path inflates the splat in a GPU pick render,
// while the flat path hands three.js a world-space radius around the ray. The
// pixels→world conversion for the latter is the fiddly part, so it lives here
// where it can be tested without a GL context.

// World units per canvas pixel at `distance` from the camera. Perspective and
// orthographic are both live in this app (the ortho snap views and the
// crop-mode projection override), and they scale differently: perspective grows
// with distance, ortho does not depend on it at all.
export function worldPerPixel(
  camera:
    | { isPerspectiveCamera: true; fov: number }
    | { isPerspectiveCamera?: false; top: number; bottom: number; zoom: number },
  viewportHeight: number,
  distance: number,
): number {
  if (viewportHeight <= 0) return 0;
  if (camera.isPerspectiveCamera) {
    return (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(distance, 1e-6)) / viewportHeight;
  }
  return (camera.top - camera.bottom) / (camera.zoom || 1) / viewportHeight;
}

// Distance from the camera to the NEAR SURFACE of a cloud's bounding sphere.
//
// This is what a flat cloud's ray tolerance must be sized from. three.js tests
// `params.Points.threshold` as a world-space radius around the ray and applies
// it unscaled at every depth under a perspective camera, so whichever distance
// feeds the pixels→world conversion decides which slice of the cloud is
// comfortably clickable. Sizing from the sphere's CENTRE (the previous
// behaviour) under-serves the near half of any cloud that is deep along the
// view axis — a 100 m scan viewed end-on got a midpoint-sized tolerance, so
// near points were too tight to hit.
//
// Clamped positive because the camera may sit inside the cloud, which would
// otherwise yield a zero or negative distance and collapse the tolerance.
export function nearSurfaceDistance(
  cameraToCenter: number,
  boundingRadius: number,
  scale = 1,
): number {
  return Math.max(cameraToCenter - boundingRadius * scale, 1e-6);
}

// ── Frame conversion ───────────────────────────────────────────────────────
//
// The scene renders at (world − displayOffset), and a cloud's stored points are
// (world − worldShift). A pick therefore comes back in DISPLAY space and has to
// climb back up both steps:
//
//   local = pick.position + displayOffset
//   world = local + worldShift
//
// See the `displayOffset` note in pointCloudHelpers.ts and `OctreeRef.worldShift`
// in pointCloudTypes.ts.

export function displayToLocal(
  pos: { x: number; y: number; z: number },
  displayOffset?: { x: number; y: number; z: number } | null,
): Vec3 {
  const o = displayOffset;
  return [pos.x + (o?.x ?? 0), pos.y + (o?.y ?? 0), pos.z + (o?.z ?? 0)];
}

export function localToWorld(
  local: Vec3,
  worldShift?: Vec3 | number[] | null,
): Vec3 {
  const s = worldShift;
  return [
    local[0] + (s?.[0] ?? 0),
    local[1] + (s?.[1] ?? 0),
    local[2] + (s?.[2] ?? 0),
  ];
}

// True when the shift is present and actually non-zero, so a bubble only shows
// the second coordinate column when it would differ from the first.
export function hasNonZeroShift(worldShift?: Vec3 | number[] | null): boolean {
  if (!worldShift) return false;
  return (worldShift[0] ?? 0) !== 0 || (worldShift[1] ?? 0) !== 0 || (worldShift[2] ?? 0) !== 0;
}

// ── Formatting ─────────────────────────────────────────────────────────────

// Coordinates print at millimetre resolution. Huge (UTM-scale) values keep the
// same 3 decimals — they're what the user needs to compare against the source
// file — but anything non-finite degrades to a dash rather than "NaN".
export function formatCoord(v: number): string {
  if (!isFinite(v)) return '—';
  return v.toFixed(3);
}

// Scalar attributes span wildly different magnitudes (a 0..1 reflectance, a
// 1e9 GPS timestamp, a small integer class id), so pick precision from the
// value rather than fixing it. Integers print bare.
//
// Large values stay in positional notation on purpose: the motivating case is a
// GPS-week timestamp around 1.2e9, where "1.2346e+9" throws away the seconds the
// user is actually reading the picker to see.
export function formatScalar(v: number): string {
  if (!isFinite(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  const mag = Math.abs(v);
  // Only genuinely tiny values go exponential — toFixed would print them as 0.
  if (mag < 1e-4) return v.toExponential(4);
  if (mag >= 1000) return v.toFixed(3);
  if (mag >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

// Render a value against its attribute's categorical scheme, when it has one:
// "2 (Non-ground)". Falls back to the plain formatted number.
export function formatAttributeValue(
  value: number,
  scheme: CategoricalScheme | null,
): string {
  if (!scheme) return formatScalar(value);
  const rounded = Math.round(value);
  const cls = scheme.classes.find((c) => c.value === rounded);
  return cls ? `${rounded} (${cls.label})` : formatScalar(value);
}

// ── Attribute rows ─────────────────────────────────────────────────────────

// Keys that are never a user-facing attribute. `position`/`normal` are the
// geometry itself; `pointCloud` is potree's back-reference to the octree
// instance; `indices` and `spacing` are potree bookkeeping.
const NON_ATTRIBUTE_KEYS = new Set([
  'position',
  'normal',
  'pointcloud',
  'indices',
  'spacing',
]);

// Attributes the picker shows even though the colour-by dropdown filters them
// out of OCTREE_BUILTIN_ATTRIBUTES. Those are excluded from *colouring* because
// they have a dedicated colour mode — but a picker that hid a point's intensity
// or colour would be missing the point.
const PICKER_KEEPS = new Set(['intensity', 'rgb', 'rgba', 'color', 'classification']);

// Everything else in the builtin set is dropped. PotreeConverter always writes
// the full default LAS schema, so a cloud imported from an ASCII file carries
// half a dozen all-zero dimensions ('return number', 'scan angle rank', 'user
// data', 'point source id', …). Listing those turns a readable bubble into a
// wall of zeros. Real LAS files keep their meaningful values regardless: the
// importer re-reads the standard dimensions into `las_*` extras, which are not
// in this set and so still appear.
function isPickerAttribute(key: string): boolean {
  const k = key.toLowerCase();
  if (NON_ATTRIBUTE_KEYS.has(k)) return false;
  if (PICKER_KEEPS.has(k)) return true;
  return !OCTREE_BUILTIN_ATTRIBUTES.has(k);
}

// Potree stores colour as a 4-component rgba attribute; it's shown as its own
// row rather than three anonymous numbers.
const RGBA_KEYS = new Set(['rgba', 'rgb', 'color']);

export interface AttributeContext {
  // slug → human display name, from OctreeRef.attributeLabels.
  labels?: Record<string, string>;
  // slug → observed [min,max], from OctreeRef.attributeRanges. Needed to build
  // the range-derived categorical schemes (tree_instance, wizard-marked fields).
  ranges?: Record<string, { min: number[]; max: number[] }>;
}

function rangeFor(
  slug: string,
  ranges?: Record<string, { min: number[]; max: number[] }>,
): [number, number] | null {
  const r = ranges?.[slug];
  if (!r || !Array.isArray(r.min) || !Array.isArray(r.max)) return null;
  const lo = r.min[0];
  const hi = r.max[0];
  if (typeof lo !== 'number' || typeof hi !== 'number') return null;
  return [lo, hi];
}

// Turn a raw {slug: value} bag — a potree PickPoint, or a flat cloud's scalar
// fields sampled at one index — into display-ready rows, sorted by label so the
// bubble's row order is stable across picks.
//
// Multi-component values (rgba) collapse to a single formatted row; anything
// else non-numeric is dropped rather than printed as "[object Object]".
export function buildAttributeRows(
  values: Record<string, unknown>,
  ctx: AttributeContext = {},
): PickedAttribute[] {
  const rows: PickedAttribute[] = [];
  for (const key of Object.keys(values)) {
    if (!isPickerAttribute(key)) continue;
    const raw = values[key];
    const label = ctx.labels?.[key] ?? key;

    if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
      if (!RGBA_KEYS.has(key.toLowerCase())) continue;
      const comps = Array.from(raw as ArrayLike<number>).slice(0, 3);
      if (comps.length < 3 || comps.some((c) => typeof c !== 'number')) continue;
      rows.push({
        slug: key,
        label,
        // Colour has no single numeric value; carry the red channel so the CSV
        // column is at least well-typed, and let `display` hold the triplet.
        value: comps[0],
        display: comps.map((c) => Math.round(c)).join(', '),
      });
      continue;
    }

    if (typeof raw !== 'number' || Number.isNaN(raw)) continue;
    const scheme = categoricalSchemeForRange(key, rangeFor(key, ctx.ranges));
    rows.push({ slug: key, label, value: raw, display: formatAttributeValue(raw, scheme) });
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

// Sample a flat cloud's per-point arrays at one index into the same raw
// {slug: value} shape `buildAttributeRows` takes, so both cloud kinds share one
// formatting path. `intensities` is a dedicated array on PointCloudData rather
// than a scalar field, so it's folded in under the conventional slug.
export function flatCloudAttributeValues(
  data: Pick<PointCloudData, 'intensities' | 'scalarFields'>,
  index: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (data.intensities && index < data.intensities.length) {
    out.intensity = data.intensities[index];
  }
  const fields = data.scalarFields ?? {};
  for (const slug of Object.keys(fields)) {
    const field: ScalarField | undefined = fields[slug];
    if (field && index < field.values.length) out[slug] = field.values[index];
  }
  return out;
}

// A flat cloud's scalar fields carry their own observed min/max, which is
// exactly what the range-derived categorical schemes need — reshape them into
// the octree's attributeRanges form so one AttributeContext serves both paths.
export function flatCloudRanges(
  data: Pick<PointCloudData, 'scalarFields'>,
): Record<string, { min: number[]; max: number[] }> {
  const out: Record<string, { min: number[]; max: number[] }> = {};
  const fields = data.scalarFields ?? {};
  for (const slug of Object.keys(fields)) {
    const f = fields[slug];
    if (f) out[slug] = { min: [f.min], max: [f.max] };
  }
  return out;
}

// ── Clipboard serialisation ────────────────────────────────────────────────

const CSV_FIXED_COLUMNS = [
  'scan',
  'world_x', 'world_y', 'world_z',
  'local_x', 'local_y', 'local_z',
  'index',
];

function csvCell(v: string | number | undefined): string {
  if (v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One row per picked point. Attribute columns are the union of every point's
// slugs (points from different scans need not agree), ordered by first
// appearance so a single-scan export keeps the bubble's row order.
export function pickedPointsToCsv(points: PickedPoint[]): string {
  const attrCols: string[] = [];
  for (const p of points) {
    for (const a of p.attributes) if (!attrCols.includes(a.slug)) attrCols.push(a.slug);
  }
  const header = [...CSV_FIXED_COLUMNS, ...attrCols];
  const lines = [header.join(',')];
  for (const p of points) {
    const bySlug = new Map(p.attributes.map((a) => [a.slug, a.value]));
    const row = [
      csvCell(p.cloudLabel),
      formatCoord(p.world[0]), formatCoord(p.world[1]), formatCoord(p.world[2]),
      formatCoord(p.local[0]), formatCoord(p.local[1]), formatCoord(p.local[2]),
      p.sourceIndex === undefined ? '' : String(p.sourceIndex),
      ...attrCols.map((slug) => {
        const v = bySlug.get(slug);
        return v === undefined ? '' : csvCell(v);
      }),
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

// Human-readable single-point summary for the per-bubble copy button — the same
// text the bubble shows, one "label\tvalue" pair per line.
export function pickedPointToText(p: PickedPoint): string {
  const lines = [p.cloudLabel];
  const axes = ['X', 'Y', 'Z'];
  for (let i = 0; i < 3; i++) {
    lines.push(
      p.hasShift
        ? `${axes[i]}\t${formatCoord(p.world[i])}\t(local ${formatCoord(p.local[i])})`
        : `${axes[i]}\t${formatCoord(p.world[i])}`,
    );
  }
  if (p.sourceIndex !== undefined) lines.push(`index\t${p.sourceIndex}`);
  for (const a of p.attributes) lines.push(`${a.label}\t${a.display}`);
  return lines.join('\n');
}

// ── Label placement ────────────────────────────────────────────────────────

// Pixel offset from a picked point to its bubble's anchor corner. Successive
// labels step down-right so a burst of clicks on nearby points doesn't stack
// them into an unreadable pile; the cycle is short so labels stay near their
// points.
const LABEL_STEP_PX = 18;
const LABEL_CYCLE = 5;
const LABEL_BASE: { dx: number; dy: number } = { dx: 26, dy: -34 };

export function labelOffsetFor(sequence: number): { dx: number; dy: number } {
  const step = ((sequence % LABEL_CYCLE) + LABEL_CYCLE) % LABEL_CYCLE;
  return {
    dx: LABEL_BASE.dx + step * LABEL_STEP_PX,
    dy: LABEL_BASE.dy + step * LABEL_STEP_PX,
  };
}
