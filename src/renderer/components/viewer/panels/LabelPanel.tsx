import { useState } from 'react';
import { Brush, X, Undo2, Eye, EyeOff, Palette, Shuffle, Lasso, Lock, Unlock, ShieldCheck, Square, Spline, MousePointerClick } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import type { ProfileLineSide } from '../../../lib/profileLine';
import { defaultPrelabelMap } from '../../../lib/prelabel';

export type LabelTool = 'lasso' | 'brush' | 'rect' | 'line' | 'pick';
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
  /** The palette's size warning (validatePalette), shown under its name. A
   *  derived palette never passes through the editor, so this is the only
   *  place a 300-class tree palette would say so. */
  paletteWarning?: string | null;
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
  /** Strokes the display octree does not carry yet (baked when the panel
   *  closes, or after a pause in painting). */
  pendingStrokes: number;
  /** Whether the next undo is a stroke on this cloud and column. */
  canUndo: boolean;
  /** This cloud's labels changed since it was last exported. There is no
   *  project file, so they are lost on quit until they are written out. */
  unexported?: boolean;
  /** True when the octree is behind the label column. */
  dirty: boolean;
  /**
   * The display is rebuilding for this column in the background. Exposed as a
   * data attribute for E2E and NOT drawn: the user has nothing to decide and
   * nothing to wait for (the labels are already on the cloud).
   */
  baking?: boolean;
  /**
   * The background rebuild failed. Shown, because the display is then behind
   * the labels until the next attempt (when the panel closes).
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
  /** Show ONLY this class (Alt-click a row); again to show every class. */
  onIsolateClass: (value: number) => void;
  /** Classes no stroke may change (the padlocks). */
  lockedClasses: Set<number>;
  onToggleLocked: (value: number) => void;
  /** Lock every labelled class (all but Unclassified), or unlock everything. */
  onToggleProtect: () => void;
  /** Where the camera is in the unlabelled-point finder (null until used):
   *  place `index` of `places`, `here` points there, `total` unlabelled. */
  finder?: { index: number; places: number; here: number; total: number; estimated?: boolean } | null;
  /** Step the finder (N / Shift+N); the first step starts it. */
  onFinderStep: (dir: 1 | -1) => void;
  onToggleFromClass: (value: number) => void;
  onSetFromAnyVisible: () => void;
  onUndoStroke: () => void;
  /** Selection primitive: lasso outline, or sphere brush. */
  tool: LabelTool;
  onToolChange: (t: LabelTool) => void;
  /** Line tool: which side of the drawn line to paint. */
  lineSide?: ProfileLineSide;
  onLineSideChange?: (s: ProfileLineSide) => void;
  /** Line tool: limit to within this distance of the line; 0 = no limit. */
  lineBand?: number;
  onLineBandChange?: (b: number) => void;
  /**
   * Instance-column actions (F7), present only when the active column numbers
   * objects (`*_instance`). They act on the ACTIVE instance (the selected row).
   */
  instances?: {
    onNew: () => void;
    onMergeInto: (target: number) => void;
    onDelete: () => void;
    onFrame: () => void;
    /** Semantic columns a stroke can also set, with their classes. */
    pairOptions: Array<{ slug: string; label: string; classes: ClassDef[] }>;
    pair: { slug: string; value: number } | null;
    onPairChange: (p: { slug: string; value: number } | null) => void;
  } | null;
  /** Pre-label (F8): other columns of this cloud whose classes can seed this one. */
  prelabelSources?: Array<{ slug: string; label: string; classes: ClassDef[] }>;
  onPrelabel?: (source: string, map: Record<string, number> | null, onlyUnlabelled: boolean) => void;
  /** Pick tool: how the cloud is cut into pieces, and the piece size (0 = auto). */
  pickMode?: 'pieces' | 'connected';
  onPickModeChange?: (m: 'pieces' | 'connected') => void;
  pickSize?: number;
  onPickSizeChange?: (v: number) => void;
  pickBusy?: boolean;
  /** How deep an outline reaches: through the cloud, front surface, or a box. */
  depthMode?: 'through' | 'front' | 'box';
  onDepthModeChange?: (m: 'through' | 'front' | 'box') => void;
  /** Front mode: extra world depth kept behind the visible surface. */
  depthTolerance?: number;
  onDepthToleranceChange?: (v: number) => void;
  /** Box mode: the limiting box (world), or null before one is drawn. */
  limitBox?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
  onLimitBoxZChange?: (z: { min: number; max: number }) => void;
  /** Box mode: placing the two corners. */
  boxDrawing?: boolean;
  onDrawBox?: () => void;
  onClearBox?: () => void;
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
  paletteWarning,
  activeClass,
  classCounts,
  visibleClasses,
  fromClasses,
  pendingStrokes,
  canUndo,
  unexported = false,
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
  onIsolateClass,
  lockedClasses,
  onToggleLocked,
  onToggleProtect,
  finder = null,
  onFinderStep,
  onToggleFromClass,
  onSetFromAnyVisible,
  onUndoStroke,
  tool,
  onToolChange,
  lineSide = 'above',
  onLineSideChange,
  lineBand = 0,
  onLineBandChange,
  instances = null,
  prelabelSources = [],
  onPrelabel,
  pickMode = 'pieces',
  onPickModeChange,
  pickSize = 0,
  onPickSizeChange,
  pickBusy = false,
  depthMode = 'through',
  onDepthModeChange,
  depthTolerance = 0,
  onDepthToleranceChange,
  limitBox = null,
  onLimitBoxZChange,
  boxDrawing = false,
  onDrawBox,
  onClearBox,
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
  // Protect is on when every labelled class (all but Unclassified) is locked.
  const labelledValues = classes.map((c) => c.value).filter((v) => v !== 0);
  const protectOn = labelledValues.length > 0 && labelledValues.every((v) => lockedClasses.has(v));
  const activeName = nameOf(activeClass);
  const fromNames = fromClasses
    ? [...fromClasses].map(nameOf).join(', ')
    : '';
  // "Paint X only over X" — the combination that silently does nothing.
  const isNoOp = !!fromClasses && fromClasses.size === 1 && fromClasses.has(activeClass);
  const activeColumn = columns.find((c) => c.slug === activeSlug);
  const limitBoxZ = limitBox ? { min: limitBox.min.z, max: limitBox.max.z } : null;
  // Pre-label draft: the chosen source column and its class map.
  const [prelabel, setPrelabel] = useState<{
    slug: string; map: Record<string, number> | null; onlyUnlabelled: boolean;
  } | null>(null);
  const prelabelSource = prelabel ? prelabelSources.find((s) => s.slug === prelabel.slug) : undefined;

  return (
    <div
      data-testid="label-panel"
      data-active-class={activeClass}
      data-pending-strokes={pendingStrokes}
      data-label-dirty={dirty ? 'true' : 'false'}
      data-label-unexported={unexported ? 'true' : 'false'}
      data-label-tool={tool}
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
            title="Click to place outline vertices; Enter closes the shape (G)"
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
            data-testid="label-tool-rect"
            onClick={() => onToolChange('rect')}
            title="Drag a rectangle; it selects at every depth, like the lasso (R)"
            className={`flex-1 px-2 py-1 text-[10px] rounded flex items-center justify-center gap-1 ${
              tool === 'rect'
                ? 'bg-blue-600 text-white'
                : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
            }`}
          >
            <Square className="w-3 h-3" />
            Rect
          </button>
          <button
            data-testid="label-tool-brush"
            onClick={() => onToolChange('brush')}
            title="Drag to paint. Depth-limited: it does not paint through the cloud (B)"
            className={`flex-1 px-2 py-1 text-[10px] rounded flex items-center justify-center gap-1 ${
              tool === 'brush'
                ? 'bg-blue-600 text-white'
                : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
            }`}
          >
            <Brush className="w-3 h-3" />
            Brush
          </button>
          <button
            data-testid="label-tool-line"
            onClick={() => onToolChange('line')}
            disabled={!sectionActive}
            title={sectionActive
              ? 'Draw a line across the section; everything above or below it is painted (P)'
              : 'Draw a cross-section first: the line is drawn in a section'}
            className={`flex-1 px-2 py-1 text-[10px] rounded flex items-center justify-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed ${
              tool === 'line'
                ? 'bg-blue-600 text-white'
                : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
            }`}
          >
            <Spline className="w-3 h-3" />
            Line
          </button>
          <button
            data-testid="label-tool-pick"
            onClick={() => onToolChange('pick')}
            title="Click a piece of the cloud to label all of it; Shift+click also takes its neighbours facing the same way (K)"
            className={`flex-1 px-2 py-1 text-[10px] rounded flex items-center justify-center gap-1 ${
              tool === 'pick'
                ? 'bg-blue-600 text-white'
                : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
            }`}
          >
            <MousePointerClick className="w-3 h-3" />
            Pick
          </button>
        </div>
        {tool === 'pick' && (
          <div data-testid="label-pick-options" data-pick-mode={pickMode}
            data-pick-busy={pickBusy ? 'true' : 'false'} className="mt-1.5">
            <div className="flex gap-1">
              {(['pieces', 'connected'] as const).map((m) => (
                <button
                  key={m}
                  data-testid={`label-pick-mode-${m}`}
                  onClick={() => onPickModeChange?.(m)}
                  title={m === 'pieces'
                    ? 'Compact pieces about Size across: a leaf, a stretch of branch'
                    : 'Everything connected, bridging gaps up to Size: a whole plant standing apart'}
                  className={`flex-1 px-2 py-0.5 text-[10px] rounded ${
                    pickMode === m
                      ? 'bg-sky-700 text-white'
                      : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  }`}
                >
                  {m === 'pieces' ? 'Pieces' : 'Connected'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 mt-1 text-[10px] text-neutral-400">
              <span className="shrink-0">{pickMode === 'pieces' ? 'Size' : 'Gap'}</span>
              <DebouncedNumberInput
                data-testid="label-pick-size"
                value={pickSize}
                onCommit={(v) => onPickSizeChange?.(v)}
                min={0}
                format={(n) => String(Number(n.toPrecision(4)))}
                title={pickMode === 'pieces'
                  ? 'How big a piece is, in cloud units. 0 = automatic from the point spacing.'
                  : 'The widest gap still counted as connected, in cloud units. 0 = automatic.'}
                className="w-16 px-1.5 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-[10px] text-neutral-200"
              />
              <span className="text-neutral-500">{pickSize > 0 ? '' : '(auto)'}</span>
            </label>
            <p className="text-[9px] text-neutral-500 mt-1 leading-tight">
              {pickBusy ? 'Finding the piece…' : 'Click a piece. Shift+click adds its neighbours facing the same way.'}
            </p>
          </div>
        )}
        {tool === 'line' && (
          <div data-testid="label-line-options" data-line-side={lineSide} className="mt-1.5">
            <div className="flex gap-1">
              {(['above', 'below', 'near'] as const).map((s) => (
                <button
                  key={s}
                  data-testid={`label-line-side-${s}`}
                  onClick={() => onLineSideChange?.(s)}
                  className={`flex-1 px-2 py-0.5 text-[10px] rounded ${
                    lineSide === s
                      ? 'bg-sky-700 text-white'
                      : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  }`}
                >
                  {s === 'above' ? 'Above' : s === 'below' ? 'Below' : 'Near'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 mt-1 text-[10px] text-neutral-400">
              <span className="shrink-0">Within ±</span>
              <DebouncedNumberInput
                data-testid="label-line-band"
                value={lineBand}
                onCommit={(v) => onLineBandChange?.(v)}
                min={0}
                debounceMs={0}
                title={lineSide === 'near'
                  ? 'How close to the line a point must be'
                  : 'Only paint this close to the line; 0 = everything on that side'}
                className="w-16 px-1.5 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-[10px] text-neutral-200"
              />
              <span className="text-neutral-500">
                {lineSide === 'near' ? '(0 = section thickness)' : '(0 = no limit)'}
              </span>
            </label>
            <p className="text-[9px] text-neutral-500 mt-1 leading-tight">
              Click along the section, Enter or double-click to finish.
            </p>
          </div>
        )}
        {tool === 'brush' && (
          <p data-testid="label-brush-size" data-brush-px={brushPx}
            className="text-[9px] text-neutral-500 mt-1 leading-tight">
            Size {brushPx}px — scroll or <kbd>[</kbd>/<kbd>]</kbd> to change.
            Alt+scroll zooms while the brush is active.
          </p>
        )}
      </div>

      {/* Depth: how far behind the outline a lasso or rectangle reaches. */}
      <div
        data-testid="label-depth"
        data-depth-mode={depthMode}
        data-limit-box={limitBox
          ? [limitBox.min.x, limitBox.min.y, limitBox.min.z, limitBox.max.x, limitBox.max.y, limitBox.max.z]
            .map((v) => v.toFixed(3)).join(',')
          : ''}
        className="mb-3"
      >
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-neutral-500 uppercase tracking-wide w-10 shrink-0">Depth</span>
          {(['through', 'front', 'box'] as const).map((m) => (
            <button
              key={m}
              data-testid={`label-depth-${m}`}
              onClick={() => onDepthModeChange?.(m)}
              title={m === 'through'
                ? 'The lasso and rectangle select at every depth inside the outline'
                : m === 'front'
                  ? 'The lasso and rectangle select only the surface you can see inside the outline'
                  : 'Every stroke selects only inside a box you place'}
              className={`flex-1 px-2 py-0.5 text-[10px] rounded ${
                depthMode === m
                  ? 'bg-sky-700 text-white'
                  : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
              }`}
            >
              {m === 'through' ? 'Through' : m === 'front' ? 'Front' : 'Box'}
            </button>
          ))}
        </div>
        {depthMode === 'front' && (
          <label className="flex items-center gap-1.5 mt-1 text-[10px] text-neutral-400">
            <span className="shrink-0">Also keep</span>
            <DebouncedNumberInput
              data-testid="label-depth-tolerance"
              value={depthTolerance}
              onCommit={(v) => onDepthToleranceChange?.(v)}
              min={0}
              debounceMs={0}
              title="How far behind the visible surface still counts as on it, in cloud units. 0 = automatic (the surface's own slope)."
              className="w-16 px-1.5 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-[10px] text-neutral-200"
            />
            <span className="text-neutral-500">behind the surface</span>
          </label>
        )}
        {depthMode === 'box' && (
          <div className="mt-1 text-[10px] text-neutral-400">
            <div className="flex items-center gap-1">
              <button
                data-testid="label-box-draw"
                onClick={onDrawBox}
                className={`px-2 py-0.5 rounded ${boxDrawing ? 'bg-amber-700 text-white' : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'}`}
              >
                {boxDrawing ? 'Click two corners…' : limitBoxZ ? 'Redraw box' : 'Draw box'}
              </button>
              {limitBoxZ && !boxDrawing && (
                <button data-testid="label-box-clear" onClick={onClearBox}
                  className="px-2 py-0.5 rounded bg-neutral-700 text-neutral-300 hover:bg-neutral-600">
                  Clear
                </button>
              )}
            </div>
            {limitBoxZ && !boxDrawing && (
              <div className="flex items-center gap-1 mt-1">
                <span className="shrink-0">Z</span>
                <DebouncedNumberInput
                  data-testid="label-box-zmin"
                  value={limitBoxZ.min}
                  onCommit={(v) => onLimitBoxZChange?.({ min: v, max: Math.max(v, limitBoxZ.max) })}
                  className="w-16 px-1.5 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-[10px] text-neutral-200"
                />
                <span>to</span>
                <DebouncedNumberInput
                  data-testid="label-box-zmax"
                  value={limitBoxZ.max}
                  onCommit={(v) => onLimitBoxZChange?.({ min: Math.min(v, limitBoxZ.min), max: v })}
                  className="w-16 px-1.5 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-[10px] text-neutral-200"
                />
              </div>
            )}
            {!limitBoxZ && !boxDrawing && (
              <p className="text-[9px] text-amber-400 mt-1">No box yet: strokes are refused until one is drawn.</p>
            )}
          </div>
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
      {paletteWarning && (
        <p data-testid="label-palette-warning" className="-mt-1 mb-2 text-[10px] text-amber-400">
          {paletteWarning}
        </p>
      )}

      {/* Class list. Clicking a row makes it the active class (1-9 do the same
          for the first nine); the eye toggles visibility; the dot toggles the
          From-class gate. The header names those last two columns — an unlabeled
          dot next to an unlabeled eye gives no clue that one means "paint this"
          and the other "paint over this". */}
      <div className="flex items-center gap-1.5 px-1.5 pb-1 text-[9px] text-neutral-500 uppercase tracking-wide">
        <span className="w-3" />
        <span className="flex-1">Click a class to paint it</span>
        <span title="Only paint over this class">over</span>
        <span title="Lock: no stroke changes this class">lock</span>
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
              data-locked={lockedClasses.has(c.value) ? 'true' : 'false'}
              data-color={rgbToHex(c.color)}
              className={`flex items-center gap-1.5 px-1.5 py-1 text-[11px] cursor-pointer ${
                active ? 'bg-blue-600/40' : 'hover:bg-neutral-700/60'
              }`}
              onClick={(e) => (e.altKey ? onIsolateClass(c.value) : onSelectClass(c.value))}
              title="Click to paint this class; Alt-click to show only this class"
            >
              <span
                className="w-3 h-3 rounded-sm shrink-0 border border-black/30"
                style={{ backgroundColor: rgbToHex(c.color) }}
              />
              <span className="flex-1 truncate text-neutral-200" title={c.label}>
                {i < 10 ? `${(i + 1) % 10}. ` : ''}{c.label}
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
                data-testid={`label-lock-${c.value}`}
                aria-label={`${lockedClasses.has(c.value) ? 'Unlock' : 'Lock'} ${c.label}`}
                title={lockedClasses.has(c.value)
                  ? 'Locked: strokes never change this class'
                  : 'Lock so no stroke changes this class'}
                onClick={(e) => { e.stopPropagation(); onToggleLocked(c.value); }}
                className="p-0.5 hover:bg-neutral-600 rounded shrink-0"
              >
                {lockedClasses.has(c.value)
                  ? <Lock className="w-3 h-3 text-amber-400" />
                  : <Unlock className="w-3 h-3 text-neutral-600" />}
              </button>
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
        <button
          data-testid="label-protect"
          data-active={protectOn ? 'true' : 'false'}
          onClick={onToggleProtect}
          title="Lock every labelled class, so strokes only label points that are still Unclassified"
          className={`mt-1 w-full px-2 py-1 rounded text-left flex items-center gap-1 ${
            protectOn ? 'bg-amber-600/30 text-amber-200' : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-700'
          }`}
        >
          <ShieldCheck className="w-3 h-3" />
          {protectOn ? 'Protecting labelled points' : 'Protect labelled points'}
        </button>
        {isNoOp && (
          <div data-testid="label-noop-warning" className="mt-1.5 text-amber-400">
            This paints {activeName} only over points that are already
            {' '}{activeName}, so it will do nothing. Clear the ◉ on that class,
            or pick a different class to paint.
          </div>
        )}
      </div>

      {instances && (
        <div data-testid="label-instances" className="mb-3 p-2 rounded bg-neutral-900/60 border border-neutral-700 text-[10px] text-neutral-300">
          <div className="flex items-center gap-1 mb-1.5">
            <span className="text-[9px] text-neutral-500 uppercase tracking-wide flex-1">Instances</span>
            <button data-testid="label-instance-new" onClick={instances.onNew}
              title="Add the next free id and paint with it"
              className="px-2 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600">New instance</button>
          </div>
          {activeClass !== 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-neutral-400">{activeName}:</span>
              <button data-testid="label-instance-frame" onClick={instances.onFrame}
                title="Move the view to this instance"
                className="px-1.5 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600">Frame</button>
              <select
                data-testid="label-instance-merge"
                value=""
                onChange={(e) => { if (e.target.value) instances.onMergeInto(Number(e.target.value)); }}
                title="Give every point of this instance another instance's id"
                className="px-1 py-0.5 rounded bg-neutral-700 text-neutral-200"
              >
                <option value="">Merge into…</option>
                {classes.filter((c) => c.value !== activeClass && c.value !== 0).map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <button data-testid="label-instance-delete" onClick={instances.onDelete}
                title="Return every point of this instance to Unassigned (undoable)"
                className="px-1.5 py-0.5 rounded bg-neutral-700 hover:bg-red-900/60">Delete</button>
            </div>
          )}
          {instances.pairOptions.length > 0 && (
            <label className="flex items-center gap-1 mt-1.5">
              <span className="shrink-0 text-neutral-400">Also set</span>
              <select
                data-testid="label-instance-pair"
                value={instances.pair ? `${instances.pair.slug}:${instances.pair.value}` : ''}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) { instances.onPairChange(null); return; }
                  const i = v.lastIndexOf(':');
                  instances.onPairChange({ slug: v.slice(0, i), value: Number(v.slice(i + 1)) });
                }}
                title="Each stroke also paints this class in another column, in the same undo step"
                className="flex-1 min-w-0 px-1 py-0.5 rounded bg-neutral-700 text-neutral-200"
              >
                <option value="">nothing else</option>
                {instances.pairOptions.map((o) => (
                  <optgroup key={o.slug} label={o.label}>
                    {o.classes.filter((c) => c.value !== 0).map((c) => (
                      <option key={c.value} value={`${o.slug}:${c.value}`}>{o.label}: {c.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          data-testid="label-undo"
          onClick={onUndoStroke}
          disabled={!canUndo || busy}
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Undo2 className="w-3 h-3" />
          Undo
        </button>
      </div>

      <div className="mt-2 flex items-center gap-1 text-[10px]">
        <button
          data-testid="label-find-unlabelled"
          onClick={() => onFinderStep(1)}
          title="Show only unlabelled points and go to where most of them are (N; Shift+N goes back)"
          className="flex-1 px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-left"
        >
          {finder ? 'Next unlabelled area (N)' : 'Find unlabelled points (N)'}
        </button>
        {finder && finder.places > 0 && (
          <button
            data-testid="label-finder-prev"
            onClick={() => onFinderStep(-1)}
            title="Previous area (Shift+N)"
            className="px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
          >
            Back
          </button>
        )}
      </div>
      {finder && (
        <div
          data-testid="label-finder-status"
          data-index={finder.index}
          data-places={finder.places}
          data-total={finder.total}
          className="mt-1 text-[10px] text-neutral-400"
        >
          {finder.places === 0
            ? 'No unlabelled points left.'
            : `Area ${finder.index + 1} of ${finder.places}: ${finder.estimated ? 'about ' : ''}`
              + `${finder.here.toLocaleString()} of ${finder.total.toLocaleString()} unlabelled points.`}
        </div>
      )}

      {unexported && (
        <div data-testid="label-unexported" className="mt-2 text-[10px] text-amber-400">
          Labels changed since this cloud was last exported. Export it to keep
          them: they are not saved when the app closes.
        </div>
      )}

      {onPrelabel && prelabelSources.length > 0 && (
        <div data-testid="label-prelabel" className="mt-2 text-[10px] text-neutral-300">
          <select
            data-testid="label-prelabel-source"
            value={prelabel?.slug ?? ''}
            onChange={(e) => {
              const src = prelabelSources.find((s) => s.slug === e.target.value);
              setPrelabel(src ? {
                slug: src.slug,
                map: defaultPrelabelMap(src.slug, src.classes, activeSlug, classes),
                onlyUnlabelled: true,
              } : null);
            }}
            title="Seed this column from a result another tool wrote (ground, wood/leaf, trees…)"
            className="w-full px-1 py-1 rounded bg-neutral-700 text-neutral-200"
          >
            <option value="">Pre-label from another column…</option>
            {prelabelSources.map((s) => <option key={s.slug} value={s.slug}>{s.label}</option>)}
          </select>
          {prelabel && prelabelSource && (
            <div className="mt-1 p-1.5 rounded border border-neutral-700 bg-neutral-900/60">
              {prelabel.map === null ? (
                <p className="text-neutral-400">Instance ids are copied unchanged.</p>
              ) : (
                prelabelSource.classes.filter((c) => c.value !== 0).map((c) => (
                  <label key={c.value} className="flex items-center gap-1 mb-0.5">
                    <span className="flex-1 truncate">{c.label} →</span>
                    <select
                      data-testid={`label-prelabel-map-${c.value}`}
                      value={prelabel.map![String(c.value)] ?? ''}
                      onChange={(e) => {
                        const next = { ...prelabel.map! };
                        if (e.target.value === '') delete next[String(c.value)];
                        else next[String(c.value)] = Number(e.target.value);
                        setPrelabel({ ...prelabel, map: next });
                      }}
                      className="px-1 py-0.5 rounded bg-neutral-700 text-neutral-200"
                    >
                      <option value="">leave as is</option>
                      {classes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </label>
                ))
              )}
              <label className="flex items-center gap-1 mt-1 text-neutral-400">
                <input
                  type="checkbox"
                  data-testid="label-prelabel-only-unlabelled"
                  checked={prelabel.onlyUnlabelled}
                  onChange={(e) => setPrelabel({ ...prelabel, onlyUnlabelled: e.target.checked })}
                />
                Only points still Unclassified
              </label>
              <div className="flex gap-1 mt-1">
                <button
                  data-testid="label-prelabel-apply"
                  disabled={busy || (prelabel.map !== null && Object.keys(prelabel.map).length === 0)}
                  onClick={() => { onPrelabel(prelabel.slug, prelabel.map, prelabel.onlyUnlabelled); setPrelabel(null); }}
                  className="flex-1 px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40"
                >
                  Pre-label
                </button>
                <button onClick={() => setPrelabel(null)}
                  className="px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      <details data-testid="label-shortcuts" className="mt-2 text-[10px] text-neutral-400">
        <summary className="cursor-pointer select-none text-neutral-500 hover:text-neutral-300">
          Keyboard shortcuts
        </summary>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          <dt><kbd>1</kbd>–<kbd>9</kbd>, <kbd>0</kbd></dt><dd>Paint the numbered class</dd>
          <dt><kbd>G</kbd> <kbd>R</kbd> <kbd>B</kbd> <kbd>P</kbd> <kbd>K</kbd></dt><dd>Lasso, rectangle, brush, line (in a section), pick</dd>
          <dt><kbd>X</kbd></dt><dd>Swap the paint class with the one it paints over</dd>
          <dt><kbd>L</kbd></dt><dd>Stop drawing to look around, and back</dd>
          <dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Brush size</dd>
          <dt><kbd>N</kbd> / <kbd>Shift</kbd>+<kbd>N</kbd></dt><dd>Next / previous unlabelled area</dd>
          <dt>Alt+click</dt><dd>Show only that class</dd>
          <dt><kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd></dt><dd>Undo / redo a stroke</dd>
        </dl>
      </details>

      {bakeFailed && (
        <div data-testid="label-bake-failed-hint" className="mt-2 text-[10px] text-amber-400">
          The labels are on the cloud, but the display could not be rebuilt. It
          tries again when you close this panel.
        </div>
      )}
    </div>
  );
}
