import { useMemo, useState } from 'react';
import { ClipboardList, Loader2, X, AlertTriangle, Download, ArrowUp, ArrowDown } from 'lucide-react';
import { StandSummaryView } from './StandSummaryView';
import type { StandSettings, StandSummary } from '../../../lib/standSummary';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { InfoHint } from '../../InfoHint';
import type { TreeInventoryTree } from '../../../utils/backendApi';
import {
  TREE_TABLE_COLUMNS, TREE_STATUSES, EMPTY_TREE_EDIT, sortTrees, describeFlags,
  type SortDir, type TreeColumn, type TreeEdit, type TreeEdits, type TreeStatus,
} from '../../../lib/treeInventory';

export interface TreeInventorySettings {
  breastHeightM: number;
  fitMethod: 'ransac' | 'hough';
  voxelSizeM: number;
  minPoints: number;
  competitionRadiusM: number;
}

export interface TreeQsmSettings {
  maxPointsPerTree: number;
  woodOnly: boolean;
}

export interface TreeQsmResultView {
  built: number;
  failed: number;
  woodOnly: boolean;
}

export interface TreeInventoryResultView {
  cloudId: string;
  cloudName: string;
  trees: TreeInventoryTree[];
  nStemCurveRows: number;
  warnings: string[];
  /** The result belongs to the selected cloud (else to an earlier one). */
  forSelectedCloud: boolean;
  /** The cloud changed after the run (re-segmented, edited, moved). */
  stale: boolean;
  /** Woody volume (m³) per tree id, from the last batch QSM. */
  qsmVolumes: Record<number, number>;
  /** Above-ground biomass (kg) per tree under the stand settings, or null. */
  biomassKg: Record<number, number | null> | null;
  measuredPlotAreaM2: number | null;
}

type Tab = 'trees' | 'stand' | 'qsm';

// Presentational panel for the tree inventory: settings, Run/Cancel, and the
// Tree Table. The run, the result, the user's per-tree entries and the viewer
// overlays all live in PointCloudViewer; this renders them. Clicking a row asks
// the parent to select (and frame) that tree.
interface TreeInventoryPanelProps {
  cloudName: string | null;
  // Why Run is unavailable (no single session cloud selected, no tree labels),
  // or null when it can run.
  blockedReason: string | null;
  // Which ground source the selected cloud will use — shown so a user without
  // a DEM knows their heights come from ground labels or the tree minimum.
  groundSource: 'height_above_ground' | 'ground_class' | 'tree_min_z' | null;
  settings: TreeInventorySettings;
  onSettingsChange: (patch: Partial<TreeInventorySettings>) => void;
  inProgress: boolean;
  progressLabel: string | null;
  progress: number | null;
  error: string | null;
  result: TreeInventoryResultView | null;
  edits: TreeEdits;
  onEdit: (treeId: number, patch: Partial<TreeEdit>) => void;
  selectedTreeId: number | null;
  onSelectTree: (treeId: number) => void;
  showOverlays: boolean;
  onShowOverlaysChange: (v: boolean) => void;
  onRun: () => void;
  onCancel: () => void;
  onExportTrees: () => void;
  onExportStemCurve: () => void;
  onClose: () => void;
  // Stand tab.
  standSettings: StandSettings;
  onStandSettingsChange: (patch: Partial<StandSettings>) => void;
  standSummary: StandSummary | null;
  onExportStand: () => void;
  // QSM tab.
  qsmSettings: TreeQsmSettings;
  onQsmSettingsChange: (patch: Partial<TreeQsmSettings>) => void;
  hasWoodClass: boolean;
  qsmInProgress: boolean;
  qsmProgressLabel: string | null;
  qsmProgress: number | null;
  qsmError: string | null;
  qsmResult: TreeQsmResultView | null;
  onBuildQsms: () => void;
  onCancelQsms: () => void;
  onExportQsms: () => void;
}

const GROUND_TEXT: Record<string, string> = {
  height_above_ground: 'Heights from the DEM (height above ground).',
  ground_class: 'No DEM height column: heights from the ground-labeled points.',
  tree_min_z: 'No ground data: heights from each tree’s lowest point (biased on slopes). Run Segment Ground and Generate DEM first.',
};

function fmt(v: number | null | undefined, digits: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}

