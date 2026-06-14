import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, ChevronLeft, ChevronRight, FileUp, AlertTriangle } from 'lucide-react';
import {
  previewPointCloud,
  type PointCloudPreviewResponse,
  type PreviewColumn,
  type ColumnPlan,
  type ColumnPlanEntry,
} from '../utils/backendApi';
import type { ScanParameters } from '../lib/scanParameters';
import { showToast } from './Toast';
import { DebouncedNumberInput } from './DebouncedNumberInput';

// One scan to walk the user through. `path` is REQUIRED — the wizard previews
// by reading the file on disk; callers without a path (Blob fixtures) should
// bypass the wizard. `asciiFormatHint`/`params` ride along from a Helios XML
// import so the eventual Scan can carry them.
export interface WizardScanInput {
  path: string;
  fileName: string;
  asciiFormatHint?: string | null;
  params?: ScanParameters;
  label?: string;
  color?: string;
}

// What the wizard hands back per scan. App turns these into actual Scans by
// calling parsePointCloudFromPath(path, asciiFormat, columnPlan, categoricalSlugs).
export interface WizardResult {
  input: WizardScanInput;
  asciiFormat: string | null;
  columnPlan: ColumnPlan | null;   // null → let the backend auto-detect
  categoricalSlugs: string[];
  // CloudCompare-style global shift [x, y, z] to SUBTRACT from every point at
  // import, or null to keep the original coordinates. Auto-suggested from the
  // preview for large (e.g. UTM) clouds; the user can edit or disable it.
  worldShift: [number, number, number] | null;
}

interface PointCloudImportWizardProps {
  inputs: WizardScanInput[];
  onCancel: () => void;
  onComplete: (results: WizardResult[]) => void;
}

// Roles the user can assign to a column in the role dropdown. 'extra' = carry as
// a named scalar field; 'skip' = drop. r/g/b scale is handled by a separate
// per-scan toggle, so the dropdown only exposes the generic 'rgb' members.
// 'extra' = a continuous scalar field (gradient); 'label' = a categorical
// class field (discrete colours + legend). Both become an octree extra dim;
// they differ only in how the renderer colours them. 'skip' = drop. RGB scale
// is handled by a separate per-scan toggle, so the dropdown exposes plain r/g/b.
const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'x', label: 'X' },
  { value: 'y', label: 'Y' },
  { value: 'z', label: 'Z' },
  { value: 'r', label: 'Red' },
  { value: 'g', label: 'Green' },
  { value: 'b', label: 'Blue' },
  { value: 'intensity', label: 'Intensity' },
  { value: 'reflectance', label: 'Reflectance' },
  { value: 'row_index', label: 'Scan Row Index' },
  { value: 'column_index', label: 'Scan Column Index' },
  { value: 'extra', label: 'Scalar' },
  { value: 'label', label: 'Label' },
  { value: 'skip', label: 'Skip' },
];
// 'row_index'/'column_index' are structured-scan raster indices: integer (row,
// column) positions within the scanner's rectangular acquisition grid. They
// pass straight through buildColumnPlan as their own role token — the backend
// pins them to canonical extra-dim slugs so the gap-filling / miss-recovery
// path can reconstruct the raster — so they need no rename box and aren't in
// SCALAR_ROLES below.

// Roles that carry a named scalar field (and so get a rename box). 'label' is
// the categorical variant of 'extra'.
const SCALAR_ROLES = new Set(['extra', 'label']);

// Per-column editable state in the wizard.
interface ColumnConfig {
  index: number;
  headerName: string | null;
  role: string;            // one of ROLE_OPTIONS values (RGB normalised to r/g/b)
  slug: string;            // editable for extra/label columns
  label: string;           // rename target
  typeHint: string;
  remappable: boolean;
}

interface ScanConfig {
  preview: PointCloudPreviewResponse | null;
  loading: boolean;
  error: string | null;     // hard failure → offer auto-detect import
  warning: string | null;
  columns: ColumnConfig[];
  rgbIs255: boolean;
  // True when preview returned no usable columns; the wizard then only offers
  // "import with auto-detect" for this scan.
  autoOnly: boolean;
  // CloudCompare-style global shift. `shiftEnabled` gates whether it's applied;
  // `shift` holds the per-axis offset to SUBTRACT. Seeded from the preview's
  // `suggested_shift` (enabled when the cloud's coords are large), with Z left at
  // 0/keep by default since elevation is rarely huge. The user can edit/toggle.
  shiftEnabled: boolean;
  shift: { x: number; y: number; z: number };
}

