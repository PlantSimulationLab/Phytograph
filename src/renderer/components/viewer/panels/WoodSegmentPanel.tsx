import { Trees, Loader2, X } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

// Output mode for wood/leaf segmentation:
//  - 'label': keep all points, write the wood_class column, colour by it.
//  - 'split': also emit separate wood-only and leaf-only child clouds.
//  - 'remove': drop the wood points, leaving a leaf-only cloud (wood removal).
export type WoodSegmentMode = 'label' | 'split' | 'remove';

// When >1 scan is selected: 'aggregate' segments them TOGETHER (denser local
// neighbourhoods — for multi-view scans of one tree, must be pre-aligned), then
// scatters the labels back to each scan; 'per-scan' segments each independently.
export type WoodMultiMode = 'aggregate' | 'per-scan';

// Presentational tool panel for wood/leaf segmentation. The `onSegment` handler
// and all state live in PointCloudViewer; the parent gates rendering on
// `showWoodSegmentPanel && selectedIds.size >= 1`.
interface WoodSegmentPanelProps {
  woodBias: number;
  kMax: number;
  regIters: number;
  mode: WoodSegmentMode;
  multiMode: WoodMultiMode;
  selectedCount: number;
  inProgress: boolean;
  error: string | null;
  // Reflectance assist: only meaningful when the selected cloud carries a
  // per-point reflectance/intensity scalar. `reflectanceAvailable` gates whether
  // the toggle is shown at all; `useReflectance` is the user's on/off choice
  // (defaulted on when available — the per-cloud weighting makes it harmless on
  // low-contrast species).
  reflectanceAvailable: boolean;
  useReflectance: boolean;
  onClose: () => void;
  onWoodBiasChange: (n: number) => void;
  onKMaxChange: (n: number) => void;
  onRegItersChange: (n: number) => void;
  onModeChange: (m: WoodSegmentMode) => void;
  onMultiModeChange: (m: WoodMultiMode) => void;
  onUseReflectanceChange: (b: boolean) => void;
  onSegment: () => void;
}

export function WoodSegmentPanel({
  woodBias,
  kMax,
  regIters,
  mode,
  multiMode,
  selectedCount,
  inProgress,
  error,
  reflectanceAvailable,
  useReflectance,
  onClose,
  onWoodBiasChange,
  onKMaxChange,
  onRegItersChange,
  onModeChange,
  onMultiModeChange,
  onUseReflectanceChange,
  onSegment,
}: WoodSegmentPanelProps) {
  return (
    <div data-testid="wood-segment-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Trees className="w-3 h-3" />
          Wood / Leaf Segmentation
        </div>
        <button onClick={onClose} className="p-1 hover:bg-neutral-700 rounded">
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        Separates woody structure (trunk, branches) from leaves using local
        geometry. Crop the ground first. Higher sensitivity classifies more
        points as wood.
      </div>

      {/* Multi-scan mode: segment selected scans together (denser, for multi-
          view scans of one tree) or each separately. Only shown for >1 scan. */}
      {selectedCount > 1 && (
        <div data-testid="wood-multi-mode" className="mb-3">
          <div className="text-[10px] text-neutral-400 mb-1">
            {selectedCount} scans selected
          </div>
          <label className="flex items-start gap-2 mb-1.5 cursor-pointer">
            <input
              data-testid="wood-mode-aggregate"
              type="radio"
              name="wood-multi-mode"
              checked={multiMode === 'aggregate'}
              onChange={() => onMultiModeChange('aggregate')}
              disabled={inProgress}
              className="mt-0.5 accent-green-500"
            />
            <span className="text-[10px] text-neutral-300 leading-snug">
              Segment scans together
              <span className="block text-neutral-500">
                Combine views of one tree for denser geometry (must be
                pre-aligned); labels are written back to each scan.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              data-testid="wood-mode-per-scan"
              type="radio"
              name="wood-multi-mode"
              checked={multiMode === 'per-scan'}
              onChange={() => onMultiModeChange('per-scan')}
              disabled={inProgress}
              className="mt-0.5 accent-green-500"
            />
            <span className="text-[10px] text-neutral-300 leading-snug">
              Segment each scan separately
              <span className="block text-neutral-500">
                Classify each selected scan independently, in sequence.
              </span>
            </span>
          </label>
        </div>
      )}

      {/* Wood sensitivity (wood_bias, inverted for intuition: higher slider →
          more wood → lower wood_bias). */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 block mb-1">Wood sensitivity (0–1)</label>
        <DebouncedNumberInput
          data-testid="wood-bias"
          value={woodBias}
          onCommit={(n) => onWoodBiasChange(Math.max(0.05, Math.min(0.95, n)))}
          min={0.05}
          max={0.95}
          step={0.05}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Neighbourhood scale (k_max) — larger = smoother / slower. */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 block mb-1">Neighbourhood size</label>
        <DebouncedNumberInput
          data-testid="wood-kmax"
          value={kMax}
          onCommit={(n) => onKMaxChange(Math.max(20, Math.min(200, Math.round(n))))}
          min={20}
          max={200}
          step={10}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Smoothing (reg_iters). */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 block mb-1">Smoothing (0–8)</label>
        <DebouncedNumberInput
          data-testid="wood-reg-iters"
          value={regIters}
          onCommit={(n) => onRegItersChange(Math.max(0, Math.min(8, Math.round(n))))}
          min={0}
          max={8}
          step={1}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Reflectance assist — only when the cloud carries a reflectance/intensity
          scalar. Auto-weighted per cloud, so on a low-contrast species it's a
          no-op; ticked on by default when available. */}
      {reflectanceAvailable && (
        <label className="flex items-start gap-2 mb-3 cursor-pointer">
          <input
            data-testid="wood-use-reflectance"
            type="checkbox"
            checked={useReflectance}
            onChange={(e) => onUseReflectanceChange(e.target.checked)}
            disabled={inProgress}
            className="mt-0.5 accent-green-500"
          />
          <span className="text-[10px] text-neutral-300 leading-snug">
            Use reflectance assist
            <span className="block text-neutral-500">
              Supplement geometry with the cloud's reflectance, weighted by how
              well it separates wood from leaf (no effect on low-contrast species).
            </span>
          </span>
        </label>
      )}

      {/* Output mode. In aggregate mode the labels are scattered back to each
          scan in place, so split/remove (which produce per-cloud children)
          don't apply — show a note instead of the dropdown. */}
      {selectedCount > 1 && multiMode === 'aggregate' ? (
        <div className="mb-3 text-[10px] text-neutral-500">
          Each scan is labelled in place with its wood/leaf classification.
        </div>
      ) : (
        <div className="mb-3">
          <label className="text-[10px] text-neutral-400 block mb-1">Output</label>
          <select
            data-testid="wood-mode"
            value={mode}
            onChange={(e) => onModeChange(e.target.value as WoodSegmentMode)}
            disabled={inProgress}
            className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
          >
            <option value="label">Label in place (wood + leaf)</option>
            <option value="split">Split into wood + leaf clouds</option>
            <option value="remove">Remove wood (keep leaves only)</option>
          </select>
        </div>
      )}

      {error && (
        <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
          {error}
        </div>
      )}

      <button
        data-testid="wood-segment-run-button"
        onClick={onSegment}
        disabled={inProgress}
        className={`w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 ${
          inProgress
            ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
            : 'bg-green-600 hover:bg-green-500 text-white'
        }`}
      >
        {inProgress ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            Segmenting...
          </>
        ) : (
          <>
            <Trees className="w-3 h-3" />
            Segment Wood / Leaf
          </>
        )}
      </button>
    </div>
  );
}
