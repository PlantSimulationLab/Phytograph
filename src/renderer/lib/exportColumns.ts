// Column model for point-cloud / scan export. The export modal lets the user pick
// which fields become columns — for every format except the fixed-schema ones
// (OBJ carries geometry only; E57 and PTX define their own layout — PTX's is a
// complete raster, so its columns aren't a menu at all). See COLUMN_PICKER_FORMATS. The text formats and PLY also honor
// the column ORDER; LAS/LAZ store dimensions by name, so order doesn't apply
// (usesFixedColumnOrder) and a couple of standard dimensions can't be dropped at
// all (LAS_LOCKED_KINDS).
//
// A "column" is one exportable field. Geometry (x/y/z) and colour (r/g/b) are
// fixed slugs; every other field is a named scalar (intensity, is_miss, a custom
// scan column, a class label, …).
//
// Where the available fields come from matters: a cloud imported through the
// normal (octree/session) path holds NO flat arrays — `positions` is empty and
// colors/intensities/scalarFields are unset — so its field list must come from
// `octree.attributeRanges`. Reading only the flat arrays is what limited this
// picker to bare x/y/z for every real import; see AvailableColumnsOptions.

import type { PointCloudData } from './pointCloudTypes';

// Slugs for the always-available geometry + colour columns.
export const GEOMETRY_SLUGS = ['x', 'y', 'z'] as const;
export const COLOR_SLUGS = ['r', 'g', 'b'] as const;

export interface ExportColumn {
  slug: string;        // canonical token written to the header / ASCII_format
  label: string;       // human label in the picker
  kind: 'geometry' | 'color' | 'intensity' | 'scalar' | 'label';
  selected: boolean;   // included in the export
  // x/y/z are required for a re-loadable scan XML; the picker keeps them locked.
  required?: boolean;
}

// Formats whose columns the user can choose. Only OBJ is excluded — a `v` line
// takes exactly x/y/z, so there is genuinely nothing to pick.
//
// PLY belongs here even though it is not a bare text layout: an ASCII PLY
// declares each column as a named `property`, so a chosen scalar round-trips
// with its name (the backend emits `property float <slug>`).
//
// LAS/LAZ belong here too. It is tempting to exclude them as "fixed schema", but
// that conflates two different things: the STANDARD dimensions are a fixed menu,
// while every scalar rides as an explicitly declared EXTRA dimension and is
// freely omittable. See LAS_LOCKED_KINDS for the parts that really are fixed.
export const COLUMN_PICKER_FORMATS = new Set([
  'xyz', 'txt', 'csv', 'ply', 'las', 'laz', 'scan',
]);

// True when the format lets the user pick its columns. (Named for the capability
// rather than "isAscii", which would wrongly imply a plain text layout now that
// PLY and LAS/LAZ — structured formats — take a column selection.)
export function supportsColumnSelection(format: string): boolean {
  return COLUMN_PICKER_FORMATS.has(format);
}

// True when the format writes a fixed COLUMN ORDER, so drag-reordering is
// meaningless even though the column SET is selectable. LAS/LAZ store dimensions
// by name in a header, not positionally — the order rows appear in the picker has
// no effect on the file.
export function usesFixedColumnOrder(format: string): boolean {
  return format === 'las' || format === 'laz';
}

// Column kinds LAS/LAZ cannot omit, and why. Both are standard dimensions:
//   * geometry — x/y/z ARE the point record.
//   * intensity — present in the core record of every LAS point format (0-3), so
//     deselecting it could only write zeros, never remove the field. A checkbox
//     that silently meant "zero this" would be worse than stating the limit.
// Colour is deliberately NOT here: dropping r/g/b selects point format 1, which
// has no RGB dimension at all — a real omission. (It comes bundled with GPS time,
// since the point format is a menu rather than a free choice of dimensions.)
export const LAS_LOCKED_KINDS = new Set<ExportColumn['kind']>(['geometry', 'intensity']);