// Normalise a backend-detected role to the wizard's RGB convention: the backend
// reports r255/g255/b255, but the wizard models RGB scale with a single toggle
// and the plain r/g/b roles.
function normaliseRole(role: string): string {
  if (role === 'r255') return 'r';
  if (role === 'g255') return 'g';
  if (role === 'b255') return 'b';
  return role;
}

function configFromColumn(c: PreviewColumn): ColumnConfig {
  let role = normaliseRole(c.detected_role);
  // The backend reports an unrecognised ASCII column as 'skip', but auto-detect
  // import CARRIES it as a scalar field (it has a suggested slug). Default such
  // columns to 'extra' so the wizard's no-edit behaviour matches the old
  // auto-detect — otherwise a default import would silently drop scalars.
  if (role === 'skip' && c.remappable && c.suggested_slug) {
    role = 'extra';
  }
  return {
    index: c.index,
    headerName: c.header_name,
    // Default a carried scalar to 'extra' (continuous), never 'label', so a
    // no-edit import matches the old auto-detect colouring — a field that used
    // to render as a gradient shouldn't silently become discrete. The type hint
    // instead suggests switching to 'Label' when the values look categorical.
    role,
    slug: c.suggested_slug,
    label: c.suggested_label,
    typeHint: c.type_hint,
    remappable: c.remappable,
  };
}

function blankScanConfig(): ScanConfig {
  return {
    preview: null, loading: true, error: null, warning: null,
    columns: [], rgbIs255: true, autoOnly: false,
    shiftEnabled: false, shift: { x: 0, y: 0, z: 0 },
  };
}

// The shift [x, y, z] for a scan, or null when disabled / all-zero (a zero shift
// is a no-op, so don't bother sending it). Returned to the caller in WizardResult.
function effectiveShift(cfg: ScanConfig): [number, number, number] | null {
  if (!cfg.shiftEnabled) return null;
  const { x, y, z } = cfg.shift;
  if (x === 0 && y === 0 && z === 0) return null;
  return [x, y, z];
}

// Does this scan's column config have all of x, y, z assigned? Required before
// import for remappable (ASCII) formats; in-file formats are always ready.
function hasXYZ(cfg: ScanConfig): boolean {
  if (cfg.autoOnly) return true; // auto-detect will sort it out (or error clearly)
  const anyRemappable = cfg.columns.some((c) => c.remappable);
  if (!anyRemappable) return true;
  const roles = new Set(cfg.columns.map((c) => c.role));
  return roles.has('x') && roles.has('y') && roles.has('z');
}

// Build the ColumnPlan to send to the backend for a remappable (ASCII) scan.
// Returns null when the scan isn't remappable (in-file layout) or when the user
// left everything at auto-detected defaults with no edits — in which case we let
// the backend auto-detect (smaller request, identical result).
function buildColumnPlan(cfg: ScanConfig): ColumnPlan | null {
  if (cfg.autoOnly) return null;
  const anyRemappable = cfg.columns.some((c) => c.remappable);
  if (!anyRemappable) return null;

  const columns: ColumnPlanEntry[] = cfg.columns.map((c) => {
    const isScalar = SCALAR_ROLES.has(c.role);
    // Both 'extra' (Scalar) and 'label' (Label) become a backend extra dim;
    // the backend only knows the 'extra' token, so map both to it and carry the
    // categorical-ness via the flag ('label' → categorical).
    let role = isScalar ? 'extra' : c.role;
    // RGB roles map to r255/g255/b255 when the scan is 0-255, else the 0-1 r/g/b
    // tokens, so the backend reads the right scale.
    if (role === 'r' || role === 'g' || role === 'b') {
      role = cfg.rgbIs255 ? `${role}255` : role;
    }
    return {
      index: c.index,
      role,
      slug: isScalar ? c.slug : null,
      label: isScalar ? c.label : null,
      categorical: c.role === 'label',
    };
  });
  return { columns, rgbIs255: cfg.rgbIs255 };
}

