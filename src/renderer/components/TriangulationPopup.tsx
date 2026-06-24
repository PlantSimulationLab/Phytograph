import { useState, useCallback, useMemo, useEffect } from 'react';
import { X, Triangle } from 'lucide-react';
import {
  TriangulationMethod,
  HeliosTriangulationRequest,
  HeliosGrid,
} from '../utils/backendApi';
import type { GridOption } from '../lib/gridOption';
import type { Scan } from '../lib/scan';
import { hasData, hasParams } from '../lib/scan';
import { buildHeliosTriangulationRequest } from '../lib/pointCloudHelpers';

// What the modal hands back when the user clicks Triangulate. The Open3D path
// (ball_pivoting / poisson / alpha_shape / delaunay) is a thin descriptor the
// viewer turns into one or more /api/triangulate calls; the Helios path carries
// a fully-built request (same shape the old HeliosTriangulationPopup produced).
export type TriangulationStartArgs =
  | {
      kind: 'open3d';
      method: Exclude<TriangulationMethod, 'helios'>;
      scanIds: string[];
      // false = one mesh per scan; true = fuse selected scans' points into one mesh.
      merge: boolean;
      depth?: number;            // poisson
      alpha?: number | null;     // alpha_shape (null → auto)
      radii?: number[];          // ball_pivoting (omitted → auto)
      // Crop-to-grid box (world coords). Set only by the Ball Pivot "Crop to
      // grid" toggle when a real voxel box is chosen; points outside it are
      // dropped before meshing. Omitted for "Auto — fit to all points" (no crop).
      // `rotationDeg` is the box's azimuthal rotation about +z (degrees); when
      // non-zero the backend crops the ROTATED box, not its AABB — so a rotated
      // grid doesn't leak points past its rotated walls (matches Helios).
      cropBox?: {
        min: [number, number, number];
        max: [number, number, number];
        rotationDeg?: number;
      };
      // The voxel grid this Ball Pivot mesh is PINNED to, so it can later be
      // re-used as the external triangulation for the leaf-area (LAD) inversion.
      // Set only for ball_pivoting + a chosen grid + per-scan (NOT merged) — a
      // merged mesh has no single source scan, so it can't drive LAD. Carries the
      // grid geometry (for backend per-triangle cell binning) and the source
      // voxel-box mesh id (so LAD can auto-hide it). Omitted = not LAD-reusable.
      grid?: HeliosGrid;
      gridMeshId?: string;
    }
  | {
      kind: 'helios';
      // `scanColors` is aligned 1:1 with `request.scans` (same order), so the
      // caller can map each triangle's scan index back to a display color.
      request: HeliosTriangulationRequest;
      scanColors: string[];
      sourceScanIds: string[];
      gridMeshId?: string;
    };

interface TriangulationPopupProps {
  isOpen: boolean;
  onClose: () => void;
  onStartTriangulate: (args: TriangulationStartArgs) => void;
  scans: Scan[];
  initialSelectedIds?: Set<string>;
  // Voxel boxes available to use as the Helios triangulation grid. Empty → the
  // backend auto-creates a single-cell grid over all points (with a warning).
  gridOptions?: GridOption[];
  // True while a triangulation (Open3D or Helios) is running — disables the run
  // button so the user can't fire a second one.
  inProgress?: boolean;
  // Surfaced from the viewer's triangulation error state, shown in a red box.
  error?: string | null;
}

// Per-method one-liner shown under the dropdown.
const METHOD_DESCRIPTIONS: Record<TriangulationMethod, string> = {
  ball_pivoting: 'Good for clean, uniformly sampled point clouds',
  poisson: 'Creates watertight meshes, good for noisy data',
  alpha_shape: 'Good for concave shapes',
  delaunay: 'Fast 2D projection, best for roughly planar surfaces',
  helios: 'Spherical Delaunay triangulation for multi-scan LiDAR data',
};

