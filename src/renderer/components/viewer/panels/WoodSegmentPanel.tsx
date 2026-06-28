import { Trees, Loader2, X } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { InfoHint } from '../../InfoHint';

// Output mode for wood/leaf segmentation:
//  - 'label': keep all points, write the wood_class column, colour by it.
//  - 'split': also emit separate wood-only and leaf-only child clouds.
//  - 'remove': drop the wood points, leaving a leaf-only cloud (wood removal).
export type WoodSegmentMode = 'label' | 'split' | 'remove';

// When >1 scan is selected: 'aggregate' segments them TOGETHER (denser local
// neighbourhoods — for multi-view scans of one tree, must be pre-aligned), then
// scatters the labels back to each scan; 'per-scan' segments each independently.
export type WoodMultiMode = 'aggregate' | 'per-scan';

// Classification method:
//  - 'connectivity': roots a geodesic skeleton at the trunk base and recovers
//    the woody backbone (thin branches/twigs the point-wise method misses).
//    Needs the ground removed.
//  - 'geometric': the original point-wise classifier (local shape only).
export type WoodMethod = 'sota' | 'connectivity' | 'geometric';

// Presentational tool panel for wood/leaf segmentation. The `onSegment` handler
// and all state live in PointCloudViewer; the parent gates rendering on
// `showWoodSegmentPanel && selectedIds.size >= 1`.
interface WoodSegmentPanelProps {
  woodBias: number;
  kMax: number;
  regIters: number;
  mode: WoodSegmentMode;
  multiMode: WoodMultiMode;
  method: WoodMethod;
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
  onMethodChange: (m: WoodMethod) => void;
  onUseReflectanceChange: (b: boolean) => void;
  onSegment: () => void;
  onCancel: () => void;
}

export function WoodSegmentPanel({
  woodBias,
  kMax,
  regIters,
  mode,
  multiMode,
  method,
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
  onMethodChange,
  onUseReflectanceChange,
  onSegment,
  onCancel,
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
        Separates woody structure (trunk, branches) from leaves. Crop the ground
        first. Higher sensitivity classifies more points as wood.
      </div>

      {/* Method: connectivity (skeleton backbone, recovers thin twigs) vs the
          original geometric (local shape). */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Method
          <InfoHint
            data-testid="wood-method-help"
            label="Method"
            text="Which classifier separates wood from leaf. Branch-segment fits cylinders to whole branch segments (best on real trees, needs the ground removed); Connectivity traces branches back to the trunk to recover thin twigs (also needs ground removed); Geometric judges each point from its local shape alone — use it when the cloud can't be cleanly ground-removed or is partial/disconnected."
          />
        </label>
        <select
          data-testid="wood-method"
          value={method}
          onChange={(e) => onMethodChange(e.target.value as WoodMethod)}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        >
          <option value="sota">Branch-segment (recommended)</option>
          <option value="connectivity">Connectivity (skeleton backbone)</option>
          <option value="geometric">Geometric (local shape)</option>
        </select>
        <div className="text-[9px] text-neutral-500 mt-1 leading-snug">
          {method === 'sota'
            ? 'Classifies whole branch segments by cylinder fit — recovers thin branches without over-segmenting leaves. Requires ground removal.'
            : method === 'connectivity'
            ? 'Traces branches back to the trunk base — recovers thin twigs the local method drops. Requires ground removal.'
            : 'Classifies each point from its local 3-D shape only.'}
        </div>
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
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Wood sensitivity (0–1)
          <InfoHint
            data-testid="wood-bias-help"
            label="Wood sensitivity"
            text="The wood/leaf decision threshold. Raise it to classify more points as wood — catches thin twigs at the cost of some leaf bleed; lower it to be stricter about what counts as wood. The default works across broadleaf and conifer scans."
          />
        </label>
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
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Neighbourhood size
          <InfoHint
            data-testid="wood-kmax-help"
            label="Neighbourhood size"
            text="How many neighbouring points define each point's local geometry. Larger is smoother but slower; the default suits typical terrestrial-LiDAR densities. Increase it for noisy or sparse clouds, decrease it to preserve fine detail."
          />
        </label>
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
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Smoothing (0–8)
          <InfoHint
            data-testid="wood-reg-iters-help"
            label="Smoothing"
            text="How aggressively isolated misclassifications are cleaned up by a majority vote over each point's neighbours. Higher values remove more speckle but can erode thin structures; 0 disables it entirely."
          />
        </label>
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
          <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
            Output
            <InfoHint
              data-testid="wood-mode-help"
              label="Output"
              text="What to produce. Label in place keeps every point and adds a Wood Class attribute, recoloured by it. Split additionally emits separate … (wood) and … (leaf) clouds. Remove wood drops the wood points, leaving a leaf-only cloud (classic wood removal). Label and Split never delete the original."
            />
          </label>
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

      {inProgress ? (
        <div className="flex gap-2">
          <button
            data-testid="wood-segment-run-button"
            disabled
            className="flex-1 px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-neutral-600 text-neutral-400 cursor-not-allowed"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            Segmenting…
          </button>
          <button
            data-testid="wood-segment-cancel-button"
            onClick={onCancel}
            className="px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-1 bg-red-600 hover:bg-red-500 text-white"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </div>
      ) : (
        <button
          data-testid="wood-segment-run-button"
          onClick={onSegment}
          className="w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white"
        >
          <Trees className="w-3 h-3" />
          Segment Wood / Leaf
        </button>
      )}
    </div>
  );
}
