// Self-contained "Stitch Clouds" dialog. Picks 2+ point clouds to merge into one,
// independent of the viewport selection (seeded from it when available). Replaces
// the old selection-gated stitch button.
import { useState, useEffect, useMemo } from 'react';
import { Merge, X, AlertTriangle } from 'lucide-react';
import { ObjectPicker, type PickerItem } from './ObjectPicker';

export interface StitchCloudOption {
  id: string;
  label: string;
  color?: string;
  pointCount?: number;
  // Whether this cloud carries a real scanner origin (E57/synthetic scanOrigin,
  // or attached scan parameters). Stitching discards origins, so when a selected
  // cloud has one, the dialog warns that origin-dependent analyses (Backfill
  // Misses overlay, Helios triangulation, LAD) will be unavailable on the merge.
  hasOrigin?: boolean;
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

  // Warn when any SELECTED cloud carries a scanner origin: stitching discards
  // origins (a merged multi-scan cloud has no single beam apex), which disables
  // every origin-dependent analysis on the result. No warning when nothing is
  // lost (plain XYZ/LAS clouds that never had an origin).
  const originsLost = useMemo(
    () => clouds.filter(c => selected.has(c.id) && c.hasOrigin).length,
    [clouds, selected],
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

          {originsLost > 0 && (
            <div
              data-testid="stitch-origin-warning"
              className="flex gap-2 text-[11px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2.5 py-2"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <div className="space-y-1">
                <div>
                  {originsLost === 1
                    ? 'One selected cloud has a scanner origin.'
                    : `${originsLost} selected clouds have scanner origins.`}{' '}
                  Stitching discards them — a merged cloud has no single origin.
                </div>
                <div className="text-amber-300/80">
                  Origin-dependent analyses (<strong>Backfill Misses</strong> overlay,{' '}
                  <strong>Helios triangulation</strong>, <strong>Leaf Area Density</strong>) will be
                  unavailable on the merged cloud. Register the clouds first if you need them.
                </div>
              </div>
            </div>
          )}
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
            {originsLost > 0 ? 'Stitch anyway' : 'Stitch'}
          </button>
        </div>
      </div>
    </div>
  );
}
