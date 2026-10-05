import { STICKY_PANEL_HEADER } from './stickyPanelHeader';
import { ChartScatter, Loader2, X } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { ObjectPicker, type PickerItem } from '../../ObjectPicker';

export type ResampleMode = 'random' | 'voxel';

// Presentational resample panel. Thins the CHECKED clouds, either by keeping a
// random fraction of their points or by keeping one point per voxel (uniform
// spacing). PointCloudViewer owns the target set, the estimate and the commit
// (backend `/resample` + bake for streamed clouds, lib/pointCloudHelpers for
// in-memory ones); this component renders the controls and forwards intent.
interface ResamplePanelProps {
  /** Every point cloud in the scene, with the ones to resample checked. */
  picker: {
    items: PickerItem[];
    selectedIds: Set<string>;
    onChange: (next: Set<string>) => void;
  };
  mode: ResampleMode;
  fraction: number;
  /** Voxel edge length, meters. */
  voxelSize: number;
  /** Points in the checked clouds now. */
  pointsBefore: number;
  /** Estimated points after; null while unknown (voxel mode is computed). */
  pointsAfter: number | null;
  estimating: boolean;
  /** True while the commit (thin + display rebuild) runs. */
  applying: boolean;
  onModeChange: (mode: ResampleMode) => void;
  onFractionChange: (fraction: number) => void;
  onVoxelSizeChange: (size: number) => void;
  onApply: () => void;
  onClose: () => void;
}

const PRESETS = [0.5, 0.25, 0.1, 0.05, 0.01];

export function ResamplePanel({
  picker,
  mode,
  fraction,
  voxelSize,
  pointsBefore,
  pointsAfter,
  estimating,
  applying,
  onModeChange,
  onFractionChange,
  onVoxelSizeChange,
  onApply,
  onClose,
}: ResamplePanelProps) {
  const targetCount = picker.selectedIds.size;
  const noop = mode === 'random' ? fraction >= 1.0 : pointsAfter !== null && pointsAfter >= pointsBefore;
  const canApply = targetCount > 0 && !noop && !applying;
  return (
    <div
      data-testid="resample-panel"
      data-target-count={targetCount}
      data-mode={mode}
      data-points-after={pointsAfter ?? ''}
      className="absolute top-4 right-[280px] z-20 bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 max-h-[calc(100%-2rem)] overflow-y-auto"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className={`flex items-center justify-between ${STICKY_PANEL_HEADER}`}>
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <ChartScatter className="w-3 h-3" />
          Resample
        </div>
        <button
          data-testid="resample-close"
          onClick={onClose}
          aria-label="Close"
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <p className="mb-3 text-[10px] text-neutral-400 leading-snug">
        Thin the checked clouds to fewer points. Sky/miss points are always kept.
      </p>

      <div className="mb-3">
        <ObjectPicker
          items={picker.items}
          selectedIds={picker.selectedIds}
          onChange={picker.onChange}
          label="Clouds"
          emptyMessage="No point clouds in the scene."
          rowTestId="resample-target-row"
          data-testid="resample-targets"
        />
        {targetCount === 0 && picker.items.length > 0 && (
          <p className="mt-1 text-[10px] text-neutral-500" data-testid="resample-none-checked">
            Check the clouds to resample.
          </p>
        )}
      </div>

      {targetCount > 0 && (
        <>
          {/* Method */}
          <div className="mb-3">
            <div className="text-[10px] text-neutral-400 mb-1">Method</div>
            <div className="flex gap-1">
              {([
                ['random', 'Random', 'Keep a random fraction of the points (density pattern unchanged)'],
                ['voxel', 'Even spacing', 'Keep one point per cube of the given size (evens out dense and sparse areas)'],
              ] as const).map(([value, label, title]) => (
                <button
                  key={value}
                  data-testid={`resample-mode-${value}`}
                  onClick={() => onModeChange(value)}
                  title={title}
                  className={`flex-1 px-2 py-1 text-[11px] rounded ${
                    mode === value ? 'bg-cyan-600 text-white' : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {mode === 'random' ? (
            <div className="mb-3">
              <label className="text-[10px] text-neutral-400 block mb-1">Keep fraction (0.001 – 1.0)</label>
              <DebouncedNumberInput
                min={0.001}
                max={1.0}
                step={0.01}
                debounceMs={0}
                value={fraction}
                onCommit={onFractionChange}
                data-testid="resample-fraction"
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
              />
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
          ) : (
            <div className="mb-3">
              <label className="text-[10px] text-neutral-400 block mb-1">Point spacing (m)</label>
              <DebouncedNumberInput
                min={0.0001}
                step={0.005}
                value={voxelSize}
                format={(n) => String(Number(n.toPrecision(4)))}
                onCommit={onVoxelSizeChange}
                data-testid="resample-voxel-size"
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
              />
              <p className="mt-1 text-[10px] text-neutral-500">
                Keeps the point nearest the center of each cube this size.
              </p>
            </div>
          )}

          <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400" data-testid="resample-estimate">
            {pointsBefore.toLocaleString()} →{' '}
            {estimating || pointsAfter === null
              ? '…'
              : `${pointsAfter.toLocaleString()}`}{' '}
            points
          </div>
        </>
      )}

      <button
        data-testid="resample-apply"
        onClick={onApply}
        disabled={!canApply}
        className="w-full px-2 py-1.5 text-xs rounded text-white bg-red-600 hover:bg-red-500 disabled:bg-neutral-700 disabled:text-neutral-500 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
      >
        {applying ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            Resampling…
          </>
        ) : (
          `Resample ${targetCount} cloud${targetCount === 1 ? '' : 's'} (permanent)`
        )}
      </button>
    </div>
  );
}
