import { Mountain, Loader2, X, AlertTriangle } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { InfoHint } from '../../InfoHint';

export type DemInterpMethod = 'tin' | 'idw' | 'nearest';
export type DemSurfaceType = 'dtm' | 'dsm' | 'chm';

// Presentational tool panel for DEM (Digital Elevation Model) generation. The
// `onGenerate` handler and all state live in PointCloudViewer; the parent gates
// rendering on `showDEMPanel && selectedIds.size === 1`.
// Hard cap on grid cells (nx*ny) — mirrors the backend's _DEM_MAX_CELLS. A finer
// cell than this on the current extent is rejected server-side, so the panel
// flags it up front.
const DEM_MAX_CELLS = 4_000_000;

interface DEMPanelProps {
  // Which surface products to build. One run generates all of them (in order),
  // each as its own mesh — so DTM, DSM and CHM can be produced in one click.
  selectedSurfaces: Set<DemSurfaceType>;
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
  // Streaming progress fraction (0–1) while running, or null before the first
  // marker / when not running. Shown as a percentage on the spinner button.
  progress?: number | null;
  // Human label for the running phase (e.g. "Generating CHM (2/3)…"), shown on
  // the spinner button when a batch is running. Optional.
  progressLabel?: string | null;
  error: string | null;
  onClose: () => void;
  onToggleSurface: (t: DemSurfaceType, checked: boolean) => void;
  onCellSizeChange: (n: number) => void;
  onMethodChange: (m: DemInterpMethod) => void;
  onFillVoidsChange: (v: boolean) => void;
  onComputeHeightAboveGroundChange: (v: boolean) => void;
  onGenerate: () => void;
  onCancel: () => void;
}

// Per-surface labels + descriptions. DTM = bare-earth ground; DSM = first-return
// / top-of-canopy surface; CHM = canopy height (DSM − DTM).
const SURFACE_META: Record<DemSurfaceType, { title: string; blurb: string; needsGround: boolean }> = {
  dtm: {
    title: 'Terrain (DTM)',
    blurb: "Bare-earth terrain surface from the cloud's ground points. Run Segment Ground first for control; otherwise ground is auto-detected.",
    needsGround: true,
  },
  dsm: {
    title: 'Surface (DSM)',
    blurb: 'First-return / top-of-canopy surface — the highest return in each cell. Does not need ground classification.',
    needsGround: false,
  },
  chm: {
    title: 'Canopy height (CHM)',
    blurb: 'Canopy height model = DSM − DTM: vegetation height above the bare earth. Run Segment Ground first for control over the ground.',
    needsGround: true,
  },
};

// Display order for the checkbox list (bottom-up: terrain, surface, canopy height).
// The Terrain (DTM) also carries density / intensity / hillshade / slope / aspect
// as colour-by layers — no separate checkboxes; pick them from the mesh's Color by.
const SURFACE_ORDER: DemSurfaceType[] = ['dtm', 'dsm', 'chm'];

export function DEMPanel({
  selectedSurfaces,
  cellSize,
  method,
  fillVoids,
  computeHeightAboveGround,
  hasGroundClass,
  extentX,
  extentY,
  inProgress,
  progress,
  progressLabel,
  error,
  onClose,
  onToggleSurface,
  onCellSizeChange,
  onMethodChange,
  onFillVoidsChange,
  onComputeHeightAboveGroundChange,
  onGenerate,
  onCancel,
}: DEMPanelProps) {
  const count = selectedSurfaces.size;
  // Short run-button suffix per product ("DEM" is the historical DTM wording).
  const RUN_SUFFIX: Record<DemSurfaceType, string> = { dtm: 'DEM', dsm: 'DSM', chm: 'CHM' };
  const runLabel = count === 0
    ? 'Select a surface'
    : count === 1
      ? `Generate ${RUN_SUFFIX[[...selectedSurfaces][0]]}`
      : `Generate ${count} surfaces`;
  // The no-ground notice applies when any CHECKED surface needs ground classification.
  const anyNeedsGround = SURFACE_ORDER.some((s) => selectedSurfaces.has(s) && SURFACE_META[s].needsGround);
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
          Generate surfaces
        </div>
        <button onClick={onClose} className="p-1 hover:bg-neutral-700 rounded">
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      {/* Surface types — tick each product to build; one run generates them all. */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
          Surfaces
          <InfoHint
            data-testid="dem-surface-type-help"
            label="Surface types"
            text="Tick every product you want — one run generates them all, each as its own mesh. Terrain (DTM) is the bare-earth ground surface. Surface (DSM) is the first-return / top-of-canopy surface. Canopy height (CHM) is DSM minus DTM — vegetation height above the ground."
          />
        </label>
        <div data-testid="dem-surface-list" className="space-y-1.5">
          {SURFACE_ORDER.map((s) => {
            const meta = SURFACE_META[s];
            const checked = selectedSurfaces.has(s);
            return (
              <label
                key={s}
                className="flex items-start gap-2 text-[10px] text-neutral-300 p-1.5 rounded bg-neutral-900/40 hover:bg-neutral-900/70 cursor-pointer"
              >
                <input
                  data-testid={`dem-surface-${s}`}
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => onToggleSurface(s, e.target.checked)}
                  className="mt-0.5 rounded bg-neutral-700 border-neutral-600 accent-green-500"
                  disabled={inProgress}
                />
                <span className="flex-1">
                  <span className="font-medium">{meta.title}</span>
                  <span className="block text-neutral-500">{meta.blurb}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {anyNeedsGround && !hasGroundClass && (
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
          text="Fill cells that have returns but no ground (e.g. under dense canopy, where ground pulses are sparse) with the nearest measured ground elevation — so the DTM covers the whole scanned area instead of leaving holes where the canopy blocked the ground. Off by default: gaps stay empty. Either way the surface never extends past the scanned footprint."
        />
      </div>

      {/* Height above ground — DTM only (DSM/CHM don't produce a per-point HAG). */}
      {selectedSurfaces.has('dtm') && (
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
            text="Also subtract the DEM from each point to add a 'height above ground' scalar to the cloud (a canopy-height-model precursor). The cloud recolours by this height. Off by default. For a rasterised canopy height model use the Canopy height (CHM) surface instead."
          />
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
            data-testid="dem-run-button"
            disabled
            className="flex-1 px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-neutral-600 text-neutral-400 cursor-not-allowed"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            {(progressLabel ?? 'Generating…')}{progress != null ? ` ${Math.round(progress * 100)}%` : ''}
          </button>
          <button
            data-testid="dem-cancel-button"
            onClick={onCancel}
            className="px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-1 bg-red-600 hover:bg-red-500 text-white"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </div>
      ) : (
        <button
          data-testid="dem-run-button"
          onClick={onGenerate}
          disabled={count === 0 || tooFine}
          className={`w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 ${
            count === 0 || tooFine
              ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
              : 'bg-green-600 hover:bg-green-500 text-white'
          }`}
        >
          <Mountain className="w-3 h-3" />
          {runLabel}
        </button>
      )}
    </div>
  );
}
