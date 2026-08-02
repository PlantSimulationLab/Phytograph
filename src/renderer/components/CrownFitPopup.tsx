import { useState, useCallback, useMemo, useEffect } from 'react';
import { X, TreeDeciduous, AlertTriangle } from 'lucide-react';
import type { Scan } from '../lib/scan';
import { hasData, scanDisplayName } from '../lib/scan';
import {
  evaluateScanForCrownFit,
  coerceCrownFitOptions,
  DEFAULT_CROWN_FIT_OPTIONS,
  CROWN_SHAPES,
  CROWN_SHAPE_LABELS,
  CROWN_FIT_OPTIONS_STORE_KEY,
  MAX_STRICTNESS,
  type CrownShape,
  type CrownFitScanEligibility,
} from '../lib/crownFit';
import { ObjectPicker, type PickerItem } from './ObjectPicker';
import { DebouncedNumberInput } from './DebouncedNumberInput';
import { InfoHint } from './InfoHint';

// The args the parent's handler receives when the user clicks "Fit crowns".
// `eligibility` is keyed by scan id so the handler knows, per scan, how to fit
// (leaf-only? which tree ids? ground baseline?) without re-deriving it.
export interface CrownFitStartArgs {
  scanIds: string[];
  shape: CrownShape;
  strictness: number;
  alpha: number | null;
  exportCsv: boolean;
  eligibility: Map<string, CrownFitScanEligibility>;
}

interface CrownFitPopupProps {
  isOpen: boolean;
  onClose: () => void;
  onStartFit: (args: CrownFitStartArgs) => void;
  scans: Scan[];
  initialSelectedIds?: Set<string>;
}

const SHAPE_DESCRIPTIONS: Record<CrownShape, string> = {
  ellipsoid: 'Smooth upright ellipsoid — a good default for rounded, broadleaf crowns.',
  prism: 'Axis-aligned bounding box around the crown — reports width × depth × height directly.',
  cone: 'Upright cone (apex at the crown top) — suits conifers and young trees.',
  alpha: 'Smooth watertight concave hull that hugs the crown outline — the most faithful shape.',
};

