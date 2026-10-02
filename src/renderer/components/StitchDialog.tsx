// Self-contained "Stitch" dialog. Picks 2+ point clouds to merge into one cloud,
// or — on the Meshes side of the toggle at the top — 2+ meshes to merge into one
// mesh. Independent of the viewport selection (seeded from it when available).
// Replaces the old selection-gated stitch button.
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

export interface StitchMeshOption {
  id: string;
  label: string;
  color?: string;
  triangleCount?: number;
  // Why this mesh cannot be merged (a triangulation, plant, DEM, …). The row
  // is listed but disabled, so the user sees why it is not on offer.
  disabledReason?: string;
}

export type StitchMode = 'clouds' | 'meshes';

interface StitchDialogProps {
  isOpen: boolean;
  onClose: () => void;
  clouds: StitchCloudOption[];
  initialSelectedIds?: Set<string>;
  // `opts` is an object so future stitch options stay additive.
  onStitch: (ids: string[], opts: { retainOriginals: boolean }) => void;
  meshes?: StitchMeshOption[];
  initialSelectedMeshIds?: Set<string>;
  onMergeMeshes?: (ids: string[], opts: { retainOriginals: boolean; matchColors: boolean; removeOverlap: boolean }) => void;
  // Why the picked meshes cannot be merged TOGETHER although each is mergeable
  // on its own (textured with untextured), or undefined when they can.
  meshSetBlockReason?: (ids: string[]) => string | undefined;
}

const NO_MESHES: StitchMeshOption[] = [];

