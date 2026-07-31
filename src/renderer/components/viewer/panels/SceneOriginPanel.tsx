import { Crosshair, X, Target, MousePointerClick, Eye, EyeOff } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

type Axis = 'x' | 'y' | 'z';

// Scene-origin panel (CloudCompare-style pivot). The origin is a point in WORLD
// coordinates that serves as the rotation pivot for the Transformation tool. It
// ALWAYS exists — with no user override it sits at the scene bounds center — so
// `origin` is never null; `isCustom` distinguishes "the user placed this" from
// "the default", which is all the Reset button needs. The parent
// (PointCloudViewer) owns the origin state, the pick-mode arming, and the
// world-frame math; this component only renders the current value and reports
// intent.
interface SceneOriginPanelProps {
  /** Effective origin in WORLD coords (user override, else the ground-anchored scene center). */
  origin: [number, number, number];
  /** True when the user has overridden the default scene-center origin. */
  isCustom: boolean;
  /** True while click-to-place is armed (next viewport click sets the origin). */
  placeMode: boolean;
  /** Whether the marker is drawn in the viewport. */
  showMarker: boolean;
  /** True when the marker is standing down regardless of `showMarker` (empty scene). */
  markerSuppressed?: boolean;
  /** Whether a "move to selection center" target is available. */
  canMoveToSelection: boolean;
  onCoordChange: (axis: Axis, value: number) => void;
  onTogglePlaceMode: () => void;
  onToggleShowMarker: () => void;
  onMoveToSelection: () => void;
  onReset: () => void;
  onClose: () => void;
}

const AXES: Axis[] = ['x', 'y', 'z'];

export function SceneOriginPanel({
  origin, isCustom, placeMode, showMarker, markerSuppressed = false, canMoveToSelection,
  onCoordChange, onTogglePlaceMode, onToggleShowMarker, onMoveToSelection, onReset, onClose,
}: SceneOriginPanelProps) {
  const markerDrawn = showMarker && !markerSuppressed;
  return (
    <div
      className="absolute top-4 right-[280px] bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56"
      data-testid="scene-origin-panel"
      data-has-origin={isCustom ? 'true' : 'false'}
      data-place-mode={placeMode ? 'true' : 'false'}
      data-marker-visible={markerDrawn ? 'true' : 'false'}
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
        The pivot the view and the Transform tool rotate about, and what the
        camera looks at (so zoom converges here until you pan). Defaults to the
        scene center at ground level — drag its marker, click a point in the
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
              value={origin[AXES.indexOf(axis)]}
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

      <label
        className={`w-full mt-2 py-1.5 flex items-center gap-2 text-[11px] select-none ${
          markerSuppressed ? 'text-neutral-500 cursor-default' : 'text-neutral-300 cursor-pointer'
        }`}
        title={markerSuppressed
          ? 'The marker is hidden until something is loaded'
          : 'Hide the origin marker in the viewport (the pivot itself is unchanged)'}
      >
        <input
          type="checkbox"
          checked={showMarker}
          onChange={onToggleShowMarker}
          data-testid="scene-origin-show-marker"
          className="accent-blue-500"
        />
        {markerDrawn ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
        Show origin marker
      </label>

      <button
        onClick={onReset}
        disabled={!isCustom}
        data-testid="scene-origin-clear"
        title="Move the origin back to the default: the center of the scene, at ground level"
        className="w-full mt-1 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Reset to scene center
      </button>
    </div>
  );
}
