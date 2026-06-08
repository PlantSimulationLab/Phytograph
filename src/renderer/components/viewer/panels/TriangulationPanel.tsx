import { Triangle, Loader2, X } from 'lucide-react';
import { TriangulationMethod } from '../../../utils/backendApi';

// Presentational tool panel for point-cloud triangulation. State and the
// `onTriangulate` / `onSetup` handlers live in PointCloudViewer; this component
// only renders the controls and forwards events. The parent gates rendering on
// `showTriangulationPanel && selectedIds.size === 1`.
interface TriangulationPanelProps {
  method: TriangulationMethod;
  inProgress: boolean;
  error: string | null;
  poissonDepth: number;
  alphaValue: number | null;
  // True when the run button should open the Helios popup instead of running
  // directly (helios method, or a multi-cloud selection).
  useSetup: boolean;
  onClose: () => void;
  onMethodChange: (method: TriangulationMethod) => void;
  onPoissonDepthChange: (depth: number) => void;
  onAlphaValueChange: (alpha: number | null) => void;
  onSetup: () => void;
  onTriangulate: () => void;
}

export function TriangulationPanel({
  method,
  inProgress,
  error,
  poissonDepth,
  alphaValue,
  useSetup,
  onClose,
  onMethodChange,
  onPoissonDepthChange,
  onAlphaValueChange,
  onSetup,
  onTriangulate,
}: TriangulationPanelProps) {
  return (
    <div data-testid="triangulation-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Triangle className="w-3 h-3" />
          Triangulation
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      {/* Method Selection */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 block mb-1">Method</label>
        <select
          data-testid="triangulation-method"
          value={method}
          onChange={(e) => onMethodChange(e.target.value as TriangulationMethod)}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
          disabled={inProgress}
        >
          <option value="ball_pivoting">Ball Pivoting</option>
          <option value="poisson">Poisson</option>
          <option value="alpha_shape">Alpha Shape</option>
          <option value="delaunay">Delaunay (2D)</option>
          <option value="helios">Helios</option>
        </select>
      </div>

      {/* Method Description */}
      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        {method === 'ball_pivoting' && 'Good for clean, uniformly sampled point clouds'}
        {method === 'poisson' && 'Creates watertight meshes, good for noisy data'}
        {method === 'alpha_shape' && 'Good for concave shapes'}
        {method === 'delaunay' && 'Fast 2D projection, best for roughly planar surfaces'}
        {method === 'helios' && 'Spherical Delaunay triangulation for multi-scan LiDAR data'}
      </div>

      {/* Method-specific Parameters */}
      {method === 'poisson' && (
        <div className="mb-3">
          <label className="text-[10px] text-neutral-400 block mb-1">
            Octree Depth: {poissonDepth}
          </label>
          <input
            data-testid="triangulation-poisson-depth"
            type="range"
            min="4"
            max="12"
            value={poissonDepth}
            onChange={(e) => onPoissonDepthChange(parseInt(e.target.value))}
            className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
            disabled={inProgress}
          />
          <div className="flex justify-between text-[9px] text-neutral-500 mt-0.5">
            <span>Coarse</span>
            <span>Fine</span>
          </div>
        </div>
      )}

      {method === 'alpha_shape' && (
        <div className="mb-3">
          <label className="flex items-center gap-2 text-[10px] text-neutral-400 mb-1">
            <input
              type="checkbox"
              checked={alphaValue === null}
              onChange={(e) => onAlphaValueChange(e.target.checked ? null : 0.1)}
              className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
              disabled={inProgress}
            />
            Auto Alpha
          </label>
          {alphaValue !== null && (
            <input
              type="number"
              value={alphaValue}
              onChange={(e) => onAlphaValueChange(parseFloat(e.target.value) || 0.1)}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600 mt-1"
              step="0.01"
              min="0.001"
              disabled={inProgress}
            />
          )}
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
          {error}
        </div>
      )}

      {/* Triangulate / Setup Button */}
      {useSetup ? (
        <button
          data-testid="triangulation-setup-button"
          onClick={onSetup}
          className="w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white"
        >
          <Triangle className="w-3 h-3" />
          Setup
        </button>
      ) : (
        <button
          data-testid="triangulation-run-button"
          onClick={onTriangulate}
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
              Triangulating...
            </>
          ) : (
            <>
              <Triangle className="w-3 h-3" />
              Triangulate
            </>
          )}
        </button>
      )}
    </div>
  );
}
