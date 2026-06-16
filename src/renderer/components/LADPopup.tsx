import { useState, useCallback, useMemo, useEffect } from 'react';
import { X, Grid3x3 } from 'lucide-react';
import { LADRequest } from '../utils/backendApi';
import type { GridOption } from '../lib/gridOption';
import type { HeliosGrid } from '../utils/backendApi';
import type { Scan } from '../lib/scan';
import { hasData, hasParams } from '../lib/scan';
import { buildLADRequest } from '../lib/pointCloudHelpers';

// An existing Helios triangulation the user can REUSE. Selecting it locks the
// inversion to the same scans + grid + lmax/aspect that produced the mesh, so
// the (re-run) triangulation reproduces that mesh's G-function exactly.
export interface LADTriangulationOption {
  id: string;        // mesh id
  label: string;     // mesh display name
  grid: HeliosGrid;  // the grid this mesh was triangulated in
  scanIds: string[]; // the scans fused into it
  lmax: number;
  maxAspectRatio: number;
  // The voxel-box mesh (if still in the scene) whose volume matches this grid.
  // Reusing this triangulation hides that box so its faces don't z-fight the LAD
  // voxel result. Undefined when the box was deleted/resized away.
  gridMeshId?: string;
}

interface LADPopupProps {
  isOpen: boolean;
  onClose: () => void;
  // `scanColors` is aligned 1:1 with `request.scans` (same order).
  // `gridMeshId` is the id of the voxel-box mesh used as the grid (a GridOption
  // id is its mesh id), so the caller can auto-hide that box once the LAD result
  // — which occupies the same space — is shown, avoiding z-fighting. When the
  // user reuses an existing triangulation, the grid lives on that mesh (not a
  // voxel box), so there's nothing to auto-hide → pass ''.
  onStartLAD: (request: LADRequest, scanColors: string[], gridMeshId: string) => void;
  scans: Scan[];
  initialSelectedIds?: Set<string>;
  // Voxel boxes available as the LAD grid. LAD REQUIRES one — when empty (and no
  // triangulation is reused) the compute button is disabled and the user is told
  // to create a voxel box.
  gridOptions?: GridOption[];
  // Existing Helios triangulations the user can reuse instead of running a new
  // one. Reusing one locks the scans, grid, and lmax/aspect to that mesh.
  triangulationOptions?: LADTriangulationOption[];
  // Pre-fill Lmax / max aspect ratio from the filter the user dialed in on a
  // Helios triangulation mesh, so the inversion bakes in that filtering. Still
  // editable here. Omitted → fall back to the standard defaults.
  defaultLmax?: number;
  defaultMaxAspectRatio?: number;
}

