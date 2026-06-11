import { useState, useEffect, useMemo, useCallback } from 'react';
import { X, Compass } from 'lucide-react';
import { QSMAdjustLeafAnglesRequest } from '../utils/backendApi';
import type { QSMEntry, MeshEntry } from '../lib/pointCloudTypes';
import { meshCellIds } from '../lib/leafAngleDistribution';
import { eligibleLeafAngleMeshes, meshToTriangulationInput } from '../lib/adjustLeafAngles';

interface AdjustLeafAnglesPopupProps {
  isOpen: boolean;
  onClose: () => void;
  qsm: QSMEntry | null;
  meshes: MeshEntry[];
  onAdjust: (qsmId: string, request: QSMAdjustLeafAnglesRequest) => void;
  // Resolve a mesh's display name (mirrors the mesh-list naming).
  meshLabel: (mesh: MeshEntry) => string;
}

export function AdjustLeafAnglesPopup({
  isOpen, onClose, qsm, meshes, onAdjust, meshLabel,
}: AdjustLeafAnglesPopupProps) {
  const eligible = useMemo(
    () => (qsm ? eligibleLeafAngleMeshes(meshes, qsm) : []),
    [meshes, qsm],
  );

  const [selectedMeshId, setSelectedMeshId] = useState<string>('');
  const [seedStr, setSeedStr] = useState('0');
  const [error, setError] = useState<string | null>(null);

  // Default to the first eligible mesh whenever the popup opens / the list changes.
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setSelectedMeshId(prev =>
      eligible.some(m => m.id === prev) ? prev : (eligible[0]?.id ?? ''));
  }, [isOpen, eligible]);

  const selectedMesh = useMemo(
    () => eligible.find(m => m.id === selectedMeshId) ?? null,
    [eligible, selectedMeshId],
  );

  const cellCount = useMemo(
    () => (selectedMesh ? meshCellIds(selectedMesh.data).length : 0),
    [selectedMesh],
  );

  const handleSubmit = useCallback(() => {
    if (!qsm || !qsm.leaves?.request) return;
    setError(null);
    if (!selectedMesh) {
      setError('Select a triangulation to match');
      return;
    }
    const triangulation = meshToTriangulationInput(selectedMesh.data);
    if (!triangulation) {
      setError('The selected mesh has no grid / cell ids');
      return;
    }
    const request: QSMAdjustLeafAnglesRequest = {
      ...qsm.leaves.request,
      triangulation,
      seed: parseInt(seedStr, 10) || 0,
    };
    onAdjust(qsm.id, request);
    onClose();
  }, [qsm, selectedMesh, seedStr, onAdjust, onClose]);

  if (!isOpen || !qsm) return null;

  const inputCls =
    'w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div data-testid="adjust-leaf-angles-popup" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Compass className="w-4 h-4 text-green-400" />
            <h2 className="text-sm font-semibold text-white">Adjust Leaf Angles</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[72vh] overflow-y-auto">
          <p className="text-[10px] text-neutral-500">
            Rotates the leaves to match the leaf-angle distribution measured per voxel
            cell from a leaf-on Helios triangulation that overlaps this QSM. Each leaf
            rotates about its base; cells with no measured leaves keep their current angles.
          </p>

          {eligible.length === 0 ? (
            <div className="p-3 text-center text-xs text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded">
              No eligible triangulation. Build a leaf-on Helios triangulation <em>with a grid</em>
              that overlaps this QSM first.
            </div>
          ) : (
            <>
              <div>
                <label className="text-xs font-medium text-neutral-300 block mb-1">Leaf-on triangulation</label>
                <select
                  data-testid="adjust-leaves-mesh-select"
                  value={selectedMeshId}
                  onChange={(e) => setSelectedMeshId(e.target.value)}
                  className={inputCls}
                >
                  {eligible.map(m => (
                    <option key={m.id} value={m.id}>{meshLabel(m)}</option>
                  ))}
                </select>
                {selectedMesh && (
                  <p className="text-[9px] text-neutral-500 mt-1" data-testid="adjust-leaves-mesh-info">
                    {cellCount} voxel cell{cellCount === 1 ? '' : 's'} ·{' '}
                    {selectedMesh.data.triangleCount.toLocaleString()} triangles
                  </p>
                )}
              </div>

              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">Random seed</label>
                <input
                  data-testid="adjust-leaves-seed"
                  type="number"
                  value={seedStr}
                  onChange={(e) => setSeedStr(e.target.value)}
                  step="1"
                  className={inputCls}
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Same seed → reproducible angle sampling.</p>
              </div>
            </>
          )}

          {error && (
            <div className="p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">{error}</div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-neutral-700 bg-neutral-800/90 flex items-center justify-between">
          <span className="text-[10px] text-neutral-500">
            {qsm.leaves ? `${qsm.leaves.leafCount.toLocaleString()} leaves` : ''}
          </span>
          <button
            data-testid="adjust-leaves-submit"
            onClick={handleSubmit}
            disabled={eligible.length === 0}
            className={`px-4 py-2 text-xs rounded font-medium flex items-center gap-2 ${
              eligible.length === 0
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-500 text-white'
            }`}
          >
            <Compass className="w-3.5 h-3.5" /> Adjust Angles
          </button>
        </div>
      </div>
    </div>
  );
}