export function CrownFitPopup({
  isOpen,
  onClose,
  onStartFit,
  scans,
  initialSelectedIds,
}: CrownFitPopupProps) {
  const [opts, setOpts] = useState(DEFAULT_CROWN_FIT_OPTIONS);
  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());

  // Every scan that has point data is a candidate; eligibility decides whether
  // it's fittable (and what warning to show). Recomputed when the scan set changes.
  const eligibility = useMemo(() => {
    const map = new Map<string, CrownFitScanEligibility>();
    for (const scan of scans) {
      if (hasData(scan)) map.set(scan.id, evaluateScanForCrownFit(scan));
    }
    return map;
  }, [scans]);

  // Load remembered options + seed the selection from the incoming viewport
  // selection (only the eligible ones) each time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const stored = await window.electronAPI?.store?.get?.(CROWN_FIT_OPTIONS_STORE_KEY);
        if (!cancelled) setOpts(coerceCrownFitOptions(stored));
      } catch {
        if (!cancelled) setOpts(DEFAULT_CROWN_FIT_OPTIONS);
      }
    })();
    const seed = new Set<string>();
    for (const id of initialSelectedIds ?? []) {
      const e = eligibility.get(id);
      if (e?.eligible) seed.add(id);
    }
    setSelectedScanIds(seed);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const items: PickerItem[] = useMemo(() => {
    return scans.filter(hasData).map((scan) => {
      const e = eligibility.get(scan.id);
      const treeCount = e?.treeInstanceIds?.length ?? 0;
      const detail =
        treeCount >= 2 ? `${treeCount} trees` : `${(scan.data?.pointCount ?? 0).toLocaleString()} pts`;
      return {
        id: scan.id,
        label: scanDisplayName(scan),
        color: scan.color,
        detail,
        disabledReason: e?.disabledReason,
      };
    });
  }, [scans, eligibility]);

  // Warnings for the currently-selected scans, deduped, for the banner.
  const selectedWarnings = useMemo(() => {
    const seen = new Set<string>();
    for (const id of selectedScanIds) {
      const w = eligibility.get(id)?.warning;
      if (w) seen.add(w);
    }
    return [...seen];
  }, [selectedScanIds, eligibility]);

  const canFit = selectedScanIds.size > 0;

  const handleFit = useCallback(() => {
    if (!canFit) return;
    const finalOpts = { ...opts };
    // Remember the options for next time (fire-and-forget).
    window.electronAPI?.store?.set?.(CROWN_FIT_OPTIONS_STORE_KEY, finalOpts);
    onStartFit({
      scanIds: [...selectedScanIds],
      shape: finalOpts.shape,
      strictness: finalOpts.strictness,
      alpha: finalOpts.alpha,
      exportCsv: finalOpts.exportCsv,
      eligibility,
    });
    onClose();
  }, [canFit, opts, selectedScanIds, eligibility, onStartFit, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        data-testid="crown-fit-popup"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-2xl mx-4 overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <TreeDeciduous className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Fit Crown &amp; Metrics</h2>
          </div>
          <button
            data-testid="crown-fit-close"
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 transition-colors"
          >
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Scan selection. Each scan must be a segmented individual tree with
              the ground handled; ineligible scans are greyed with a reason. */}
          <ObjectPicker
            data-testid="crown-scan-picker"
            label="Scans to fit"
            items={items}
            selectedIds={selectedScanIds}
            onChange={setSelectedScanIds}
            mode="multi"
            emptyMessage="No scans with point data. Import a segmented tree cloud first."
          />

          {/* Aggregate warning banner: missing labels are ambiguous (manual vs
              forgot-to-run), so we warn rather than block. */}
          {selectedWarnings.length > 0 && (
            <div
              data-testid="crown-fit-warning"
              className="flex gap-2 rounded-lg border border-amber-600/40 bg-amber-900/20 p-3"
            >
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="space-y-1 text-[11px] leading-snug text-amber-200/90">
                {selectedWarnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            </div>
          )}

          {/* Shape selector. */}
          <div>
            <label className="text-xs font-medium text-neutral-300 mb-1 block">Crown shape</label>
            <select
              data-testid="crown-shape-select"
              value={opts.shape}
              onChange={(e) => setOpts((o) => ({ ...o, shape: e.target.value as CrownShape }))}
              className="w-full bg-neutral-700 text-neutral-100 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:outline-none focus:border-neutral-500"
            >
              {CROWN_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {CROWN_SHAPE_LABELS[s]}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-neutral-500 mt-1">{SHAPE_DESCRIPTIONS[opts.shape]}</p>
          </div>

          {/* Strictness / fuzziness. */}
          <div>
            <label className="text-xs font-medium text-neutral-300 mb-1 flex items-center gap-1">
              Fuzziness
              <InfoHint
                label="Fuzziness"
                text="How aggressively lone branches shooting outside the general crown are trimmed before fitting. 0 = keep every point (the shape fully encloses the crown, including stray branches). Higher values trim the outermost points so an outlier branch doesn't inflate the shape with empty space."
              />
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={MAX_STRICTNESS}
                step={0.05}
                value={opts.strictness}
                onChange={(e) => setOpts((o) => ({ ...o, strictness: parseFloat(e.target.value) }))}
                className="flex-1"
                data-testid="crown-strictness-slider"
              />
              <div className="w-20">
                <DebouncedNumberInput
                  data-testid="crown-strictness-input"
                  value={opts.strictness}
                  onCommit={(n) => setOpts((o) => ({ ...o, strictness: n }))}
                  min={0}
                  max={MAX_STRICTNESS}
                  debounceMs={0}
                  className="w-full bg-neutral-700 text-neutral-100 text-xs rounded px-2 py-1 border border-neutral-600"
                />
              </div>
            </div>
          </div>

          {/* Alpha-shape-only: optional radius override. */}
          {opts.shape === 'alpha' && (
            <div>
              <label className="text-xs font-medium text-neutral-300 mb-1 flex items-center gap-1">
                Alpha radius (m)
                <InfoHint
                  label="Alpha radius"
                  text="Controls how tightly the alpha shape hugs the crown. Leave blank for auto — the fit grows the radius until it forms a single, closed (watertight) surface. Set a value to override: larger bridges gaps (smoother, more convex); smaller follows finer concavities but can leave the surface open."
                />
              </label>
              <input
                type="text"
                inputMode="decimal"
                data-testid="crown-alpha-input"
                placeholder="auto"
                value={opts.alpha ?? ''}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  const n = parseFloat(v);
                  setOpts((o) => ({ ...o, alpha: v !== '' && Number.isFinite(n) && n > 0 ? n : null }));
                }}
                className="w-28 bg-neutral-700 text-neutral-100 text-xs rounded px-2 py-1 border border-neutral-600 focus:outline-none focus:border-neutral-500"
              />
            </div>
          )}

          {/* CSV export toggle. downloadFile opens the native save dialog itself. */}
          <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer">
            <input
              type="checkbox"
              data-testid="crown-export-csv"
              checked={opts.exportCsv}
              onChange={(e) => setOpts((o) => ({ ...o, exportCsv: e.target.checked }))}
              className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-green-500 focus:ring-0"
            />
            Export crown metrics to CSV (one row per crown)
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-neutral-300 rounded hover:bg-neutral-700 transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="crown-fit-run"
            onClick={handleFit}
            disabled={!canFit}
            className="px-3 py-1.5 text-xs font-medium text-white rounded bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Fit crowns
          </button>
        </div>
      </div>
    </div>
  );
}
