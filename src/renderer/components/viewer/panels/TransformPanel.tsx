import { Maximize2, Move, CircleDot, RotateCcw, Grid3x3 } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

type Axis = 'x' | 'y' | 'z';
interface Vec3 { x: number; y: number; z: number }

// Presentational transform controls for a selected mesh / shape / voxel box:
// position, rotation, per-axis scale, and (for voxel boxes) grid resolution +
// fit-to-scans. The selected mesh id and all state Maps live in PointCloudViewer;
// this component receives the current per-axis values and emits set/reset events.
// Parent gates on `showResizePanel && selectedMesh`.
interface TransformPanelProps {
  isShape: boolean;
  isVoxel: boolean;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  grid: Vec3;
  scaleLocked: boolean;
  translateActive: boolean;
  rotateActive: boolean;
  // True when a fit-to-scans target is available (one or more scans with points).
  fitAvailable: boolean;
  onClose: () => void;
  onScaleLockedChange: (v: boolean) => void;
  onToggleTranslate: () => void;
  onToggleRotate: () => void;
  onMoveToOrigin: () => void;
  onFitToScans: () => void;
  onSetPosition: (axis: Axis, value: number) => void;
  onResetPosition: () => void;
  onSetRotation: (axis: Axis, value: number) => void;
  onResetRotation: () => void;
  onSetScale: (axis: Axis, value: number) => void;
  onResetScale: () => void;
  onSetGrid: (axis: Axis, value: number) => void;
  onResetGrid: () => void;
}

const AXES: Axis[] = ['x', 'y', 'z'];

export function TransformPanel({
  isShape,
  isVoxel,
  position,
  rotation,
  scale,
  grid,
  scaleLocked,
  translateActive,
  rotateActive,
  fitAvailable,
  onClose,
  onScaleLockedChange,
  onToggleTranslate,
  onToggleRotate,
  onMoveToOrigin,
  onFitToScans,
  onSetPosition,
  onResetPosition,
  onSetRotation,
  onResetRotation,
  onSetScale,
  onResetScale,
  onSetGrid,
  onResetGrid,
}: TransformPanelProps) {
  return (
    <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56">
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Maximize2 className="w-3 h-3" />
          Transform {isShape ? 'Shape' : 'Mesh'}
        </span>
        <button
          onClick={onClose}
          className="text-neutral-500 hover:text-neutral-300"
        >
          ×
        </button>
      </div>

      {/* Voxel-specific: fit the box to the selected scan(s) */}
      {isVoxel && (
        <button
          data-testid="voxel-fit-to-scans"
          disabled={!fitAvailable}
          title={fitAvailable
            ? 'Resize and center this voxel box around the selected scan(s)'
            : 'Select one or more scans with points first'}
          onClick={onFitToScans}
          className="w-full mb-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 disabled:cursor-not-allowed text-white rounded text-[11px] flex items-center justify-center gap-1.5"
        >
          <Maximize2 className="w-3 h-3" />
          Fit to selected scan(s)
        </button>
      )}

      {/* Position */}
      <div className="mb-3 p-2 bg-neutral-900/50 rounded">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] text-neutral-400 flex items-center gap-1">
            <Move className="w-3 h-3" />
            Position
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onMoveToOrigin}
              className="p-0.5 hover:bg-neutral-700 rounded text-neutral-400 hover:text-neutral-200"
              title="Move to Origin"
            >
              <CircleDot className="w-3 h-3" />
            </button>
            <button
              onClick={onToggleTranslate}
              className={`p-0.5 rounded ${translateActive ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700'}`}
              title={translateActive ? 'Hide translate gizmo' : 'Show translate gizmo'}
            >
              <Move className="w-3 h-3" />
            </button>
          </div>
        </div>
        <div className="space-y-1.5">
          {AXES.map((axis) => (
            <div key={axis} className="flex items-center gap-2">
              <label className="text-[10px] text-neutral-500 w-3 uppercase font-medium">{axis}</label>
              <DebouncedNumberInput
                data-testid={`mesh-pos-${axis}`}
                step={0.1}
                value={position[axis]}
                format={(n) => n.toFixed(3)}
                onCommit={(n) => onSetPosition(axis, n)}
                className="flex-1 bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-0.5 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
          ))}
        </div>
        <button
          onClick={onResetPosition}
          className="w-full mt-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[10px]"
        >
          Reset Position
        </button>
      </div>

      {/* Rotation */}
      <div className="mb-3 p-2 bg-neutral-900/50 rounded">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] text-neutral-400 flex items-center gap-1">
            <RotateCcw className="w-3 h-3" />
            Rotation (°)
          </div>
          <button
            onClick={onToggleRotate}
            className={`p-0.5 rounded ${rotateActive ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700'}`}
            title={rotateActive ? 'Hide rotate gizmo' : 'Show rotate gizmo'}
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
        <div className="space-y-1.5">
          {AXES.map((axis) => (
            <div key={axis} className="flex items-center gap-2">
              <label className="text-[10px] text-neutral-500 w-3 uppercase font-medium">{axis}</label>
              <DebouncedNumberInput
                step={5}
                value={rotation[axis]}
                format={(n) => n.toFixed(1)}
                onCommit={(n) => onSetRotation(axis, n)}
                className="flex-1 bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-0.5 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
          ))}
        </div>
        <button
          onClick={onResetRotation}
          className="w-full mt-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[10px]"
        >
          Reset Rotation
        </button>
      </div>

      {/* Per-Axis Scale */}
      <div className={`${isVoxel ? 'mb-3' : ''} p-2 bg-neutral-900/50 rounded`}>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] text-neutral-400 flex items-center gap-1">
            <Maximize2 className="w-3 h-3" />
            Scale
          </div>
          <label className="flex items-center gap-1 text-[10px] text-neutral-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={scaleLocked}
              onChange={(e) => onScaleLockedChange(e.target.checked)}
              className="accent-blue-500"
            />
            Lock
          </label>
        </div>
        <div className="space-y-1.5">
          {AXES.map((axis) => (
            <div key={axis} className="flex items-center gap-2">
              <label className="text-[10px] text-neutral-500 w-3 uppercase font-medium">{axis}</label>
              <DebouncedNumberInput
                step={0.1}
                min={0}
                value={scale[axis]}
                format={(n) => n.toFixed(2)}
                onCommit={(v) => onSetScale(axis, v)}
                className="flex-1 bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-0.5 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
          ))}
        </div>
        <button
          onClick={onResetScale}
          className="w-full mt-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[10px]"
        >
          Reset Scale
        </button>
      </div>

      {/* Voxel-specific: Grid subdivision (for PyHelios LiDAR grid) */}
      {isVoxel && (
        <div className="p-2 bg-neutral-900/50 rounded">
          <div className="text-[10px] text-neutral-400 mb-1.5 flex items-center gap-1">
            <Grid3x3 className="w-3 h-3" />
            Grid Resolution
          </div>
          <div className="space-y-1.5">
            {AXES.map((axis) => (
              <div key={axis} className="flex items-center gap-2">
                <label className="text-[10px] text-neutral-500 w-3 uppercase font-medium">{axis}</label>
                <DebouncedNumberInput
                  data-testid={`voxel-grid-${axis}`}
                  min={1}
                  step={1}
                  parse={(s) => parseInt(s, 10)}
                  value={grid[axis]}
                  onCommit={(n) => onSetGrid(axis, n)}
                  className="flex-1 bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-0.5 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                />
              </div>
            ))}
          </div>
          <button
            onClick={onResetGrid}
            className="w-full mt-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[10px]"
          >
            Reset Grid
          </button>
        </div>
      )}
    </div>
  );
}
