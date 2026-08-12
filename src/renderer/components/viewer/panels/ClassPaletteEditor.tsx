import { useMemo, useState } from 'react';
import { Palette, X, Plus, Trash2, Save, Download, Upload, AlertTriangle } from 'lucide-react';
import type { ClassPalette } from '../../../lib/classPalettes';
import {
  validatePalette,
  paletteErrors,
  nextFreeClassValue,
  UNCLASSIFIED_VALUE,
  CLASS_VALUE_MIN,
  CLASS_VALUE_MAX,
} from '../../../lib/classPalettes';
import type { RGB } from '../../../lib/colormaps';
import { rgbToHex } from '../../../lib/classification';

// Editor for a user-defined class palette.
//
// The presets are starting points, not a constraint — the whole point of the
// palette model is that a user can label ANYTHING, so this is where a palette
// stops being one of our four vocabularies and becomes theirs. Without it the
// ClassPalette type, its validation, and the whole saved-palette library are
// unreachable from the UI.
//
// Presentational: every rule lives in lib/classPalettes.ts and every write goes
// through the caller. This component owns only the DRAFT — edits are local
// until Save, so a half-typed class name never reaches the cloud binding or
// repaints the viewport.

/** #rrggbb → 0-1 RGB. The inverse of classification.ts's rgbToHex. */
function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface ClassPaletteEditorProps {
  palette: ClassPalette;
  /**
   * Points currently carrying each class value, keyed by value.
   *
   * Drives the value-lock below: renaming and recolouring a class are always
   * safe, but CHANGING ITS VALUE is not, because the backend column stores real
   * class values. Repointing a class that already has points would leave those
   * points holding a number the palette no longer describes — they would read
   * as unlabelled with no warning and no undo. So a class with points keeps its
   * value; an empty one is free to move.
   */
  classCounts?: Record<number, number>;
  /** Saved palettes to load from, most recent first. */
  library: ClassPalette[];
  onSave: (palette: ClassPalette) => void;
  onLoad: (palette: ClassPalette) => void;
  onDelete: (id: string) => void;
  onExport: () => void;
  onImport: () => void;
  onClose: () => void;
}