// Unified triangulation setup. Models LADPopup / the old HeliosTriangulationPopup:
// a scan picker plus method-specific parameters. Open3D methods expose their
// algorithm params and a per-scan/merged toggle; Helios has no algorithm params
// (the Lmax / aspect filter is applied afterwards in the Meshes panel) but adds a
// grid selector and always fuses scans at the backend, so the merge toggle is hidden.
export function TriangulationPopup({
  isOpen,
  onClose,
  onStartTriangulate,
  scans,
  initialSelectedIds,
  gridOptions = [],
  inProgress = false,
  error = null,
}: TriangulationPopupProps) {
  const [method, setMethod] = useState<TriangulationMethod>('ball_pivoting');

  // Open3D needs only point data; Helios additionally needs scan parameters
  // (the scanner origin needed to reconstruct per-pulse directions).
  const eligible = useMemo(
    () =>
      method === 'helios'
        ? scans.filter(s => hasData(s) && hasParams(s))
        : scans.filter(s => hasData(s)),
    [scans, method],
  );

  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());

  // Method-specific parameters.
  const [poissonDepth, setPoissonDepth] = useState(8);
  const [alphaAuto, setAlphaAuto] = useState(true);
  const [alphaStr, setAlphaStr] = useState('0.1');
  const [radiusAuto, setRadiusAuto] = useState(true);
  const [radiusStr, setRadiusStr] = useState('0.1');
  // Open3D only: false = one mesh per scan, true = merge points into one mesh.
  const [mergeScans, setMergeScans] = useState(false);

  // Which voxel box (if any) drives the grid. Empty string = "Auto" (no grid).
  // Shared by BOTH the Helios path (bounds the triangulation region) and the Ball
  // Pivot path (pins the mesh to the box so it can later be re-used for the LAD
  // inversion; points outside the box are cropped before meshing). One selector,
  // one source of truth — a ball-pivot mesh is LAD-reusable only when a real box
  // is chosen here AND the mesh is built per-scan (not merged).
  const [selectedGridId, setSelectedGridId] = useState<string>('');

  const [localError, setLocalError] = useState<string | null>(null);

  // On open: default the method (Helios when any scan carries parameters,
  // otherwise Ball Pivoting) and seed the selection from the caller.
  useEffect(() => {
    if (!isOpen) return;
    const anyWithParams = scans.some(s => hasData(s) && hasParams(s));
    setMethod(anyWithParams ? 'helios' : 'ball_pivoting');
    setLocalError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // On OPEN, (re)seed from the caller's ids (the live Scans-panel selection),
  // intersected with eligibility; fall back to all eligible when that's empty.
  // Keyed on `isOpen` only so reopening with a different panel selection picks up
  // the new one (not a prior session's — the stale-reseed bug).
  useEffect(() => {
    if (!isOpen) return;
    const seed = initialSelectedIds ?? new Set<string>();
    const filtered = new Set<string>();
    for (const id of seed) if (eligible.some(s => s.id === id)) filtered.add(id);
    setSelectedScanIds(filtered.size > 0 ? filtered : new Set(eligible.map(s => s.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // When the eligible set changes WHILE OPEN (e.g. switching method between Helios
  // — which needs params — and Open3D), prune any now-ineligible ids from the
  // current selection. Pure prune: never re-expand, so it can't clobber the user's
  // pick. (Skipped on the initial open; the seed effect above owns that.)
  useEffect(() => {
    if (!isOpen) return;
    setSelectedScanIds(prev => {
      const kept = new Set<string>();
      for (const id of prev) if (eligible.some(s => s.id === id)) kept.add(id);
      return kept.size === prev.size ? prev : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible]);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedGridId(prev =>
      gridOptions.some(g => g.id === prev) ? prev : (gridOptions[0]?.id ?? ''),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, gridOptions]);

  const selectedGrid = useMemo(
    () => gridOptions.find(g => g.id === selectedGridId) ?? null,
    [gridOptions, selectedGridId],
  );

  // The crop AABB derived from the selected grid box (Ball Pivot path): its world
  // min/max (center ± size/2). Used to drop points outside the box before meshing
  // so the pinned mesh contains only in-grid geometry. Null when no real box is
  // chosen ("Auto — fit to all points" = no crop). Method-gated by the caller, so
  // it's safe to derive unconditionally here.
  const cropBox = useMemo(() => {
    if (!selectedGrid) return null;
    const [cx, cy, cz] = selectedGrid.grid.center;
    const [sx, sy, sz] = selectedGrid.grid.size;
    return {
      min: [cx - sx / 2, cy - sy / 2, cz - sz / 2] as [number, number, number],
      max: [cx + sx / 2, cy + sy / 2, cz + sz / 2] as [number, number, number],
      // Carry the grid's azimuthal rotation so the backend crops the rotated box
      // (the min/max above are the box's AXIS-ALIGNED extent before rotation).
      ...(selectedGrid.grid.rotation ? { rotationDeg: selectedGrid.grid.rotation } : {}),
    };
  }, [selectedGrid]);

  const toggleScan = useCallback((scanId: string) => {
    setSelectedScanIds(prev => {
      const next = new Set(prev);
      if (next.has(scanId)) next.delete(scanId); else next.add(scanId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedScanIds(new Set(eligible.map(s => s.id)));
  }, [eligible]);

  const deselectAll = useCallback(() => {
    setSelectedScanIds(new Set());
  }, []);

  const selectedScans = useMemo(
    () => eligible.filter(s => selectedScanIds.has(s.id)),
    [eligible, selectedScanIds],
  );

  // Assemble the HeliosTriangulationRequest from the current selection + grid.
  // Delegates to the shared, unit-tested builder so the point-source resolution
  // (session → file → inline points, misses excluded server-side) can't drift
  // from the LAD path. Throws if a scan has no resolvable source.
  const buildHeliosRequest = useCallback((): HeliosTriangulationRequest => {
    return buildHeliosTriangulationRequest(selectedScans, selectedGrid?.grid ?? null);
  }, [selectedScans, selectedGrid]);

  const handleTriangulate = useCallback(() => {
    setLocalError(null);
    if (selectedScans.length === 0) {
      setLocalError('Select at least one scan');
      return;
    }

    if (method === 'helios') {
      let request: HeliosTriangulationRequest;
      try {
        request = buildHeliosRequest();
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : String(err));
        return;
      }
      const scanColors = selectedScans.map(s => s.color);
      const sourceScanIds = selectedScans.map(s => s.id);
      onStartTriangulate({
        kind: 'helios',
        request,
        scanColors,
        sourceScanIds,
        gridMeshId: selectedGrid?.id,
      });
      onClose();
      return;
    }

    // Open3D path.
    const args: TriangulationStartArgs = {
      kind: 'open3d',
      method: method as Exclude<TriangulationMethod, 'helios'>,
      scanIds: selectedScans.map(s => s.id),
      merge: mergeScans,
    };
    if (method === 'poisson') {
      args.depth = poissonDepth;
    } else if (method === 'alpha_shape') {
      args.alpha = alphaAuto ? null : (parseFloat(alphaStr) || 0.1);
    } else if (method === 'ball_pivoting' && !radiusAuto) {
      const r = parseFloat(radiusStr);
      if (Number.isFinite(r) && r > 0) args.radii = [r];
    }
    // Grid pin (Ball Pivot only): crop points to the chosen box, and — when the
    // mesh is built PER-SCAN (not merged) — pin it to the grid so it can later be
    // re-used for the leaf-area (LAD) inversion. A merged mesh fuses multiple
    // scans with no single source scan, so it's never LAD-reusable: crop it, but
    // don't attach the LAD pin (grid/gridMeshId).
    if (method === 'ball_pivoting' && cropBox) {
      args.cropBox = cropBox;
      if (!mergeScans && selectedGrid) {
        args.grid = selectedGrid.grid;
        args.gridMeshId = selectedGrid.id;
      }
    }
    onStartTriangulate(args);
    onClose();
  }, [
    method, selectedScans, mergeScans, poissonDepth, alphaAuto, alphaStr,
    radiusAuto, radiusStr, selectedGrid, cropBox, buildHeliosRequest, onStartTriangulate, onClose,
  ]);

  if (!isOpen) return null;

  const totalPoints = selectedScans.reduce((sum, s) => sum + s.data!.pointCount, 0);
  // Scans usable for the *current* method but not selected, and (Helios only)
  // scans with data that lack parameters.
  const ineligibleScans = method === 'helios'
    ? scans.filter(s => hasData(s) && !hasParams(s))
    : [];
  const shownError = localError ?? error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div data-testid="triangulation-popup" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-2xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Triangle className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Triangulation Setup</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 transition-colors"
          >
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Method */}
          <div>
            <label className="text-xs font-medium text-neutral-300 block mb-1">Method</label>
            <select
              data-testid="triangulation-method"
              value={method}
              onChange={(e) => setMethod(e.target.value as TriangulationMethod)}
              className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
            >
              <option value="ball_pivoting">Ball Pivoting</option>
              <option value="poisson">Poisson</option>
              <option value="alpha_shape">Alpha Shape</option>
              <option value="delaunay">Delaunay (2D)</option>
              <option value="helios">Helios</option>
            </select>
            <p className="text-[9px] text-neutral-500 mt-1">{METHOD_DESCRIPTIONS[method]}</p>
          </div>

          {/* Select controls + count */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-neutral-300">Scans</label>
              <span className="text-[10px] text-neutral-500">
                ({selectedScanIds.size}/{eligible.length} selected)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={selectAll}
                className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                All
              </button>
              <span className="text-neutral-600 text-[10px]">|</span>
              <button
                onClick={deselectAll}
                className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                None
              </button>
            </div>
          </div>

          {eligible.length === 0 ? (
            <div className="p-4 text-center text-xs text-neutral-500">
              {method === 'helios'
                ? 'No scans have both point data and scan parameters. Attach parameters from the Scans panel first.'
                : 'No point clouds available to triangulate. Import a point cloud first.'}
            </div>
          ) : (
            <div className="border border-neutral-700 rounded-lg overflow-hidden">
              <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 px-3 py-2 bg-neutral-900/80 border-b border-neutral-700 items-center">
                <div className="w-4" />
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider">Scan</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-16 text-center">X</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-16 text-center">Y</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-16 text-center">Z</span>
              </div>

              <div className="max-h-[35vh] overflow-y-auto">
                {eligible.map(scan => {
                  const isSelected = selectedScanIds.has(scan.id);
                  const fileName = scan.label || scan.data!.fileName || 'Unnamed';
                  // Origin is only present when the scan carries params (always
                  // true for Helios; may be absent for plain Open3D clouds).
                  const origin = scan.params?.origin;
                  return (
                    <div
                      key={scan.id}
                      data-testid="triangulation-scan-row"
                      data-scan-id={scan.id}
                      className={`grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 px-3 py-2 items-center border-b border-neutral-700/50 transition-colors ${
                        isSelected ? 'bg-neutral-700/30' : 'bg-neutral-800/50 opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleScan(scan.id)}
                        className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-green-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                      />
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: scan.color }} />
                        <span className="text-xs text-white truncate" title={fileName}>{fileName}</span>
                        <span className="text-[9px] text-neutral-500 flex-shrink-0">
                          {scan.data!.pointCount.toLocaleString()} pts
                        </span>
                      </div>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{origin ? origin.x.toFixed(2) : '—'}</span>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{origin ? origin.y.toFixed(2) : '—'}</span>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{origin ? origin.z.toFixed(2) : '—'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {ineligibleScans.length > 0 && (
            <div className="text-[10px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5">
              {ineligibleScans.length} scan(s) missing parameters and cannot be triangulated with Helios.
              Add scan parameters from the Scans panel.
            </div>
          )}

          {/* Per-scan vs merged — Open3D only. Helios always fuses scans into one
              mesh at the backend, so the toggle doesn't apply. */}
          {method !== 'helios' && (
            <div className="border-t border-neutral-700 pt-4">
              <label className="text-xs font-medium text-neutral-300 block mb-2">Output</label>
              <div className="flex flex-col gap-1.5" data-testid="triangulation-merge-toggle">
                <label className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer">
                  <input
                    type="radio"
                    name="triangulation-merge"
                    checked={!mergeScans}
                    onChange={() => setMergeScans(false)}
                    className="text-green-500 focus:ring-0 focus:ring-offset-0"
                  />
                  Triangulate each scan separately (one mesh per scan)
                </label>
                <label className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer">
                  <input
                    type="radio"
                    name="triangulation-merge"
                    checked={mergeScans}
                    onChange={() => setMergeScans(true)}
                    className="text-green-500 focus:ring-0 focus:ring-offset-0"
                  />
                  Merge selected scans into one mesh
                </label>
              </div>
            </div>
          )}

          {/* Method-specific parameters */}
          <div className="border-t border-neutral-700 pt-4">
            <label className="text-xs font-medium text-neutral-300 block mb-3">Parameters</label>

            {method === 'ball_pivoting' && (
              <div>
                <label className="flex items-center gap-2 text-[11px] text-neutral-300 mb-1 cursor-pointer">
                  <input
                    data-testid="triangulation-radius-auto"
                    type="checkbox"
                    checked={radiusAuto}
                    onChange={(e) => setRadiusAuto(e.target.checked)}
                    className="rounded bg-neutral-700 border-neutral-600 text-green-500 focus:ring-0 focus:ring-offset-0"
                  />
                  Auto radius
                </label>
                {!radiusAuto && (
                  <>
                    <input
                      data-testid="triangulation-radius"
                      type="number"
                      onWheel={(e) => e.currentTarget.blur()}
                      value={radiusStr}
                      onChange={(e) => setRadiusStr(e.target.value)}
                      step="0.01"
                      min="0.001"
                      className="w-40 px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                    />
                    <p className="text-[9px] text-neutral-500 mt-0.5">Ball pivoting radius (m)</p>
                  </>
                )}
                {radiusAuto && (
                  <p className="text-[9px] text-neutral-500">
                    Radius auto-computed from the median nearest-neighbour spacing.
                  </p>
                )}

                {/* Grid: pin the mesh to a voxel box. Same selector pattern as the
                    Helios path. Choosing a box crops points to it before meshing
                    AND — when triangulating per-scan — pins the mesh so it can be
                    re-used for the leaf-area (LAD) inversion. */}
                <div className="border-t border-neutral-700/60 mt-4 pt-3">
                  <label className="text-xs font-medium text-neutral-300 block mb-1">Grid</label>
                  <p className="text-[9px] text-neutral-500 mb-2">
                    Pin the mesh to a voxel box to crop points to it and make the mesh
                    re-usable for the leaf-area (LAD) inversion.
                  </p>
                  <select
                    data-testid="triangulation-grid-select"
                    value={selectedGridId}
                    onChange={(e) => setSelectedGridId(e.target.value)}
                    className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                  >
                    <option value="">Auto — fit to all points (no pin)</option>
                    {gridOptions.map(g => (
                      <option key={g.id} value={g.id}>{g.label}</option>
                    ))}
                  </select>
                  {selectedGrid ? (
                    mergeScans ? (
                      <p
                        className="text-[9px] text-amber-300/80 mt-1"
                        data-testid="triangulation-grid-merge-note"
                      >
                        Cropping to {selectedGrid.label}, but a merged mesh can’t be
                        used for the leaf-area inversion (no single source scan).
                        Triangulate each scan separately to make it LAD-reusable.
                      </p>
                    ) : (
                      <p
                        className="text-[9px] text-neutral-500 mt-1"
                        data-testid="triangulation-grid-summary"
                      >
                        Pinned to {selectedGrid.label} — re-usable for the leaf-area
                        inversion.
                      </p>
                    )
                  ) : (
                    <p
                      className="text-[9px] text-amber-300/80 mt-1"
                      data-testid="triangulation-grid-allpoints-note"
                    >
                      No grid box selected — all points are triangulated and the mesh
                      can’t be used for the leaf-area inversion (create a voxel box in
                      the viewer and select it here to pin the mesh to it).
                    </p>
                  )}
                </div>
              </div>
            )}

            {method === 'poisson' && (
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Octree Depth: {poissonDepth}
                </label>
                <input
                  data-testid="triangulation-poisson-depth"
                  type="range"
                  min={4}
                  max={12}
                  value={poissonDepth}
                  onChange={(e) => setPoissonDepth(parseInt(e.target.value, 10))}
                  className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-neutral-500 mt-0.5">
                  <span>Coarse</span>
                  <span>Fine</span>
                </div>
              </div>
            )}

            {method === 'alpha_shape' && (
              <div>
                <label className="flex items-center gap-2 text-[11px] text-neutral-300 mb-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={alphaAuto}
                    onChange={(e) => setAlphaAuto(e.target.checked)}
                    className="rounded bg-neutral-700 border-neutral-600 text-green-500 focus:ring-0 focus:ring-offset-0"
                  />
                  Auto Alpha
                </label>
                {!alphaAuto && (
                  <>
                    <input
                      data-testid="triangulation-alpha"
                      type="number"
                      onWheel={(e) => e.currentTarget.blur()}
                      value={alphaStr}
                      onChange={(e) => setAlphaStr(e.target.value)}
                      step="0.01"
                      min="0.001"
                      className="w-40 px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                    />
                    <p className="text-[9px] text-neutral-500 mt-0.5">Alpha-shape radius</p>
                  </>
                )}
              </div>
            )}

            {method === 'delaunay' && (
              <p className="text-[10px] text-neutral-500">
                No parameters — 2D Delaunay projects the points to a plane and triangulates.
              </p>
            )}

            {/* Helios: no algorithm params; only the post-hoc filter (later) and
                the grid. */}
            {method === 'helios' && (
              <>
                <div
                  className="text-[10px] text-neutral-400 bg-neutral-700/30 border border-neutral-700 rounded px-2.5 py-2"
                  data-testid="helios-filter-note"
                >
                  Triangulates all candidate triangles. The edge-length (L<sub>max</sub>)
                  and aspect-ratio filter is then auto-estimated and adjustable per
                  mesh in the Meshes panel — no re-triangulation needed.
                </div>

                <label className="text-xs font-medium text-neutral-300 block mt-4 mb-1">Grid</label>
                <p className="text-[9px] text-neutral-500 mb-2">
                  The triangulation grid bounds the region. Use a voxel box from the
                  viewer, or let Phytograph fit one to all points.
                </p>
                <select
                  data-testid="helios-grid-select"
                  value={selectedGridId}
                  onChange={(e) => setSelectedGridId(e.target.value)}
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                >
                  <option value="">Auto — fit to all points (1×1×1)</option>
                  {gridOptions.map(g => (
                    <option key={g.id} value={g.id}>{g.label}</option>
                  ))}
                </select>
                {selectedGrid ? (
                  <p className="text-[9px] text-neutral-500 mt-1" data-testid="helios-grid-summary">
                    Grid: {selectedGrid.label} ({selectedGrid.grid.nx}×{selectedGrid.grid.ny}×{selectedGrid.grid.nz} cells)
                  </p>
                ) : (
                  <div
                    className="text-[10px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5 mt-2"
                    data-testid="helios-grid-allpoints-warning"
                  >
                    No grid box selected — all points will be triangulated within their
                    bounding box. This assumes ground and trunk are already segmented
                    or cropped.
                  </div>
                )}
              </>
            )}
          </div>

          {shownError && (
            <div className="p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
              {shownError}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-neutral-700 bg-neutral-800/90 flex items-center justify-between">
          <span className="text-[10px] text-neutral-500">
            {selectedScans.length > 0
              ? `${selectedScans.length} scan${selectedScans.length > 1 ? 's' : ''}, ${totalPoints.toLocaleString()} total points`
              : 'No scans selected'}
          </span>
          <button
            data-testid="triangulation-run-button"
            onClick={handleTriangulate}
            disabled={selectedScans.length === 0 || inProgress}
            className={`px-4 py-2 text-xs rounded font-medium flex items-center gap-2 ${
              selectedScans.length === 0 || inProgress
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-500 text-white'
            }`}
          >
            <Triangle className="w-3.5 h-3.5" />
            {inProgress ? 'Triangulating…' : 'Triangulate'}
          </button>
        </div>
      </div>
    </div>
  );
}
