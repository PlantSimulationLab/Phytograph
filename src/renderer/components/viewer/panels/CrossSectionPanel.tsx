import { Layers3, X, ChevronLeft, ChevronRight, Home, Pencil, Lock, LockOpen, Eye, EyeOff, Trash2 } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import type { SlabStepMode } from '../../../lib/crossSection';

// Presentational cross-section panel. All slab geometry and camera work lives
// in PointCloudViewer / lib/crossSection.ts; this renders the controls.
//
// Separate from the labelling panel because a section is a VIEW STATE, not a
// mode. It coexists with whatever tool is active — inspect a canopy with no tool
// open, bound an erase stroke, check a QSM against its points, or (the main
// case) bound a labelling stroke. Modes are mutually exclusive; view states are
// not, which is why this panel does not participate in closeAllToolPanels and
// stacks below the active tool's panel instead.

const STEP_MODES: Array<{ id: SlabStepMode; label: string; hint: string }> = [
  { id: 'half', label: 'Half', hint: 'Half the thickness — sections overlap, so nothing is missed (recommended)' },
  { id: 'almost', label: '90%', hint: 'Almost a full thickness — a sliver of overlap' },
  { id: 'full', label: 'Full', hint: 'Exactly one thickness — sections tile with no overlap' },
  { id: 'fixed', label: 'Fixed', hint: 'A distance you set' },
];

export interface CrossSectionPanelProps {
  /**
   * Push the panel down when another tool's panel occupies the top slot. The
   * section is a view state that coexists with a tool rather than replacing it,
   * so the two are visible at once and must not overlap.
   */
  stacked?: boolean;
  /** True once a centreline exists; false while the user is still drawing one. */
  hasSlab: boolean;
  drawing: boolean;
  thickness: number;
  thicknessMin: number;
  thicknessMax: number;
  thicknessStep: number;
  stepMode: SlabStepMode;
  fixedStep: number;
  /** 1-based position in the traverse and the number of steps spanning it. */
  coverage: { index: number; total: number } | null;
  locked: boolean;
  /** Section defined but not currently clipping — the whole cloud is shown. */
  suspended: boolean;
  onToggleSuspended: () => void;
  onClear: () => void;
  onDraw: () => void;
  onThicknessChange: (v: number) => void;
  onStepModeChange: (m: SlabStepMode) => void;
  onFixedStepChange: (v: number) => void;
  onStep: (dir: 1 | -1) => void;
  onResetOffset: () => void;
  onToggleLocked: () => void;
  onClose: () => void;
}

