import { useEffect, useRef, useState } from 'react';
import { Sprout, Loader2, X, AlertTriangle } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { InfoHint } from '../../InfoHint';
import type { TreeSegmentMethod } from '../../../utils/backendApi';

// Presentational tool panel for TreeIso tree-instance segmentation. State,
// handlers (`onSegment`/`onMerge`/`onSplit`), and the seed-mode pointer plumbing
// all live in PointCloudViewer. `hasTrees` is computed by the parent (whether
// the selected flat cloud already carries a tree_instance field) so this stays
// a pure render. Parent gates on `showTreeSegmentPanel && selectedIds.size === 1`.
interface TreeSegmentPanelProps {
  // 'treeiso' shows the TreeIso knobs; 'chm' the canopy-height ones.
  method: TreeSegmentMethod;
  chmCrownScale: number;
  chmMinHeight: number;
  chmCell: number | null;   // null = the backend's default, crown scale ÷ 12
  onMethodChange: (m: TreeSegmentMethod) => void;
  onChmCrownScaleChange: (n: number) => void;
  onChmMinHeightChange: (n: number) => void;
  onChmCellChange: (n: number | null) => void;
  regStrength1: number;
  regStrength2: number;
  maxGap: number;
  maxOutlierGap: number;
  seedMode: boolean;
  seedCount: number;
  // Automatic stem seeds (fills the seed list) and tiling for large plots.
  autoSeedInProgress: boolean;
  onAutoSeed: () => void;
  tiling: 'auto' | 'on' | 'off';
  tileBufferM: number;
  onTilingChange: (t: 'auto' | 'on' | 'off') => void;
  onTileBufferChange: (n: number) => void;
  splitClouds: boolean;
  inProgress: boolean;
  error: string | null;
  // Set when the backend wants confirmation before an expensive run. Shows the
  // estimate and turns the run button into "Segment Anyway"; clicking `onSegment`
  // again re-sends with acknowledge_cost. Not a blocker — the run is always
  // available, and Cancel still works once it starts.
  costWarning: string | null;
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
  onMaxOutlierGapChange: (n: number) => void;
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
  method,
  chmCrownScale,
  chmMinHeight,
  chmCell,
  onMethodChange,
  onChmCrownScaleChange,
  onChmMinHeightChange,
  onChmCellChange,
  regStrength1,
  regStrength2,
  maxGap,
  maxOutlierGap,
  seedMode,
  seedCount,
  autoSeedInProgress,
  onAutoSeed,
  tiling,
  tileBufferM,
  onTilingChange,
  onTileBufferChange,
  splitClouds,
  inProgress,
  error,
  costWarning,
  hasTrees,
  mergeA,
  mergeB,
  splitId,
  onClose,
  onRegStrength1Change,
  onRegStrength2Change,
  onMaxGapChange,
  onMaxOutlierGapChange,
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
    <div
      data-testid="tree-segment-panel"
      // z-20 keeps the panel above the trunk-seed overlay (z-10), which fills the
      // whole viewport while "Seed trunks" is on. Without it the transparent SVG
      // swallowed this panel's own controls — including the checkbox that turns
      // seeding off and "Clear seeds", which left the mode with no way out.
      // (Same reason CropPanel carries z-20.) Being above the overlay also makes
      // the panel a genuine blocker, so ViewportBlockedZone hatches it.
      className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 max-h-[80vh] overflow-y-auto z-20"
    >
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

