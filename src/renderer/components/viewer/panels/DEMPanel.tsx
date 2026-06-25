import { Mountain, Loader2, X, AlertTriangle } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { InfoHint } from '../../InfoHint';

export type DemInterpMethod = 'tin' | 'idw' | 'nearest';

// Presentational tool panel for DEM (Digital Elevation Model) generation. The
// `onGenerate` handler and all state live in PointCloudViewer; the parent gates
// rendering on `showDEMPanel && selectedIds.size === 1`.
// Hard cap on grid cells (nx*ny) — mirrors the backend's _DEM_MAX_CELLS. A finer
// cell than this on the current extent is rejected server-side, so the panel
// flags it up front.
const DEM_MAX_CELLS = 4_000_000;

interface DEMPanelProps {
  cellSize: number;
  method: DemInterpMethod;
  fillVoids: boolean;
  computeHeightAboveGround: boolean;
  hasGroundClass: boolean;
  // Horizontal extent (m) of the selected cloud's X/Y spans, used to estimate the
  // DEM grid dimensions for the chosen cell size. Undefined when unknown.
  extentX?: number;
  extentY?: number;
  inProgress: boolean;
  error: string | null;
  onClose: () => void;
  onCellSizeChange: (n: number) => void;
  onMethodChange: (m: DemInterpMethod) => void;
  onFillVoidsChange: (v: boolean) => void;
  onComputeHeightAboveGroundChange: (v: boolean) => void;
  onGenerate: () => void;
}

export function DEMPanel({
  cellSize,
  method,
  fillVoids,
  computeHeightAboveGround,
  hasGroundClass,
  extentX,
  extentY,
  inProgress,
  error,
  onClose,
  onCellSizeChange,
  onMethodChange,
  onFillVoidsChange,
  onComputeHeightAboveGroundChange,
  onGenerate,
}: DEMPanelProps) {
  // Estimated grid dimensions for the current cell size (ceil(extent / cell) per
  // axis), so the user can see the resolution/cost before running. The true DEM
  // is gridded over the ground points' extent, which is ≤ the whole cloud — hence
  // an estimate.
  const haveExtent =
    Number.isFinite(extentX) && Number.isFinite(extentY) &&
    (extentX as number) > 0 && (extentY as number) > 0 && cellSize > 0;
  const nx = haveExtent ? Math.max(1, Math.ceil((extentX as number) / cellSize)) : 0;
  const ny = haveExtent ? Math.max(1, Math.ceil((extentY as number) / cellSize)) : 0;
  const totalCells = nx * ny;
  const tooFine = totalCells > DEM_MAX_CELLS;

  return (
    <div data-testid="dem-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Mountain className="w-3 h-3" />
          Generate DEM
        </div>
        <button onClick={onClose} className="p-1 hover:bg-neutral-700 rounded">
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        Builds a bare-earth terrain surface (DEM) from the cloud's ground points
        by interpolating elevation onto a regular grid. Run Segment Ground first
        for control; otherwise ground is auto-detected.
      </div>

      {!hasGroundClass && (
        <div
          data-testid="dem-no-ground-warning"
          className="mb-3 p-2 bg-yellow-900/30 border border-yellow-600/50 rounded text-[10px] text-yellow-200 flex gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          <span>No ground classification found — ground will be auto-detected (CSF, settings scaled to the cloud's size). Run Segment Ground first for control over the result.</span>
        </div>
      )}

      {/* Cell size */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Cell size (m)
          <InfoHint
            data-testid="dem-cell-size-help"
            label="Cell size"
            text="Horizontal resolution of the DEM grid, in metres. Smaller resolves finer terrain but runs slower and leaves more gaps where ground is sparse; larger is coarser and smoother. Seeded from the cloud's extent — a few centimetres for close-range scans, larger for field-scale tiles."
          />
        </label>
        <DebouncedNumberInput
          data-testid="dem-cell-size"
          value={cellSize}
          onCommit={(n) => onCellSizeChange(n)}
          min={0.01}
          max={10}
          step={0.05}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        />
        {haveExtent && (
          <div
            data-testid="dem-grid-estimate"
            className={`mt-1 text-[10px] ${tooFine ? 'text-red-300' : 'text-neutral-500'}`}
          >
            Estimated grid: {nx.toLocaleString()} × {ny.toLocaleString()} cells (
            {totalCells.toLocaleString()})
            {tooFine && ' — too fine; increase cell size'}
          </div>
        )}
      </div>

      {/* Interpolation method */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Interpolation
          <InfoHint
            data-testid="dem-method-help"
            label="Interpolation method"
            text="How elevation is filled between ground points. TIN (linear) builds a triangulated surface through the ground returns — the most faithful, and the default. IDW (inverse-distance) smooths across neighbours. Nearest snaps each cell to the closest ground point (blocky, gap-free)."
          />
        </label>
        <select
          data-testid="dem-method"
          value={method}
          onChange={(e) => onMethodChange(e.target.value as DemInterpMethod)}
          disabled={inProgress}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
        >
          <option value="tin">TIN (linear)</option>
          <option value="idw">IDW (inverse-distance)</option>
          <option value="nearest">Nearest</option>
        </select>
      </div>

      {/* Fill voids */}
      <div className="flex items-center gap-1 mb-3">
        <label className="flex items-center gap-2 text-[10px] text-neutral-400">
          <input
            data-testid="dem-fill-voids"
            type="checkbox"
            checked={fillVoids}
            onChange={(e) => onFillVoidsChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
            disabled={inProgress}
          />
          Fill data gaps
        </label>
        <InfoHint
          data-testid="dem-fill-voids-help"
          label="Fill data gaps"
          align="right"
          text="Extrapolate elevation into cells with no nearby ground (e.g. outside the data footprint) using the nearest measured value. Off by default — gaps stay empty so the DEM never invents terrain it didn't measure."
        />
      </div>

      {/* Height above ground */}
      <div className="flex items-center gap-1 mb-3">
        <label className="flex items-center gap-2 text-[10px] text-neutral-400">
          <input
            data-testid="dem-compute-hag"
            type="checkbox"
            checked={computeHeightAboveGround}
            onChange={(e) => onComputeHeightAboveGroundChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
            disabled={inProgress}
          />
          Compute height above ground
        </label>
        <InfoHint
          data-testid="dem-compute-hag-help"
          label="Compute height above ground"
          align="right"
          text="Also subtract the DEM from each point to add a 'height above ground' scalar to the cloud (a canopy-height-model precursor). The cloud recolours by this height. Off by default."
        />
      </div>

      {error && (
        <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
          {error}
        </div>
      )}

      <button
        data-testid="dem-run-button"
        onClick={onGenerate}
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
            Generating...
          </>
        ) : (
          <>
            <Mountain className="w-3 h-3" />
            Generate DEM
          </>
        )}
      </button>
    </div>
  );
}
