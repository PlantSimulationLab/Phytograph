import { useState, useCallback } from 'react';
import { Move, RotateCcw, X, Loader2 } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

type Axis = 'x' | 'y' | 'z';
interface Vec3 { x: number; y: number; z: number }

// Transformation panel for clouds and skeletons (meshes use TransformPanel):
// X/Y/Z translation AND (clouds only) X/Y/Z rotation in degrees.
//
// Editing model (see the flow the user specified):
//  - The panel is a DRAFT editor. Typing an axis value (or dragging a gizmo,
//    which the parent pushes back in via `position`/`rotation`) updates the
//    viewport LIVE but does NOT bake. Nothing is committed until the user
//    resolves the panel.
//  - **OK** → `onApply`: bake the pending transform (rotation-about-pivot then
//    translation) into geometry, then close. While the bake runs the panel shows
//    an "Applying…" state and blocks (its buttons disable) so the user can't fire
//    a second commit.
//  - **Cancel** → `onCancel`: revert to the baseline the panel opened with and
//    close. Nothing is baked.
//  - **X** (top-right): if there are unsaved changes vs. baseline, prompt the
//    user to Apply or Discard; with no changes it just closes (== cancel).
//
// The parent (PointCloudViewer) owns the actual translation/rotation state and
// the baseline; this component renders the draft and reports intent. Rotation is
// hidden for skeletons (their render-only offset is translation-only) via
// `showRotation`. Testids keep the historical `translate-*` names so the existing
// E2E suite is undisturbed; rotation adds `rotation-*` testids.
interface TransformationPanelProps {
  position: Vec3;
  /** Draft rotation in DEGREES (Euler XYZ). Only meaningful for clouds. */
  rotation: Vec3;
  /** Whether to show the rotation section (clouds yes, skeletons no). */
  showRotation: boolean;
  objectName: string;
  /** True when the draft (translation and/or rotation) differs from the baseline
   *  the panel opened with. The parent computes this (it owns the baseline); the
   *  panel uses it to gate the X-close confirm and to enable/disable OK. */
  isDirty: boolean;
  /** True while an OK-triggered bake is in flight. Disables the controls and
   *  shows the spinner; the parent closes the panel when the bake resolves. */
  isApplying: boolean;
  onCoordChange: (axis: Axis, value: number) => void;
  onRotationChange: (axis: Axis, value: number) => void;
  /** Reset the draft TRANSLATION to zero (still not baked). */
  onReset: () => void;
  /** Reset the draft ROTATION to zero (still not baked). */
  onResetRotation: () => void;
  /** Commit: bake the pending transform. The parent flips `isApplying` and
   *  closes on completion. */
  onApply: () => void;
  /** Discard: revert to baseline and close. */
  onCancel: () => void;
}

const AXES: Axis[] = ['x', 'y', 'z'];

export function TransformationPanel({
  position, rotation, showRotation, objectName, isDirty, isApplying,
  onCoordChange, onRotationChange, onReset, onResetRotation, onApply, onCancel,
}: TransformationPanelProps) {
  // Whether the X-close confirm ("Apply or discard?") is showing.
  const [confirmClose, setConfirmClose] = useState(false);

  const handleXClose = useCallback(() => {
    if (isApplying) return;
    if (isDirty) setConfirmClose(true);
    else onCancel();  // no changes → closing is a plain cancel
  }, [isApplying, isDirty, onCancel]);

  return (
    <div
      className="absolute top-4 right-[280px] z-20 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56"
      data-testid="translate-panel"
      data-dirty={isDirty ? 'true' : 'false'}
      data-applying={isApplying ? 'true' : 'false'}
    >
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Move className="w-3 h-3" />
          Transform
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

      {/* Position */}
      <div className="text-[10px] text-neutral-400 mb-1.5 flex items-center gap-1">
        <Move className="w-3 h-3" />
        Position
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
        className="w-full mt-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Reset Position
      </button>

      {/* Rotation (clouds only). Degrees, Euler XYZ, applied about the active
          pivot (scene origin, or the cloud's bbox center when none is set). */}
      {showRotation && (
        <>
          <div className="text-[10px] text-neutral-400 mt-3 mb-1.5 flex items-center gap-1">
            <RotateCcw className="w-3 h-3" />
            Rotation (°)
          </div>
          <div className="space-y-2">
            {AXES.map((axis) => (
              <div key={axis} className="flex items-center gap-2">
                <label className="text-[10px] text-neutral-400 w-3 uppercase font-medium">
                  {axis}
                </label>
                <DebouncedNumberInput
                  step={5}
                  value={rotation[axis]}
                  format={(n) => n.toFixed(1)}
                  onCommit={(n) => onRotationChange(axis, n)}
                  disabled={isApplying}
                  debounceMs={0}
                  data-testid={`rotation-input-${axis}`}
                  className="flex-1 bg-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                />
              </div>
            ))}
          </div>
          <button
            onClick={onResetRotation}
            disabled={isApplying}
            data-testid="rotation-reset"
            className="w-full mt-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Reset Rotation
          </button>
        </>
      )}

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
            Apply the transform before closing?
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
