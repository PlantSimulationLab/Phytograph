import { STICKY_PANEL_HEADER } from './stickyPanelHeader';
import { useState, useCallback } from 'react';
import { Move, RotateCcw, X, Loader2, Maximize2, Lock, Unlock, AlertTriangle } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { ObjectPicker, type PickerItem } from '../../ObjectPicker';

type Axis = 'x' | 'y' | 'z';
interface Vec3 { x: number; y: number; z: number }

// Transformation panel. Two users:
//
//  - The Transformation tool (clouds + meshes): a target PICKER listing every
//    cloud and mesh in the scene, and one RELATIVE delta — move by / rotate by /
//    scale by, about the scene origin — applied to every checked object alike.
//    Passing `picker` turns this mode on.
//  - The skeleton translate panel: translation only (`showRotation` false, no
//    picker, no scale).
//
// The per-mesh absolute editor (grid, Fit to Scans, …) is TransformPanel.
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
  /** Commit: bake the pending transform. The parent flips `isApplying`; it
   *  either closes the panel on completion or (with `keepOpenOnApply`) resets
   *  the fields and leaves it open. May resolve to false when nothing applied. */
  onApply: () => void | Promise<boolean>;
  /** The Transformation tool stays open after Apply, so several objects can be
   *  moved by different amounts in turn. The commit button then reads "Apply",
   *  the left button "Close" when nothing is pending, and the X-close confirm's
   *  Apply closes after applying. */
  keepOpenOnApply?: boolean;
  /** Discard: revert to baseline and close. */
  onCancel: () => void;
  /** Target picker (Transformation tool). Omitted for the skeleton panel. */
  picker?: {
    items: PickerItem[];
    selectedIds: Set<string>;
    onChange: (next: Set<string>) => void;
  };
  /** Draft SCALE factors. Omitted → no scale section. */
  scale?: Vec3;
  scaleLocked?: boolean;
  onScaleLockedChange?: (locked: boolean) => void;
  onScaleChange?: (axis: Axis, value: number) => void;
  onResetScale?: () => void;
  /** Read-only description of the pivot (e.g. the scene origin's coordinates). */
  pivotLabel?: string;
  /** Advisory notes shown above OK (non-blocking). */
  warnings?: { testId: string; text: string }[];
  /** When set, OK is disabled and this explains why. */
  okBlockedReason?: string | null;
}

const AXES: Axis[] = ['x', 'y', 'z'];

