// Self-contained "Cloud-to-Mesh Distance" dialog. Picks one point cloud and one
// mesh, then computes point-to-mesh distance statistics (RMSE, percentiles,
// coverage) — surfaced in the AlignmentPanel. Replaces the old
// 1-cloud+1-mesh-selection-gated command.
import { useState, useEffect, useMemo } from 'react';
import { Ruler, X } from 'lucide-react';
import { ObjectPicker, type PickerItem } from './ObjectPicker';

export interface MeshCloudCloudOption {
  id: string;
  label: string;
  color?: string;
}

export interface MeshCloudMeshOption {
  id: string;
  label: string;
  color?: string;
}

interface MeshCloudDistanceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  clouds: MeshCloudCloudOption[];
  meshes: MeshCloudMeshOption[];
  initialCloudId?: string;
  initialMeshId?: string;
  isRunning?: boolean;
  onCompute: (cloudId: string, meshId: string) => void;
}

export function MeshCloudDistanceDialog({
  isOpen, onClose, clouds, meshes, initialCloudId, initialMeshId, isRunning, onCompute,
}: MeshCloudDistanceDialogProps) {
  const [cloudId, setCloudId] = useState<string>('');
  const [meshId, setMeshId] = useState<string>('');

  useEffect(() => {
    if (!isOpen) return;
    setCloudId(initialCloudId && clouds.some(c => c.id === initialCloudId) ? initialCloudId : '');
    setMeshId(initialMeshId && meshes.some(m => m.id === initialMeshId) ? initialMeshId : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const cloudItems = useMemo<PickerItem[]>(
    () => clouds.map(c => ({ id: c.id, label: c.label, color: c.color })),
    [clouds],
  );
  const meshItems = useMemo<PickerItem[]>(
    () => meshes.map(m => ({ id: m.id, label: m.label, color: m.color })),
    [meshes],
  );

  if (!isOpen) return null;

  const canRun = !!cloudId && !!meshId && !isRunning;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div data-testid="mesh-cloud-distance-dialog" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Ruler className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Cloud-to-Mesh Distance</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-xs text-neutral-400">
            Measures how far each point of the{' '}
            <span className="text-neutral-200 font-medium">cloud</span> lies from the{' '}
            <span className="text-neutral-200 font-medium">mesh</span> surface (RMSE, percentiles, coverage).
          </p>
          <ObjectPicker
            data-testid="mesh-cloud-distance-cloud-picker"
            label="Point cloud"
            items={cloudItems}
            selectedIds={cloudId ? new Set([cloudId]) : new Set()}
            onChange={(s) => setCloudId([...s][0] ?? '')}
            mode="single"
            emptyMessage="No point clouds available."
          />
          <ObjectPicker
            data-testid="mesh-cloud-distance-mesh-picker"
            label="Mesh"
            items={meshItems}
            selectedIds={meshId ? new Set([meshId]) : new Set()}
            onChange={(s) => setMeshId([...s][0] ?? '')}
            mode="single"
            emptyMessage="No meshes available."
          />
        </div>

        <div className="flex items-center justify-end px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <button
            data-testid="mesh-cloud-distance-run"
            onClick={() => { onCompute(cloudId, meshId); onClose(); }}
            disabled={!canRun}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              canRun ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-neutral-700 text-neutral-500 cursor-not-allowed'
            }`}
          >
            {isRunning ? 'Computing…' : 'Compute Distance'}
          </button>
        </div>
      </div>
    </div>
  );
}