      {/* Method. TreeIso needs visible stems; an airborne scan of a closed
          canopy has almost none, and TreeIso fuses its touching crowns
          (bad_segment_example.laz: 333 instances for ~1,400 trees). The CHM
          method finds trees where such a scan does see them — the crown tops. */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Method
          <InfoHint
            data-testid="tree-method-help"
            label="Method"
            text="TreeIso (terrestrial) builds trees up from stems and branches — use it for ground-based scans where trunks are visible. Canopy height (airborne) finds each treetop in a canopy height model and gives every point the crown above it — use it for airborne or drone scans, and for dense canopies where TreeIso merges neighbouring trees."
          />
        </label>
        <select
          data-testid="tree-method"
          value={method}
          onChange={(e) => onMethodChange(e.target.value as TreeSegmentMethod)}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        >
          <option value="treeiso">TreeIso (terrestrial)</option>
          <option value="chm">Canopy height (airborne)</option>
        </select>
      </div>

      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        {method === 'chm'
          ? 'Finds treetops in a canopy height model and splits the crowns between them. Points under a crown (stems, understory) join that tree.'
          : 'TreeIso isolates individual trees by cut-pursuit graph segmentation.'}
        {' '}Works best on ground-removed clouds — run Ground Segmentation first.
      </div>

      {method === 'chm' && (
        <>
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
              Crown scale (m)
              <InfoHint
                data-testid="tree-chm-crown-scale-help"
                label="Crown scale"
                text="Roughly the width of the smaller crowns in the stand — not the distance between trunks. The default (2.5 m) suits most stands, planted or natural. Lower it if neighbouring trees come out as one; raise it if one crown is split into several trees. If unsure, err low: too small splits crowns (easy to spot), too large merges trees (easy to miss)."
              />
            </label>
            <DebouncedNumberInput
              data-testid="tree-chm-crown-scale"
              value={chmCrownScale}
              onCommit={onChmCrownScaleChange}
              min={0.5} max={30} step={0.1}
              disabled={inProgress}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
            />
          </div>
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
              Min tree height (m)
              <InfoHint
                data-testid="tree-chm-min-height-help"
                label="Min tree height"
                text="Canopy lower than this above the ground is not a tree, so low shrubs and grass are left unassigned (tree id 0)."
              />
            </label>
            <DebouncedNumberInput
              data-testid="tree-chm-min-height"
              value={chmMinHeight}
              onCommit={onChmMinHeightChange}
              min={0} max={100} step={0.5}
              disabled={inProgress}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
            />
          </div>
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
              CHM cell (m)
              <InfoHint
                data-testid="tree-chm-cell-help"
                label="CHM cell"
                text="Grid size of the canopy height model. Leave empty to use one twelfth of the crown scale, which resolves the dip between neighbouring crowns at any point density. Raise it only to smooth out very bumpy crowns — a coarse grid merges neighbouring trees."
              />
            </label>
            <ChmCellInput value={chmCell} onCommit={onChmCellChange} disabled={inProgress} />
          </div>
        </>
      )}

      {method === 'treeiso' && (<>
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

      {/* Split distance. Sits next to Max intra-tree gap because the two are the
          paired distances and are easy to confuse: this one is SMALLER, and the
          two point in opposite directions (connect vs. separate). */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Separate trees beyond (m)
          <InfoHint
            data-testid="tree-max-outlier-gap-help"
            label="Separate trees beyond"
            text="After trees are assembled, any part of one tree that sits further than this from the rest of it is treated as a different tree. Lower it if a neighbour's branches are absorbed into the tree you want; raise it if one tree is broken into pieces. Note this is the opposite of the gap above: that one joins an occluded limb back to its tree, this one separates bodies that are too far apart to belong together."
          />
        </label>
        <DebouncedNumberInput
          data-testid="tree-max-outlier-gap"
          value={maxOutlierGap}
          onCommit={(n) => onMaxOutlierGapChange(n)}
          min={0.05} max={10} step={0.05}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
        {maxOutlierGap > maxGap && (
          <div
            data-testid="tree-outlier-gap-warning"
            className="mt-1 text-[10px] text-amber-400/90 leading-tight"
          >
            Above the intra-tree gap, so nothing will be separated — lower it
            below {maxGap} m to split anything.
          </div>
        )}
      </div>
      </>)}

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
            text={method === 'chm'
              ? "Correct the result by marking trees yourself. Turn this on, then left-click a trunk or treetop in the viewer (the camera locks); right-click removes the last seed. Each seed yields exactly one tree and replaces any automatic treetop within half the crown scale of it; every other tree is still found automatically. Seed just the trees that came out wrong — two seeds split a merged pair, one seed joins a split crown."
              : "Guide the result by marking trunks yourself. Turn this on, then left-click each trunk in the viewer (the camera locks); right-click removes the last seed. Each seed yields exactly one tree and ambiguous segments are assigned to their nearest seed — use it when neighbouring trees split automatically. Seeds can't separate trees TreeIso has already merged into one segment; for that, lower λ₂ or use Canopy height."}
          />
        </label>
        {seedMode && (
          <>
            <div className="text-[10px] text-neutral-500 mb-1">
              Click trunks in the view (camera locked); right-click removes the last seed.
            </div>
            <div data-testid="tree-seed-blocked-hint" className="text-[10px] text-amber-400/90 leading-tight mb-1">
              ⊘ These panels sit over the viewport and take the click
              themselves — seeds can&apos;t land on them. Orbit or pan (turn
              seeding off first) to bring those trunks into the open.
            </div>
          </>
        )}
        <button
          data-testid="tree-auto-seed"
          onClick={onAutoSeed}
          disabled={inProgress || autoSeedInProgress}
          className="w-full mb-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 disabled:text-neutral-500 text-[10px] text-neutral-200"
          title="Find trunks in the 1–2 m layer above the terrain and add one seed per trunk. Needs Generate DEM with height above ground."
        >
          {autoSeedInProgress && <Loader2 className="w-3 h-3 animate-spin" />}
          Auto-seed stems
        </button>
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

      {/* Tiling for large plots (TreeIso only: the CHM is one linear pass). */}
      {method === 'treeiso' && <div className="grid grid-cols-2 gap-2 mb-3 text-[10px] text-neutral-400">
        <label className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1">Tiling
            <InfoHint
              label="Tiling"
              text="Large plots are segmented in square tiles, each with a buffer of its neighbours' points, and every tree is kept from the one tile its stem stands in. Auto tiles only when the plot is too big to segment at once."
            />
          </span>
          <select
            data-testid="tree-tiling"
            value={tiling}
            onChange={(e) => onTilingChange(e.target.value as 'auto' | 'on' | 'off')}
            disabled={inProgress}
            className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5"
          >
            <option value="auto">Auto</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5" title="Must be wider than any crown reaches from its stem">
          Tile buffer (m)
          <DebouncedNumberInput
            data-testid="tree-tile-buffer"
            value={tileBufferM}
            onCommit={onTileBufferChange}
            min={1} max={50} step={1} debounceMs={0}
            disabled={inProgress || tiling === 'off'}
            className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5 w-full"
          />
        </label>
      </div>}

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
          text="Also add a separate cloud for each detected tree (… (tree N)) to the scan list, so you can hide, export, or process each individually. The original cloud is kept and recoloured by tree, but hidden so it doesn't draw on top of the per-tree clouds — show it again with its eye toggle in the scan list."
        />
      </label>

      {error && (
        <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
          {error}
        </div>
      )}

      {/* Cost advisory: amber, not red — the run is still available, it just
          wants a deliberate second click. */}
      {costWarning && !inProgress && (
        <div
          data-testid="tree-segment-cost-warning"
          className="mb-3 p-2 bg-amber-900/30 border border-amber-600/50 rounded text-[10px] text-amber-200 flex gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span>{costWarning}</span>
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
          className={`w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 text-white ${
            costWarning
              ? 'bg-amber-600 hover:bg-amber-500'
              : 'bg-green-600 hover:bg-green-500'
          }`}
        >
          {costWarning ? <AlertTriangle className="w-3 h-3" /> : <Sprout className="w-3 h-3" />}
          {costWarning ? 'Segment Anyway' : 'Segment Trees'}
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
              text="Hand-correct the segmentation by tree ID (read the IDs off the legend). Merge combines two trees that should be one; Split separates a single ID that actually holds two trees, breaking it wherever its parts are further apart than the “Separate trees beyond” distance above. Changes apply to the existing tree_instance field in place."
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

// Optional CHM cell: empty = "auto" (null, the backend uses crown scale ÷ 12).
// A text draft rather than DebouncedNumberInput, because that one has
// no empty state — the repo's pattern for an optional number field (see
// CLAUDE.md, "Numeric input fields"). Only a finite positive parse commits.
function ChmCellInput({ value, onCommit, disabled }: {
  value: number | null;
  onCommit: (n: number | null) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value == null ? '' : String(value));
  }, [value]);
  const commit = (s: string) => {
    if (s.trim() === '') { onCommit(null); return; }
    const n = parseFloat(s);
    if (Number.isFinite(n) && n > 0) onCommit(n);
  };
  return (
    <input
      data-testid="tree-chm-cell"
      type="text"
      inputMode="decimal"
      placeholder="auto"
      value={draft}
      disabled={disabled}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }}
      onBlur={() => {
        focused.current = false;
        setDraft(value == null ? '' : String(value));
      }}
      className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600 placeholder:text-neutral-500"
    />
  );
}
