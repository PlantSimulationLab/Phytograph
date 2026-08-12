import { Brush, X, Undo2, Check, Eye, EyeOff, Palette } from 'lucide-react';
import type { ClassDef } from '../../../lib/classification';
import { rgbToHex } from '../../../lib/classification';

// Presentational manual-labelling panel. All painting, stroke bookkeeping and
// backend calls live in PointCloudViewer; this renders the class list, the
// active-class selection, the From-class gate and the commit/undo actions from
// derived props — the same split ErasePanel uses.
//
// The data-* attributes are the E2E seam: the DOM cannot show what the GPU
// painted, so the panel publishes the parent's own counts (see also the narrow
// window.__labelOverlay fact the overlay module publishes).

export interface LabelPanelProps {
  /** Classes from the cloud's bound palette, in display order. */
  classes: ClassDef[];
  paletteName: string;
  activeClass: number;
  /** value -> count of currently-labelled points, from the backend. */
  classCounts: Record<number, number>;
  /** Classes currently drawn; hidden ones are also excluded from the From gate. */
  visibleClasses: Set<number>;
  /**
   * From-class gate. null = "Any visible" — repaint whatever the region covers.
   * A set restricts repainting to those classes, which is what makes fast,
   * sloppy selection safe (overspray onto a class you didn't name is a no-op).
   */
  fromClasses: Set<number> | null;
  /** Uncommitted strokes (the undo depth, and what a commit would bake). */
  pendingStrokes: number;
  /** True when the octree is behind the label column. */
  dirty: boolean;
  /** True while the lasso is armed (clicks place vertices, view is frozen). */
  drawing: boolean;
  onToggleDrawing: () => void;
  /**
   * True when a cross-section is bounding strokes. Surfaced because it silently
   * changes what a lasso does — without it the user cannot tell why a stroke
   * painted fewer points than it enclosed.
   */
  sectionActive?: boolean;
  onClearSection?: () => void;
  busy: boolean;
  onSelectClass: (value: number) => void;
  onToggleVisible: (value: number) => void;
  onToggleFromClass: (value: number) => void;
  onSetFromAnyVisible: () => void;
  onUndoStroke: () => void;
  onCommit: () => void;
  onEditPalette: () => void;
  onClose: () => void;
}