// Apply LAS/LAZ rules to a column list: the dimensions that cannot be omitted are
// forced on and locked, so the picker can only offer choices the format can
// actually honor. Everything else (colour, scalars, labels) stays as the user set
// it. Mirrors `lockGeometryForScanXml`, which does the same for a scan bundle.
export function lockFixedDimsForLas(columns: ExportColumn[]): ExportColumn[] {
  return columns.map(c =>
    LAS_LOCKED_KINDS.has(c.kind) ? { ...c, selected: true, required: true } : c);
}

// Categorical / label slugs that should be presented under the "label" kind so
// the user can reason about them separately from continuous scalars. The actual
// categorical detection lives in classification.ts; we accept a predicate so the
// caller wires it without this module importing the registry.
export interface AvailableColumnsOptions {
  // True if a scalar slug is a categorical/label field (e.g. ground_class).
  isLabel?: (slug: string) => boolean;
  // Pretty display name for a slug (falls back to the slug itself).
  labelFor?: (slug: string) => string;
  // Helios ASCII_format hint (e.g. "row column x y z r g b reflectance") for an
  // octree/session-backed cloud whose points live on disk — its scalar columns
  // aren't in the in-RAM `scalarFields`, so we recover them from the format
  // string instead. Tokens x/y/z and r/g/b are handled as geometry/colour; the
  // rest become scalar columns.
  asciiFormat?: string | null;
  // The octree's per-attribute names, from `OctreeRef.attributeRanges` (keys) —
  // the authoritative list of what a session/octree-backed cloud actually holds.
  //
  // This is the load-bearing input for the normal import path. Octree clouds keep
  // no flat arrays at all (`buildPointCloudFromOctree` sets `positions` to an
  // empty Float32Array and never sets colors/intensities/scalarFields), and
  // `asciiFormat` is populated only by the Helios-XML importer — so without this
  // the picker degenerated to bare x/y/z for every LAS/LAZ/E57/PLY/XYZ import.
  // The colour-by dropdown, the scalar filter and the point-pick inspector all
  // already read this same source; export was the one consumer that didn't.
  octreeAttributes?: string[];
  // The octree's per-attribute min/max (`OctreeRef.attributeRanges`), used to
  // suppress DEGENERATE schema dimensions.
  //
  // PotreeConverter writes the full LAS point schema even when the source is a
  // bare XYZ with no such data, so a plain `x y z` import reports `intensity`,
  // `classification`, `gps-time` … all identically zero. Offering those as
  // export columns invents fields the cloud never had (a re-import would then
  // show a real-looking all-zero `classification`). A name blocklist can't
  // decide this — `classification` and `intensity` ARE meaningful on a LAS
  // import — but an all-zero range is exactly the signal that separates them.
  //
  // Only attributes that appear here AND are all-zero are dropped; an attribute
  // with no range entry is kept (absence of evidence isn't evidence of absence).
  octreeAttributeRanges?: Record<string, { min: number[]; max: number[] }>;
}

// True when an octree attribute's reported range is identically zero — the
// signature of a LAS schema dimension PotreeConverter emitted for a source that
// never carried it. A genuinely all-zero real field is indistinguishable here,
// but exporting a constant-zero column loses nothing either way.
function _isDegenerateRange(range?: { min: number[]; max: number[] }): boolean {
  if (!range || !range.min?.length || !range.max?.length) return false;
  return range.min.every(v => v === 0) && range.max.every(v => v === 0);
}

// Octree attribute names that are geometry/colour/intensity rather than scalars,
// plus PotreeConverter's schema plumbing. Kept parallel to
// OCTREE_BUILTIN_ATTRIBUTES in pointCloudHelpers.ts, but export treats `rgb` and
// `intensity` as REAL exportable columns (they map to r/g/b and intensity slugs)
// rather than hiding them the way the colour-by picker does.
const _OCTREE_NON_SCALAR = new Set([
  'position', 'normal', 'indices', 'spacing',
  'return number', 'number of returns',
  'scan angle rank', 'user data', 'point source id',
  // NOT 'gps-time': the octree view renames it to `timestamp` (see
  // buildPointCloudFromOctree), and that IS an exportable column — the backend
  // exporter's allowlist has always included it. Blocking it here is why a
  // RIEGL scan's timestamp was missing from the export picker.
]);

