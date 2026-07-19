import { Plus, Trash2, Check, X, ListOrdered, Crosshair, Play, Square } from 'lucide-react';
import { DebouncedNumberInput } from './DebouncedNumberInput';
import {
  type PoseDraft,
  validateTimestamps,
} from '../lib/trajectoryEdit';

// The right-docked pose table for the manual trajectory editor. It is a fully
// CONTROLLED view of the draft pose list owned by PointCloudViewer's editor
// session — every edit calls back up; the panel holds no pose state of its own.
// Selecting a row highlights the matching scanner model in the 3D viewport (and
// vice-versa), so table editing and in-scene translate/rotate stay in sync.
//
// Numeric cells use DebouncedNumberInput (never a raw <input type="number">, per
// the project's controlled-number-field rule) so a partial "-" / "1." / cleared
// field doesn't clobber the value mid-keystroke.

export interface TrajectoryTablePanelProps {
  drafts: PoseDraft[];
  selectedIndex: number | null;
  onSelectRow: (index: number) => void;
  onEditField: (
    index: number,
    field: 't' | 'x' | 'y' | 'z' | 'rollDeg' | 'pitchDeg' | 'yawDeg',
    value: number,
  ) => void;
  onDeleteRow: (index: number) => void;
  onAddPose: () => void;
  onRenumber: () => void;
  onTogglePreview: () => void;
  previewPlaying: boolean;
  onSave: () => void;
  onCancel: () => void;
}

const COLUMNS: Array<{
  key: 't' | 'x' | 'y' | 'z' | 'rollDeg' | 'pitchDeg' | 'yawDeg';
  label: string;
}> = [
  { key: 't', label: 't (s)' },
  { key: 'x', label: 'X (m)' },
  { key: 'y', label: 'Y (m)' },
  { key: 'z', label: 'Z (m)' },
  { key: 'rollDeg', label: 'Roll°' },
  { key: 'pitchDeg', label: 'Pitch°' },
  { key: 'yawDeg', label: 'Yaw°' },
];

export function TrajectoryTablePanel({
  drafts,
  selectedIndex,
  onSelectRow,
  onEditField,
  onDeleteRow,
  onAddPose,
  onRenumber,
  onTogglePreview,
  previewPlaying,
  onSave,
  onCancel,
}: TrajectoryTablePanelProps) {
  const validation = validateTimestamps(drafts);

  return (
    <div
      data-testid="trajectory-table-panel"
      className="absolute top-0 right-0 z-[56] flex h-full w-[30rem] max-w-[45vw] flex-col border-l border-neutral-700 bg-neutral-900/95 backdrop-blur-sm shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-neutral-700 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Crosshair size={16} /> Trajectory editor
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onTogglePreview}
            disabled={drafts.length < 2}
            data-testid="trajectory-preview"
            title="Animate the scanner along the trajectory (5 s)"
            className="flex items-center gap-1 rounded-md border border-neutral-600 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {previewPlaying ? <><Square size={12} /> Stop</> : <><Play size={12} /> Preview</>}
          </button>
          <button
            type="button"
            onClick={onRenumber}
            title="Reassign timestamps to an even sequence"
            className="flex items-center gap-1 rounded-md border border-neutral-600 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-white"
          >
            <ListOrdered size={13} /> Renumber t
          </button>
        </div>
      </div>

      <p className="px-4 pt-3 text-xs text-neutral-400">
        Each row is a 6-DOF pose, kept ordered by time. Edit values here, or click
        a scanner in the viewport and press <kbd className="rounded bg-neutral-700 px-1">t</kbd>/
        <kbd className="rounded bg-neutral-700 px-1">r</kbd> to move or rotate it.
        Hover the path between poses for a <span className="text-lime-400">+</span> to insert.
      </p>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-3">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-neutral-400">
              <th className="px-1 py-1 text-left font-medium">#</th>
              {COLUMNS.map((c) => (
                <th key={c.key} className="px-1 py-1 text-left font-medium">
                  {c.label}
                </th>
              ))}
              <th className="px-1 py-1" />
            </tr>
          </thead>
          <tbody>
            {drafts.map((d, i) => {
              const selected = i === selectedIndex;
              const badRow = validation.badRow === i + 1;
              return (
                <tr
                  key={d.id}
                  data-testid={`trajectory-row-${i}`}
                  data-selected={selected ? 'true' : 'false'}
                  onClick={() => onSelectRow(i)}
                  className={`cursor-pointer border-b border-neutral-800 ${
                    selected ? 'bg-blue-600/25' : 'hover:bg-neutral-800/60'
                  } ${badRow ? 'outline outline-1 outline-red-500/70' : ''}`}
                >
                  <td className="px-1 py-1 text-neutral-500">{i}</td>
                  {COLUMNS.map((c) => (
                    <td key={c.key} className="px-0.5 py-0.5">
                      <DebouncedNumberInput
                        data-testid={`trajectory-${i}-${c.key}`}
                        step="any"
                        // Values commit eagerly; the TIME re-sort is deferred
                        // separately (in the viewer) until typing settles, so the
                        // row doesn't jump mid-edit.
                        debounceMs={0}
                        value={d[c.key]}
                        onCommit={(v) => onEditField(i, c.key, v)}
                        className="w-16 rounded border border-neutral-600 bg-neutral-800 px-1 py-1 text-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                      />
                    </td>
                  ))}
                  <td className="px-1 py-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteRow(i);
                      }}
                      title="Delete pose"
                      data-testid={`trajectory-delete-${i}`}
                      className="rounded p-1 text-neutral-500 hover:bg-red-600/20 hover:text-red-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <button
          type="button"
          onClick={onAddPose}
          data-testid="trajectory-add-pose"
          className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-neutral-600 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-white"
        >
          <Plus size={13} /> Add pose
        </button>
      </div>

      {!validation.ok && validation.message && (
        <p
          data-testid="trajectory-validation-error"
          className="px-4 py-2 text-xs text-red-400"
        >
          {validation.message}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-neutral-700 px-4 py-3">
        <button
          type="button"
          onClick={onCancel}
          data-testid="trajectory-cancel"
          className="flex items-center gap-1 rounded-md border border-neutral-600 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700 hover:text-white"
        >
          <X size={14} /> Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!validation.ok}
          data-testid="trajectory-save"
          className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check size={14} /> Save trajectory
        </button>
      </div>
    </div>
  );
}