export function TransformationPanel({
  position, rotation, showRotation, objectName, isDirty, isApplying,
  onCoordChange, onRotationChange, onReset, onResetRotation, onApply, onCancel,
  picker, scale, scaleLocked = true, onScaleLockedChange, onScaleChange, onResetScale,
  pivotLabel, warnings, okBlockedReason, keepOpenOnApply = false,
}: TransformationPanelProps) {
  // With a picker the numbers are a DELTA applied to many objects, so say so.
  const relative = !!picker;
  const nothingChecked = !!picker && picker.selectedIds.size === 0;
  // The tool stays open after Apply, so an Apply with nothing pending would be
  // a no-op. Graying it out makes the button double as the "you have unapplied
  // changes" signal: the pending transform follows the CHECKED set, so it must
  // be applied before checking a different object. (The skeleton panel's OK
  // closes the panel, so it stays live with nothing pending.)
  const nothingPending = keepOpenOnApply && !isDirty;
  // Whether the X-close confirm ("Apply or discard?") is showing.
  const [confirmClose, setConfirmClose] = useState(false);

  const handleXClose = useCallback(() => {
    if (isApplying) return;
    if (isDirty) setConfirmClose(true);
    else onCancel();  // no changes → closing is a plain cancel
  }, [isApplying, isDirty, onCancel]);

  return (
    <div
      className={`absolute top-4 right-[280px] z-20 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 shadow-lg ${
        relative ? 'w-72 max-h-[calc(100%-2rem)] overflow-y-auto' : 'w-56'
      }`}
      data-testid="translate-panel"
      data-dirty={isDirty ? 'true' : 'false'}
      data-applying={isApplying ? 'true' : 'false'}
    >
      <div className={`text-xs font-medium text-neutral-300 flex items-center justify-between ${STICKY_PANEL_HEADER}`}>
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

      {picker && (
        <div className="mb-3">
          <ObjectPicker
            items={picker.items}
            selectedIds={picker.selectedIds}
            onChange={picker.onChange}
            label="Objects"
            emptyMessage="No point clouds or meshes in the scene."
            rowTestId="transform-target-row"
            data-testid="transform-targets"
          />
          {picker.selectedIds.size === 0 && picker.items.length > 0 && (
            <p className="mt-1 text-[10px] text-neutral-500" data-testid="transform-none-checked">
              Check the objects to transform.
            </p>
          )}
        </div>
      )}
      {pivotLabel && (
        <div className="mb-2 text-[10px] text-neutral-500" data-testid="transform-pivot">
          About {pivotLabel}
        </div>
      )}

      {/* Position */}
      <div className="text-[10px] text-neutral-400 mb-1.5 flex items-center gap-1">
        <Move className="w-3 h-3" />
        {relative ? 'Move by' : 'Position'}
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
        {relative ? 'Reset Move' : 'Reset Position'}
      </button>

      {/* Rotation (clouds only). Degrees, Euler XYZ, applied about the active
          pivot (scene origin, or the cloud's bbox center when none is set). */}
      {showRotation && (
        <>
          <div className="text-[10px] text-neutral-400 mt-3 mb-1.5 flex items-center gap-1">
            <RotateCcw className="w-3 h-3" />
            {relative ? 'Rotate by (°)' : 'Rotation (°)'}
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

      {/* Scale (Transformation tool). Per world axis, applied about the pivot
          BEFORE the rotation. The lock keeps it uniform. */}
      {scale && onScaleChange && (
        <>
          <div className="text-[10px] text-neutral-400 mt-3 mb-1.5 flex items-center gap-1">
            <Maximize2 className="w-3 h-3" />
            <span className="flex-1">Scale by (×)</span>
            <button
              type="button"
              onClick={() => onScaleLockedChange?.(!scaleLocked)}
              disabled={isApplying}
              data-testid="scale-lock"
              data-locked={scaleLocked ? 'true' : 'false'}
              title={scaleLocked ? 'Uniform scale (click to scale axes independently)' : 'Independent axes (click to lock uniform)'}
              aria-label={scaleLocked ? 'Unlock scale axes' : 'Lock scale axes'}
              className="p-0.5 hover:bg-neutral-700 rounded disabled:opacity-40"
            >
              {scaleLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
            </button>
          </div>
          <div className="space-y-2">
            {AXES.map((axis) => (
              <div key={axis} className="flex items-center gap-2">
                <label className="text-[10px] text-neutral-400 w-3 uppercase font-medium">
                  {axis}
                </label>
                <DebouncedNumberInput
                  step={0.1}
                  min={0.001}
                  value={scale[axis]}
                  format={(n) => n.toFixed(3)}
                  onCommit={(n) => onScaleChange(axis, n)}
                  disabled={isApplying}
                  debounceMs={0}
                  data-testid={`scale-input-${axis}`}
                  className="flex-1 bg-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                />
              </div>
            ))}
          </div>
          <button
            onClick={onResetScale}
            disabled={isApplying}
            data-testid="scale-reset"
            className="w-full mt-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Reset Scale
          </button>
        </>
      )}

      {warnings && warnings.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {warnings.map((w) => (
            <div
              key={w.testId}
              data-testid={w.testId}
              className="flex gap-1.5 text-[10px] leading-snug text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded p-1.5"
            >
              <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-px" />
              <span>{w.text}</span>
            </div>
          ))}
        </div>
      )}
      {okBlockedReason && (
        <div
          data-testid="transform-ok-blocked"
          className="mt-2 text-[10px] leading-snug text-red-300 bg-red-500/10 border border-red-500/30 rounded p-1.5"
        >
          {okBlockedReason}
        </div>
      )}

      {/* OK / Cancel */}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onCancel}
          disabled={isApplying}
          data-testid="translate-cancel"
          title={keepOpenOnApply && isDirty ? 'Discard the unapplied changes and close' : undefined}
          className="flex-1 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {keepOpenOnApply && !isDirty ? 'Close' : 'Cancel'}
        </button>
        <button
          onClick={onApply}
          disabled={isApplying || !!okBlockedReason || nothingChecked || nothingPending}
          title={okBlockedReason ?? (nothingChecked ? 'Check the objects to transform' : nothingPending ? 'No changes to apply' : undefined)}
          data-testid="translate-ok"
          className={`flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium flex items-center justify-center gap-1.5 ${
            isApplying ? 'disabled:opacity-60 disabled:cursor-wait' : 'disabled:opacity-40 disabled:cursor-not-allowed'
          }`}
        >
          {isApplying ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Applying…
            </>
          ) : (
            keepOpenOnApply ? 'Apply' : 'OK'
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
              onClick={() => {
                setConfirmClose(false);
                // The tool stays open after Apply; closing was asked for here,
                // so close once the apply has landed.
                void Promise.resolve(onApply()).then((ok) => {
                  if (keepOpenOnApply && ok !== false) onCancel();
                });
              }}
              disabled={!!okBlockedReason}
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