const _OCTREE_COLOR_NAMES = new Set(['rgb', 'rgba', 'color']);

// Tokens in a Helios ASCII_format that are geometry/colour (not extra scalars).
const _GEO_COLOR_TOKENS = new Set([
  'x', 'y', 'z', 'r', 'g', 'b', 'r255', 'g255', 'b255',
]);

// Build the default, ordered column list for a cloud: x y z, then colour (if the
// cloud has colours), then intensity (if present), then every other scalar field
// in a stable order. Everything is selected by default so a plain export is
// lossless; the user prunes from there.
export function defaultExportColumns(
  data: Pick<PointCloudData, 'colors' | 'intensities' | 'scalarFields'>,
  opts: AvailableColumnsOptions = {},
): ExportColumn[] {
  const isLabel = opts.isLabel ?? (() => false);
  const labelFor = opts.labelFor ?? ((s: string) => s);

  const cols: ExportColumn[] = [
    { slug: 'x', label: 'X', kind: 'geometry', selected: true },
    { slug: 'y', label: 'Y', kind: 'geometry', selected: true },
    { slug: 'z', label: 'Z', kind: 'geometry', selected: true },
  ];

  // Format tokens (octree/session clouds whose columns aren't in-RAM).
  const fmtTokens = (opts.asciiFormat ?? '').split(/\s+/).filter(Boolean);
  const hasColorTokens = fmtTokens.includes('r') || fmtTokens.includes('r255');

  // Octree attributes: the authoritative field list for a session-backed cloud,
  // minus the degenerate all-zero LAS schema dimensions PotreeConverter emits
  // for sources that never carried them (see octreeAttributeRanges).
  const ranges = opts.octreeAttributeRanges;
  const octreeAttrs = (opts.octreeAttributes ?? []).filter(
    a => !_isDegenerateRange(ranges?.[a]));
  const hasOctreeColor = octreeAttrs.some(a => _OCTREE_COLOR_NAMES.has(a.toLowerCase()));
  const hasOctreeIntensity = octreeAttrs.some(a => a.toLowerCase() === 'intensity');

  if (data.colors || hasColorTokens || hasOctreeColor) {
    cols.push(
      { slug: 'r', label: 'R', kind: 'color', selected: true },
      { slug: 'g', label: 'G', kind: 'color', selected: true },
      { slug: 'b', label: 'B', kind: 'color', selected: true },
    );
  }

  // Gather scalar slugs from the in-RAM fields, the octree attributes, and the
  // format string, in a stable union (in-RAM first, then octree attributes, then
  // any format-only tokens not already seen).
  const seen = new Set<string>(['x', 'y', 'z', 'r', 'g', 'b']);
  const scalarSlugs: string[] = [];
  for (const slug of Object.keys(data.scalarFields ?? {})) {
    if (!seen.has(slug)) { seen.add(slug); scalarSlugs.push(slug); }
  }
  for (const name of octreeAttrs) {
    const lower = name.toLowerCase();
    // Colour/geometry/plumbing aren't scalar columns; `intensity` is handled
    // separately below so it keeps its dedicated slug and ordering.
    if (_OCTREE_NON_SCALAR.has(lower) || _OCTREE_COLOR_NAMES.has(lower)) continue;
    if (lower === 'intensity') continue;
    if (!seen.has(name)) { seen.add(name); scalarSlugs.push(name); }
  }
  for (const tok of fmtTokens) {
    if (_GEO_COLOR_TOKENS.has(tok) || tok === 'skip') continue;
    if (!seen.has(tok)) { seen.add(tok); scalarSlugs.push(tok); }
  }

  // Intensity is a distinct, well-known scalar; surface it before the rest.
  if ((data.intensities || hasOctreeIntensity) && !scalarSlugs.includes('intensity')) {
    cols.push({ slug: 'intensity', label: 'Intensity', kind: 'intensity', selected: true });
    seen.add('intensity');
  }

  for (const slug of scalarSlugs) {
    const kind: ExportColumn['kind'] =
      slug === 'intensity' ? 'intensity' : isLabel(slug) ? 'label' : 'scalar';
    cols.push({
      slug,
      label: slug === 'intensity' ? 'Intensity' : labelFor(slug),
      kind,
      selected: true,
    });
  }

  return cols;
}

