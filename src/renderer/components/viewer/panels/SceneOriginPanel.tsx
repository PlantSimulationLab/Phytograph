import { useState } from 'react';
import { Crosshair, X, Target, MousePointerClick, Focus, Radio } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

type Axis = 'x' | 'y' | 'z';

// One scan the origin can be snapped onto: a scanner position in WORLD coords,
// already carrying any uncommitted transform draft (the parent resolves that).
export interface ScannerPositionOption {
  id: string;
  label: string;
  position: [number, number, number];
}

// Scene-origin panel (CloudCompare-style pivot). The origin is a point in WORLD
// coordinates that serves as the rotation pivot for the Transformation tool. It
// ALWAYS exists — with no override it sits at the scene bounds center (or, on a
// scan project that carries scanner positions, at their centroid) — so `origin`
// is never null; `isCustom` distinguishes "something other than the plain
// scene-center default", which is all the Reset button needs. The parent
// (PointCloudViewer) owns the origin state, the pick-mode arming, and the
// world-frame math; this component only renders the current value and reports
// intent. Whether the marker is DRAWN is a viewport display setting, not an
// origin setting, so that toggle lives with Grid/Axes in the Display panel.
interface SceneOriginPanelProps {
  /** Effective origin in WORLD coords (user override, else the ground-anchored scene center). */
  origin: [number, number, number];
  /**
   * True when the origin is NOT the plain scene-center default — i.e. Reset has
   * something to undo. Covers both an explicit user placement and the scanner
   * centroid seeded on import; `originSource` says which.
   */
  isCustom: boolean;
  /** Where the current origin came from, for the caption and for E2E. */
  originSource: 'user' | 'scanners' | 'default';
  /** True while click-to-place is armed (next viewport click sets the origin). */
  placeMode: boolean;
  /** Whether a "move to selection center" target is available. */
  canMoveToSelection: boolean;
  /**
   * Scans carrying a known scanner position, in scene order. Empty when nothing
   * in the scene records one (a plain XYZ/LAS import), which disables the snap.
   */
  scannerPositions: ScannerPositionOption[];
  onCoordChange: (axis: Axis, value: number) => void;
  onTogglePlaceMode: () => void;
  onMoveToSelection: () => void;
  /** Move the origin onto the given scan's scanner position. */
  onSnapToScanner: (scanId: string) => void;
  /** Re-centre the camera on the origin, keeping the current viewing angle. */
  onFrameOrigin: () => void;
  onReset: () => void;
  onClose: () => void;
}

const AXES: Axis[] = ['x', 'y', 'z'];

export function SceneOriginPanel({
  origin, isCustom, originSource, placeMode, canMoveToSelection, scannerPositions,
  onCoordChange, onTogglePlaceMode, onMoveToSelection, onSnapToScanner, onFrameOrigin,
  onReset, onClose,
}: SceneOriginPanelProps) {
  // Which scanner the snap targets. Held as an id rather than an index so the
  // choice survives a scan being added or removed, and resolved against the
  // CURRENT list every render — a scan that disappears (deleted, or its draft
  // baked away) silently falls back to the first available one instead of
  // leaving the button pointed at nothing.
  const [pickedScanId, setPickedScanId] = useState<string | null>(null);
  const chosenScanner =
    scannerPositions.find((s) => s.id === pickedScanId) ?? scannerPositions[0] ?? null;

  return (
    <div
      className="absolute top-4 right-[280px] z-20 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56"
      data-testid="scene-origin-panel"
      data-has-origin={isCustom ? 'true' : 'false'}
      data-origin-source={originSource}
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
        The pivot the view and the Transform tool rotate about, and what the
        camera looks at (so zoom converges here until you pan). Defaults to the
        scene center at ground level — drag its marker, click a point in the
        viewport, or type world coordinates.
      </p>

      {originSource === 'scanners' && (
        <p
          className="text-[10px] text-neutral-400 mb-2 leading-relaxed"
          data-testid="scene-origin-source-note"
        >
          Placed at the average of the imported scanner positions.
        </p>
      )}

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

      {/* Snap to a scanner position. The scene-origin panel is where a
          multi-scan user reasons about the plot's geometry, and the scanner
          positions are the only other absolute points in it — so offer them
          directly rather than making the user copy coordinates out of the Scans
          panel. Disabled outright when nothing in the scene carries an origin
          (a plain XYZ/LAS import records none). */}
      <div className="mt-3">
        <label
          htmlFor="scene-origin-scanner-select"
          className="text-[10px] text-neutral-400 block mb-1"
        >
          Scanner position
        </label>
        <select
          id="scene-origin-scanner-select"
          data-testid="scene-origin-scanner-select"
          value={chosenScanner?.id ?? ''}
          disabled={scannerPositions.length === 0}
          onChange={(e) => setPickedScanId(e.target.value)}
          className="w-full bg-neutral-700 text-neutral-200 text-[11px] px-2 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {scannerPositions.length === 0 ? (
            <option value="">No scanner positions</option>
          ) : (
            scannerPositions.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))
          )}
        </select>
        <button
          onClick={() => { if (chosenScanner) onSnapToScanner(chosenScanner.id); }}
          disabled={!chosenScanner}
          data-testid="scene-origin-to-scanner"
          title={chosenScanner
            ? `Set the origin to ${chosenScanner.label} at (${chosenScanner.position.map((v) => v.toFixed(3)).join(', ')})`
            : 'No scan in the scene records a scanner position — import a scan project, a Helios XML, or a file with a pose'}
          className="w-full mt-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[11px] flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Radio className="w-3 h-3" />
          Snap to scanner
        </button>
      </div>

      <button
        onClick={onFrameOrigin}
        data-testid="scene-origin-frame"
        title="Move the camera to look at the origin, keeping the current viewing angle"
        className="w-full mt-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[11px] flex items-center justify-center gap-1.5"
      >
        <Focus className="w-3 h-3" />
        Zoom to origin
      </button>

      <button
        onClick={onReset}
        disabled={!isCustom}
        data-testid="scene-origin-clear"
        title="Move the origin back to the default: the center of the scene, at ground level"
        className="w-full mt-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Reset to scene center
      </button>
    </div>
  );
}
