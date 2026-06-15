// Self-contained "Align Clouds (ICP)" dialog. Picks a fixed TARGET and a moving
// SOURCE cloud, then runs cloud-to-cloud ICP. The source is transformed, so it
// can't be a streamed (octree) cloud — those are offered only as targets.
// Replaces the old 2-cloud-selection-gated alignment button.
import { useState, useEffect, useMemo } from 'react';
import { Globe, X } from 'lucide-react';
import { ObjectPicker, type PickerItem } from './ObjectPicker';

export interface AlignCloudOption {
  id: string;
  label: string;
  color?: string;
  /** Streamed octree clouds can't be moved, so they can't be the source. */
  isOctree?: boolean;
}

interface AlignDialogProps {
  isOpen: boolean;
  onClose: () => void;
  clouds: AlignCloudOption[];
  initialSelectedIds?: Set<string>;
  isRunning?: boolean;
  onAlign: (targetId: string, sourceId: string) => void;
}

export function AlignDialog({ isOpen, onClose, clouds, initialSelectedIds, isRunning, onAlign }: AlignDialogProps) {
  const [targetId, setTargetId] = useState<string>('');
  const [sourceId, setSourceId] = useState<string>('');

  useEffect(() => {
    if (!isOpen) return;
    // Seed from the current selection: first two selected clouds → target, source.
    const seeded = initialSelectedIds
      ? clouds.filter(c => initialSelectedIds.has(c.id)).map(c => c.id)
      : [];
    setTargetId(seeded[0] ?? '');
    setSourceId(seeded[1] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const targetItems = useMemo<PickerItem[]>(
    () => clouds.map(c => ({ id: c.id, label: c.label, color: c.color })),
    [clouds],
  );
  // The source can't be the target, and can't be a streamed octree cloud.
  const sourceItems = useMemo<PickerItem[]>(
    () => clouds.map(c => ({
      id: c.id,
      label: c.label,
      color: c.color,
      disabledReason: c.id === targetId
        ? 'Already the target'
        : c.isOctree
          ? 'Streamed clouds can’t be moved — use as the target instead'
          : undefined,
    })),
    [clouds, targetId],
  );

  // Clear an invalid source if the target changes to equal it.
  useEffect(() => {
    if (sourceId && sourceId === targetId) setSourceId('');
  }, [targetId, sourceId]);

  if (!isOpen) return null;

  const sourceCloud = clouds.find(c => c.id === sourceId);
  const canAlign = !!targetId && !!sourceId && targetId !== sourceId && !sourceCloud?.isOctree && !isRunning;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div data-testid="align-dialog" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Align Clouds (ICP)</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-xs text-neutral-400">
            ICP keeps the <span className="text-neutral-200 font-medium">target</span> fixed and moves the{' '}
            <span className="text-neutral-200 font-medium">source</span> onto it.
          </p>
          <ObjectPicker
            data-testid="align-target-picker"
            label="Target (fixed)"
            items={targetItems}
            selectedIds={targetId ? new Set([targetId]) : new Set()}
            onChange={(s) => setTargetId([...s][0] ?? '')}
            mode="single"
            emptyMessage="No point clouds available."
          />
          <ObjectPicker
            data-testid="align-source-picker"
            label="Source (moves)"
            items={sourceItems}
            selectedIds={sourceId ? new Set([sourceId]) : new Set()}
            onChange={(s) => setSourceId([...s][0] ?? '')}
            mode="single"
            emptyMessage="No point clouds available."
          />
        </div>

        <div className="flex items-center justify-end px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <button
            data-testid="align-run"
            onClick={() => { onAlign(targetId, sourceId); onClose(); }}
            disabled={!canAlign}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              canAlign ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-neutral-700 text-neutral-500 cursor-not-allowed'
            }`}
          >
            {isRunning ? 'Aligning…' : 'Align'}
          </button>
        </div>
      </div>
    </div>
  );
}
