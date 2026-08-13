// "Auto-Register Clouds" dialog — coarse global registration followed by ICP.
//
// Distinct from AlignDialog (plain ICP) on purpose. ICP is a LOCAL method: it
// polishes a pair that already starts close together, and cannot recover a
// large rotation. This tool first reduces both clouds to sparse per-plant
// anchors and matches those, so it works from an arbitrary starting pose — at
// the cost of running segmentation over both clouds. Keeping them separate lets
// a user reach for the cheap one when that is all they need.
//
// Either side may be a streamed (octree) cloud; the transform is applied on its
// backend session and the octree rebuilt.
import { useState, useEffect, useMemo } from 'react';
import { Sparkles, X } from 'lucide-react';
import { ObjectPicker, type PickerItem } from './ObjectPicker';
import { DebouncedNumberInput } from './DebouncedNumberInput';
import type { AnchorMethod, GlobalEstimator, SceneType } from '../utils/backendApi';

export interface AutoRegisterCloudOption {
  id: string;
  label: string;
  color?: string;
}

export interface AutoRegisterOptions {
  sceneType: SceneType;
  anchorMethod: AnchorMethod;
  estimator: GlobalEstimator;
  voxelSize?: number;
}

interface AutoRegisterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  clouds: AutoRegisterCloudOption[];
  initialSelectedIds?: Set<string>;
  isRunning?: boolean;
  onRegister: (targetId: string, sourceId: string, options: AutoRegisterOptions) => void;
}

/** Scene type decides the ALGORITHM, so it is asked first and asked plainly.
 *  Vegetated scenes are matched plant-by-plant; built scenes have no per-plant
 *  landmark to find, so they are matched on surface shape instead — a different
 *  pipeline, not a tuning knob. */
const SCENE_TYPES: { value: SceneType; label: string; hint: string }[] = [
  { value: 'agriculture', label: 'Crops or orchard', hint: 'Plants set out on a regular grid or in rows' },
  { value: 'natural', label: 'Natural woodland', hint: 'Self-seeded trees at irregular spacing' },
  { value: 'urban', label: 'Buildings or built site', hint: 'Matched on surface shape — plant matching does not apply' },
];

/** Each option names the landmark it keys on, so the choice is about the DATA
 *  rather than about an algorithm the user has no way to evaluate. */
const ANCHOR_METHODS: { value: AnchorMethod; label: string; hint: string }[] = [
  { value: 'crown', label: 'Tree crowns', hint: 'Best for aerial scans — needs no visible trunks' },
  { value: 'trunk', label: 'Trunk bases', hint: 'Best for ground scans of trees or vines' },
  { value: 'chm', label: 'Canopy peaks', hint: 'No segmentation — try when the others find too few plants' },
];

const ESTIMATORS: { value: GlobalEstimator; label: string; hint: string }[] = [
  { value: 'correlation', label: 'Canopy pattern (recommended)', hint: 'Matches the overall planting pattern — fastest and most reliable' },
  { value: 'ransac_fpfh', label: 'Plant landmarks', hint: 'Matches individual plants; only works when both scans detect the same ones' },
  { value: 'fgr', label: 'Surface shape', hint: 'For built scenes rather than vegetation' },
];

export function AutoRegisterDialog({
  isOpen, onClose, clouds, initialSelectedIds, isRunning, onRegister,
}: AutoRegisterDialogProps) {
  const [targetId, setTargetId] = useState<string>('');
  const [sourceId, setSourceId] = useState<string>('');
  const [sceneType, setSceneType] = useState<SceneType>('agriculture');
  const [anchorMethod, setAnchorMethod] = useState<AnchorMethod>('crown');
  const [estimator, setEstimator] = useState<GlobalEstimator>('correlation');
  const [voxelSize, setVoxelSize] = useState<number | undefined>(undefined);

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
  const sourceItems = useMemo<PickerItem[]>(
    () => clouds.map(c => ({
      id: c.id,
      label: c.label,
      color: c.color,
      disabledReason: c.id === targetId ? 'Already the target' : undefined,
    })),
    [clouds, targetId],
  );

  useEffect(() => {
    if (sourceId && sourceId === targetId) setSourceId('');
  }, [targetId, sourceId]);

  if (!isOpen) return null;

  const canRun = !!targetId && !!sourceId && targetId !== sourceId && !isRunning;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div data-testid="auto-register-dialog" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Auto-Register Clouds</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-xs text-neutral-400">
            Finds the alignment automatically, even when the clouds start far apart or
            rotated. The <span className="text-neutral-200 font-medium">target</span> stays
            fixed and the <span className="text-neutral-200 font-medium">source</span> moves
            onto it.
          </p>
          <ObjectPicker
            data-testid="auto-register-target-picker"
            label="Target (fixed)"
            items={targetItems}
            selectedIds={targetId ? new Set([targetId]) : new Set()}
            onChange={(s) => setTargetId([...s][0] ?? '')}
            mode="single"
            emptyMessage="No point clouds available."
          />
          <ObjectPicker
            data-testid="auto-register-source-picker"
            label="Source (moves)"
            items={sourceItems}
            selectedIds={sourceId ? new Set([sourceId]) : new Set()}
            onChange={(s) => setSourceId([...s][0] ?? '')}
            mode="single"
            emptyMessage="No point clouds available."
          />

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-neutral-300">Scene type</label>
            <select
              data-testid="auto-register-scene"
              value={sceneType}
              onChange={(e) => setSceneType(e.target.value as SceneType)}
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs text-white"
            >
              {SCENE_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-neutral-500">
              {SCENE_TYPES.find(t => t.value === sceneType)?.hint}
            </p>
          </div>

          {/* Landmark choice is meaningless on a built scene — there are no
              plants to key on — so it is hidden rather than shown disabled. */}
          {sceneType !== 'urban' && estimator === 'ransac_fpfh' && (
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-neutral-300">Match on</label>
            <select
              data-testid="auto-register-method"
              value={anchorMethod}
              onChange={(e) => setAnchorMethod(e.target.value as AnchorMethod)}
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs text-white"
            >
              {ANCHOR_METHODS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-neutral-500">
              {ANCHOR_METHODS.find(m => m.value === anchorMethod)?.hint}
            </p>
          </div>
          )}

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-neutral-300">Search method</label>
            <select
              data-testid="auto-register-estimator"
              value={estimator}
              onChange={(e) => setEstimator(e.target.value as GlobalEstimator)}
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs text-white"
            >
              {ESTIMATORS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-neutral-500">
              {ESTIMATORS.find(m => m.value === estimator)?.hint}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-neutral-300">
              Detail size (m) <span className="text-neutral-500 font-normal">— optional</span>
            </label>
            <DebouncedNumberInput
              data-testid="auto-register-voxel"
              value={voxelSize ?? NaN}
              onCommit={(v) => setVoxelSize(Number.isFinite(v) && v > 0 ? v : undefined)}
              min={0}
              debounceMs={0}
              placeholder="Auto"
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs text-white"
            />
            <p className="text-[11px] text-neutral-500">
              Leave blank to size it from the cloud. Increase it if registration finds
              nothing; decrease it for small or finely-sampled plants.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <button
            data-testid="auto-register-run"
            onClick={() => {
              onRegister(targetId, sourceId, { sceneType, anchorMethod, estimator, voxelSize });
              onClose();
            }}
            disabled={!canRun}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              canRun ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-neutral-700 text-neutral-500 cursor-not-allowed'
            }`}
          >
            {isRunning ? 'Registering…' : 'Register'}
          </button>
        </div>
      </div>
    </div>
  );
}
