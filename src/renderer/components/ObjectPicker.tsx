// Reusable object picker for multi-input tool dialogs (alignment, stitch, LAD,
// run-scan, …). Renders a checkbox/radio list of selectable objects (clouds,
// meshes, scans) so a tool can pick its own inputs explicitly instead of reading
// the current viewport selection. Modeled on the scan list in LADPopup.
import { useCallback } from 'react';

export interface PickerItem {
  id: string;
  label: string;
  /** Optional swatch color (e.g. a cloud's display color). */
  color?: string;
  /** Optional secondary line (e.g. point count). */
  detail?: string;
  /** When set, the row is shown disabled with this reason as a tooltip. */
  disabledReason?: string;
}

interface ObjectPickerProps {
  items: PickerItem[];
  selectedIds: Set<string>;
  onChange: (next: Set<string>) => void;
  /** 'single' shows radios (one at a time); 'multi' shows checkboxes. */
  mode?: 'single' | 'multi';
  /** Message shown when there are no eligible items. */
  emptyMessage?: string;
  label?: string;
  'data-testid'?: string;
}

export function ObjectPicker({
  items,
  selectedIds,
  onChange,
  mode = 'multi',
  emptyMessage = 'No eligible objects.',
  label = 'Objects',
  'data-testid': testId,
}: ObjectPickerProps) {
  const toggle = useCallback(
    (id: string) => {
      if (mode === 'single') {
        onChange(new Set([id]));
        return;
      }
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      onChange(next);
    },
    [mode, selectedIds, onChange],
  );

  const selectable = items.filter(i => !i.disabledReason);
  const allSelected = selectable.length > 0 && selectable.every(i => selectedIds.has(i.id));

  return (
    <div data-testid={testId}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-neutral-300">{label}</span>
          <span className="text-[10px] text-neutral-500">
            ({selectedIds.size}/{items.length} selected)
          </span>
        </div>
        {mode === 'multi' && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => onChange(allSelected ? new Set() : new Set(selectable.map(i => i.id)))}
              className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              {allSelected ? 'None' : 'All'}
            </button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="p-4 text-center text-xs text-neutral-500 border border-neutral-700 rounded-lg">
          {emptyMessage}
        </div>
      ) : (
        <div className="border border-neutral-700 rounded-lg overflow-hidden max-h-[35vh] overflow-y-auto">
          {items.map(item => {
            const isSelected = selectedIds.has(item.id);
            const disabled = !!item.disabledReason;
            return (
              <label
                key={item.id}
                data-testid="picker-row"
                data-object-id={item.id}
                title={item.disabledReason}
                className={`flex items-center gap-2 px-3 py-2 border-b border-neutral-700/50 transition-colors ${
                  disabled
                    ? 'opacity-40 cursor-not-allowed'
                    : isSelected
                      ? 'bg-neutral-700/30 cursor-pointer'
                      : 'bg-neutral-800/50 opacity-70 cursor-pointer hover:opacity-100'
                }`}
              >
                <input
                  type={mode === 'single' ? 'radio' : 'checkbox'}
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => { if (!disabled) toggle(item.id); }}
                  className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-green-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                />
                {item.color && (
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: item.color }} />
                )}
                <span className="text-xs text-neutral-200 truncate flex-1">{item.label}</span>
                {item.detail && <span className="text-[10px] text-neutral-500">{item.detail}</span>}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
