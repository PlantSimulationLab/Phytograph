import { Eraser, X } from 'lucide-react';

// Presentational erase-brush panel for flat and octree clouds. The brush math,
// preview frame, and all apply/restore/bake logic live in PointCloudViewer; this
// component renders the brush-size control, status text, and action buttons from
// derived props. Parent gates on `editMode === 'erase' && firstSelectedCloud`.
interface ErasePanelProps {
  isOctree: boolean;
  // Octree clouds erase via on-screen pixel stamps; flat clouds via world-space
  // brush radius. Both sizing inputs are present; the active one is chosen by
  // isOctree.
  eraseActive: boolean;
  erasedCount: number;
  stampCount: number;
  // What the panel surfaces as pending erase (stamps for octree, indices for flat).
  pendingCount: number;
  eraseBrushPx: number;
  eraseBrushSize: number;
  flatMin: number;
  flatMax: number;
  flatStep: number;
  // data-* diagnostics asserted by the erase regression tests.
  eraseProjectionKind: 'orthographic' | 'perspective' | '';
  // Octree-only: whether the selected cloud has unbaked committed deletes.
  hasPendingDeletes: boolean;
  onToggleEraseActive: () => void;
  onBrushPxChange: (px: number) => void;
  onBrushSizeChange: (size: number) => void;
  onApply: () => void;
  onRestore: () => void;
  onBake: () => void;
  onUndoPending: () => void;
  onClose: () => void;
}

export function ErasePanel({
  isOctree,
  eraseActive,
  erasedCount,
  stampCount,
  pendingCount,
  eraseBrushPx,
  eraseBrushSize,
  flatMin,
  flatMax,
  flatStep,
  eraseProjectionKind,
  hasPendingDeletes,
  onToggleEraseActive,
  onBrushPxChange,
  onBrushSizeChange,
  onApply,
  onRestore,
  onBake,
  onUndoPending,
  onClose,
}: ErasePanelProps) {
  return (
    <div
      data-testid="erase-panel"
      data-erased-count={erasedCount}
      data-stamp-count={stampCount}
      data-erase-active={eraseActive ? 'true' : 'false'}
      data-erase-projection-kind={eraseProjectionKind}
      className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56"
    >
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Eraser className="w-3 h-3" />
          Erase Brush
        </span>
        <button
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>
      {isOctree && (
        // Erase-mode toggle: ON freezes the view and makes clicks stamp; OFF lets
        // the user orbit to reframe without leaving the tool. The 'e' key toggles
        // this same button.
        <button
          data-testid="erase-mode-toggle"
          onClick={onToggleEraseActive}
          className={`w-full mb-3 px-2 py-1.5 text-xs font-medium rounded transition-colors ${
            eraseActive
              ? 'bg-red-600 hover:bg-red-500 text-white'
              : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
          }`}
        >
          {eraseActive ? 'Erasing — view frozen (E)' : 'Start Erasing (E)'}
        </button>
      )}
      <div className="mb-3">
        {isOctree ? (
          <>
            <label className="text-[10px] text-neutral-400 block mb-1">
              Brush Size: {Math.round(eraseBrushPx * 2)} px
            </label>
            <input
              type="range"
              min={4}
              max={150}
              step={1}
              value={eraseBrushPx}
              onChange={(e) => onBrushPxChange(parseFloat(e.target.value))}
              className="w-full h-1 bg-neutral-600 rounded appearance-none cursor-pointer"
            />
          </>
        ) : (
          <>
            <label className="text-[10px] text-neutral-400 block mb-1">
              Brush Size: {eraseBrushSize < 1 ? eraseBrushSize.toFixed(3) : eraseBrushSize.toFixed(2)}
            </label>
            <input
              type="range"
              min={flatMin}
              max={flatMax}
              step={flatStep}
              value={eraseBrushSize}
              onChange={(e) => onBrushSizeChange(parseFloat(e.target.value))}
              className="w-full h-1 bg-neutral-600 rounded appearance-none cursor-pointer"
            />
          </>
        )}
        <div className="flex justify-between text-[9px] text-neutral-500 mt-1">
          <span>Small</span>
          <span>Large</span>
        </div>
      </div>
      <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
        {isOctree ? (
          pendingCount > 0 ? (
            <span>{pendingCount.toLocaleString()} stroke{pendingCount === 1 ? '' : 's'} painted — preview shown. Apply to remove.</span>
          ) : eraseActive ? (
            <span>View frozen. Click or drag on the cloud to stamp a square erase region — it cuts straight through. Press 'E' to pause and reframe.</span>
          ) : (
            <span>Orbit to frame your view, then press 'E' or the button above to start erasing.</span>
          )
        ) : (
          erasedCount > 0 ? (
            <span>{erasedCount.toLocaleString()} points erased</span>
          ) : (
            <span>Move cursor over the cloud, then hold 'E' to erase</span>
          )
        )}
      </div>
      {pendingCount > 0 && (
        <div className="flex flex-col gap-2">
          <button
            data-testid="erase-apply"
            onClick={onApply}
            className="w-full px-2 py-1.5 text-xs bg-red-600 hover:bg-red-500 rounded text-white font-medium"
          >
            {isOctree
              ? `Apply Erase (${pendingCount.toLocaleString()} stroke${pendingCount === 1 ? '' : 's'})`
              : `Apply Erase (${erasedCount.toLocaleString()} points)`}
          </button>
          <button
            data-testid="erase-restore"
            onClick={onRestore}
            className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
          >
            {isOctree ? 'Clear Strokes' : 'Restore All Points'}
          </button>
        </div>
      )}
      {/* Permanently apply deletions (bake): shown when the selected session
          cloud has unbaked deletes. Rebuilds the octree from the survivors and
          frees the in-RAM mask. Slow but exact; not undoable afterward. */}
      {isOctree && hasPendingDeletes && (
        <div className="flex flex-col gap-1 mt-2 pt-2 border-t border-neutral-700">
          <button
            data-testid="erase-bake"
            onClick={onBake}
            className="w-full px-2 py-1.5 text-xs bg-emerald-700 hover:bg-emerald-600 rounded text-white font-medium"
            title="Rebuild the octree from the surviving points (permanent, not undoable)"
          >
            Permanently apply deletions
          </button>
          <button
            data-testid="erase-undo-pending"
            onClick={onUndoPending}
            className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
          >
            Undo last deletion
          </button>
        </div>
      )}
    </div>
  );
}
