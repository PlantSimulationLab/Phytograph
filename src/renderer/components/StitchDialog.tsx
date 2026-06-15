// Self-contained "Stitch Clouds" dialog. Picks 2+ point clouds to merge into one,
// independent of the viewport selection (seeded from it when available). Replaces
// the old selection-gated stitch button.
import { useState, useEffect, useMemo } from 'react';
import { Merge, X } from 'lucide-react';
import { ObjectPicker, type PickerItem } from './ObjectPicker';

export interface StitchCloudOption {
  id: string;
  label: string;
  color?: string;
  pointCount?: number;
}

interface StitchDialogProps {
  isOpen: boolean;
  onClose: () => void;
  clouds: StitchCloudOption[];
  initialSelectedIds?: Set<string>;
  onStitch: (ids: string[]) => void;
}

export function StitchDialog({ isOpen, onClose, clouds, initialSelectedIds, onStitch }: StitchDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    const seed = new Set<string>();
    if (initialSelectedIds) {
      for (const id of initialSelectedIds) if (clouds.some(c => c.id === id)) seed.add(id);
    }
    setSelected(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const items = useMemo<PickerItem[]>(
    () => clouds.map(c => ({
      id: c.id,
      label: c.label,
      color: c.color,
      detail: c.pointCount != null ? `${c.pointCount.toLocaleString()} pts` : undefined,
    })),
    [clouds],
  );

  if (!isOpen) return null;

  const canStitch = selected.size >= 2;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div data-testid="stitch-dialog" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Merge className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Stitch Point Clouds</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-xs text-neutral-400">
            Select two or more clouds to merge into a single point cloud.
          </p>
          <ObjectPicker
            data-testid="stitch-picker"
            label="Clouds"
            items={items}
            selectedIds={selected}
            onChange={setSelected}
            mode="multi"
            emptyMessage="No point clouds available to stitch."
          />
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <span className="text-[11px] text-neutral-500">
            {canStitch ? `${selected.size} clouds selected` : 'Select at least 2 clouds'}
          </span>
          <button
            data-testid="stitch-run"
            onClick={() => { onStitch(Array.from(selected)); onClose(); }}
            disabled={!canStitch}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              canStitch ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-neutral-700 text-neutral-500 cursor-not-allowed'
            }`}
          >
            Stitch
          </button>
        </div>
      </div>
    </div>
  );
}
