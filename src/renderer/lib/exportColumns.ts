// Column model for ASCII point-cloud / scan export. The export modal lets the
// user pick which fields become columns and in what order, but only for the
// text formats (XYZ / TXT / CSV / Helios scan .xyz) — binary/structured formats
// (LAS/LAZ/PLY/OBJ) have their own fixed schema and ignore this entirely.
//
// A "column" is one exportable field. Geometry (x/y/z) and colour (r/g/b) are
// fixed slugs; every other field is a named scalar (intensity, is_miss, a custom
// scan column, a class label, …) carried on the cloud's scalarFields.

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

// Formats whose columns the user can choose/reorder. Everything else is fixed.
export const ASCII_EXPORT_FORMATS = new Set(['xyz', 'txt', 'csv', 'scan']);

export function isAsciiExportFormat(format: string): boolean {
  return ASCII_EXPORT_FORMATS.has(format);
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
}

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

  if (data.colors || hasColorTokens) {
    cols.push(
      { slug: 'r', label: 'R', kind: 'color', selected: true },
      { slug: 'g', label: 'G', kind: 'color', selected: true },
      { slug: 'b', label: 'B', kind: 'color', selected: true },
    );
  }

  // Gather scalar slugs from both the in-RAM fields and the format string, in a
  // stable union (in-RAM first, then any format-only tokens not already seen).
  const seen = new Set<string>(['x', 'y', 'z', 'r', 'g', 'b']);
  const scalarSlugs: string[] = [];
  for (const slug of Object.keys(data.scalarFields ?? {})) {
    if (!seen.has(slug)) { seen.add(slug); scalarSlugs.push(slug); }
  }
  for (const tok of fmtTokens) {
    if (_GEO_COLOR_TOKENS.has(tok) || tok === 'skip') continue;
    if (!seen.has(tok)) { seen.add(tok); scalarSlugs.push(tok); }
  }

  // Intensity is a distinct, well-known scalar; surface it before the rest.
  if (data.intensities && !scalarSlugs.includes('intensity')) {
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
