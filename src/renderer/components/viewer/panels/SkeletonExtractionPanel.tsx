import { GitBranch, Loader2, ChevronRight, X } from 'lucide-react';

// Presentational tool panel for BFS-graph skeleton extraction. State and the
// `onExtract` handler live in PointCloudViewer; the parent gates rendering on
// `showSkeletonPanel && selectedIds.size === 1`.
interface SkeletonExtractionPanelProps {
  removeOutliers: boolean;
  smooth: boolean;
  searchRadius: number;
  thresholdFilter: number;
  showAdvanced: boolean;
  rootThreshold: number;
  quantizationLevels: number;
  useNonlinearQuant: boolean;
  useProportionFilter: boolean;
  smoothIterations: number;
  inProgress: boolean;
  error: string | null;
  onClose: () => void;
  onRemoveOutliersChange: (v: boolean) => void;
  onSmoothChange: (v: boolean) => void;
  onSearchRadiusChange: (n: number) => void;
  onThresholdFilterChange: (n: number) => void;
  onShowAdvancedChange: (v: boolean) => void;
  onRootThresholdChange: (n: number) => void;
  onQuantizationLevelsChange: (n: number) => void;
  onUseNonlinearQuantChange: (v: boolean) => void;
  onUseProportionFilterChange: (v: boolean) => void;
  onSmoothIterationsChange: (n: number) => void;
  onExtract: () => void;
  onCancel: () => void;
}

export function SkeletonExtractionPanel({
  removeOutliers,
  smooth,
  searchRadius,
  thresholdFilter,
  showAdvanced,
  rootThreshold,
  quantizationLevels,
  useNonlinearQuant,
  useProportionFilter,
  smoothIterations,
  inProgress,
  error,
  onClose,
  onRemoveOutliersChange,
  onSmoothChange,
  onSearchRadiusChange,
  onThresholdFilterChange,
  onShowAdvancedChange,
  onRootThresholdChange,
  onQuantizationLevelsChange,
  onUseNonlinearQuantChange,
  onUseProportionFilterChange,
  onSmoothIterationsChange,
  onExtract,
  onCancel,
}: SkeletonExtractionPanelProps) {
  return (
    <div data-testid="skeleton-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-72 max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <GitBranch className="w-3 h-3" />
          Skeleton Extraction (BFS Graph)
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      {/* Description */}
      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        BFS graph-based algorithm for tree skeleton extraction. Follows branch connectivity from root to tips.
      </div>

      {/* Main Parameters */}
      <div className="mb-3 space-y-2">
        <label className="flex items-center gap-2 text-[10px] text-neutral-300 cursor-pointer">
          <input
            type="checkbox"
            checked={removeOutliers}
            onChange={(e) => onRemoveOutliersChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
            disabled={inProgress}
          />
          Remove outlier points
        </label>
        <label className="flex items-center gap-2 text-[10px] text-neutral-300 cursor-pointer">
          <input
            type="checkbox"
            checked={smooth}
            onChange={(e) => onSmoothChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
            disabled={inProgress}
          />
          Smooth skeleton (Laplace)
        </label>
      </div>

      {/* Search Radius */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 block mb-1">
          Search Radius: {searchRadius < 0.001 ? 'Auto (based on density)' : `${searchRadius.toFixed(3)}m`}
        </label>
        <input
          data-testid="skeleton-search-radius"
          type="range"
          min="0"
          max="0.2"
          step="0.005"
          value={searchRadius}
          onChange={(e) => onSearchRadiusChange(parseFloat(e.target.value))}
          className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer"
          disabled={inProgress}
        />
        <div className="text-[9px] text-neutral-500 mt-1">
          Neighbor connection distance. Set to 0 for auto-calculation from point density.
        </div>
      </div>

      {/* Threshold Filter */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 block mb-1">
          Min Points/Block: {thresholdFilter}
        </label>
        <input
          data-testid="skeleton-min-points"
          type="range"
          min="1"
          max="50"
          step="1"
          value={thresholdFilter}
          onChange={(e) => onThresholdFilterChange(parseInt(e.target.value))}
          className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer"
          disabled={inProgress}
        />
        <div className="text-[9px] text-neutral-500 mt-1">
          Filter noise/small branches. Lower for more detail.
        </div>
      </div>

      {/* Advanced Options Toggle */}
      <button
        onClick={() => onShowAdvancedChange(!showAdvanced)}
        className="w-full text-left text-[10px] text-neutral-400 hover:text-neutral-300 mb-2 flex items-center gap-1"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
        Advanced Options
      </button>

      {/* Advanced Options */}
      {showAdvanced && (
        <div className="mb-3 pl-2 border-l border-neutral-700 space-y-3">
          {/* Root Threshold */}
          <div>
            <label className="text-[10px] text-neutral-400 block mb-1">
              Root Threshold: {rootThreshold.toFixed(3)}m
            </label>
            <input
              type="range"
              min="0.005"
              max="0.1"
              step="0.005"
              value={rootThreshold}
              onChange={(e) => onRootThresholdChange(parseFloat(e.target.value))}
              className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer"
              disabled={inProgress}
            />
          </div>

          {/* Quantization Levels */}
          <div>
            <label className="text-[10px] text-neutral-400 block mb-1">
              Quantization Levels: {quantizationLevels}
            </label>
            <input
              type="range"
              min="20"
              max="120"
              step="10"
              value={quantizationLevels}
              onChange={(e) => onQuantizationLevelsChange(parseInt(e.target.value))}
              className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer"
              disabled={inProgress}
            />
          </div>

          <label className="flex items-center gap-2 text-[10px] text-neutral-300 cursor-pointer">
            <input
              type="checkbox"
              checked={useNonlinearQuant}
              onChange={(e) => onUseNonlinearQuantChange(e.target.checked)}
              className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
              disabled={inProgress}
            />
            Nonlinear quantization (sqrt scaling)
          </label>

          <label className="flex items-center gap-2 text-[10px] text-neutral-300 cursor-pointer">
            <input
              type="checkbox"
              checked={useProportionFilter}
              onChange={(e) => onUseProportionFilterChange(e.target.checked)}
              className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
              disabled={inProgress}
            />
            Proportion filter (parent/child ratio)
          </label>

          {/* Smoothing Iterations */}
          {smooth && (
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">
                Smoothing Iterations: {smoothIterations}
              </label>
              <input
                type="range"
                min="1"
                max="5"
                step="1"
                value={smoothIterations}
                onChange={(e) => onSmoothIterationsChange(parseInt(e.target.value))}
                className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer"
                disabled={inProgress}
              />
            </div>
          )}

          <div className="text-[9px] text-neutral-500">
            Nonlinear quantization preserves branch detail. Proportion filter removes small disconnected clusters.
          </div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
          {error}
        </div>
      )}

      {/* Extract / Cancel buttons */}
      {inProgress ? (
        <div className="flex gap-2">
          <button
            data-testid="skeleton-extract-button"
            disabled
            className="flex-1 px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-neutral-600 text-neutral-400 cursor-not-allowed"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            Extracting…
          </button>
          <button
            data-testid="skeleton-extract-cancel-button"
            onClick={onCancel}
            className="px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-1 bg-red-600 hover:bg-red-500 text-white"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </div>
      ) : (
        <button
          data-testid="skeleton-extract-button"
          onClick={onExtract}
          className="w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 text-white"
        >
          <GitBranch className="w-3 h-3" />
          Extract Skeleton
        </button>
      )}
    </div>
  );
}