// Per-voxel leaf area density setup. Models HeliosTriangulationPopup but the
// voxel grid is mandatory (it's the basis of the LAD calculation, not just a
// bounding region) and there is no auto-grid fallback. Lmax/aspect feed the
// triangulation that produces the G-function; min_voxel_hits gates which
// voxels are solved. Return type is derived from each scan's own parameters.
export function LADPopup({
  isOpen,
  onClose,
  onStartLAD,
  scans,
  initialSelectedIds,
  gridOptions = [],
  triangulationOptions = [],
  defaultLmax,
  defaultMaxAspectRatio,
}: LADPopupProps) {
  const eligible = useMemo(() => scans.filter(s => hasData(s) && hasParams(s)), [scans]);
  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());

  // Triangulation mode: '' = run a new triangulation (pick scans + grid + params
  // below); otherwise the id of an existing Helios mesh to REUSE (its scans,
  // grid, and lmax/aspect are locked, reproducing that mesh's G-function).
  const [reuseTriId, setReuseTriId] = useState<string>('');
  useEffect(() => {
    if (!isOpen) return;
    setReuseTriId(prev => (triangulationOptions.some(t => t.id === prev) ? prev : ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, triangulationOptions]);
  const reuseTri = useMemo(
    () => triangulationOptions.find(t => t.id === reuseTriId) ?? null,
    [triangulationOptions, reuseTriId],
  );

  // Which voxel box drives the grid. Default to the first available box;
  // empty string means "none selected" → cannot compute.
  const [selectedGridId, setSelectedGridId] = useState<string>('');
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

  useEffect(() => {
    if (isOpen) {
      if (initialSelectedIds && initialSelectedIds.size > 0) {
        const filtered = new Set<string>();
        for (const id of initialSelectedIds) {
          if (eligible.some(s => s.id === id)) filtered.add(id);
        }
        setSelectedScanIds(filtered.size > 0 ? filtered : new Set(eligible.map(s => s.id)));
      } else {
        setSelectedScanIds(new Set(eligible.map(s => s.id)));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const [lmaxStr, setLmaxStr] = useState('0.1');
  const [maxAspectRatioStr, setMaxAspectRatioStr] = useState('4.0');
  const [minVoxelHitsStr, setMinVoxelHitsStr] = useState('5');
  // Characteristic vegetation element width (m). Drives the Pimont (2018)
  // uncertainty that the backend computes on every run. Broadleaf ≈ 0.05 m,
  // conifer needles ≈ 0.002 m — presets below set common values.
  const [elementWidthStr, setElementWidthStr] = useState('0.05');
  const [error, setError] = useState<string | null>(null);

  // Seed Lmax / aspect from the mesh filter the user dialed in (when provided)
  // each time the dialog opens, so the inversion reproduces that filtering. The
  // user can still override before computing.
  useEffect(() => {
    if (!isOpen) return;
    if (defaultLmax !== undefined && Number.isFinite(defaultLmax)) {
      setLmaxStr(Number(defaultLmax.toPrecision(4)).toString());
    }
    if (defaultMaxAspectRatio !== undefined && Number.isFinite(defaultMaxAspectRatio)) {
      setMaxAspectRatioStr(String(defaultMaxAspectRatio));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

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

  // The scans actually fed to the inversion. When reusing a triangulation, they
  // come from that mesh's recorded source scans (still resolved against the
  // current session, so a deleted scan is dropped); otherwise the user's pick.
  const selectedScans = useMemo(() => {
    if (reuseTri) {
      const ids = new Set(reuseTri.scanIds);
      return eligible.filter(s => ids.has(s.id));
    }
    return eligible.filter(s => selectedScanIds.has(s.id));
  }, [reuseTri, eligible, selectedScanIds]);

  // Whether all of the reused mesh's source scans are still present (with data +
  // params). If some are gone, the reused triangulation can't be reproduced.
  const reuseScansMissing = useMemo(
    () => (reuseTri ? reuseTri.scanIds.length - selectedScans.length : 0),
    [reuseTri, selectedScans],
  );

  // Return-type summary derived from the selected scans (read-only — set it per
  // scan in the Scans panel).
  const returnTypes = useMemo(
    () => new Set(selectedScans.map(s => s.params!.returnType)),
    [selectedScans],
  );

  const handleCompute = useCallback(() => {
    setError(null);

    if (selectedScans.length === 0) {
      setError(reuseTri
        ? 'The reused triangulation’s source scans are no longer available'
        : 'Select at least one scan');
      return;
    }

    // Grid + lmax/aspect come from the reused mesh, else from the dialog.
    const grid = reuseTri ? reuseTri.grid : selectedGrid?.grid;
    if (!grid) {
      setError('Select a voxel grid — LAD requires one');
      return;
    }

    const lmax = reuseTri ? reuseTri.lmax : (parseFloat(lmaxStr) || 0.1);
    const maxAspectRatio = reuseTri ? reuseTri.maxAspectRatio : (parseFloat(maxAspectRatioStr) || 4.0);
    const minVoxelHits = Math.max(1, parseInt(minVoxelHitsStr, 10) || 1);
    const elementWidth = Math.max(0, parseFloat(elementWidthStr) || 0.05);

    const request = buildLADRequest(selectedScans, grid, {
      lmax,
      maxAspectRatio,
      minVoxelHits,
      elementWidth,
    });

    // The grid mesh to auto-hide so it doesn't z-fight the LAD voxel result. In
    // new-triangulation mode that's the selected voxel box; in reuse mode it's
    // the box the reused triangulation's grid matches (if it's still around).
    const gridMeshId = reuseTri ? (reuseTri.gridMeshId ?? '') : (selectedGrid?.id ?? '');
    onStartLAD(request, selectedScans.map(s => s.color), gridMeshId);
    onClose();
  }, [reuseTri, selectedScans, selectedGrid, lmaxStr, maxAspectRatioStr, minVoxelHitsStr, elementWidthStr, onStartLAD, onClose]);

  if (!isOpen) return null;

  const totalPoints = selectedScans.reduce((sum, s) => sum + s.data!.pointCount, 0);
  const ineligibleScans = scans.filter(s => hasData(s) && !hasParams(s));
  const canCompute = selectedScans.length > 0 && (reuseTri != null || selectedGrid != null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div data-testid="lad-popup" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-2xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Grid3x3 className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Leaf Area Density Setup</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 transition-colors"
          >
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Triangulation source: run a new one, or reuse an existing Helios
              mesh (which locks the scans, grid, and lmax/aspect to reproduce its
              G-function). Only shown when reusable triangulations exist. */}
          {triangulationOptions.length > 0 && (
            <div>
              <label className="text-xs font-medium text-neutral-300 block mb-1">Triangulation</label>
              <select
                data-testid="lad-triangulation-select"
                value={reuseTriId}
                onChange={(e) => setReuseTriId(e.target.value)}
                className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
              >
                <option value="">Run a new triangulation</option>
                {triangulationOptions.map(t => (
                  <option key={t.id} value={t.id}>Reuse: {t.label}</option>
                ))}
              </select>
              {reuseTri && (
                <p className="text-[9px] text-neutral-500 mt-1" data-testid="lad-reuse-summary">
                  Reusing {reuseTri.label}: {reuseTri.scanIds.length} scan{reuseTri.scanIds.length > 1 ? 's' : ''},
                  grid {reuseTri.grid.nx}×{reuseTri.grid.ny}×{reuseTri.grid.nz},
                  Lmax {(reuseTri.lmax * 100).toFixed(1)} cm, aspect ≤ {reuseTri.maxAspectRatio}.
                  Scans, grid, and filter are locked to match this mesh.
                  {reuseScansMissing > 0 && (
                    <span className="text-amber-300"> {reuseScansMissing} source scan(s) no longer available.</span>
                  )}
                </p>
              )}
            </div>
          )}

          {/* Scan picker — only when running a NEW triangulation. When reusing,
              the scans are fixed by the mesh, so we hide the picker. */}
          {!reuseTri && (
          <>
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
              No scans have both point data and scan parameters. Attach parameters from the Scans panel first.
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
                  return (
                    <div
                      key={scan.id}
                      data-testid="lad-scan-row"
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
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{scan.params!.origin.x.toFixed(2)}</span>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{scan.params!.origin.y.toFixed(2)}</span>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{scan.params!.origin.z.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {ineligibleScans.length > 0 && (
            <div className="text-[10px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5">
              {ineligibleScans.length} scan(s) missing parameters and cannot be used.
              Add scan parameters from the Scans panel.
            </div>
          )}
          </>
          )}

          {/* Return type (read-only, derived from the selected scans) */}
          {selectedScans.length > 0 && (
            <div
              data-testid="lad-returntype-summary"
              className="text-[10px] text-neutral-400"
            >
              {returnTypes.size > 1 ? (
                <span className="text-amber-300">
                  Selected scans mix single- and multi-return; each is computed with its own return type.
                </span>
              ) : returnTypes.has('multi') ? (
                <span>Return type: <span className="text-neutral-200">multi-return</span> (full-waveform; beam params from scan parameters)</span>
              ) : (
                <span>Return type: <span className="text-neutral-200">single-return</span></span>
              )}
            </div>
          )}

          {/* Algorithm Parameters */}
          <div className="border-t border-neutral-700 pt-4">
            <label className="text-xs font-medium text-neutral-300 block mb-3">Parameters</label>

            <div className="grid grid-cols-3 gap-3">
              {/* Lmax + Aspect drive the G-function triangulation, so they're
                  locked when reusing an existing triangulation (the mesh already
                  fixes them). Hidden in reuse mode; the reuse summary shows them. */}
              {!reuseTri && (
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Max Edge Length (Lmax)
                </label>
                <input
                  data-testid="lad-input-lmax"
                  type="number"
                  value={lmaxStr}
                  onChange={(e) => setLmaxStr(e.target.value)}
                  step="0.01"
                  min="0.001"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">G-function triangulation</p>
              </div>
              )}

              {!reuseTri && (
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Max Aspect Ratio
                </label>
                <input
                  data-testid="lad-input-aspect"
                  type="number"
                  value={maxAspectRatioStr}
                  onChange={(e) => setMaxAspectRatioStr(e.target.value)}
                  step="0.5"
                  min="1"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Filters skinny triangles</p>
              </div>
              )}

              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Min Voxel Hits
                </label>
                <input
                  data-testid="lad-input-min-hits"
                  type="number"
                  value={minVoxelHitsStr}
                  onChange={(e) => setMinVoxelHitsStr(e.target.value)}
                  step="1"
                  min="1"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Skip sparse voxels</p>
              </div>
            </div>

            {/* Element width — drives the Pimont et al. (2018) sampling
                uncertainty reported alongside the LAD estimate. Presets set
                common values; the field stays editable. */}
            <div className="mt-4">
              <label className="text-[10px] text-neutral-400 block mb-1">
                Element width (m)
              </label>
              <div className="flex items-center gap-2">
                <input
                  data-testid="lad-input-element-width"
                  type="number"
                  value={elementWidthStr}
                  onChange={(e) => setElementWidthStr(e.target.value)}
                  step="0.01"
                  min="0"
                  className="w-28 px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <button
                  data-testid="lad-preset-broadleaf"
                  type="button"
                  onClick={() => setElementWidthStr('0.05')}
                  className="px-2 py-1 text-[10px] rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-700 transition-colors"
                >
                  Broadleaf (0.05)
                </button>
                <button
                  data-testid="lad-preset-conifer"
                  type="button"
                  onClick={() => setElementWidthStr('0.002')}
                  className="px-2 py-1 text-[10px] rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-700 transition-colors"
                >
                  Conifer (0.002)
                </button>
              </div>
              <p className="text-[9px] text-neutral-500 mt-0.5">
                Characteristic leaf/needle width. Sets the Pimont et al. (2018)
                sampling-uncertainty interval reported with the result.
              </p>
            </div>

            {/* Voxel grid — only when running a new triangulation. When reusing,
                the grid is fixed by the mesh (shown in the reuse summary above). */}
            {!reuseTri && (
            <>
            <label className="text-xs font-medium text-neutral-300 block mt-4 mb-1">Voxel Grid (required)</label>
            <p className="text-[9px] text-neutral-500 mb-2">
              LAD is computed per voxel, so an explicit voxel grid is the basis of
              the calculation. Use a voxel box from the viewer and set its
              subdivisions for the grid resolution.
            </p>
            {gridOptions.length === 0 ? (
              <div
                className="text-[10px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5"
                data-testid="lad-no-grid-warning"
              >
                No voxel grid available. Create a Voxel box in the viewer (Create
                Voxel) and set its subdivisions, then reopen this dialog.
              </div>
            ) : (
              <>
                <select
                  data-testid="lad-grid-select"
                  value={selectedGridId}
                  onChange={(e) => setSelectedGridId(e.target.value)}
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                >
                  {gridOptions.map(g => (
                    <option key={g.id} value={g.id}>{g.label}</option>
                  ))}
                </select>
                {selectedGrid && (
                  <p className="text-[9px] text-neutral-500 mt-1" data-testid="lad-grid-summary">
                    Grid: {selectedGrid.label} ({selectedGrid.grid.nx}×{selectedGrid.grid.ny}×{selectedGrid.grid.nz} voxels)
                  </p>
                )}
              </>
            )}
            </>
            )}
          </div>

          {error && (
            <div className="p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
              {error}
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
            data-testid="lad-compute-button"
            onClick={handleCompute}
            disabled={!canCompute}
            className={`px-4 py-2 text-xs rounded font-medium flex items-center gap-2 ${
              !canCompute
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-500 text-white'
            }`}
          >
            <Grid3x3 className="w-3.5 h-3.5" />
            Compute LAD
          </button>
        </div>
      </div>
    </div>
  );
}
