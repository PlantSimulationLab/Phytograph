import { Sprout, Loader2, X } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { InfoHint } from '../../InfoHint';

// Presentational tool panel for TreeIso tree-instance segmentation. State,
// handlers (`onSegment`/`onMerge`/`onSplit`), and the seed-mode pointer plumbing
// all live in PointCloudViewer. `hasTrees` is computed by the parent (whether
// the selected flat cloud already carries a tree_instance field) so this stays
// a pure render. Parent gates on `showTreeSegmentPanel && selectedIds.size === 1`.
interface TreeSegmentPanelProps {
  regStrength1: number;
  regStrength2: number;
  maxGap: number;
  seedMode: boolean;
  seedCount: number;
  splitClouds: boolean;
  inProgress: boolean;
  error: string | null;
  // True when the selected cloud already has a tree_instance field — enables the
  // Refine (merge/split) section.
  hasTrees: boolean;
  mergeA: number;
  mergeB: number;
  splitId: number;
  onClose: () => void;
  onRegStrength1Change: (n: number) => void;
  onRegStrength2Change: (n: number) => void;
  onMaxGapChange: (n: number) => void;
  onSeedModeChange: (v: boolean) => void;
  onClearSeeds: () => void;
  onSplitCloudsChange: (v: boolean) => void;
  onSegment: () => void;
  onCancel: () => void;
  onMergeAChange: (n: number) => void;
  onMergeBChange: (n: number) => void;
  onSplitIdChange: (n: number) => void;
  onMerge: () => void;
  onSplit: () => void;
}

