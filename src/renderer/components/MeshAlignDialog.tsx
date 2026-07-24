// Self-contained "Align Mesh to Mesh (ICP)" dialog. Picks a fixed TARGET and a
// moving SOURCE mesh, then runs mesh-to-mesh ICP. The source mesh is transformed
// onto the target. Replaces the old 2-mesh-selection-gated alignment command.
import { useState, useEffect, useMemo } from 'react';
import { Shapes, X } from 'lucide-react';
import { ObjectPicker, type PickerItem } from './ObjectPicker';

export interface MeshAlignOption {
  id: string;
  label: string;
  color?: string;
}

interface MeshAlignDialogProps {
  isOpen: boolean;
  onClose: () => void;
  meshes: MeshAlignOption[];
  initialSelectedIds?: Set<string>;
  isRunning?: boolean;
  onAlign: (targetId: string, sourceId: string) => void;
}

export function MeshAlignDialog({ isOpen, onClose, meshes, initialSelectedIds, isRunning, onAlign }: MeshAlignDialogProps) {
  const [targetId, setTargetId] = useState<string>('');
  const [sourceId, setSourceId] = useState<string>('');

  useEffect(() => {
    if (!isOpen) return;
    // Seed from the current selection: first two selected meshes → target, source.
    const seeded = initialSelectedIds
      ? meshes.filter(m => initialSelectedIds.has(m.id)).map(m => m.id)
      : [];
    setTargetId(seeded[0] ?? '');
    setSourceId(seeded[1] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const targetItems = useMemo<PickerItem[]>(
    () => meshes.map(m => ({ id: m.id, label: m.label, color: m.color })),
    [meshes],
  );
  // The source can't be the target.
  const sourceItems = useMemo<PickerItem[]>(
    () => meshes.map(m => ({
      id: m.id,
      label: m.label,
      color: m.color,
      disabledReason: m.id === targetId ? 'Already the target' : undefined,
    })),
    [meshes, targetId],
  );

  // Clear an invalid source if the target changes to equal it.
  useEffect(() => {
    if (sourceId && sourceId === targetId) setSourceId('');
  }, [targetId, sourceId]);

  if (!isOpen) return null;

  const canAlign = !!targetId && !!sourceId && targetId !== sourceId && !isRunning;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div data-testid="mesh-align-dialog" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Shapes className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Align Mesh to Mesh (ICP)</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-xs text-neutral-400">
            ICP keeps the <span className="text-neutral-200 font-medium">target</span> fixed and moves the{' '}
            <span className="text-neutral-200 font-medium">source</span> mesh onto it.
          </p>
          <ObjectPicker
            data-testid="mesh-align-target-picker"
            label="Target (fixed)"
            items={targetItems}
            selectedIds={targetId ? new Set([targetId]) : new Set()}
            onChange={(s) => setTargetId([...s][0] ?? '')}
            mode="single"
            emptyMessage="No meshes available."
          />
          <ObjectPicker
            data-testid="mesh-align-source-picker"
            label="Source (moves)"
            items={sourceItems}
            selectedIds={sourceId ? new Set([sourceId]) : new Set()}
            onChange={(s) => setSourceId([...s][0] ?? '')}
            mode="single"
            emptyMessage="No meshes available."
          />
        </div>

        <div className="flex items-center justify-end px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <button
            data-testid="mesh-align-run"
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
