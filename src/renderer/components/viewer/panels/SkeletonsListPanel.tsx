import { GitBranch, Eye, EyeOff, Trash2 } from 'lucide-react';
import type { SkeletonEntry, PointCloudEntry } from '../../../lib/pointCloudTypes';

// Presentational right-side list of extracted skeletons plus the global skeleton
// display settings (cylinder rendering, tube radius, branch-order coloring).
// State and handlers live in PointCloudViewer; the parent gates on
// `skeletons.length > 0`.
interface SkeletonsListPanelProps {
  skeletons: SkeletonEntry[];
  clouds: PointCloudEntry[];
  selectedSkeletonId: string | null;
  showAsCylinders: boolean;
  tubeRadius: number;
  colorByBranchOrder: boolean;
  onSelect: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onRequestDelete: (id: string, name: string) => void;
  onShowAsCylindersChange: (v: boolean) => void;
  onTubeRadiusChange: (n: number) => void;
  onColorByBranchOrderChange: (v: boolean) => void;
}

export function SkeletonsListPanel({
  skeletons,
  clouds,
  selectedSkeletonId,
  showAsCylinders,
  tubeRadius,
  colorByBranchOrder,
  onSelect,
  onToggleVisibility,
  onRequestDelete,
  onShowAsCylindersChange,
  onTubeRadiusChange,
  onColorByBranchOrderChange,
}: SkeletonsListPanelProps) {
  return (
    <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-64 max-h-[40vh] flex flex-col">
      <div className="p-2 border-b border-neutral-700 flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-neutral-400" />
        <span className="text-xs font-medium text-neutral-300 flex-1">Skeletons</span>
      </div>
      <div className="overflow-y-auto flex-1 p-1">
        {skeletons.map(skeleton => {
          const sourceCloud = clouds.find(c => c.id === skeleton.sourceCloudId);
          const sourceName = sourceCloud?.data.fileName || 'Skeleton';
          const isSelected = selectedSkeletonId === skeleton.id;
          return (
            <div
              key={skeleton.id}
              data-testid="skeleton-row"
              data-skeleton-name={sourceName}
              data-total-length={skeleton.data.totalLength}
              data-point-count={skeleton.data.pointCount}
              data-selected={isSelected ? 'true' : 'false'}
              onClick={() => onSelect(skeleton.id)}
              className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                isSelected ? 'bg-amber-600/30 border border-amber-500/50' : 'hover:bg-neutral-700/50'
              }`}
            >
              <div className="w-3 h-3 rounded flex-shrink-0" style={{ backgroundColor: skeleton.color }} />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-neutral-200 truncate" data-testid="skeleton-row-name">
                  {sourceName}
                </div>
                <div className="text-[10px] text-neutral-500" data-testid="skeleton-row-stats">
                  {skeleton.data.totalLength.toFixed(2)}m · {skeleton.data.pointCount} pts
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onToggleVisibility(skeleton.id); }}
                className="p-1 hover:bg-neutral-600 rounded"
                title={skeleton.visible ? 'Hide' : 'Show'}
              >
                {skeleton.visible ? (
                  <Eye className="w-3 h-3 text-neutral-400" />
                ) : (
                  <EyeOff className="w-3 h-3 text-neutral-600" />
                )}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onRequestDelete(skeleton.id, sourceName); }}
                className="p-1 hover:bg-red-600/30 rounded"
                title="Remove"
              >
                <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
              </button>
            </div>
          );
        })}
      </div>
      {/* Skeleton Settings */}
      <div className="p-2 border-t border-neutral-700">
        <label className="flex items-center gap-2 text-[10px] text-neutral-400 cursor-pointer mb-2">
          <input
            type="checkbox"
            checked={showAsCylinders}
            onChange={(e) => onShowAsCylindersChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 w-3 h-3 accent-neutral-500"
          />
          Show as cylinders
        </label>
        {showAsCylinders && (
          <div className="mb-2">
            <label className="text-[10px] text-neutral-400 block mb-1">Tube Radius: {tubeRadius.toFixed(3)}</label>
            <input
              type="range"
              min="0.005"
              max="0.1"
              step="0.005"
              value={tubeRadius}
              onChange={(e) => onTubeRadiusChange(parseFloat(e.target.value))}
              className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
            />
          </div>
        )}
        <label className="flex items-center gap-2 text-[10px] text-neutral-400 cursor-pointer">
          <input
            type="checkbox"
            checked={colorByBranchOrder}
            onChange={(e) => onColorByBranchOrderChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 w-3 h-3 accent-neutral-500"
          />
          Color by branch order
        </label>
      </div>
    </div>
  );
}
