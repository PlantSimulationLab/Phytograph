import { AlertTriangle, Loader2, X } from 'lucide-react';
import { NormalsIcon } from '../../icons/NormalsIcon';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { InfoHint } from '../../InfoHint';
import { ObjectPicker, type PickerItem } from '../../ObjectPicker';

// Presentational tool panel for per-point normal estimation. The `onCompute`
// handler and all state live in PointCloudViewer, including the picker's
// checked set: the run covers every CHECKED cloud, one after another.
export type NormalOrientation = 'origin' | 'up' | 'viewpoint' | 'none';

interface ComputeNormalsPanelProps {
  /** Every point cloud in the scene, with the ones to compute checked. Flat
   *  clouds carry a `disabledReason`: normals are stored on a session. */
  picker: {
    items: PickerItem[];
    selectedIds: Set<string>;
    onChange: (next: Set<string>) => void;
  };
  /** "scan-b (2/3)" while a multi-cloud run is on that cloud, else null. */
  progress: string | null;
  neighbors: number;
  useRadius: boolean;
  radius: number;
  orientation: NormalOrientation;
  inProgress: boolean;
  error: string | null;
  // Cost advisory from the backend (a 409 `cost_warning`): the run on this
  // cloud is estimated past the time / memory guideline. Not an error — the
  // button turns into "Compute Anyway" and the next click re-sends with
  // `acknowledge_cost`. Mirrors GroundSegmentPanel.
  costWarning: string | null;
  // True when a checked cloud already carries normals that predate a later edit. A
  // normal is a neighborhood statistic, so a crop or delete changes the right
  // answer for every surviving point beside the cut.
  stale: boolean;
  /** True when every checked cloud already carries normals. */
  hasNormals: boolean;
  onClose: () => void;
  onNeighborsChange: (n: number) => void;
  onUseRadiusChange: (v: boolean) => void;
  onRadiusChange: (n: number) => void;
  onOrientationChange: (v: NormalOrientation) => void;
  onCompute: () => void;
  onCancel: () => void;
}