export function LabelPanel({
  classes,
  paletteName,
  activeClass,
  classCounts,
  visibleClasses,
  fromClasses,
  pendingStrokes,
  dirty,
  drawing,
  onToggleDrawing,
  sectionActive = false,
  onClearSection,
  busy,
  onSelectClass,
  onToggleVisible,
  onToggleFromClass,
  onSetFromAnyVisible,
  onUndoStroke,
  onCommit,
  onEditPalette,
  onClose,
}: LabelPanelProps) {
  const labelled = Object.entries(classCounts)
    .filter(([v]) => Number(v) !== 0)
    .reduce((n, [, c]) => n + c, 0);

  const nameOf = (v: number) => classes.find((c) => c.value === v)?.label ?? `Class ${v}`;
  const activeName = nameOf(activeClass);
  const fromNames = fromClasses
    ? [...fromClasses].map(nameOf).join(', ')
    : '';
  // "Paint X only over X" — the combination that silently does nothing.
  const isNoOp = !!fromClasses && fromClasses.size === 1 && fromClasses.has(activeClass);

  return (
    <div
      data-testid="label-panel"
      data-active-class={activeClass}
      data-pending-strokes={pendingStrokes}
      data-label-dirty={dirty ? 'true' : 'false'}
      data-label-drawing={drawing ? 'true' : 'false'}
      data-section-active={sectionActive ? 'true' : 'false'}
      data-labelled-count={labelled}
      // Serialised counts, so a spec can assert on per-class totals without
      // reaching into the scene graph.
      data-label-counts={JSON.stringify(classCounts)}
      // z-20 keeps the panel above the polygon lasso overlay (z-10), which fills
      // the whole viewport while drawing. WITHOUT IT the overlay renders on top
      // and swallows every click here — the panel becomes unusable and even its
      // close button just drops another lasso vertex. Same reason CropPanel
      // carries z-20; the labelling tool borrows that same overlay.
      className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 z-20"
    >
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Brush className="w-3 h-3" />
          Label Points
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

      {/* Arm/disarm, mirroring the Erase tool's toggle. ON freezes the view and
          makes clicks place lasso vertices; OFF hands the viewport back so the
          user can orbit and reframe between strokes WITHOUT closing the tool and
          losing their class selection. Without this the tool is unusable on real
          data: every click is a vertex, so there is no way to look around. */}
      <button
        data-testid="label-mode-toggle"
        onClick={onToggleDrawing}
        className={`w-full mb-3 px-2 py-1.5 text-xs font-medium rounded transition-colors ${
          drawing
            ? 'bg-blue-600 hover:bg-blue-500 text-white'
            : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
        }`}
      >
        {drawing ? 'Drawing — view frozen (L)' : 'Start Drawing (L)'}
      </button>

      {sectionActive && (
        <div
          data-testid="label-section-notice"
          className="mb-3 px-2 py-1.5 rounded bg-sky-900/40 border border-sky-700/50 text-[10px] text-sky-200 flex items-center justify-between gap-2"
        >
          <span>Strokes are limited to the cross-section.</span>
          {onClearSection && (
            <button
              data-testid="label-clear-section"
              onClick={onClearSection}
              className="shrink-0 underline hover:text-white"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-neutral-400 truncate" title={paletteName}>
          {paletteName}
        </span>
        <button
          data-testid="label-edit-palette"
          onClick={onEditPalette}
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
        >
          <Palette className="w-3 h-3" />
          Classes
        </button>
      </div>

      {/* Class list. Clicking a row makes it the active class (1-9 do the same
          for the first nine); the eye toggles visibility; the dot toggles the
          From-class gate. The header names those last two columns — an unlabeled
          dot next to an unlabeled eye gives no clue that one means "paint this"
          and the other "paint over this". */}
      <div className="flex items-center gap-1.5 px-1.5 pb-1 text-[9px] text-neutral-500 uppercase tracking-wide">
        <span className="w-3" />
        <span className="flex-1">Click a class to paint it</span>
        <span title="Only paint over this class">over</span>
        <span title="Show/hide this class">show</span>
      </div>
      <div
        data-testid="label-class-list"
        className="max-h-56 overflow-y-auto mb-3 border border-neutral-700 rounded"
      >
        {classes.map((c, i) => {
          const active = c.value === activeClass;
          const visible = visibleClasses.has(c.value);
          const inFrom = fromClasses?.has(c.value) ?? false;
          return (
            <div
              key={c.value}
              data-testid={`label-class-${c.value}`}
              data-active={active ? 'true' : 'false'}
              data-visible={visible ? 'true' : 'false'}
              data-in-from={inFrom ? 'true' : 'false'}
              data-count={classCounts[c.value] ?? 0}
              className={`flex items-center gap-1.5 px-1.5 py-1 text-[11px] cursor-pointer ${
                active ? 'bg-blue-600/40' : 'hover:bg-neutral-700/60'
              }`}
              onClick={() => onSelectClass(c.value)}
            >
              <span
                className="w-3 h-3 rounded-sm shrink-0 border border-black/30"
                style={{ backgroundColor: rgbToHex(c.color) }}
              />
              <span className="flex-1 truncate text-neutral-200" title={c.label}>
                {i < 9 ? `${i + 1}. ` : ''}{c.label}
              </span>
              <span className="text-[10px] text-neutral-500 tabular-nums">
                {classCounts[c.value] ?? 0}
              </span>
              <button
                data-testid={`label-from-${c.value}`}
                aria-label={`Only repaint ${c.label}`}
                title="Only repaint this class"
                onClick={(e) => { e.stopPropagation(); onToggleFromClass(c.value); }}
                className={`w-3 h-3 rounded-full shrink-0 border ${
                  inFrom ? 'bg-amber-400 border-amber-200' : 'border-neutral-500'
                }`}
              />
              <button
                data-testid={`label-visible-${c.value}`}
                aria-label={`${visible ? 'Hide' : 'Show'} ${c.label}`}
                onClick={(e) => { e.stopPropagation(); onToggleVisible(c.value); }}
                className="p-0.5 hover:bg-neutral-600 rounded shrink-0"
              >
                {visible
                  ? <Eye className="w-3 h-3 text-neutral-400" />
                  : <EyeOff className="w-3 h-3 text-neutral-600" />}
              </button>
            </div>
          );
        })}
      </div>

      {/* The active class and the From gate, stated as a SENTENCE.
          The two are easy to confuse — one is what a stroke paints, the other is
          what it is allowed to paint OVER — and the most natural-looking
          combination (highlight a class AND set its own From dot) is a no-op by
          construction: "paint X, but only over X". Spelling it out, and warning
          on that exact case, is cheaper than expecting the icons to carry it. */}
      <div className="mb-3 text-[10px]">
        <div data-testid="label-rule" className="text-neutral-300 mb-1 leading-relaxed">
          Painting <span className="text-white font-medium">{activeName}</span>
          {' over '}
          <span className="text-white font-medium">
            {fromClasses === null
              ? 'any visible class'
              : fromNames || 'nothing'}
          </span>
        </div>
        <button
          data-testid="label-from-any"
          onClick={onSetFromAnyVisible}
          className={`w-full px-2 py-1 rounded text-left ${
            fromClasses === null
              ? 'bg-neutral-700 text-neutral-200'
              : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-700'
          }`}
        >
          {fromClasses === null
            ? 'Paint over any visible class'
            : 'Reset — paint over any visible class'}
        </button>
        {isNoOp && (
          <div data-testid="label-noop-warning" className="mt-1.5 text-amber-400">
            This paints {activeName} only over points that are already
            {' '}{activeName}, so it will do nothing. Clear the ◉ on that class,
            or pick a different class to paint.
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <button
          data-testid="label-undo"
          onClick={onUndoStroke}
          disabled={pendingStrokes === 0 || busy}
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Undo2 className="w-3 h-3" />
          Undo
        </button>
        <button
          data-testid="label-commit"
          onClick={onCommit}
          disabled={!dirty || busy}
          title="Bake the labels into the point cloud"
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Check className="w-3 h-3" />
          {busy ? 'Saving…' : 'Commit'}
        </button>
      </div>

      {pendingStrokes > 0 && (
        <div data-testid="label-pending-hint" className="mt-2 text-[10px] text-amber-400">
          {pendingStrokes} unsaved {pendingStrokes === 1 ? 'stroke' : 'strokes'} — commit to keep them.
        </div>
      )}
    </div>
  );
}
