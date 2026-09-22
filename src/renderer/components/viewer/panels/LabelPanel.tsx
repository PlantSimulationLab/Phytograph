import { Brush, X, Undo2, Check, Eye, EyeOff, Palette, Shuffle, Lasso } from 'lucide-react';
import type { ClassDef } from '../../../lib/classification';
import { rgbToHex } from '../../../lib/classification';
import type { LabelableColumn } from '../../../lib/classPalettes';

// Presentational manual-labelling panel. All painting, stroke bookkeeping and
// backend calls live in PointCloudViewer; this renders the class list, the
// active-class selection, the From-class gate and the commit/undo actions from
// derived props — the same split ErasePanel uses.
//
// The data-* attributes are the E2E seam: the DOM cannot show what the GPU
// painted, so the panel publishes the parent's own counts (see also the narrow
// window.__labelOverlay fact the overlay module publishes).

/**
 * Sentinel option value for "+ New classification…". Not a slug — the handler
 * intercepts it — and it can never collide with a real one, which must start
 * with a lowercase letter.
 */
const NEW_COLUMN_SENTINEL = '__new__';

const COLUMN_GROUP_LABEL: Record<LabelableColumn['kind'], string> = {
  manual: 'Labelling',
  categorical: 'Classifications',
  scalar: 'Other columns',
};

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
  /**
   * A commit for this column is baking in the background.
   *
   * Exposed as a data attribute for E2E and NOT drawn: the commit toast has
   * already said the labels are saved, and a second, persistent "still
   * working" line is what turns an unblocking change back into a wait. The
   * user has nothing to decide and nothing to do.
   */
  baking?: boolean;
  /**
   * The background bake failed. Actionable, unlike `baking`, and therefore
   * shown: the labels are still on the cloud but the display index does not
   * carry them, and the only way to ask again is the Commit button — which,
   * with no strokes pending, would otherwise sit disabled with nothing
   * explaining why it matters.
   */
  bakeFailed?: boolean;
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
  /** Selection primitive: lasso outline, or sphere brush. */
  tool: 'lasso' | 'brush';
  onToolChange: (t: 'lasso' | 'brush') => void;
  /** Brush radius in screen pixels, shown so the wheel/bracket keys are discoverable. */
  brushPx: number;
  /**
   * The columns of this cloud that can be labelled, in display order.
   *
   * The tool used to reach only the four columns its presets named, so a cloud
   * carrying its own classification — a `tree_instance` from a tree
   * segmentation that needs correcting — could not be hand-edited at all.
   */
  columns: LabelableColumn[];
  /** The column being painted. Always equals the live palette's slug. */
  activeSlug: string;
  onSelectColumn: (slug: string) => void;
  /** Start a brand-new classification column. */
  onNewColumn: () => void;
  /**
   * How many stock vocabularies describe the ACTIVE column. Zero disables the
   * Preset button — a preset names a column as well as a class list, so cycling
   * one that belongs to another column would silently move the user off theirs.
   */
  presetCount: number;
  /** Cycle to the next built-in preset vocabulary for this column. */
  onCyclePreset: () => void;
  /** Open the editor to add/rename/recolour classes. */
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
  baking = false,
  bakeFailed = false,
  busy,
  onSelectClass,
  onToggleVisible,
  onToggleFromClass,
  onSetFromAnyVisible,
  onUndoStroke,
  onCommit,
  tool,
  onToolChange,
  brushPx,
  columns,
  activeSlug,
  onSelectColumn,
  onNewColumn,
  presetCount,
  onCyclePreset,
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
  const activeColumn = columns.find((c) => c.slug === activeSlug);

  return (
    <div
      data-testid="label-panel"
      data-active-class={activeClass}
      data-pending-strokes={pendingStrokes}
      data-label-dirty={dirty ? 'true' : 'false'}
      data-label-baking={baking ? 'true' : 'false'}
      data-label-drawing={drawing ? 'true' : 'false'}
      data-section-active={sectionActive ? 'true' : 'false'}
      data-labelled-count={labelled}
      // The column being painted. The DOM cannot show which backend column a
      // stroke lands in, so the panel states it.
      data-label-slug={activeSlug}
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

      {/* Lasso vs brush. Both are kept because they answer different questions:
          a lasso is precise around an irregular outline, a brush is faster for
          touch-up AND is depth-limited — it will not paint the trunk behind the
          leaf you aimed at, which the screen-space lasso always does. */}
      <div className="mb-3">
        <div className="flex gap-1">
          <button
            data-testid="label-tool-lasso"
            onClick={() => onToolChange('lasso')}
            title="Click to place outline vertices; Enter closes the shape"
            className={`flex-1 px-2 py-1 text-[10px] rounded flex items-center justify-center gap-1 ${
              tool === 'lasso'
                ? 'bg-blue-600 text-white'
                : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
            }`}
          >
            <Lasso className="w-3 h-3" />
            Lasso
          </button>
          <button
            data-testid="label-tool-brush"
            onClick={() => onToolChange('brush')}
            title="Drag to paint. Depth-limited: it does not paint through the cloud"
            className={`flex-1 px-2 py-1 text-[10px] rounded flex items-center justify-center gap-1 ${
              tool === 'brush'
                ? 'bg-blue-600 text-white'
                : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
            }`}
          >
            <Brush className="w-3 h-3" />
            Brush
          </button>
        </div>
        {tool === 'brush' && (
          <p data-testid="label-brush-size" data-brush-px={brushPx}
            className="text-[9px] text-neutral-500 mt-1 leading-tight">
            Size {brushPx}px — scroll or <kbd>[</kbd>/<kbd>]</kbd> to change.
            Alt+scroll zooms while the brush is active.
          </p>
        )}
      </div>

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

      {/* WHICH COLUMN the strokes land in. Above the class set, because it is
          the more fundamental choice: a class set is a vocabulary FOR a column,
          and conflating the two is what made a cloud's own classification
          unreachable. A <select> rather than a text input — this is a discrete
          choice, and selects are immune to the partial-keystroke problem
          DebouncedNumberInput exists for. */}
      <div className="mb-2">
        <label className="block text-[9px] text-neutral-500 uppercase tracking-wide mb-0.5">
          Column
        </label>
        <select
          data-testid="label-column-select"
          value={activeSlug}
          onChange={(e) => {
            if (e.target.value === NEW_COLUMN_SENTINEL) onNewColumn();
            else onSelectColumn(e.target.value);
          }}
          className="w-full bg-neutral-900 border border-neutral-700 rounded px-1.5 py-1 text-[11px] text-neutral-100"
        >
          {(['manual', 'categorical', 'scalar'] as const).map((kind) => {
            const group = columns.filter((c) => c.kind === kind);
            if (group.length === 0) return null;
            return (
              <optgroup key={kind} label={COLUMN_GROUP_LABEL[kind]}>
                {group.map((c) => (
                  <option key={c.slug} value={c.slug} data-column-kind={c.kind}
                    title={kind === 'scalar'
                      ? 'A measurement, not a classification — painting it overwrites those values'
                      : c.missing ? 'Created when you paint the first points' : c.slug}>
                    {c.label}{c.missing ? ' (new)' : ''}
                  </option>
                ))}
              </optgroup>
            );
          })}
          <option value={NEW_COLUMN_SENTINEL}>+ New classification…</option>
        </select>
        {activeColumn?.kind === 'scalar' && (
          <p data-testid="label-scalar-warning"
            className="text-[9px] text-amber-400 mt-0.5 leading-tight">
            This column holds measurements. Painting it replaces those values.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-neutral-400 truncate" title={paletteName}>
          {paletteName}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <button
            data-testid="label-cycle-preset"
            onClick={onCyclePreset}
            disabled={presetCount < 2}
            title={presetCount >= 2
              ? 'Switch class set for this column'
              : 'No other built-in class set describes this column'}
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-neutral-700"
          >
            <Shuffle className="w-3 h-3" />
            Preset
          </button>
          <button
            data-testid="label-edit-palette"
            onClick={onEditPalette}
            title="Add, rename or recolour classes — build your own set"
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
          >
            <Palette className="w-3 h-3" />
            Edit
          </button>
        </div>
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
          // Deliberately NOT disabled while a bake is running. Strokes painted
          // during one are new work, and the queue gives them their own run —
          // blocking the button until the previous rebuild lands would put the
          // wait back, one step later and with no way to see it ending.
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

      {bakeFailed && (
        <div data-testid="label-bake-failed-hint" className="mt-2 text-[10px] text-amber-400">
          The labels are saved but the display could not be rebuilt — commit again.
        </div>
      )}
    </div>
  );
}