export function CrossSectionPanel({
  stacked = false,
  hasSlab,
  drawing,
  thickness,
  thicknessMin,
  thicknessMax,
  thicknessStep,
  stepMode,
  fixedStep,
  coverage,
  locked,
  suspended,
  onToggleSuspended,
  onClear,
  onDraw,
  onThicknessChange,
  onStepModeChange,
  onFixedStepChange,
  onStep,
  onResetOffset,
  onToggleLocked,
  onClose,
}: CrossSectionPanelProps) {
  return (
    <div
      data-testid="cross-section-panel"
      data-has-slab={hasSlab ? 'true' : 'false'}
      data-drawing={drawing ? 'true' : 'false'}
      data-step-mode={stepMode}
      data-locked={locked ? 'true' : 'false'}
      data-suspended={suspended ? 'true' : 'false'}
      data-coverage={coverage ? `${coverage.index}/${coverage.total}` : ''}
      data-thickness={thickness}
      // z-20 keeps the panel above the z-10 lasso overlay, which fills the
      // viewport while drawing. Without it the overlay swallows every click here
      // and the panel cannot even be closed. See CropPanel / LabelPanel.
      className={`absolute right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 z-20 ${
        stacked ? 'top-[26rem]' : 'top-4'
      }`}
    >
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Layers3 className="w-3 h-3" />
          Cross-section
        </span>
        <button onClick={onClose} aria-label="Close" title="Close"
          className="p-1 hover:bg-neutral-700 rounded">
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <button
        data-testid="section-draw"
        onClick={onDraw}
        className={`w-full mb-3 px-2 py-1.5 text-xs font-medium rounded transition-colors flex items-center justify-center gap-1.5 ${
          drawing
            ? 'bg-blue-600 hover:bg-blue-500 text-white'
            : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
        }`}
      >
        <Pencil className="w-3 h-3" />
        {drawing
          ? 'Click two points in the view'
          : hasSlab ? 'Redraw section' : 'Draw section'}
      </button>

      {hasSlab && (
        <>
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">
              Thickness
            </label>
            <DebouncedNumberInput
              data-testid="section-thickness"
              value={thickness}
              min={thicknessMin}
              max={thicknessMax}
              step={thicknessStep}
              onCommit={onThicknessChange}
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-100"
            />
            <p className="text-[9px] text-neutral-500 mt-1 leading-tight">
              Thin enough that nothing hides behind anything — that is what makes
              painting in a section unambiguous.
            </p>
          </div>

          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">Step size</label>
            <div className="flex gap-1">
              {STEP_MODES.map((m) => (
                <button
                  key={m.id}
                  data-testid={`section-step-${m.id}`}
                  title={m.hint}
                  onClick={() => onStepModeChange(m.id)}
                  className={`flex-1 px-1 py-1 text-[10px] rounded ${
                    stepMode === m.id
                      ? 'bg-blue-600 text-white'
                      : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {stepMode === 'fixed' && (
              <DebouncedNumberInput
                data-testid="section-fixed-step"
                value={fixedStep}
                min={thicknessMin}
                max={thicknessMax * 10}
                step={thicknessStep}
                onCommit={onFixedStepChange}
                className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-100"
              />
            )}
          </div>

          {/* Stepping. The coverage readout is what makes a traverse PROVABLE —
              without it the user has no way to know they have inspected the
              whole cloud, which is the main thing a free 3-D orbit cannot give. */}
          <div className="mb-3">
            <div className="flex items-center gap-1">
              <button
                data-testid="section-step-back"
                onClick={() => onStep(-1)}
                title="Previous section (,)"
                className="flex-1 flex items-center justify-center px-2 py-1.5 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                data-testid="section-reset"
                onClick={onResetOffset}
                title="Back to where the section was drawn (Home)"
                className="px-2 py-1.5 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-300"
              >
                <Home className="w-3 h-3" />
              </button>
              <button
                data-testid="section-step-forward"
                onClick={() => onStep(1)}
                title="Next section (.)"
                className="flex-1 flex items-center justify-center px-2 py-1.5 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
            {coverage && (
              <div data-testid="section-coverage"
                className="mt-1 text-center text-[10px] text-neutral-400 tabular-nums">
                Section {coverage.index} of {coverage.total}
              </div>
            )}
          </div>

          <button
            data-testid="section-lock"
            onClick={onToggleLocked}
            title={locked
              ? 'Unlock to orbit and inspect the same slab in 3-D'
              : 'Lock back to the face-on section view'}
            className={`w-full px-2 py-1.5 text-xs rounded flex items-center justify-center gap-1.5 ${
              locked
                ? 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
                : 'bg-amber-600/80 hover:bg-amber-600 text-white'
            }`}
          >
            {locked ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
            {locked ? 'Locked to section' : 'Free camera'}
          </button>

          {/* Getting back to the whole cloud. Everything above ADJUSTS the
              section; these two are the only ways out of it. Suspend keeps the
              slab so the user can look around and drop back into the same
              section; Clear removes it. */}
          <button
            data-testid="section-suspend"
            onClick={onToggleSuspended}
            title={suspended
              ? 'Show the section again'
              : 'Temporarily show the whole cloud — the section is kept'}
            className={`w-full mt-2 px-2 py-1.5 text-xs rounded flex items-center justify-center gap-1.5 ${
              suspended
                ? 'bg-amber-600/80 hover:bg-amber-600 text-white'
                : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
            }`}
          >
            {suspended ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            {suspended ? 'Showing full cloud' : 'Show full cloud'}
          </button>

          <button
            data-testid="section-clear"
            onClick={onClear}
            title="Remove the section and go back to the full cloud"
            className="w-full mt-2 px-2 py-1.5 text-xs rounded flex items-center justify-center gap-1.5 bg-neutral-700 hover:bg-red-900/60 text-neutral-300 hover:text-red-200"
          >
            <Trash2 className="w-3 h-3" />
            Clear section
          </button>
        </>
      )}
    </div>
  );
}