// Slugs mapped to the 'Label' role for a scan — registered for categorical
// (discrete) colouring after import.
function categoricalSlugs(cfg: ScanConfig): string[] {
  return cfg.columns
    .filter((c) => c.role === 'label')
    .map((c) => c.slug)
    .filter(Boolean);
}

export function PointCloudImportWizard({ inputs, onCancel, onComplete }: PointCloudImportWizardProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [configs, setConfigs] = useState<ScanConfig[]>(() => inputs.map(blankScanConfig));
  const [applyToAll, setApplyToAll] = useState(false);
  // Furthest scan the user has reached via Next. For a multi-scan import we only
  // enable the Import button once they've either stepped through every scan
  // (maxStepReached === last) or checked "apply to all" — otherwise it's too easy
  // to import without realising the per-scan choices on later scans went unseen.
  const [maxStepReached, setMaxStepReached] = useState(0);

  const total = inputs.length;
  const current = inputs[stepIdx];
  const cfg = configs[stepIdx];

  // Preview every input up front (in parallel). Previewing all scans — not just
  // the visited one — is what lets the Import button enable for a multi-file
  // import without forcing the user to step through each one; it also keeps the
  // "apply to all" layout-match check meaningful (every scan's signature known).
  // Preview reads only a file header + a few rows, so N parallel previews stay
  // cheap. Runs once per `inputs` identity.
  useEffect(() => {
    let cancelled = false;
    inputs.forEach((input, i) => {
      (async () => {
        try {
          const preview = await previewPointCloud(input.path, input.asciiFormatHint ?? null);
          if (cancelled) return;
          const columns = preview.columns.map(configFromColumn);
          // Seed the global shift from the backend's suggestion (present only for
          // large/UTM coords). Default Z to keep (0) — elevation is rarely huge —
          // even when a Z suggestion is offered, matching CloudCompare's default.
          const sug = preview.suggested_shift ?? null;
          setConfigs((prev) => prev.map((c, idx) => idx === i ? {
            ...c,
            preview,
            loading: false,
            warning: preview.warning ?? null,
            columns,
            autoOnly: columns.length === 0,
            shiftEnabled: sug != null,
            shift: sug ? { x: sug[0], y: sug[1], z: 0 } : { x: 0, y: 0, z: 0 },
          } : c));
        } catch (e) {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : 'Preview failed';
          setConfigs((prev) => prev.map((c, idx) => idx === i ? {
            ...c, loading: false, error: msg, autoOnly: true,
          } : c));
        }
      })();
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs]);

  const updateColumn = useCallback((colIndex: number, patch: Partial<ColumnConfig>) => {
    setConfigs((prev) => prev.map((c, i) => i === stepIdx ? {
      ...c,
      columns: c.columns.map((col) => col.index === colIndex ? { ...col, ...patch } : col),
    } : c));
  }, [stepIdx]);

  const setRgbIs255 = useCallback((v: boolean) => {
    setConfigs((prev) => prev.map((c, i) => i === stepIdx ? { ...c, rgbIs255: v } : c));
  }, [stepIdx]);

  const setShiftEnabled = useCallback((v: boolean) => {
    setConfigs((prev) => prev.map((c, i) => i === stepIdx ? { ...c, shiftEnabled: v } : c));
  }, [stepIdx]);

  const setShiftAxis = useCallback((axis: 'x' | 'y' | 'z', v: number) => {
    setConfigs((prev) => prev.map((c, i) => i === stepIdx
      ? { ...c, shift: { ...c.shift, [axis]: v } } : c));
  }, [stepIdx]);

  // Copy the current scan's column config onto every other scan whose column
  // signature matches (same count + same header names). Mismatches are skipped
  // with a toast so a 6-col layout never lands on a 4-col file.
  const applyCurrentToAll = useCallback(() => {
    const src = configs[stepIdx];
    if (!src || !src.preview) return;
    const sig = (s: ScanConfig | null) =>
      s && s.preview
        ? `${s.columns.length}|${s.columns.map((c) => c.headerName ?? '').join('')}`
        : null;
    const srcSig = sig(src);
    let applied = 0, skipped = 0;
    setConfigs((prev) => prev.map((c, i) => {
      if (i === stepIdx) return c;
      // Only apply to scans already previewed (we need their signature).
      if (!c.preview) { skipped++; return c; }
      if (sig(c) !== srcSig) { skipped++; return c; }
      applied++;
      return {
        ...c,
        rgbIs255: src.rgbIs255,
        columns: c.columns.map((col, idx) => ({
          ...col,
          role: src.columns[idx]?.role ?? col.role,
          slug: src.columns[idx]?.slug ?? col.slug,
          label: src.columns[idx]?.label ?? col.label,
        })),
      };
    }));
    if (applied > 0) showToast({ title: `Applied settings to ${applied} other scan(s)`, type: 'success' });
    if (skipped > 0) showToast({ title: `Skipped ${skipped} scan(s) with a different column layout`, type: 'info' });
  }, [configs, stepIdx]);

  // Whenever applyToAll is toggled on, propagate immediately and on subsequent
  // edits to the current scan. Keep it simple: re-propagate on explicit action.
  useEffect(() => {
    if (applyToAll) applyCurrentToAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyToAll]);

  const allReady = useMemo(
    () => configs.every((c) => !c.loading && hasXYZ(c)),
    [configs],
  );

  const handleImport = useCallback(() => {
    const results: WizardResult[] = inputs.map((input, i) => {
      const c = configs[i];
      return {
        input,
        asciiFormat: input.asciiFormatHint ?? null,
        columnPlan: buildColumnPlan(c),
        categoricalSlugs: categoricalSlugs(c),
        worldShift: effectiveShift(c),
      };
    });
    onComplete(results);
  }, [inputs, configs, onComplete]);

  const goPrev = () => setStepIdx((i) => Math.max(0, i - 1));
  const goNext = () => setStepIdx((i) => {
    const next = Math.min(total - 1, i + 1);
    setMaxStepReached((m) => Math.max(m, next));
    return next;
  });

  // For a single scan there's nothing to step through; for many, require that the
  // user has either seen every scan (advanced Next to the last) or opted to apply
  // one scan's settings to all.
  const reviewedAll = total <= 1 || applyToAll || maxStepReached >= total - 1;

  const sampleRows = cfg?.preview?.sample_rows ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      <div
        data-testid="import-wizard"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-5xl mx-4 overflow-hidden"
      >
        {/* Header + stepper */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2 min-w-0">
            <FileUp className="w-4 h-4 text-neutral-400 flex-shrink-0" />
            <h2 className="text-sm font-semibold text-white">Import point cloud</h2>
            {total > 1 && (
              <span data-testid="import-wizard-step" className="text-[11px] text-neutral-400 truncate">
                — scan {stepIdx + 1} of {total}: <span className="text-neutral-200">{current?.fileName}</span>
              </span>
            )}
            {total === 1 && (
              <span className="text-[11px] text-neutral-400 truncate">— {current?.fileName}</span>
            )}
          </div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-neutral-700 transition-colors" title="Cancel">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto custom-scrollbar">
          {cfg?.loading && (
            <div data-testid="import-wizard-loading" className="p-6 text-center text-xs text-neutral-400">
              Reading file…
            </div>
          )}

          {cfg?.warning && (
            <div className="flex items-start gap-2 text-[11px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>{cfg.warning}</span>
            </div>
          )}

          {cfg?.error && (
            <div data-testid="import-wizard-error" className="flex items-start gap-2 text-[11px] text-red-300 bg-red-500/5 border border-red-500/30 rounded px-2 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>Couldn't preview this file: {cfg.error}. You can still import with auto-detect.</span>
            </div>
          )}

          {/* Column mapping table — CloudCompare style: each FILE column is a
              visual column. The role dropdown (+ rename / categorical for scalar
              columns) lives in the column header; the file's first rows preview
              underneath so the user maps against real values. Scrolls
              horizontally when there are more columns than fit. */}
          {cfg && !cfg.loading && !cfg.autoOnly && cfg.columns.length > 0 && (
            <>
              <div className="border border-neutral-700 rounded-lg overflow-x-auto custom-scrollbar">
                <table className="border-collapse text-xs" style={{ minWidth: '100%' }}>
                  <thead>
                    <tr className="bg-neutral-900/80">
                      {cfg.columns.map((col) => {
                        const isScalar = SCALAR_ROLES.has(col.role);
                        // Suggest the Label role when the values look like class
                        // labels but the column is still a continuous Scalar.
                        const suggestLabel = col.role === 'extra' && col.typeHint === 'categorical';
                        return (
                          <th
                            key={col.index}
                            data-testid="import-wizard-column"
                            data-col-index={col.index}
                            className="align-top border-b border-r border-neutral-700 last:border-r-0 px-2 py-2 min-w-[9rem]"
                          >
                            {/* Source header name (or positional fallback). */}
                            <div className="text-[10px] text-neutral-400 font-medium truncate mb-1 text-left" title={col.headerName ?? ''}>
                              {col.headerName ?? <span className="italic text-neutral-600">column {col.index + 1}</span>}
                            </div>
                            {/* Role dropdown. 'Scalar' = continuous gradient,
                                'Label' = categorical (discrete classes). For
                                in-file formats (PLY/PCD/LAS/E57) the file fixes
                                the layout, so roles can't be reassigned — EXCEPT a
                                scalar column can still toggle Scalar↔Label, since
                                that's a renderer-side colouring choice, not a
                                re-mapping of the file. A fixed non-scalar role
                                (X/Y/Z/Intensity/RGB) shows its OWN role as a lone
                                disabled option, so the select displays "X" rather
                                than falling back to the first list entry. */}
                            <select
                              data-testid="import-wizard-role"
                              value={col.role}
                              disabled={!col.remappable && !isScalar}
                              onChange={(e) => updateColumn(col.index, { role: e.target.value })}
                              className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {(col.remappable
                                ? ROLE_OPTIONS
                                : isScalar
                                  ? ROLE_OPTIONS.filter((o) => SCALAR_ROLES.has(o.value))
                                  : ROLE_OPTIONS.filter((o) => o.value === col.role))
                                .map((o) => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                            {/* Scalar/Label columns get a rename box. */}
                            {isScalar && (
                              <div className="mt-1.5 space-y-1">
                                <input
                                  type="text"
                                  data-testid="import-wizard-name"
                                  value={col.label}
                                  placeholder="field name"
                                  onChange={(e) => updateColumn(col.index, { label: e.target.value, slug: e.target.value })}
                                  className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                                />
                                {suggestLabel && (
                                  <button
                                    type="button"
                                    data-testid="import-wizard-suggest-label"
                                    onClick={() => updateColumn(col.index, { role: 'label' })}
                                    className="text-[9px] text-amber-400/90 hover:text-amber-300 leading-tight text-left"
                                    title="Sampled values look like class labels"
                                  >
                                    looks categorical — use Label?
                                  </button>
                                )}
                              </div>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="font-mono text-neutral-300">
                    {sampleRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={cfg.columns.length}
                          className="px-2 py-3 text-center text-[11px] text-neutral-500 italic font-sans"
                        >
                          No preview rows available for this file.
                        </td>
                      </tr>
                    ) : (
                      sampleRows.slice(0, 10).map((row, ri) => (
                        <tr
                          key={ri}
                          data-testid="import-wizard-preview-row"
                          className="even:bg-neutral-800/40"
                        >
                          {cfg.columns.map((col) => (
                            <td
                              key={col.index}
                              className={`border-r border-neutral-800 last:border-r-0 px-2 py-1 text-[11px] whitespace-nowrap ${
                                col.role === 'skip' ? 'text-neutral-600' : ''
                              }`}
                            >
                              {row[col.index] ?? ''}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* RGB scale toggle — shown only when an RGB role is present AND
                  the layout is remappable (ASCII). For in-file formats (E57/PLY/
                  PCD/LAS) the colour scale is known from the file — the converter
                  normalises it — so the toggle would be misleading dead UI:
                  buildColumnPlan returns null for non-remappable scans, so
                  rgbIs255 is never even sent. */}
              {cfg.columns.some((c) => (c.role === 'r' || c.role === 'g' || c.role === 'b') && c.remappable) && (
                <div className="flex items-center gap-3 text-[11px] text-neutral-300">
                  <span className="font-medium">RGB range:</span>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      data-testid="import-wizard-rgb-255"
                      name="rgb-scale"
                      checked={cfg.rgbIs255}
                      onChange={() => setRgbIs255(true)}
                      className="accent-blue-500"
                    />
                    0–255 (integer)
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      data-testid="import-wizard-rgb-01"
                      name="rgb-scale"
                      checked={!cfg.rgbIs255}
                      onChange={() => setRgbIs255(false)}
                      className="accent-blue-500"
                    />
                    0–1 (float)
                  </label>
                </div>
              )}

              {!hasXYZ(cfg) && (
                <div className="text-[11px] text-amber-300">
                  Assign X, Y, and Z before importing.
                </div>
              )}

              {total > 1 && (
                <label className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="import-wizard-apply-all"
                    checked={applyToAll}
                    onChange={(e) => setApplyToAll(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-0 cursor-pointer"
                  />
                  Apply these settings to all scans with the same column layout
                </label>
              )}
            </>
          )}

          {/* In-file format note (PLY/PCD/LAS/LAZ): roles fixed, rename/categorical only. */}
          {cfg && !cfg.loading && !cfg.autoOnly && cfg.preview && cfg.columns.every((c) => !c.remappable) && cfg.columns.length > 0 && (
            <div className="text-[10px] text-neutral-500">
              This format defines its own column layout, so X/Y/Z and colour roles can't be
              reassigned. You can still rename scalar fields and switch any scalar between
              <span className="text-neutral-400"> Scalar</span> (gradient) and
              <span className="text-neutral-400"> Label</span> (discrete classes).
            </div>
          )}

          {/* Global shift (CloudCompare-style). Subtracts a large offset from every
              point at import so coordinates are small and easy to work with — and so
              the viewport doesn't lose float32 precision (kinked grid / flickering
              meshes). Auto-suggested + on by default for large (e.g. UTM) clouds;
              the original coordinates are restored on export. Shown for every
              previewed scan, including auto-detect-only ones. */}
          {cfg && !cfg.loading && !cfg.error && (
            <div
              data-testid="import-wizard-shift"
              className="border border-neutral-700 rounded-lg px-3 py-2.5 space-y-2"
            >
              <label className="flex items-center gap-2 text-[11px] text-neutral-200 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="import-wizard-shift-enabled"
                  checked={cfg.shiftEnabled}
                  onChange={(e) => setShiftEnabled(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-0 cursor-pointer"
                />
                <span className="font-medium">Apply global shift</span>
                {cfg.preview?.suggested_shift != null && (
                  <span className="text-[10px] text-amber-300/90">
                    — large coordinates detected
                  </span>
                )}
              </label>
              <p className="text-[10px] text-neutral-500 leading-snug">
                Subtracts this offset from every point so coordinates stay small and the
                viewport renders cleanly. The original (global) coordinates are restored
                when you export.
              </p>
              <div className="flex items-center gap-3">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <label key={axis} className="flex items-center gap-1.5 text-[11px] text-neutral-300">
                    <span className="uppercase w-3 text-neutral-400">{axis}</span>
                    <DebouncedNumberInput
                      value={cfg.shift[axis]}
                      onCommit={(n) => setShiftAxis(axis, n)}
                      disabled={!cfg.shiftEnabled}
                      debounceMs={0}
                      data-testid={`import-wizard-shift-${axis}`}
                      aria-label={`Global shift ${axis.toUpperCase()}`}
                      className="w-32 px-2 py-1 text-xs bg-neutral-900 border border-neutral-700 rounded text-neutral-100 disabled:opacity-40 focus:outline-none focus:border-blue-500"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            {total > 1 && (
              <>
                <button
                  onClick={goPrev}
                  disabled={stepIdx === 0}
                  data-testid="import-wizard-prev"
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Back
                </button>
                <button
                  onClick={goNext}
                  disabled={stepIdx >= total - 1}
                  data-testid="import-wizard-next"
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {total > 1 && !reviewedAll && (
              <span data-testid="import-wizard-review-hint" className="text-[11px] text-neutral-400">
                Step through every scan, or check “apply to all”, to import.
              </span>
            )}
            <button
              onClick={onCancel}
              data-testid="import-wizard-cancel"
              className="px-3 py-1.5 text-xs text-neutral-300 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleImport}
              disabled={!allReady || !reviewedAll}
              data-testid="import-wizard-import"
              className="px-4 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Import {total > 1 ? `${total} scans` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