export function TreeSegmentPanel({
  regStrength1,
  regStrength2,
  maxGap,
  seedMode,
  seedCount,
  splitClouds,
  inProgress,
  error,
  hasTrees,
  mergeA,
  mergeB,
  splitId,
  onClose,
  onRegStrength1Change,
  onRegStrength2Change,
  onMaxGapChange,
  onSeedModeChange,
  onClearSeeds,
  onSplitCloudsChange,
  onSegment,
  onCancel,
  onMergeAChange,
  onMergeBChange,
  onSplitIdChange,
  onMerge,
  onSplit,
}: TreeSegmentPanelProps) {
  return (
    <div data-testid="tree-segment-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Sprout className="w-3 h-3" />
          Tree Segmentation
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        TreeIso isolates individual trees by cut-pursuit graph segmentation.
        Works best on ground-removed clouds — run Ground Segmentation first.
      </div>

      {/* Regularization strength 1 (3D) */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          3D reg. strength (λ₁)
          <InfoHint
            data-testid="tree-reg-strength1-help"
            label="3D reg. strength"
            text="Regularization for the initial 3D over-segmentation that breaks the cloud into small clusters. Higher values merge points into larger, smoother clusters; lower keeps them finer. The default rarely needs changing — tune λ₂ first."
          />
        </label>
        <DebouncedNumberInput
          data-testid="tree-reg-strength1"
          value={regStrength1}
          onCommit={(n) => onRegStrength1Change(n)}
          min={0.1} max={10} step={0.1}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Regularization strength 2 (2D) */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          2D reg. strength (λ₂)
          <InfoHint
            data-testid="tree-reg-strength2-help"
            label="2D reg. strength"
            text="Regularization for the intermediate 2D grouping that assembles clusters into trees — the most influential knob. Raise it if one tree is split into several pieces; lower it if separate trees are merged together."
          />
        </label>
        <DebouncedNumberInput
          data-testid="tree-reg-strength2"
          value={regStrength2}
          onCommit={(n) => onRegStrength2Change(n)}
          min={1} max={100} step={1}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Max gap */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Max intra-tree gap (m)
          <InfoHint
            data-testid="tree-max-gap-help"
            label="Max intra-tree gap"
            text="The largest gap (in metres, usually from occlusion) still treated as belonging to a single tree. Lower it when trees stand close together so neighbours aren't merged into one; raise it if a single sparsely-scanned tree is broken apart."
          />
        </label>
        <DebouncedNumberInput
          data-testid="tree-max-gap"
          value={maxGap}
          onCommit={(n) => onMaxGapChange(n)}
          min={0.1} max={10} step={0.1}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Trunk seeding (human-in-the-loop) */}
      <div className="mb-3 p-2 bg-neutral-900/50 rounded">
        <label className="flex items-center gap-2 text-[10px] text-neutral-400 mb-2">
          <input
            data-testid="tree-seed-mode"
            type="checkbox"
            checked={seedMode}
            onChange={(e) => onSeedModeChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
            disabled={inProgress}
          />
          Seed trunks (left-click to add)
          <InfoHint
            data-testid="tree-seed-mode-help"
            label="Seed trunks"
            text="Guide the result by marking trunks yourself. Turn this on, then left-click each trunk in the viewer (the camera locks); right-click removes the last seed. Each seed yields exactly one tree and ambiguous segments are assigned to their nearest seed — use it when neighbouring trees merge or split automatically."
          />
        </label>
        {seedMode && (
          <div className="text-[10px] text-neutral-500 mb-1">
            Click trunks in the view (camera locked); right-click removes the last seed.
          </div>
        )}
        <div className="flex items-center justify-between text-[10px] text-neutral-500">
          <span data-testid="tree-seed-count">{seedCount} seed{seedCount === 1 ? '' : 's'}</span>
          {seedCount > 0 && (
            <button
              className="px-2 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-300"
              onClick={onClearSeeds}
              disabled={inProgress}
            >
              Clear seeds
            </button>
          )}
        </div>
      </div>

      {/* Split checkbox */}
      <label className="flex items-center gap-2 text-[10px] text-neutral-400 mb-3">
        <input
          data-testid="tree-split-clouds"
          type="checkbox"
          checked={splitClouds}
          onChange={(e) => onSplitCloudsChange(e.target.checked)}
          className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
          disabled={inProgress}
        />
        Split into one cloud per tree
        <InfoHint
          data-testid="tree-split-clouds-help"
          label="Split into one cloud per tree"
          align="right"
          text="Also add a separate cloud for each detected tree (… (tree N)) to the scan list, so you can hide, export, or process each individually. The original cloud is always kept and recoloured by tree."
        />
      </label>

      {error && (
        <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
          {error}
        </div>
      )}

      {inProgress ? (
        <div className="flex gap-2">
          <button
            data-testid="tree-segment-run-button"
            disabled
            className="flex-1 px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-neutral-600 text-neutral-400 cursor-not-allowed"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            Segmenting…
          </button>
          <button
            data-testid="tree-segment-cancel-button"
            onClick={onCancel}
            className="px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-1 bg-red-600 hover:bg-red-500 text-white"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </div>
      ) : (
        <button
          data-testid="tree-segment-run-button"
          onClick={onSegment}
          className="w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white"
        >
          <Sprout className="w-3 h-3" />
          Segment Trees
        </button>
      )}

      {/* Refine: merge / split the current tree_instance field (flat clouds). */}
      {hasTrees && (
        <div data-testid="tree-refine" className="mt-3 pt-3 border-t border-neutral-700">
          <div className="text-[10px] font-medium text-neutral-300 mb-2 flex items-center gap-1">
            Refine
            <InfoHint
              data-testid="tree-refine-help"
              label="Refine"
              text="Hand-correct the segmentation by tree ID (read the IDs off the legend). Merge combines two trees that should be one; Split separates a single ID that actually holds two trees by breaking it at spatial gaps. Changes apply to the existing tree_instance field in place."
            />
          </div>
          {/* Merge */}
          <div className="flex items-end gap-1 mb-2">
            <div className="flex-1">
              <label className="text-[10px] text-neutral-500 block">Merge tree</label>
              <DebouncedNumberInput
                data-testid="tree-merge-a"
                value={mergeA}
                onCommit={(n) => onMergeAChange(Math.max(1, Math.round(n)))}
                min={1} step={1}
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
              />
            </div>
            <span className="text-[10px] text-neutral-500 pb-1">+</span>
            <div className="flex-1">
              <label className="text-[10px] text-neutral-500 block">into</label>
              <DebouncedNumberInput
                data-testid="tree-merge-b"
                value={mergeB}
                onCommit={(n) => onMergeBChange(Math.max(1, Math.round(n)))}
                min={1} step={1}
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
              />
            </div>
            <button
              data-testid="tree-merge-run"
              onClick={onMerge}
              className="px-2 py-1 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
            >
              Merge
            </button>
          </div>
          {/* Split */}
          <div className="flex items-end gap-1">
            <div className="flex-1">
              <label className="text-[10px] text-neutral-500 block">Split tree (by gaps)</label>
              <DebouncedNumberInput
                data-testid="tree-split-id"
                value={splitId}
                onCommit={(n) => onSplitIdChange(Math.max(1, Math.round(n)))}
                min={1} step={1}
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
              />
            </div>
            <button
              data-testid="tree-split-run"
              onClick={onSplit}
              className="px-2 py-1 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
            >
              Split
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
