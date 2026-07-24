import { Crosshair, X, Target, MousePointerClick } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

type Axis = 'x' | 'y' | 'z';

// Scene-origin panel (CloudCompare-style pivot). The origin is a point in WORLD
// coordinates that serves as the rotation pivot for the Transformation tool and
// the camera orbit center. The parent (PointCloudViewer) owns the origin state,
// the pick-mode arming, and the world-frame math; this component only renders the
// current value and reports intent.
interface SceneOriginPanelProps {
  /** Current origin in WORLD coords, or null when none is set. */
  origin: [number, number, number] | null;
  /** True while click-to-place is armed (next viewport click sets the origin). */
  placeMode: boolean;
  /** Whether a "move to selection center" target is available. */
  canMoveToSelection: boolean;
  onCoordChange: (axis: Axis, value: number) => void;
  onTogglePlaceMode: () => void;
  onMoveToSelection: () => void;
  onClear: () => void;
  onClose: () => void;
}

const AXES: Axis[] = ['x', 'y', 'z'];

export function SceneOriginPanel({
  origin, placeMode, canMoveToSelection,
  onCoordChange, onTogglePlaceMode, onMoveToSelection, onClear, onClose,
}: SceneOriginPanelProps) {
  const value = origin ?? [0, 0, 0];
  return (
    <div
      className="absolute top-4 right-[280px] bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56"
      data-testid="scene-origin-panel"
      data-has-origin={origin ? 'true' : 'false'}
      data-place-mode={placeMode ? 'true' : 'false'}
    >
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Crosshair className="w-3 h-3" />
          Scene Origin
        </span>
        <button
          onClick={onClose}
          aria-label="Close"
          title="Close"
          data-testid="scene-origin-close"
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <p className="text-[10px] text-neutral-500 mb-2 leading-relaxed">
        The pivot for cloud rotation and camera orbit. Click a point in the
        viewport, or type world coordinates.
      </p>

      <button
        onClick={onTogglePlaceMode}
        data-testid="scene-origin-pick"
        className={`w-full mb-3 py-1.5 rounded text-[11px] flex items-center justify-center gap-1.5 ${
          placeMode
            ? 'bg-amber-600 hover:bg-amber-500 text-white'
            : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
        }`}
      >
        <MousePointerClick className="w-3 h-3" />
        {placeMode ? 'Click in viewport…' : 'Pick in viewport'}
      </button>

      <div className="space-y-2">
        {AXES.map((axis) => (
          <div key={axis} className="flex items-center gap-2">
            <label className="text-[10px] text-neutral-400 w-3 uppercase font-medium">
              {axis}
            </label>
            <DebouncedNumberInput
              step={0.1}
              value={value[AXES.indexOf(axis)]}
              format={(n) => n.toFixed(3)}
              onCommit={(n) => onCoordChange(axis, n)}
              debounceMs={0}
              data-testid={`scene-origin-input-${axis}`}
              className="flex-1 bg-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
            />
          </div>
        ))}
      </div>

      <button
        onClick={onMoveToSelection}
        disabled={!canMoveToSelection}
        data-testid="scene-origin-to-selection"
        title={canMoveToSelection
          ? 'Set the origin to the center of the selected cloud(s)'
          : 'Select one or more clouds first'}
        className="w-full mt-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[11px] flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Target className="w-3 h-3" />
        Center on selection
      </button>

      <button
        onClick={onClear}
        disabled={!origin}
        data-testid="scene-origin-clear"
        className="w-full mt-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Clear origin
      </button>
    </div>
  );
}
