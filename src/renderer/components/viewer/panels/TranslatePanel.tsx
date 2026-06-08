import { Move } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

type Axis = 'x' | 'y' | 'z';
interface Vec3 { x: number; y: number; z: number }

// Presentational X/Y/Z translation panel for clouds and skeletons (meshes use
// TransformPanel instead). The parent (PointCloudViewer) resolves the current
// translation + object name from the active selection and applies coordinate
// changes; this component only renders. Parent gates on
// `editMode === 'translate' && !selectedMesh && (selectedSkeletonId || selectedIds.size > 0)`.
interface TranslatePanelProps {
  position: Vec3;
  objectName: string;
  onCoordChange: (axis: Axis, value: number) => void;
  onReset: () => void;
}

const AXES: Axis[] = ['x', 'y', 'z'];

export function TranslatePanel({ position, objectName, onCoordChange, onReset }: TranslatePanelProps) {
  return (
    <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56">
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Move className="w-3 h-3" />
          Position
        </span>
        <span className="text-[9px] text-neutral-500 truncate max-w-[100px]" title={objectName}>
          {objectName}
        </span>
      </div>

      <div className="space-y-2">
        {AXES.map((axis) => (
          <div key={axis} className="flex items-center gap-2">
            <label className="text-[10px] text-neutral-400 w-3 uppercase font-medium">
              {axis}
            </label>
            <DebouncedNumberInput
              step={0.1}
              value={position[axis]}
              format={(n) => n.toFixed(3)}
              onCommit={(n) => onCoordChange(axis, n)}
              className="flex-1 bg-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
            />
          </div>
        ))}
      </div>

      <button
        onClick={onReset}
        className="w-full mt-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs"
      >
        Reset Position
      </button>
    </div>
  );
}