export function TreeInventoryPanel({
  cloudName, blockedReason, groundSource, settings, onSettingsChange,
  inProgress, progressLabel, progress, error, result, edits, onEdit,
  selectedTreeId, onSelectTree, showOverlays, onShowOverlaysChange,
  onRun, onCancel, onExportTrees, onExportStemCurve, onClose,
  standSettings, onStandSettingsChange, standSummary, onExportStand,
  qsmSettings, onQsmSettingsChange, hasWoodClass, qsmInProgress, qsmProgressLabel, qsmProgress,
  qsmError, qsmResult, onBuildQsms, onCancelQsms, onExportQsms,
}: TreeInventoryPanelProps) {
  const [tab, setTab] = useState<Tab>('trees');
  const [sortCol, setSortCol] = useState('tree_id');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  // The static columns plus the ones later steps fill in: QSM woody volume
  // once a batch QSM ran, biomass once a method is chosen.
  const columns = useMemo<TreeColumn[]>(() => {
    const cols = [...TREE_TABLE_COLUMNS];
    const vols = result?.qsmVolumes ?? {};
    if (Object.keys(vols).length > 0) {
      cols.push({ id: 'qsm_volume_m3', header: 'QSM m³', title: 'Woody volume of the tree’s QSM', digits: 3, get: t => vols[t.tree_id] });
    }
    const agb = result?.biomassKg;
    if (agb) {
      cols.push({ id: 'agb_kg', header: 'AGB kg', title: 'Above-ground biomass (Stand tab method)', digits: 0, get: t => agb[t.tree_id] });
    }
    return cols;
  }, [result]);
  const rows = useMemo(
    () => (result ? sortTrees(result.trees, sortCol, sortDir, columns) : []),
    [result, sortCol, sortDir, columns],
  );
  const measured = result ? result.trees.filter(t => t.dbh_m != null).length : 0;

  const clickHeader = (id: string) => {
    if (id === sortCol) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(id); setSortDir(id === 'tree_id' ? 'asc' : 'desc'); }
  };

  return (
    <div
      data-testid="tree-inventory-panel"
      className="absolute top-4 right-[280px] z-20 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 shadow-lg w-[640px] max-w-[calc(100vw-320px)] max-h-[80vh] flex flex-col"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <ClipboardList className="w-3 h-3" />
          Tree inventory{cloudName ? ` — ${cloudName}` : ''}
          <InfoHint
            label="Tree inventory"
            text="Measures every segmented tree: stem position, DBH (with fit-quality evidence), stem curve, lean, height, crown base, crown size and voxel crown volume. Run Segment Ground, Generate DEM (with height above ground) and Segment Trees first. See the Tree inventory measurements page for the method and its sources."
          />
        </div>
        <button onClick={onClose} className="p-1 hover:bg-neutral-700 rounded" aria-label="Close">
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      {/* Settings */}
      <div className="grid grid-cols-5 gap-2 mb-2 text-[10px] text-neutral-400">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1">
            Breast height
            <InfoHint
              data-testid="tree-inventory-breast-height-help"
              label="Breast height"
              text="Height above the uphill ground, measured along the stem, where DBH is taken. 1.3 m is the international convention; 4.5 ft (1.37 m) is the US one. Changes DBH, basal area and every stand total built on them."
            />
          </span>
          <select
            data-testid="tree-inventory-breast-height"
            aria-label="Breast height"
            value={settings.breastHeightM === 1.37 ? '1.37' : '1.3'}
            onChange={e => onSettingsChange({ breastHeightM: parseFloat(e.target.value) })}
            disabled={inProgress}
            className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5"
          >
            <option value="1.3">1.3 m</option>
            <option value="1.37">4.5 ft (1.37 m)</option>
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1">
            Circle search
            <InfoHint
              data-testid="tree-inventory-fit-method-help"
              label="Circle search"
              text="How the stem's points are picked out of the breast-height slice before the final circle fit. RANSAC tries many three-point circles and keeps the one most points agree with; randomized Hough votes for centers and radii. Both ignore branches and noise, and both end in the same precise fit. If a cluttered stem gets a no_stem or high_residual flag with one, the other is worth a try."
            />
          </span>
          <select
            data-testid="tree-inventory-fit-method"
            aria-label="Circle search"
            value={settings.fitMethod}
            onChange={e => onSettingsChange({ fitMethod: e.target.value as 'ransac' | 'hough' })}
            disabled={inProgress}
            className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5"
          >
            <option value="ransac">RANSAC</option>
            <option value="hough">Randomized Hough</option>
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1">
            Crown voxel (m)
            <InfoHint
              data-testid="tree-inventory-voxel-help"
              label="Crown voxel (m)"
              text="Only affects the crown volume column. The crown is cut into cubes of this size and the volume is the number of cubes holding at least one point. Smaller cubes follow the foliage and report less volume (and too small reports gaps where the scan is sparse); larger cubes fill the gaps and approach the crown's envelope. Use roughly 2-3x the point spacing in the crown, and the same value when comparing trees or plots."
            />
          </span>
          <DebouncedNumberInput
            data-testid="tree-inventory-voxel"
            aria-label="Crown voxel (m)"
            value={settings.voxelSizeM}
            onCommit={n => onSettingsChange({ voxelSizeM: n })}
            min={0.01} max={2} step={0.05} debounceMs={0}
            disabled={inProgress}
            className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5 w-full"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1">
            Min points / tree
            <InfoHint
              data-testid="tree-inventory-min-points-help"
              label="Min points / tree"
              text="Segments with fewer points than this are skipped, so stray fragments from the tree segmentation don't become trees. The skipped count is reported in a warning."
            />
          </span>
          <DebouncedNumberInput
            data-testid="tree-inventory-min-points"
            aria-label="Min points / tree"
            value={settings.minPoints}
            onCommit={n => onSettingsChange({ minPoints: n })}
            parse={s => parseInt(s, 10)}
            min={3} step={10} debounceMs={0}
            disabled={inProgress}
            className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5 w-full"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1">
            Competition (m)
            <InfoHint
              data-testid="tree-inventory-competition-help"
              label="Competition (m)"
              text="Radius for each tree's competition index (the CI column; Hegyi 1974): how crowded a tree is by its neighbors. Every tree with a DBH within this distance of the stem adds its DBH divided by this tree's DBH, divided by the distance between them, so bigger and closer neighbors count more. Higher CI means more competition. A radius near the crown radius of the larger trees is typical. Trees closer than this to the plot edge are marked in the CSV's edge column, because their neighbors outside the plot are missing and their CI reads low."
            />
          </span>
          <DebouncedNumberInput
            data-testid="tree-inventory-competition-radius"
            aria-label="Competition (m)"
            value={settings.competitionRadiusM}
            onCommit={n => onSettingsChange({ competitionRadiusM: n })}
            min={0.5} max={50} step={0.5} debounceMs={0}
            disabled={inProgress}
            className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5 w-full"
          />
        </div>
      </div>

      {groundSource && (
        <div
          data-testid="tree-inventory-ground-source"
          data-ground-source={groundSource}
          className={`text-[10px] mb-2 flex items-start gap-1 ${groundSource === 'tree_min_z' ? 'text-amber-400' : 'text-neutral-400'}`}
        >
          {groundSource === 'tree_min_z' && <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />}
          {GROUND_TEXT[groundSource]}
        </div>
      )}

      <div className="flex items-center gap-2 mb-2">
        {inProgress ? (
          <button
            data-testid="tree-inventory-cancel"
            onClick={onCancel}
            className="flex-1 flex items-center justify-center gap-2 bg-neutral-600 hover:bg-neutral-500 text-xs text-white rounded py-1.5"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            {progressLabel ?? 'Measuring trees…'}
            {progress != null ? ` ${Math.round(progress * 100)}%` : ''} — Cancel
          </button>
        ) : (
          <button
            data-testid="tree-inventory-run"
            onClick={onRun}
            disabled={!!blockedReason}
            title={blockedReason ?? undefined}
            className="flex-1 bg-emerald-700 hover:bg-emerald-600 disabled:bg-neutral-700 disabled:text-neutral-500 text-xs text-white rounded py-1.5"
          >
            {result?.forSelectedCloud ? 'Re-run inventory' : 'Run inventory'}
          </button>
        )}
        <label className="flex items-center gap-1 text-[10px] text-neutral-300">
          <input
            type="checkbox"
            data-testid="tree-inventory-overlays"
            checked={showOverlays}
            onChange={e => onShowOverlaysChange(e.target.checked)}
          />
          DBH &amp; stem overlays
        </label>
      </div>

      {blockedReason && !inProgress && (
        <div data-testid="tree-inventory-blocked" className="text-[10px] text-amber-400 mb-2">{blockedReason}</div>
      )}
      {error && (
        <div data-testid="tree-inventory-error" className="text-[10px] text-red-400 mb-2 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />{error}
        </div>
      )}

      {result && (
        <>
          {(!result.forSelectedCloud || result.stale) && (
            <div data-testid="tree-inventory-result-note" className="text-[10px] text-amber-400 mb-1 flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
              {result.stale
                ? `${result.cloudName} has changed since this inventory ran; its overlays are hidden. Re-run to update.`
                : `Showing the last inventory, of ${result.cloudName}.`}
            </div>
          )}
          <div className="flex gap-1 mb-2 text-[10px]" role="tablist">
            {(['trees', 'stand', 'qsm'] as Tab[]).map(t => (
              <button
                key={t}
                role="tab"
                data-testid={`tree-inventory-tab-${t}`}
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`px-2 py-0.5 rounded ${tab === t ? 'bg-emerald-800 text-white' : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'}`}
              >
                {t === 'trees' ? 'Trees' : t === 'stand' ? 'Stand' : 'QSM'}
              </button>
            ))}
          </div>
          {tab === 'stand' && standSummary && (
            <StandSummaryView
              key={result.cloudId}
              settings={standSettings}
              onSettingsChange={onStandSettingsChange}
              summary={standSummary}
              measuredPlotAreaM2={result.measuredPlotAreaM2}
              onExport={onExportStand}
            />
          )}
          {tab === 'qsm' && (
            <div data-testid="tree-qsm-tab" className="text-[10px] text-neutral-300">
              <p className="text-neutral-400 mb-2">
                Build one QSM per tree. Each model is added to the scene, its woody volume joins the table,
                and it can feed the QSM biomass method on the Stand tab.
              </p>
              <div className="grid grid-cols-2 gap-2 mb-2 text-neutral-400">
                <label className="flex flex-col gap-0.5">
                  Max points per tree
                  <DebouncedNumberInput
                    data-testid="tree-qsm-max-points" value={qsmSettings.maxPointsPerTree}
                    parse={s => parseInt(s, 10)} min={1000} max={500000} step={10000} debounceMs={0}
                    disabled={qsmInProgress}
                    onCommit={n => onQsmSettingsChange({ maxPointsPerTree: n })}
                    className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5 w-full"
                  />
                </label>
                <label className="flex items-center gap-1 mt-3" title={hasWoodClass ? '' : 'Run Segment Wood / Leaf to get wood labels'}>
                  <input
                    type="checkbox" data-testid="tree-qsm-wood-only"
                    checked={hasWoodClass && qsmSettings.woodOnly}
                    disabled={!hasWoodClass || qsmInProgress}
                    onChange={e => onQsmSettingsChange({ woodOnly: e.target.checked })}
                  />
                  Wood points only{hasWoodClass ? '' : ' (no wood labels)'}
                </label>
              </div>
              {qsmInProgress ? (
                <button
                  data-testid="tree-qsm-cancel" onClick={onCancelQsms}
                  className="w-full flex items-center justify-center gap-2 bg-neutral-600 hover:bg-neutral-500 text-white rounded py-1.5 mb-2"
                >
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {qsmProgressLabel ?? 'Building QSMs…'}{qsmProgress != null ? ` ${Math.round(qsmProgress * 100)}%` : ''} — Cancel
                </button>
              ) : (
                <button
                  data-testid="tree-qsm-build" onClick={onBuildQsms}
                  disabled={!result.forSelectedCloud || result.stale}
                  title={!result.forSelectedCloud || result.stale ? 'Re-run the inventory on the selected cloud first' : undefined}
                  className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:bg-neutral-700 disabled:text-neutral-500 text-white rounded py-1.5 mb-2"
                >
                  Build QSMs for {result.trees.length} tree{result.trees.length === 1 ? '' : 's'}
                </button>
              )}
              {qsmError && <div data-testid="tree-qsm-error" className="text-red-400 mb-2">{qsmError}</div>}
              {qsmResult && (
                <div className="flex items-center justify-between">
                  <span data-testid="tree-qsm-summary" data-built={qsmResult.built} data-failed={qsmResult.failed}>
                    {qsmResult.built} QSM{qsmResult.built === 1 ? '' : 's'} built{qsmResult.failed ? `, ${qsmResult.failed} failed` : ''}
                    {qsmResult.woodOnly ? ' (wood points)' : ''}
                  </span>
                  <button
                    data-testid="tree-qsm-export" onClick={onExportQsms}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
                  >
                    <Download className="w-3 h-3" /> QSM metrics CSV
                  </button>
                </div>
              )}
            </div>
          )}
          {tab === 'trees' && (<>
          <div className="flex items-center justify-between mb-1 text-[10px] text-neutral-400">
            <span data-testid="tree-inventory-summary" data-tree-count={result.trees.length}>
              {result.cloudName}: {result.trees.length} tree{result.trees.length === 1 ? '' : 's'}, {measured} with DBH
            </span>
            <span className="flex gap-1">
              <button
                data-testid="tree-inventory-export-trees"
                onClick={onExportTrees}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
              >
                <Download className="w-3 h-3" /> Tree list CSV
              </button>
              <button
                data-testid="tree-inventory-export-stem-curve"
                onClick={onExportStemCurve}
                disabled={result.nStemCurveRows === 0}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600 disabled:text-neutral-500 text-neutral-200"
              >
                <Download className="w-3 h-3" /> Stem curve CSV
              </button>
            </span>
          </div>
          {result.warnings.length > 0 && (
            <div className="text-[10px] text-amber-400 mb-1">{result.warnings.join(' ')}</div>
          )}
          <div className="overflow-auto min-h-0 flex-1 rounded border border-neutral-700">
            <table data-testid="tree-table" className="w-full text-[10px] text-neutral-200 border-collapse">
              <thead className="sticky top-0 bg-neutral-800">
                <tr>
                  {columns.map(c => (
                    <th
                      key={c.id}
                      title={c.title}
                      data-testid={`tree-table-sort-${c.id}`}
                      data-sort={sortCol === c.id ? sortDir : undefined}
                      onClick={() => clickHeader(c.id)}
                      className="px-1 py-1 text-right font-medium cursor-pointer select-none whitespace-nowrap hover:text-white"
                    >
                      {c.header}
                      {sortCol === c.id && (sortDir === 'asc'
                        ? <ArrowUp className="inline w-2.5 h-2.5 ml-0.5" />
                        : <ArrowDown className="inline w-2.5 h-2.5 ml-0.5" />)}
                    </th>
                  ))}
                  <th className="px-1 py-1 text-left font-medium">Species</th>
                  <th className="px-1 py-1 text-left font-medium">Status</th>
                  <th className="px-1 py-1 text-left font-medium">Label</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(t => {
                  const e = edits[t.tree_id] ?? EMPTY_TREE_EDIT;
                  const selected = t.tree_id === selectedTreeId;
                  const flagged = t.flags.length > 0;
                  return (
                    <tr
                      key={t.tree_id}
                      data-testid="tree-row"
                      data-tree-id={t.tree_id}
                      data-selected={selected ? 'true' : 'false'}
                      onClick={() => onSelectTree(t.tree_id)}
                      title={flagged ? describeFlags(t.flags) : undefined}
                      className={`cursor-pointer border-t border-neutral-700/60 ${selected ? 'bg-emerald-900/60' : 'hover:bg-neutral-700/50'}`}
                    >
                      {columns.map(c => (
                        <td key={c.id} data-col={c.id} className="px-1 py-0.5 text-right tabular-nums whitespace-nowrap">
                          {c.id === 'tree_id' && flagged && (
                            <AlertTriangle className="inline w-2.5 h-2.5 mr-0.5 text-amber-400" />
                          )}
                          {fmt(c.get(t), c.digits)}
                        </td>
                      ))}
                      <td className="px-1 py-0.5" onClick={ev => ev.stopPropagation()}>
                        <input
                          data-testid="tree-species"
                          value={e.species}
                          onChange={ev => onEdit(t.tree_id, { species: ev.target.value })}
                          className="w-24 bg-neutral-700/70 rounded px-1"
                        />
                      </td>
                      <td className="px-1 py-0.5" onClick={ev => ev.stopPropagation()}>
                        <select
                          data-testid="tree-status"
                          value={e.status}
                          onChange={ev => onEdit(t.tree_id, { status: ev.target.value as TreeStatus })}
                          className="bg-neutral-700/70 rounded px-0.5"
                        >
                          {TREE_STATUSES.map(s => <option key={s} value={s}>{s || '—'}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-0.5" onClick={ev => ev.stopPropagation()}>
                        <input
                          data-testid="tree-label"
                          value={e.label}
                          onChange={ev => onEdit(t.tree_id, { label: ev.target.value })}
                          className="w-16 bg-neutral-700/70 rounded px-1"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>)}
        </>
      )}
    </div>
  );
}