export function ClassPaletteEditor({
  palette,
  classCounts = {},
  library,
  onSave,
  onLoad,
  onDelete,
  onExport,
  onImport,
  onClose,
}: ClassPaletteEditorProps) {
  const [draft, setDraft] = useState<ClassPalette>(palette);

  const issues = useMemo(() => validatePalette(draft), [draft]);
  const errors = useMemo(() => paletteErrors(draft), [draft]);
  const warnings = issues.filter((i) => i.level === 'warning');

  const patchClass = (index: number, patch: Partial<ClassPalette['classes'][number]>) => {
    setDraft((d) => ({
      ...d,
      // Editing any class makes this the user's own palette, not the preset it
      // started from — `preset` is provenance, and keeping it would relabel a
      // customised palette as stock.
      preset: undefined,
      classes: d.classes.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  };

  const addClass = () => {
    setDraft((d) => ({
      ...d,
      preset: undefined,
      // Lands in the user-definable 64+ band, so a future writer to the real
      // LAS classification byte needs no renumbering of painted data.
      classes: [...d.classes, {
        value: nextFreeClassValue(d),
        label: 'New class',
        color: [0.6, 0.6, 0.6] as RGB,
      }],
    }));
  };

  const removeClass = (index: number) => {
    setDraft((d) => ({
      ...d,
      preset: undefined,
      classes: d.classes.filter((_, i) => i !== index),
    }));
  };

  return (
    <div
      data-testid="class-palette-editor"
      data-error-count={errors.length}
      data-class-count={draft.classes.length}
      data-dirty={JSON.stringify(draft) !== JSON.stringify(palette) ? 'true' : 'false'}
      // z-30: above the z-10 lasso overlay AND above the z-20 tool panels this
      // opens on top of. Without it the overlay swallows every click here and
      // the editor cannot even be closed. See CropPanel / LabelPanel.
      className="absolute right-4 top-4 w-80 max-h-[calc(100%-2rem)] overflow-y-auto bg-neutral-800/95 backdrop-blur-sm rounded-lg p-3 shadow-xl border border-neutral-700/50 z-30"
    >
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Palette className="w-3 h-3" />
          Edit classes
        </span>
        <button onClick={onClose} aria-label="Close" title="Close"
          className="p-1 hover:bg-neutral-700 rounded">
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      <label className="text-[10px] text-neutral-400 block mb-1">Palette name</label>
      <input
        data-testid="palette-name"
        type="text"
        value={draft.name}
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        className="w-full mb-3 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-100"
      />

      <div className="space-y-1 mb-2">
        {draft.classes.map((c, i) => {
          const painted = classCounts[c.value] ?? 0;
          const isUnclassified = c.value === UNCLASSIFIED_VALUE;
          // Class 0 is required in every palette (merge zero-fills a missing
          // column, so 0 must mean "unclassified" everywhere) — it can be
          // recoloured but never removed or repointed.
          const valueLocked = isUnclassified || painted > 0;
          return (
            <div
              key={i}
              data-testid="palette-class-row"
              data-class-value={c.value}
              data-value-locked={valueLocked ? 'true' : 'false'}
              className="flex items-center gap-1.5"
            >
              <input
                data-testid="palette-class-color"
                type="color"
                value={rgbToHex(c.color)}
                onChange={(e) => patchClass(i, { color: hexToRgb(e.target.value) })}
                title="Class colour"
                className="w-6 h-6 shrink-0 bg-transparent border border-neutral-700 rounded cursor-pointer"
              />
              <input
                data-testid="palette-class-value"
                // A raw string draft would be needed for a free-typed number,
                // but the value is committed on change and clamped here, and a
                // locked row is read-only — so the partial-keystroke problem
                // DebouncedNumberInput exists for does not arise.
                type="number"
                min={CLASS_VALUE_MIN}
                max={CLASS_VALUE_MAX}
                value={c.value}
                readOnly={valueLocked}
                title={valueLocked
                  ? (isUnclassified
                      ? 'Class 0 is always Unclassified'
                      : `${painted.toLocaleString()} points already carry this class — `
                        + 'changing its value would orphan them')
                  : 'Class value stored in the file'}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v)) patchClass(i, { value: v });
                }}
                className={`w-12 shrink-0 border rounded px-1 py-1 text-[10px] tabular-nums ${
                  valueLocked
                    ? 'bg-neutral-800 border-neutral-800 text-neutral-500 cursor-not-allowed'
                    : 'bg-neutral-900 border-neutral-700 text-neutral-100'
                }`}
              />
              <input
                data-testid="palette-class-label"
                type="text"
                value={c.label}
                readOnly={isUnclassified}
                onChange={(e) => patchClass(i, { label: e.target.value })}
                className="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-100"
              />
              <button
                data-testid="palette-class-remove"
                onClick={() => removeClass(i)}
                disabled={isUnclassified}
                title={isUnclassified
                  ? 'Unclassified cannot be removed'
                  : painted > 0
                    ? `Remove — ${painted.toLocaleString()} points carry this class and will read as unlabelled`
                    : 'Remove class'}
                className="p-1 shrink-0 rounded text-neutral-500 hover:text-red-300 hover:bg-red-900/40 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-500"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      <button
        data-testid="palette-add-class"
        onClick={addClass}
        className="w-full mb-3 px-2 py-1.5 text-xs rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 flex items-center justify-center gap-1.5"
      >
        <Plus className="w-3 h-3" />
        Add class
      </button>

      {(errors.length > 0 || warnings.length > 0) && (
        <div data-testid="palette-issues" className="mb-3 space-y-1">
          {[...errors, ...warnings].map((issue, i) => (
            <div
              key={i}
              data-testid={`palette-issue-${issue.level}`}
              className={`px-2 py-1 rounded text-[10px] flex items-start gap-1.5 ${
                issue.level === 'error'
                  ? 'bg-red-900/40 border border-red-800/50 text-red-200'
                  : 'bg-amber-900/30 border border-amber-800/40 text-amber-200'
              }`}
            >
              <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      )}

      <button
        data-testid="palette-save"
        onClick={() => onSave(draft)}
        disabled={errors.length > 0}
        title={errors.length > 0 ? 'Fix the errors above first' : 'Apply and save to your library'}
        className="w-full mb-3 px-2 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 text-white disabled:bg-neutral-700 disabled:text-neutral-500 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
      >
        <Save className="w-3 h-3" />
        Save palette
      </button>

      <div className="border-t border-neutral-700/50 pt-2">
        <div className="text-[10px] text-neutral-400 mb-1.5">Saved palettes</div>
        {library.length === 0 ? (
          <p className="text-[10px] text-neutral-500 mb-2">
            None yet — Save adds this one to your library.
          </p>
        ) : (
          <div className="space-y-1 mb-2">
            {library.map((p) => (
              <div key={p.id} data-testid="palette-library-row" data-palette-id={p.id}
                className="flex items-center gap-1">
                <button
                  data-testid="palette-library-load"
                  onClick={() => onLoad(p)}
                  title={`Load "${p.name}" (${p.classes.length} classes)`}
                  className="flex-1 min-w-0 text-left px-2 py-1 rounded text-[11px] bg-neutral-700/60 hover:bg-neutral-600 text-neutral-200 truncate"
                >
                  {p.name}
                  <span className="text-neutral-400 ml-1.5">{p.classes.length}</span>
                </button>
                <button
                  data-testid="palette-library-delete"
                  onClick={() => onDelete(p.id)}
                  title={`Delete "${p.name}" from your library`}
                  className="p-1 shrink-0 rounded text-neutral-500 hover:text-red-300 hover:bg-red-900/40"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Palettes are shareable project data, like TerraScan's .PTC files. */}
        <div className="flex gap-1">
          <button
            data-testid="palette-export"
            onClick={onExport}
            className="flex-1 px-2 py-1 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 flex items-center justify-center gap-1"
          >
            <Download className="w-3 h-3" />
            Export
          </button>
          <button
            data-testid="palette-import"
            onClick={onImport}
            className="flex-1 px-2 py-1 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 flex items-center justify-center gap-1"
          >
            <Upload className="w-3 h-3" />
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
