import { MousePointerClick, X, Copy, Trash2 } from 'lucide-react';

// Point-picker panel. The tool itself is the viewport interaction (click a
// point → a labelled bubble appears anchored to it); this panel is the place to
// see how many labels are out, copy them all, and clear them.
//
// Presentational only — the parent (PointCloudViewer) owns the armed state, the
// picked-point list, and the clipboard call.
interface PointPickerPanelProps {
  /** True while the tool is armed (viewport clicks place labels). */
  armed: boolean;
  /** How many labels are currently placed. */
  count: number;
  /** True for the ~600 ms after a successful "Copy all". */
  copied: boolean;
  onToggleArmed: () => void;
  onCopyAll: () => void;
  onClearAll: () => void;
  onClose: () => void;
}

export function PointPickerPanel({
  armed, count, copied, onToggleArmed, onCopyAll, onClearAll, onClose,
}: PointPickerPanelProps) {
  return (
    <div
      className="absolute top-4 right-[280px] z-20 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56"
      data-testid="point-picker-panel"
      data-armed={armed ? 'true' : 'false'}
      data-picked-count={count}
    >
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <MousePointerClick className="w-3 h-3" />
          Pick Point
        </span>
        <button
          onClick={onClose}
          aria-label="Close"
          title="Close"
          data-testid="point-picker-close"
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <p className="text-[10px] text-neutral-500 mb-2 leading-relaxed">
        Click a point to label it with its coordinates and scalar attributes.
        Labels stay put until dismissed. Sky/miss points are not pickable.
      </p>

      {/* A TOGGLE for the armed state, not an instruction — the tool opens
          already armed, so this button's job is to pause picking. Pausing
          hands viewport clicks back to mesh selection (which arming blocks)
          without closing the panel or discarding the placed labels. Labelled
          by what pressing it DOES, not by the state it is in. */}
      <button
        onClick={onToggleArmed}
        title={armed
          ? 'Stop picking — viewport clicks go back to selecting objects'
          : 'Arm the picker so viewport clicks label points'}
        data-testid="point-picker-arm"
        className={`w-full mb-3 py-1.5 rounded text-[11px] flex items-center justify-center gap-1.5 ${
          armed
            ? 'bg-amber-600 hover:bg-amber-500 text-white'
            : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
        }`}
      >
        <MousePointerClick className="w-3 h-3" />
        {armed ? 'Pause picking' : 'Resume picking'}
      </button>

      {armed && (
        <div className="text-[10px] text-amber-400/90 mb-2 text-center">
          Click points in the viewport
        </div>
      )}

      <div className="text-[10px] text-neutral-400 mb-2" data-testid="point-picker-count">
        {count === 0 ? 'No points picked' : `${count} point${count === 1 ? '' : 's'} picked`}
      </div>

      <button
        onClick={onCopyAll}
        disabled={count === 0}
        title="Copy every picked point as CSV"
        data-testid="point-picker-copy-all"
        className="w-full py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[11px] flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Copy className="w-3 h-3" />
        {copied ? 'Copied' : 'Copy all (CSV)'}
      </button>

      <button
        onClick={onClearAll}
        disabled={count === 0}
        data-testid="point-picker-clear-all"
        className="w-full mt-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[11px] flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Trash2 className="w-3 h-3" />
        Clear all
      </button>
    </div>
  );
}
