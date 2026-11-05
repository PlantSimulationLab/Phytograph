import { AlertTriangle, FileUp, Route, X } from 'lucide-react';
import { DebouncedNumberInput } from './DebouncedNumberInput';
import { trajectoryDurationS } from '../lib/poseStream';
import { UNIT_LABELS, UNIT_ORDER, unitLabel, unitSummary, wouldConvert, type LengthUnit } from '../lib/units';
import {
  GEOMETRY_ROLES,
  ROLE_OPTIONS,
  SCALAR_ROLES,
  SHIFTLESS_KINDS,
  TRAJECTORYLESS_KINDS,
  hasXYZ,
  protectedDropWarnings,
  withColumnImported,
  withColumnPatch,
  withRgbIs255,
  withShiftAxis,
  withShiftEnabled,
  withTrajectoryCleared,
  withUnits,
  type ScanConfig,
} from '../lib/pointCloudImportOptions';

// The point-cloud import options for ONE scan config: column mapping over the
// file's first rows, source units, global shift and platform trajectory.
// Controlled — every edit goes through `onEdit` as a pure (cfg) -> cfg
// transform from lib/pointCloudImportOptions, so the host decides what an edit
// touches (the wizard: the scan on screen, plus apply-to-all; the file
// browser: the one config shared by the whole selection). Rendered by both
// PointCloudImportWizard and the File -> Import browser.
export interface PointCloudImportOptionsProps {
  cfg: ScanConfig | undefined;
  // `scope` says what the edit is about: 'column' edits address columns by
  // index and so only mean something for the file they were made on; 'global'
  // edits (units, shift, RGB scale, trajectory) describe the whole import. The
  // file browser keys column edits to the file on screen; the wizard, which
  // edits one scan at a time, ignores it.
  onEdit: (fn: (c: ScanConfig) => ScanConfig, scope: 'column' | 'global') => void;
  // Trajectory import picks a file and may fill other scans, so the host owns it.
  onImportTrajectory: () => void;
  // Extra sentence in the trajectory blurb (how a trajectory spreads across a
  // batch); omitted for a single scan.
  trajectoryNote?: string;
}