// Apply scan-XML rules to a column list: x/y/z must be present, selected, and
// locked (a scan that drops geometry can't be re-loaded). Returns a new list
// with x/y/z forced on + required; non-geometry columns are untouched.
export function lockGeometryForScanXml(columns: ExportColumn[]): ExportColumn[] {
  return columns.map(c =>
    c.kind === 'geometry' ? { ...c, selected: true, required: true } : c);
}

// The ordered list of selected slugs — what actually gets written. This is the
// header / ASCII_format / scan column_format the export uses.
export function selectedSlugs(columns: ExportColumn[]): string[] {
  return columns.filter(c => c.selected).map(c => c.slug);
}

// Resolve one column slug's value for point index `i` to a string cell. Geometry
// and colour come from the typed arrays; everything else from scalarFields /
// intensities. Colour is written as 0-255 ints (the ASCII convention used by the
// importer's r255/g255/b255 roles). Unknown/absent slugs emit '0' so column count
// stays stable.
export function cellValue(
  data: Pick<PointCloudData, 'positions' | 'colors' | 'intensities' | 'scalarFields'>,
  slug: string,
  i: number,
): string {
  switch (slug) {
    case 'x': return data.positions[i * 3].toFixed(6);
    case 'y': return data.positions[i * 3 + 1].toFixed(6);
    case 'z': return data.positions[i * 3 + 2].toFixed(6);
    case 'r': return data.colors ? String(Math.round(data.colors[i * 3] * 255)) : '0';
    case 'g': return data.colors ? String(Math.round(data.colors[i * 3 + 1] * 255)) : '0';
    case 'b': return data.colors ? String(Math.round(data.colors[i * 3 + 2] * 255)) : '0';
    case 'intensity':
      if (data.intensities) return data.intensities[i].toFixed(4);
      return data.scalarFields?.intensity ? String(data.scalarFields.intensity.values[i]) : '0';
    default: {
      const f = data.scalarFields?.[slug];
      return f ? String(f.values[i]) : '0';
    }
  }
}

// Build the full ASCII text for a cloud given an ordered slug list. `delimiter`
// is ' ' for xyz/txt or ',' for csv. The header line uses the slugs; for '#'
// formats pass headerPrefix='# ', for csv pass '' (plain header row).
export function buildAsciiExport(
  data: Pick<PointCloudData, 'positions' | 'colors' | 'intensities' | 'scalarFields'> & { pointCount: number },
  slugs: string[],
  delimiter: string,
  headerPrefix: string,
): string {
  const header = `${headerPrefix}${slugs.join(delimiter)}`;
  const lines: string[] = [header];
  for (let i = 0; i < data.pointCount; i++) {
    lines.push(slugs.map(s => cellValue(data, s, i)).join(delimiter));
  }
  return lines.join('\n');
}

// Move the column at `from` to `to` (drag-reorder), returning a new array.
// Out-of-range indices are clamped; a no-op move returns the same content.
export function reorderColumns(
  columns: ExportColumn[], from: number, to: number,
): ExportColumn[] {
  if (from < 0 || from >= columns.length) return columns.slice();
  const next = columns.slice();
  const [moved] = next.splice(from, 1);
  const clampedTo = Math.max(0, Math.min(to, next.length));
  next.splice(clampedTo, 0, moved);
  return next;
}