export function StitchDialog({
  isOpen, onClose, clouds, initialSelectedIds, onStitch,
  meshes = NO_MESHES, initialSelectedMeshIds, onMergeMeshes, meshSetBlockReason,
}: StitchDialogProps) {
  const [mode, setMode] = useState<StitchMode>('clouds');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Each side keeps its own picks, so flipping the toggle loses nothing.
  const [selectedMeshes, setSelectedMeshes] = useState<Set<string>>(new Set());
  // When true the input clouds survive the merge (hidden) instead of being
  // removed from the scene. Deliberately not persisted — resets on every open,
  // so the destructive default is always an explicit choice.
  const [retainOriginals, setRetainOriginals] = useState(false);
  // What a mesh merge does where its sources cover the same surface. Both off
  // by default (and on every open): a plain merge changes no color or triangle.
  const [matchColors, setMatchColors] = useState(false);
  const [removeOverlap, setRemoveOverlap] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const seed = new Set<string>();
    if (initialSelectedIds) {
      for (const id of initialSelectedIds) if (clouds.some(c => c.id === id)) seed.add(id);
    }
    setSelected(seed);
    const meshSeed = new Set<string>();
    if (initialSelectedMeshIds) {
      for (const id of initialSelectedMeshIds) {
        if (meshes.some(m => m.id === id && !m.disabledReason)) meshSeed.add(id);
      }
    }
    setSelectedMeshes(meshSeed);
    // Open on the side the user is evidently working on: meshes when only
    // meshes are selected in the viewport, or when there are no clouds at all.
    const meshSelected = !!initialSelectedMeshIds && meshes.some(m => initialSelectedMeshIds.has(m.id));
    setMode((meshSelected && seed.size === 0) || (clouds.length === 0 && meshes.length > 0) ? 'meshes' : 'clouds');
    setRetainOriginals(false);
    setMatchColors(false);
    setRemoveOverlap(false);
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

  const meshItems = useMemo<PickerItem[]>(
    () => meshes.map(m => ({
      id: m.id,
      label: m.label,
      color: m.color,
      detail: m.triangleCount != null ? `${m.triangleCount.toLocaleString()} triangles` : undefined,
      disabledReason: m.disabledReason,
    })),
    [meshes],
  );

  if (!isOpen) return null;

  const meshMode = mode === 'meshes';
  const noun = meshMode ? 'meshes' : 'clouds';
  // Count only picks that still exist and are still pickable. An object removed
  // while the dialog is open (an undo, say) would otherwise leave the button
  // live on a set the handler then rejects — closing the dialog on a no-op.
  const pickable = new Set(meshMode
    ? meshes.filter(m => !m.disabledReason).map(m => m.id)
    : clouds.map(c => c.id));
  const picked = new Set(Array.from(meshMode ? selectedMeshes : selected).filter(id => pickable.has(id)));
  const setBlock = meshMode && picked.size >= 2 ? meshSetBlockReason?.(Array.from(picked)) : undefined;
  const canStitch = picked.size >= 2 && !setBlock;
  const modeButton = (m: StitchMode, text: string) => (
    <button
      data-testid={`stitch-mode-${m}`}
      aria-pressed={mode === m}
      onClick={() => setMode(m)}
      className={`flex-1 px-3 py-1 rounded text-xs font-medium transition-colors ${
        mode === m ? 'bg-neutral-600 text-white' : 'text-neutral-400 hover:text-neutral-200'
      }`}
    >
      {text}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div data-testid="stitch-dialog" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Merge className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Stitch</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="flex gap-1 p-1 rounded bg-neutral-900/60 border border-neutral-700">
            {modeButton('clouds', 'Point clouds')}
            {modeButton('meshes', 'Meshes')}
          </div>

          <p className="text-xs text-neutral-400">
            {meshMode
              ? 'Select two or more meshes to merge into a single mesh, where they are drawn.'
              : 'Select two or more clouds to merge into a single point cloud.'}
          </p>
          {meshMode ? (
            <ObjectPicker
              key="meshes"
              data-testid="stitch-mesh-picker"
              label="Meshes"
              items={meshItems}
              selectedIds={selectedMeshes}
              onChange={setSelectedMeshes}
              mode="multi"
              emptyMessage="No meshes available to merge."
            />
          ) : (
            <ObjectPicker
              key="clouds"
              data-testid="stitch-picker"
              label="Clouds"
              items={items}
              selectedIds={selected}
              onChange={setSelected}
              mode="multi"
              emptyMessage="No point clouds available to stitch."
            />
          )}

          <label
            data-testid="stitch-retain-originals"
            className="flex items-center gap-2 select-none cursor-pointer"
          >
            <input
              type="checkbox"
              checked={retainOriginals}
              onChange={(e) => setRetainOriginals(e.target.checked)}
              className="w-3.5 h-3.5 rounded bg-neutral-700 border-neutral-600 accent-green-600"
            />
            <span className="flex flex-col">
              <span className="text-xs text-neutral-300">Keep original {noun}</span>
              <span className="text-[10px] text-neutral-500">
                Sources stay in the scene (hidden) instead of being removed.
              </span>
            </span>
          </label>

          {meshMode && (
            <>
              <label
                data-testid="stitch-mesh-match-colors"
                className="flex items-center gap-2 select-none cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={matchColors}
                  onChange={(e) => setMatchColors(e.target.checked)}
                  className="w-3.5 h-3.5 rounded bg-neutral-700 border-neutral-600 accent-green-600"
                />
                <span className="flex flex-col">
                  <span className="text-xs text-neutral-300">Match colors where meshes overlap</span>
                  <span className="text-[10px] text-neutral-500">
                    Evens out lighting differences between vertex-colored meshes and blends them across the overlap.
                  </span>
                </span>
              </label>
              <label
                data-testid="stitch-mesh-remove-overlap"
                className="flex items-center gap-2 select-none cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={removeOverlap}
                  onChange={(e) => setRemoveOverlap(e.target.checked)}
                  className="w-3.5 h-3.5 rounded bg-neutral-700 border-neutral-600 accent-green-600"
                />
                <span className="flex flex-col">
                  <span className="text-xs text-neutral-300">Remove overlapping surface</span>
                  <span className="text-[10px] text-neutral-500">
                    Where two meshes cover the same surface, draws them together, keeps one copy and deletes the duplicate triangles.
                  </span>
                </span>
              </label>
            </>
          )}

          {setBlock && (
            <div
              data-testid="stitch-mesh-block"
              className="flex gap-2 text-[11px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2.5 py-2"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <div>{setBlock}</div>
            </div>
          )}

          {!meshMode && originsLost > 0 && (
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
                  unavailable on the merged cloud.{' '}
                  {retainOriginals
                    ? 'The originals keep their origins, so you can still run those on them.'
                    : 'Register the clouds first, or keep the originals, if you need them.'}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-700 bg-neutral-800/90">
          <span className="text-[11px] text-neutral-500">
            {picked.size >= 2 ? `${picked.size} ${noun} selected` : `Select at least 2 ${noun}`}
          </span>
          <button
            data-testid="stitch-run"
            onClick={() => {
              if (meshMode) onMergeMeshes?.(Array.from(picked), { retainOriginals, matchColors, removeOverlap });
              else onStitch(Array.from(picked), { retainOriginals });
              onClose();
            }}
            disabled={!canStitch}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              canStitch ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-neutral-700 text-neutral-500 cursor-not-allowed'
            }`}
          >
            {meshMode ? 'Merge' : originsLost > 0 ? 'Stitch anyway' : 'Stitch'}
          </button>
        </div>
      </div>
    </div>
  );
}
