import { Globe, Loader2, Maximize2, X } from 'lucide-react';
import { AlignmentDistanceResponse } from '../../../utils/backendApi';

// Presentational tool panel showing cloud-to-mesh alignment statistics and the
// ICP "Snap to Fit" action. State and `onSnapToFit` live in PointCloudViewer;
// the parent gates rendering on `showAlignmentPanel && alignmentResults`.
interface AlignmentPanelProps {
  results: AlignmentDistanceResponse;
  // Snap to Fit only runs in a mesh+cloud "mixed" selection; gated otherwise.
  snapEnabled: boolean;
  isRunningICP: boolean;
  onClose: () => void;
  onSnapToFit: () => void;
}

export function AlignmentPanel({
  results,
  snapEnabled,
  isRunningICP,
  onClose,
  onSnapToFit,
}: AlignmentPanelProps) {
  return (
    <div
      className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-72 max-h-[80vh] overflow-y-auto"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') onClose(); }}
      ref={(el) => el?.focus()}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Globe className="w-3 h-3" />
          Alignment
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <div className="space-y-3">
        {/* Key Statistics */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-neutral-700/50 rounded p-2">
            <div className="text-[10px] text-neutral-400">Mean Distance</div>
            <div className="text-sm font-medium text-cyan-400">
              {results.mean_distance !== undefined ? `${(results.mean_distance * 1000).toFixed(2)} mm` : 'N/A'}
            </div>
          </div>
          <div className="bg-neutral-700/50 rounded p-2">
            <div className="text-[10px] text-neutral-400">RMSE</div>
            <div className="text-sm font-medium text-cyan-400">
              {results.rmse !== undefined ? `${(results.rmse * 1000).toFixed(2)} mm` : 'N/A'}
            </div>
          </div>
          <div className="bg-neutral-700/50 rounded p-2">
            <div className="text-[10px] text-neutral-400">Std Deviation</div>
            <div className="text-sm font-medium text-neutral-200">
              {results.std_deviation !== undefined ? `${(results.std_deviation * 1000).toFixed(2)} mm` : 'N/A'}
            </div>
          </div>
          <div className="bg-neutral-700/50 rounded p-2">
            <div className="text-[10px] text-neutral-400">Median</div>
            <div className="text-sm font-medium text-neutral-200">
              {results.median_distance !== undefined ? `${(results.median_distance * 1000).toFixed(2)} mm` : 'N/A'}
            </div>
          </div>
        </div>

        {/* Range */}
        <div className="bg-neutral-700/50 rounded p-2">
          <div className="text-[10px] text-neutral-400 mb-1">Distance Range</div>
          <div className="flex justify-between text-xs">
            <span className="text-green-400">Min: {results.min_distance !== undefined ? `${(results.min_distance * 1000).toFixed(2)} mm` : 'N/A'}</span>
            <span className="text-red-400">Max: {results.max_distance !== undefined ? `${(results.max_distance * 1000).toFixed(2)} mm` : 'N/A'}</span>
          </div>
        </div>

        {/* Percentiles */}
        <div className="bg-neutral-700/50 rounded p-2">
          <div className="text-[10px] text-neutral-400 mb-1">Percentiles</div>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-neutral-400">90th:</span>
              <span className="text-neutral-200">{results.percentile_90 !== undefined ? `${(results.percentile_90 * 1000).toFixed(2)} mm` : 'N/A'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">95th:</span>
              <span className="text-neutral-200">{results.percentile_95 !== undefined ? `${(results.percentile_95 * 1000).toFixed(2)} mm` : 'N/A'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">99th:</span>
              <span className="text-neutral-200">{results.percentile_99 !== undefined ? `${(results.percentile_99 * 1000).toFixed(2)} mm` : 'N/A'}</span>
            </div>
          </div>
        </div>

        {/* Coverage Statistics */}
        <div className="bg-neutral-700/50 rounded p-2">
          <div className="text-[10px] text-neutral-400 mb-1">Coverage (points within distance)</div>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between items-center">
              <span className="text-neutral-400">&lt; 1mm:</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 bg-neutral-600 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500"
                    style={{ width: `${results.points_within_1mm || 0}%` }}
                  />
                </div>
                <span className="text-neutral-200 w-12 text-right">{results.points_within_1mm?.toFixed(1)}%</span>
              </div>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-neutral-400">&lt; 5mm:</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 bg-neutral-600 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-yellow-500"
                    style={{ width: `${results.points_within_5mm || 0}%` }}
                  />
                </div>
                <span className="text-neutral-200 w-12 text-right">{results.points_within_5mm?.toFixed(1)}%</span>
              </div>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-neutral-400">&lt; 10mm:</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 bg-neutral-600 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-orange-500"
                    style={{ width: `${results.points_within_10mm || 0}%` }}
                  />
                </div>
                <span className="text-neutral-200 w-12 text-right">{results.points_within_10mm?.toFixed(1)}%</span>
              </div>
            </div>
          </div>
        </div>

        {/* Snap to Fit Button */}
        <button
          onClick={onSnapToFit}
          disabled={isRunningICP || !snapEnabled}
          className={`w-full px-3 py-2 rounded text-xs font-medium transition-colors flex items-center justify-center gap-2 ${
            isRunningICP || !snapEnabled
              ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
              : 'bg-cyan-600 hover:bg-cyan-500 text-white'
          }`}
          title="Use ICP registration to automatically align the mesh to the point cloud"
        >
          {isRunningICP ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Aligning...
            </>
          ) : (
            <>
              <Maximize2 className="w-3 h-3" />
              Snap to Fit (ICP)
            </>
          )}
        </button>

        {/* Point Count */}
        <div className="text-[10px] text-neutral-500 text-center">
          Computed from {results.point_count?.toLocaleString()} points
        </div>
      </div>
    </div>
  );
}
