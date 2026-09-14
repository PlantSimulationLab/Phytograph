import { MousePointerClick, X, Copy, Trash2, Ruler, Spline, Triangle } from 'lucide-react';
import type { MeasurementKind } from '../../../lib/measure';

// Pick & Measure panel. The tool itself is the viewport interaction (click a
// point → something happens); this panel chooses WHAT a click does, and is the
// place to see what is out, copy it, and clear it.
//
// Four modes, one armed picker:
//
//   inspect  — a labelled bubble with the point's coordinates and attributes
//   distance — two points, the length between them plus ΔX/ΔY/ΔZ
//   polyline — N points, each segment's length and the running total
//   angle    — three points, the angle at the middle one
//
// A mode rather than a second tool because they all want the same armed
// viewport, the same pick path and the same Escape behaviour; two tools would
// have to mutually exclude each other and duplicate all of it.
//
// Presentational only — the parent (PointCloudViewer) owns the armed state, the
// picked-point list, the measurement list, and the clipboard call.

/** 'inspect' is the original point-picker behaviour; the rest are measurements. */
export type PickerMode = 'inspect' | MeasurementKind;

interface ModeSpec {
  id: PickerMode;
  label: string;
  icon: typeof MousePointerClick;
  /** What the user is expected to do, shown while the mode is armed. */
  hint: string;
}

const MODES: ModeSpec[] = [
  {
    id: 'inspect',
    label: 'Inspect',
    icon: MousePointerClick,
    hint: 'Click a point to label it with its coordinates and attributes',
  },
  { id: 'distance', label: 'Distance', icon: Ruler, hint: 'Click two points to measure between them' },
  { id: 'polyline', label: 'Path', icon: Spline, hint: 'Click points along a path — Enter to finish' },
  { id: 'angle', label: 'Angle', icon: Triangle, hint: 'Click three points — the angle is at the second' },
];

interface PointPickerPanelProps {
  /** True while the tool is armed (viewport clicks do something). */
  armed: boolean;
  /** What a viewport click currently does. */
  mode: PickerMode;
  /** How many inspect labels are placed. */
  pickedCount: number;
  /** How many measurements are placed. */
  measurementCount: number;
  /** Vertices placed so far in the measurement being built. */
  pendingCount: number;
  /** True for the ~600 ms after a successful "Copy all". */
  copied: boolean;
  onModeChange: (mode: PickerMode) => void;
  onToggleArmed: () => void;
  onCopyAll: () => void;
  onClearAll: () => void;
  onClose: () => void;
}

export function PointPickerPanel({
  armed, mode, pickedCount, measurementCount, pendingCount, copied,
  onModeChange, onToggleArmed, onCopyAll, onClearAll, onClose,
}: PointPickerPanelProps) {
  const spec = MODES.find((m) => m.id === mode) ?? MODES[0];
  const measuring = mode !== 'inspect';
  const count = measuring ? measurementCount : pickedCount;

  return (
    <div
      className="absolute top-4 right-[280px] z-20 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56"
      data-testid="point-picker-panel"
      data-armed={armed ? 'true' : 'false'}
      data-picked-count={pickedCount}
      data-measure-mode={mode}
      data-measurement-count={measurementCount}
      data-pending-count={pendingCount}
    >
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <MousePointerClick className="w-3 h-3" />
          Pick &amp; Measure
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

      {/* Mode selector. Switching mode does NOT discard what is already
          placed — inspect labels and measurements coexist on screen, so a user
          can measure a span and then inspect one of its endpoints. */}
      <div className="grid grid-cols-2 gap-1 mb-2" data-testid="picker-mode-group">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = m.id === mode;
          return (
            <button
              key={m.id}
              onClick={() => onModeChange(m.id)}
              title={m.hint}
              data-testid={`picker-mode-${m.id}`}
              data-active={active ? 'true' : 'false'}
              className={`py-1.5 rounded text-[11px] flex items-center justify-center gap-1.5 ${
                active
                  ? 'bg-green-600 text-white'
                  : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-300'
              }`}
            >
              <Icon className="w-3 h-3" />
              {m.label}
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-neutral-500 mb-2 leading-relaxed">
        {spec.hint}. Sky/miss points are not pickable.
      </p>

      {/* A TOGGLE for the armed state, not an instruction — the tool opens
          already armed, so this button's job is to pause picking. Pausing hands
          viewport clicks back to mesh selection (which arming blocks) without
          closing the panel or discarding what is placed. Labelled by what
          pressing it DOES, not by the state it is in. */}
      <button
        onClick={onToggleArmed}
        title={armed
          ? 'Stop picking — viewport clicks go back to selecting objects'
          : 'Arm the tool so viewport clicks are picked'}
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
        <div className="text-[10px] text-amber-400/90 mb-2 text-center" data-testid="picker-hint">
          {pendingCount > 0
            ? mode === 'polyline'
              ? `${pendingCount} placed — Enter to finish, Esc to cancel`
              : `${pendingCount} placed — Esc to cancel`
            : 'Click points in the viewport'}
        </div>
      )}

      <div className="text-[10px] text-neutral-400 mb-2" data-testid="point-picker-count">
        {measuring
          ? count === 0
            ? 'No measurements'
            : `${count} measurement${count === 1 ? '' : 's'}`
          : count === 0
            ? 'No points picked'
            : `${count} point${count === 1 ? '' : 's'} picked`}
      </div>

      <button
        onClick={onCopyAll}
        disabled={count === 0}
        title={measuring ? 'Copy every measurement as CSV' : 'Copy every picked point as CSV'}
        data-testid="point-picker-copy-all"
        className="w-full py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[11px] flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Copy className="w-3 h-3" />
        {copied ? 'Copied' : 'Copy all (CSV)'}
      </button>

      {/* Enabled while a measurement is half-placed too — onClearAll discards
          the pending vertices as well, so gating purely on the committed count
          greyed the button out when there was still something to clear. */}
      <button
        onClick={onClearAll}
        disabled={measuring ? count === 0 && pendingCount === 0 : count === 0}
        data-testid="point-picker-clear-all"
        className="w-full mt-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[11px] flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Trash2 className="w-3 h-3" />
        {measuring ? 'Clear measurements' : 'Clear all'}
      </button>
    </div>
  );
}