export function ComputeNormalsPanel({
  picker,
  progress,
  neighbors,
  useRadius,
  radius,
  orientation,
  inProgress,
  error,
  costWarning,
  stale,
  hasNormals,
  onClose,
  onNeighborsChange,
  onUseRadiusChange,
  onRadiusChange,
  onOrientationChange,
  onCompute,
  onCancel,
}: ComputeNormalsPanelProps) {
  const targetCount = picker.selectedIds.size;
  return (
    <div
      data-testid="compute-normals-panel"
      data-target-count={targetCount}
      className="absolute top-4 right-[280px] z-20 bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 max-h-[calc(100%-2rem)] overflow-y-auto"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <NormalsIcon className="w-3 h-3" />
          Compute Normals
        </div>
        <button data-testid="compute-normals-close" onClick={onClose} aria-label="Close" className="p-1 hover:bg-neutral-700 rounded">
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        Fits a plane to each point's neighborhood to estimate its surface
        direction, and stores the result on each checked cloud. Also writes curvature
        (surface variation) and verticality, which color foliage, bark and
        ground differently. Exported with the cloud as nx/ny/nz.
      </div>

      {/* The targets are fixed for the length of a run. */}
      <div className={`mb-3 ${inProgress ? 'pointer-events-none opacity-60' : ''}`}>
        <ObjectPicker
          items={picker.items}
          selectedIds={picker.selectedIds}
          onChange={picker.onChange}
          label="Clouds"
          emptyMessage="No point clouds in the scene."
          rowTestId="compute-normals-target-row"
          data-testid="compute-normals-targets"
        />
        {targetCount === 0 && picker.items.length > 0 && (
          <p className="mt-1 text-[10px] text-neutral-500" data-testid="compute-normals-none-checked">
            Check the clouds to compute normals on.
          </p>
        )}
      </div>

      {/* Staleness advisory: the columns are still there and still correctly
          indexed, they just describe the cloud as it was before the edit. */}
      {stale && !inProgress && (
        <div
          data-testid="compute-normals-stale-warning"
          className="mb-3 p-2 bg-amber-900/30 border border-amber-600/50 rounded text-[10px] text-amber-200 flex gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span>
            {targetCount > 1
              ? 'Normals may be out of date — a checked cloud was edited after they were computed. Recompute to refresh them.'
              : 'Normals may be out of date — this cloud was edited after they were computed. Recompute to refresh them.'}
          </span>
        </div>
      )}

      {/* Neighbors */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Neighbors
          <InfoHint
            data-testid="compute-normals-neighbors-help"
            label="Neighbors"
            text="How many nearby points are fitted to estimate each normal. More gives a smoother, noise-tolerant result but blurs fine detail like twigs and leaf edges; fewer follows detail but is noisier. 30 suits most scans."
          />
        </label>
        <DebouncedNumberInput
          data-testid="compute-normals-neighbors"
          value={neighbors}
          onCommit={(n) => onNeighborsChange(n)}
          parse={(s) => parseInt(s, 10)}
          min={4}
          max={200}
          step={1}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
      </div>

      {/* Optional radius cap */}
      <div className="flex items-center gap-1 mb-2">
        <label className="flex items-center gap-2 text-[10px] text-neutral-400">
          <input
            data-testid="compute-normals-use-radius"
            type="checkbox"
            checked={useRadius}
            onChange={(e) => onUseRadiusChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
            disabled={inProgress}
          />
          Limit search radius
        </label>
        <InfoHint
          data-testid="compute-normals-use-radius-help"
          label="Limit search radius"
          align="right"
          text="Cap how far the neighbor search may reach, in meters. Off by default: a plain neighbor count adapts on its own to a scan whose density falls with distance, while a fixed radius finds too few points in the far field. Turn it on to stop the search bridging across a gap."
        />
      </div>

      {useRadius && (
        <div className="mb-3">
          <label className="text-[10px] text-neutral-400 mb-1 block">Radius (m)</label>
          <DebouncedNumberInput
            data-testid="compute-normals-radius"
            value={radius}
            onCommit={(n) => onRadiusChange(n)}
            min={0.001}
            max={100}
            step={0.01}
            disabled={inProgress}
            className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
          />
        </div>
      )}

      {/* Orientation */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Orientation
          <InfoHint
            data-testid="compute-normals-orientation-help"
            label="Orientation"
            text="A plane fit gives a direction but not which way it faces. 'Toward sensor' flips each normal back along the beam that measured it — correct for a scan, and the default. 'Up' suits ground or terrain. 'Leave unoriented' keeps the raw fit, which is fine for curvature but not for meshing."
          />
        </label>
        <select
          data-testid="compute-normals-orientation"
          value={orientation}
          onChange={(e) => onOrientationChange(e.target.value as NormalOrientation)}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        >
          <option value="origin">Toward sensor</option>
          <option value="up">Up (+Z)</option>
          <option value="none">Leave unoriented</option>
        </select>
      </div>

      {error && (
        <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300 whitespace-pre-line">
          {error}
        </div>
      )}

      {/* Cost advisory: amber, not red — the run is still available, it just
          wants a deliberate second click. */}
      {costWarning && !inProgress && (
        <div
          data-testid="compute-normals-cost-warning"
          className="mb-3 p-2 bg-amber-900/30 border border-amber-600/50 rounded text-[10px] text-amber-200 flex gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span>{costWarning}</span>
        </div>
      )}

      {inProgress && progress && (
        <div data-testid="compute-normals-progress" className="mb-2 text-[10px] text-neutral-400 truncate" title={progress}>
          {progress}
        </div>
      )}

      {inProgress ? (
        <div className="flex gap-2">
          <button
            data-testid="compute-normals-run-button"
            disabled
            className="flex-1 px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-neutral-600 text-neutral-400 cursor-not-allowed"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            Computing…
          </button>
          <button
            data-testid="compute-normals-cancel-button"
            onClick={onCancel}
            className="px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-1 bg-red-600 hover:bg-red-500 text-white"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </div>
      ) : (
        <button
          data-testid="compute-normals-run-button"
          onClick={onCompute}
          disabled={targetCount === 0}
          className={`w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 text-white disabled:bg-neutral-700 disabled:text-neutral-500 disabled:cursor-not-allowed ${
            costWarning ? 'bg-amber-600 hover:bg-amber-500' : 'bg-green-600 hover:bg-green-500'
          }`}
        >
          {costWarning ? <AlertTriangle className="w-3 h-3" /> : <NormalsIcon className="w-3 h-3" />}
          {costWarning ? 'Compute Anyway' : (hasNormals ? 'Recompute Normals' : 'Compute Normals')}
        </button>
      )}
    </div>
  );
}
