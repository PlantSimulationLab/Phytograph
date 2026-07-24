import { useState, useCallback } from 'react';
import { Move, X, Loader2 } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

type Axis = 'x' | 'y' | 'z';
interface Vec3 { x: number; y: number; z: number }

// X/Y/Z translation panel for clouds and skeletons (meshes use TransformPanel).
//
// Editing model (see the flow the user specified):
//  - The panel is a DRAFT editor. Typing an axis value (or dragging the gizmo,
//    which the parent pushes back in via `position`) updates the viewport LIVE
//    but does NOT bake. Nothing is committed until the user resolves the panel.
//  - **OK** → `onApply`: bake the pending translation into geometry, then close.
//    While the bake runs the panel shows an "Applying…" state and blocks (its
//    buttons disable) so the user can't fire a second commit.
//  - **Cancel** → `onCancel`: revert to the baseline the panel opened with and
//    close. Nothing is baked.
//  - **X** (top-right): if there are unsaved changes vs. baseline, prompt the
//    user to Apply or Discard; with no changes it just closes (== cancel).
//
// The parent (PointCloudViewer) owns the actual translation state and the
// baseline; this component renders the draft and reports intent. `position` is
// the current (live) translation the parent resolves from the active selection;
// the parent updates it on every `onCoordChange` and on gizmo drags, so the
// inputs and the viewport stay in lock-step.
interface TranslatePanelProps {
  position: Vec3;
  objectName: string;
  /** True when `position` differs from the baseline the panel opened with. The
   *  parent computes this (it owns the baseline); the panel uses it to gate the
   *  X-close confirm and to enable/disable OK. */
  isDirty: boolean;
  /** True while an OK-triggered bake is in flight. Disables the controls and
   *  shows the spinner; the parent closes the panel when the bake resolves. */
  isApplying: boolean;
  onCoordChange: (axis: Axis, value: number) => void;
  /** Reset the draft to zero translation (still not baked — a subsequent OK
   *  bakes the zero, Cancel reverts to baseline). */
  onReset: () => void;
  /** Commit: bake the pending translation. The parent flips `isApplying` and
   *  closes on completion. */
  onApply: () => void;
  /** Discard: revert to baseline and close. */
  onCancel: () => void;
}

const AXES: Axis[] = ['x', 'y', 'z'];

export function TranslatePanel({
  position, objectName, isDirty, isApplying,
  onCoordChange, onReset, onApply, onCancel,
}: TranslatePanelProps) {
  // Whether the X-close confirm ("Apply or discard?") is showing.
  const [confirmClose, setConfirmClose] = useState(false);

  const handleXClose = useCallback(() => {
    if (isApplying) return;
    if (isDirty) setConfirmClose(true);
    else onCancel();  // no changes → closing is a plain cancel
  }, [isApplying, isDirty, onCancel]);

  return (
    <div
      className="absolute top-4 right-[280px] bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56"
      data-testid="translate-panel"
      data-dirty={isDirty ? 'true' : 'false'}
      data-applying={isApplying ? 'true' : 'false'}
    >
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Move className="w-3 h-3" />
          Position
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[9px] text-neutral-500 truncate max-w-[100px]" title={objectName}>
            {objectName}
          </span>
          <button
            onClick={handleXClose}
            disabled={isApplying}
            aria-label="Close"
            title="Close"
            data-testid="translate-close"
            className="p-1 hover:bg-neutral-700 rounded disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X className="w-3 h-3 text-neutral-400" />
          </button>
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
              disabled={isApplying}
              debounceMs={0}
              data-testid={`translate-input-${axis}`}
              className="flex-1 bg-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
          </div>
        ))}
      </div>

      <button
        onClick={onReset}
        disabled={isApplying}
        data-testid="translate-reset"
        className="w-full mt-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Reset Position
      </button>

      {/* OK / Cancel */}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onCancel}
          disabled={isApplying}
          data-testid="translate-cancel"
          className="flex-1 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          onClick={onApply}
          disabled={isApplying}
          data-testid="translate-ok"
          className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-1.5"
        >
          {isApplying ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Applying…
            </>
          ) : (
            'OK'
          )}
        </button>
      </div>

      {/* X-close confirm: apply or discard the pending changes. */}
      {confirmClose && (
        <div
          className="absolute inset-0 bg-neutral-900/95 rounded-lg p-3 flex flex-col justify-center"
          data-testid="translate-close-confirm"
        >
          <p className="text-xs text-neutral-200 mb-3 text-center leading-relaxed">
            Apply the translation before closing?
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => { setConfirmClose(false); onApply(); }}
              data-testid="translate-confirm-apply"
              className="w-full py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium"
            >
              Apply
            </button>
            <button
              onClick={() => { setConfirmClose(false); onCancel(); }}
              data-testid="translate-confirm-discard"
              className="w-full py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs"
            >
              Discard
            </button>
            <button
              onClick={() => setConfirmClose(false)}
              data-testid="translate-confirm-keep-editing"
              className="w-full py-1 text-neutral-400 hover:text-neutral-200 text-[11px]"
            >
              Keep editing
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
