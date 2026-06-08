import { ChartScatter, X } from 'lucide-react';

// Presentational random-downsample panel. The actual resampling math lives in
// lib/pointCloudHelpers.resampleCloud; PointCloudViewer owns the preview state
// and the permanent commit (which must go through the in-RAM array, not a file
// reload). This component renders the fraction control and forwards intent.
// Parent gates on `showResamplePanel && firstSelectedCloud`.
interface ResamplePanelProps {
  // Pristine point total (before any preview), used for the "Result: ~N" estimate.
  originalCount: number;
  fraction: number;
  isPreviewActive: boolean;
  // Point count of the active preview, if any.
  previewCount: number | null;
  onClose: () => void;
  onFractionChange: (fraction: number) => void;
  onPreview: () => void;
  onApply: () => void;
  onCancelPreview: () => void;
}

const PRESETS = [1.0, 0.5, 0.25, 0.1, 0.05, 0.01];

export function ResamplePanel({
  originalCount,
  fraction,
  isPreviewActive,
  previewCount,
  onClose,
  onFractionChange,
  onPreview,
  onApply,
  onCancelPreview,
}: ResamplePanelProps) {
  const atFull = fraction >= 1.0;
  return (
    <div
      className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      ref={(el) => el?.focus()}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <ChartScatter className="w-3 h-3" />
          Resample
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      {/* Point count info */}
      <div className="mb-3 text-[10px] text-neutral-400">
        Original: {originalCount.toLocaleString()} points
        {isPreviewActive && (
          <span className="text-cyan-400 ml-2">(Preview: {previewCount?.toLocaleString()})</span>
        )}
      </div>

      {/* Fraction Input */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 block mb-1">Keep fraction (0.001 - 1.0)</label>
        <input
          type="number"
          min={0.001}
          max={1.0}
          step={0.01}
          value={fraction}
          onChange={(e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) onFractionChange(Math.min(1.0, Math.max(0.001, val)));
          }}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
        />
        {/* Quick presets */}
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {PRESETS.map(preset => (
            <button
              key={preset}
              onClick={() => onFractionChange(preset)}
              className={`px-1.5 py-0.5 text-[10px] rounded ${
                fraction === preset
                  ? 'bg-cyan-600 text-white'
                  : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
              }`}
            >
              {preset * 100}%
            </button>
          ))}
        </div>
      </div>

      {/* Result Preview */}
      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        Result: ~{Math.round(originalCount * fraction).toLocaleString()} points
      </div>

      {/* Preview Button */}
      <button
        onClick={onPreview}
        disabled={atFull}
        className={`w-full px-2 py-1.5 text-xs rounded text-white mb-2 ${atFull ? 'bg-neutral-600 cursor-not-allowed' : 'bg-cyan-600 hover:bg-cyan-500'}`}
      >
        {isPreviewActive ? 'Refresh Preview' : 'Preview'}
      </button>

      {/* Permanently Resample Button */}
      <button
        onClick={onApply}
        disabled={atFull}
        className={`w-full px-2 py-1.5 text-xs rounded text-white ${atFull ? 'bg-neutral-600 cursor-not-allowed' : 'bg-red-600 hover:bg-red-500'}`}
      >
        Permanently Resample Point Cloud
      </button>

      {/* Cancel Preview Button (only when preview is active) */}
      {isPreviewActive && (
        <button
          onClick={onCancelPreview}
          className="w-full px-2 py-1.5 text-xs rounded text-neutral-300 bg-neutral-700 hover:bg-neutral-600 mt-2"
        >
          Cancel Preview
        </button>
      )}
    </div>
  );
}