export function PointCloudImportOptions({ cfg, onEdit, onImportTrajectory, trajectoryNote }: PointCloudImportOptionsProps) {
  const sampleRows = cfg?.preview?.sample_rows ?? [];
  return (
    <>
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
                        {/* Import checkbox — the one uniform way to drop a
                            column, in every format. Omitted for X/Y/Z:
                            `hasXYZ` already blocks Import without all three,
                            so an untick there could only produce a
                            dead-end. */}
                        {!GEOMETRY_ROLES.has(col.role) && (
                          <label className="flex items-center gap-1.5 mb-1 cursor-pointer text-[10px] text-neutral-300 select-none">
                            <input
                              type="checkbox"
                              data-testid="import-wizard-include"
                              checked={col.imported}
                              onChange={(e) => onEdit((c) => withColumnImported(c, col.index, e.target.checked), 'column')}
                              className="accent-blue-500"
                            />
                            Import
                          </label>
                        )}
                        {/* Role dropdown. 'Scalar' = continuous gradient,
                            'Label' = categorical (discrete classes). For
                            in-file formats (PLY/PCD/LAS/E57) the file fixes
                            the layout, so roles can't be reassigned — EXCEPT a
                            scalar column can still toggle Scalar↔Label, since
                            that's a renderer-side coloring choice, not a
                            re-mapping of the file. A fixed non-scalar role
                            (X/Y/Z/Intensity/RGB) shows its OWN role as a lone
                            disabled option, so the select displays "X" rather
                            than falling back to the first list entry. */}
                        <select
                          data-testid="import-wizard-role"
                          value={col.imported ? col.role : 'skip'}
                          disabled={(!col.remappable && !col.roleAssignable && !isScalar) || !col.imported}
                          onChange={(e) => onEdit((c) => withColumnPatch(c, col.index, { role: e.target.value }), 'column')}
                          className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {(col.remappable
                            ? ROLE_OPTIONS
                            : col.roleAssignable
                              // A fixed-layout SCALAR: the layout is the
                              // file's, but the column's meaning is not —
                              // an ExtraBytes name is a vendor string we may
                              // not recognize. Offer the full role list
                              // minus the geometry roles, which genuinely
                              // are fixed by the reader.
                              ? ROLE_OPTIONS.filter((o) => !GEOMETRY_ROLES.has(o.value))
                            : isScalar
                              ? ROLE_OPTIONS.filter((o) => SCALAR_ROLES.has(o.value))
                              // A dropped in-file column keeps 'Skip' as its
                              // displayed value so the select doesn't fall
                              // back to the first list entry and show a role
                              // the column no longer has.
                              : ROLE_OPTIONS.filter((o) => o.value === col.role || (!col.imported && o.value === 'skip')))
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
                              // An in-file column keeps the file's slug —
                              // drops, keeps, role overrides and categorical
                              // registration all name it by that — so its
                              // rename is display-only (see scalarLabels).
                              onChange={(e) => onEdit((c) => withColumnPatch(c, col.index, col.remappable
                                ? { label: e.target.value, slug: e.target.value }
                                : { label: e.target.value }), 'column')}
                              className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                            />
                            {suggestLabel && (
                              <button
                                type="button"
                                data-testid="import-wizard-suggest-label"
                                onClick={() => onEdit((c) => withColumnPatch(c, col.index, { role: 'label' }), 'column')}
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
                            col.role === 'skip' || !col.imported ? 'text-neutral-600' : ''
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
              PCD/LAS) the color scale is known from the file — the converter
              normalizes it — so the toggle would be misleading dead UI:
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
                  onChange={() => onEdit((c) => withRgbIs255(c, true), 'global')}
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
                  onChange={() => onEdit((c) => withRgbIs255(c, false), 'global')}
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

          {/* Dropping a field that a tool looks up BY NAME doesn't error —
              the capability just quietly disappears — so name the field and
              what stops working. Not a block: an all-zero is_miss on a
              hits-only export is exactly the dead weight worth dropping. */}
          {protectedDropWarnings(cfg).length > 0 && (
            <div
              data-testid="import-wizard-drop-warning"
              className="flex items-start gap-2 text-[11px] text-amber-300"
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <div>
                <div>Skipping these disables the tools that read them:</div>
                <ul className="mt-0.5 list-disc list-inside text-amber-300/90">
                  {protectedDropWarnings(cfg).map((w) => <li key={w}>{w}</li>)}
                </ul>
              </div>
            </div>
          )}

        </>
      )}

      {/* In-file format note (PLY/PCD/LAS/LAZ): roles fixed, rename/categorical only. */}
      {cfg && !cfg.loading && !cfg.autoOnly && cfg.preview && cfg.columns.every((c) => !c.remappable) && cfg.columns.length > 0 && (
        <div className="text-[10px] text-neutral-500">
          This format defines its own column layout, so X/Y/Z and color roles can't be
          reassigned. You can still untick <span className="text-neutral-400">Import</span> to
          leave a field out, rename scalar fields, and switch any scalar between
          <span className="text-neutral-400"> Scalar</span> (gradient) and
          <span className="text-neutral-400"> Label</span> (discrete classes).
        </div>
      )}

      {/* Source units. Placed ABOVE the global shift because a unit logically
          precedes a shift magnitude — and literally so here: the backend
          scales positions to meters BEFORE subtracting the shift, and the
          suggested shift shown below is already expressed in meters.

          Phytograph works in meters throughout (LAD's m²/m³, QSM's radii,
          CSF's cloth resolution), so a non-meter cloud is converted at
          import rather than carried. When the format declared the unit
          this states a fact; otherwise it is a choice, defaulted to meters
          — which is what every import assumed implicitly before this
          existed, so leaving it alone changes nothing. */}
      {/* Rendered even when the preview FAILED, unlike the shift and
          trajectory blocks. A unit is a user choice that needs no preview —
          and a failed preview is exactly what disabled detection, so this is
          the one control that is MORE necessary then, not less. Without it
          a feet LAS whose header laspy choked on would import silently
          unscaled, on a screen that says import will still work. */}
      {cfg && !cfg.loading && (
        <div
          data-testid="import-wizard-units"
          data-units={cfg.units}
          data-units-certain={cfg.unitsCertain ? 'true' : 'false'}
          className="border border-neutral-700 rounded-lg px-3 py-2.5 space-y-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-neutral-200">Source units</span>
            {cfg.unitsCertain && (
              <span className="text-[10px] text-lime-400/90">— detected from file</span>
            )}
            {wouldConvert(cfg.units) && (
              <span className="text-[10px] text-amber-300/90">— will convert</span>
            )}
          </div>
          <select
            data-testid="import-wizard-units-select"
            value={cfg.units}
            onChange={(e) => onEdit((c) => withUnits(c, e.target.value as LengthUnit), 'global')}
            className="w-44 bg-neutral-900 border border-neutral-700 rounded px-2 py-1
                       text-[11px] text-neutral-200 focus:outline-none focus:border-neutral-500"
          >
            {UNIT_ORDER.map((u) => (
              <option key={u} value={u}>{UNIT_LABELS[u]}</option>
            ))}
          </select>
          <p className="text-[10px] text-neutral-500 leading-snug">
            {unitSummary(cfg.units, cfg.unitsCertain)}
            {' '}Phytograph works in meters, so every scan is converted at import.
          </p>
        </div>
      )}

      {/* Global shift (CloudCompare-style). Subtracts a large offset from every
          point at import so coordinates are small and easy to work with — and so
          the viewport doesn't lose float32 precision (kinked grid / flickering
          meshes). Auto-suggested + on by default for large (e.g. UTM) clouds;
          the original coordinates are restored on export. Shown for every
          previewed scan, including auto-detect-only ones — EXCEPT formats
          whose importer has no shift to apply (see SHIFTLESS_KINDS). */}
      {cfg && !cfg.loading && !cfg.error
        && !SHIFTLESS_KINDS.has(cfg.preview?.kind ?? '') && (
        <div
          data-testid="import-wizard-shift"
          className="border border-neutral-700 rounded-lg px-3 py-2.5 space-y-2"
        >
          <label className="flex items-center gap-2 text-[11px] text-neutral-200 cursor-pointer">
            <input
              type="checkbox"
              data-testid="import-wizard-shift-enabled"
              checked={cfg.shiftEnabled}
              onChange={(e) => onEdit((c) => withShiftEnabled(c, e.target.checked), 'global')}
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
            {/* Only the SHIFT is undone on export — the unit conversion is
                not, so a converted cloud exports as meters. Saying
                "original coordinates are restored" unqualified would be a
                false promise for exactly the files this feature touches. */}
            {wouldConvert(cfg.units) && (
              <> Values here are in <strong className="text-neutral-400">meters</strong>,
              like the converted cloud; exports are in meters, not the file’s
              original {unitLabel(cfg.units).toLowerCase()}.</>
            )}
          </p>
          <div className="flex items-center gap-3">
            {(['x', 'y', 'z'] as const).map((axis) => (
              <label key={axis} className="flex items-center gap-1.5 text-[11px] text-neutral-300">
                <span className="uppercase w-3 text-neutral-400">{axis}</span>
                <DebouncedNumberInput
                  value={cfg.shift[axis]}
                  onCommit={(n) => onEdit((c) => withShiftAxis(c, axis, n), 'global')}
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

      {/* Platform trajectory (mobile-mapping / MLS). Optional: attach a
          trajectory file so the imported scan is treated as a moving-platform
          acquisition — leaf-area inversion then reconstructs a per-beam origin
          per return by joining each return's timestamp to the path. Importing
          one on any scan auto-populates the others (one pass, many files); each
          scan can still get its own. Shown for every previewed scan EXCEPT
          formats that carry their own platform information (see
          TRAJECTORYLESS_KINDS). */}
      {cfg && !cfg.loading && !cfg.error
        && !TRAJECTORYLESS_KINDS.has(cfg.preview?.kind ?? '') && (
        <div
          data-testid="import-wizard-trajectory"
          className="border border-neutral-700 rounded-lg px-3 py-2.5 space-y-2"
        >
          <div className="flex items-center gap-2 text-[11px] text-neutral-200">
            <Route className="w-3.5 h-3.5 text-neutral-400" />
            <span className="font-medium">Platform trajectory</span>
            <span className="text-[10px] text-neutral-500">— mobile / MLS data (optional)</span>
          </div>
          <p className="text-[10px] text-neutral-500 leading-snug">
            For mobile-platform (drone, robot, vehicle) scans, attach the platform
            trajectory so leaf-area density uses a per-beam origin reconstructed from
            the path. {trajectoryNote} Leave empty for a static tripod scan or if there are beam origin columns in the scan data.
          </p>
          {cfg.trajectory ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs text-white truncate" data-testid="import-wizard-trajectory-label">
                  {cfg.trajectory.label ?? 'trajectory'}
                  {!cfg.trajectoryExplicit && (
                    <span className="ml-1.5 text-[10px] text-neutral-400">(from another scan)</span>
                  )}
                </p>
                <p className="text-[10px] text-neutral-400">
                  {cfg.trajectory.poses.length} poses · {trajectoryDurationS(cfg.trajectory).toFixed(2)} s
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  type="button"
                  onClick={onImportTrajectory}
                  data-testid="import-wizard-trajectory-replace"
                  className="px-2 py-1 text-[11px] bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 transition-colors"
                >
                  Replace…
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(withTrajectoryCleared, 'global')}
                  data-testid="import-wizard-trajectory-clear"
                  className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors"
                  title="Remove trajectory"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={onImportTrajectory}
              data-testid="import-wizard-trajectory-import"
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 transition-colors"
            >
              <FileUp className="w-3.5 h-3.5" /> Import trajectory file…
            </button>
          )}
          {cfg.trajectoryError && (
            <div className="flex items-start gap-1.5 text-[10px] text-red-300">
              <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
              <span data-testid="import-wizard-trajectory-error">{cfg.trajectoryError}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
