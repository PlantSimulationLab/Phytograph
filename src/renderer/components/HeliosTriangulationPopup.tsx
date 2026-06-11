import { useState, useCallback, useMemo, useEffect } from 'react';
import { X, Triangle, Wand2, Loader2, AlertTriangle } from 'lucide-react';
import {
  HeliosTriangulationRequest,
  HeliosScanEntry,
  HeliosGrid,
  HeliosSuggestResponse,
  suggestHeliosLmax,
} from '../utils/backendApi';
import type { Scan } from '../lib/scan';
import { hasData, hasParams } from '../lib/scan';

// A voxel box the user can pick as the triangulation grid. The caller derives
// `grid` from the box's transform + subdivisions (see voxelMeshToHeliosGrid).
export interface GridOption {
  id: string;
  label: string;
  grid: HeliosGrid;
}

interface HeliosTriangulationPopupProps {
  isOpen: boolean;
  onClose: () => void;
  // `scanColors` is aligned 1:1 with `request.scans` (same order), so the
  // caller can map each triangle's scan index back to a display color.
  onStartTriangulate: (request: HeliosTriangulationRequest, scanColors: string[]) => void;
  scans: Scan[];
  initialSelectedIds?: Set<string>;
  onOpenScanParams?: (scanId: string) => void;
  // Voxel boxes available to use as the triangulation grid. Empty → the
  // backend auto-creates a single-cell grid over all points (with a warning).
  gridOptions?: GridOption[];
}

// Every scan listed here must have both point data (positions to triangulate)
// and scan parameters (the scanner origin needed to reconstruct per-pulse
// directions). The unified Scans panel is what attaches those — this popup
// is read-only on per-scan geometry and only edits the algorithm parameters.
export function HeliosTriangulationPopup({
  isOpen,
  onClose,
  onStartTriangulate,
  scans,
  initialSelectedIds,
  onOpenScanParams,
  gridOptions = [],
}: HeliosTriangulationPopupProps) {
  const eligible = useMemo(() => scans.filter(s => hasData(s) && hasParams(s)), [scans]);
  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());

  // Which voxel box (if any) drives the grid. Empty string = auto-grid (all
  // points). Default to the first available box so a created box is used.
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
        // Restrict to scans that are actually eligible for Helios.
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
  const [error, setError] = useState<string | null>(null);
  // Lmax suggestion (Otsu separability) state. Cleared whenever the scan
  // selection or grid changes, since the suggestion is specific to that input.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<HeliosSuggestResponse | null>(null);

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
  // Shared by Triangulate and the Lmax suggestion so both analyse identical input.
  // Prefer the source file path (backend reads bytes from disk); fall back to
  // serialising every point. Each scan carries its own acquisition geometry so
  // Helios triangulates it in the grid it was actually sampled in.
  const buildRequest = useCallback((lmax: number, maxAspectRatio: number): HeliosTriangulationRequest => {
    const requestScans: HeliosScanEntry[] = selectedScans.map(scan => {
      const p = scan.params;
      const angular = {
        origin: [p.origin.x, p.origin.y, p.origin.z],
        n_theta: p.zenithPoints,
        n_phi: p.azimuthPoints,
        theta_min: p.zenithMinDeg,
        theta_max: p.zenithMaxDeg,
        phi_min: p.azimuthMinDeg,
        phi_max: p.azimuthMaxDeg,
      };
      if (scan.sourcePath) {
        return { file_path: scan.sourcePath, ascii_format: scan.asciiFormat ?? null, ...angular };
      }
      const points: number[][] = [];
      for (let i = 0; i < scan.data.pointCount; i++) {
        const idx = i * 3;
        points.push([
          scan.data.positions[idx],
          scan.data.positions[idx + 1],
          scan.data.positions[idx + 2],
        ]);
      }
      return { points, ...angular };
    });

    return {
      scans: requestScans,
      lmax,
      max_aspect_ratio: maxAspectRatio,
      // Request-level angles are backend-only fallbacks; per-scan values above
      // take precedence. Sensible defaults for any scan lacking its own.
      theta_min: 30,
      theta_max: 130,
      phi_min: 0,
      phi_max: 360,
      ...(selectedGrid ? { grid: selectedGrid.grid } : {}),
    };
  }, [selectedScans, selectedGrid]);

  // Ask the backend to suggest Lmax from the candidate edge-length distribution
  // (Otsu separability) and flag merged multi-scan clouds. Applies the suggestion
  // to the Lmax field and surfaces the confidence + any warning.
  const handleSuggest = useCallback(async () => {
    setError(null);
    if (selectedScans.length === 0) {
      setError('Select at least one scan');
      return;
    }
    setSuggesting(true);
    setSuggestion(null);
    try {
      // lmax / aspect are ignored by the suggest endpoint (placeholders).
      const result = await suggestHeliosLmax(buildRequest(0.1, 4.0));
      if (!result.success) {
        setError(result.error || 'Could not compute a suggestion for this data.');
        return;
      }
      setSuggestion(result);
      setLmaxStr(result.suggested_lmax.toPrecision(3));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Suggestion request failed.');
    } finally {
      setSuggesting(false);
    }
  }, [selectedScans, buildRequest]);

  const handleTriangulate = useCallback(() => {
    setError(null);
    if (selectedScans.length === 0) {
      setError('Select at least one scan');
      return;
    }
    const lmax = parseFloat(lmaxStr) || 0.1;
    const maxAspectRatio = parseFloat(maxAspectRatioStr) || 4.0;
    const request = buildRequest(lmax, maxAspectRatio);
    // Scan colors in the same order as request.scans, so triangle_scan_ids
    // (which index into request.scans) map straight to a display color.
    const scanColors = selectedScans.map(s => s.color);
    onStartTriangulate(request, scanColors);
    onClose();
  }, [selectedScans, lmaxStr, maxAspectRatioStr, buildRequest, onStartTriangulate, onClose]);

  // The suggestion is specific to the selected scans + grid; drop it when those change.
  useEffect(() => {
    setSuggestion(null);
  }, [selectedScanIds, selectedGridId]);

  if (!isOpen) return null;

  const totalPoints = selectedScans.reduce((sum, s) => sum + s.data.pointCount, 0);
  const ineligibleScans = scans.filter(s => hasData(s) && !hasParams(s));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div data-testid="helios-triangulation-popup" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-2xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Triangle className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Helios Triangulation Setup</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 transition-colors"
          >
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
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
              <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-2 px-3 py-2 bg-neutral-900/80 border-b border-neutral-700 items-center">
                <div className="w-4" />
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider">Scan</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-16 text-center">X</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-16 text-center">Y</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-16 text-center">Z</span>
                <span className="w-12" />
              </div>

              <div className="max-h-[35vh] overflow-y-auto">
                {eligible.map(scan => {
                  const isSelected = selectedScanIds.has(scan.id);
                  const fileName = scan.label || scan.data.fileName || 'Unnamed';
                  return (
                    <div
                      key={scan.id}
                      data-testid="helios-scan-row"
                      data-scan-id={scan.id}
                      className={`grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-2 px-3 py-2 items-center border-b border-neutral-700/50 transition-colors ${
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
                          {scan.data.pointCount.toLocaleString()} pts
                        </span>
                      </div>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{scan.params.origin.x.toFixed(2)}</span>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{scan.params.origin.y.toFixed(2)}</span>
                      <span className="w-16 px-1.5 py-1 text-[11px] text-neutral-300 text-center font-mono">{scan.params.origin.z.toFixed(2)}</span>
                      {onOpenScanParams ? (
                        <button
                          onClick={() => onOpenScanParams(scan.id)}
                          className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors w-12 text-right"
                          title="Edit scan parameters"
                        >
                          Edit…
                        </button>
                      ) : (
                        <div className="w-12" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Scans with data but no params can't participate. List them so the
              user knows what to fix from the Scans panel. */}
          {ineligibleScans.length > 0 && (
            <div className="text-[10px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5">
              {ineligibleScans.length} scan(s) missing parameters and cannot be triangulated.
              Add scan parameters from the Scans panel.
            </div>
          )}

          {/* Algorithm Parameters */}
          <div className="border-t border-neutral-700 pt-4">
            <label className="text-xs font-medium text-neutral-300 block mb-3">Parameters</label>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] text-neutral-400">
                    Max Edge Length (Lmax)
                  </label>
                  <button
                    data-testid="helios-suggest-button"
                    onClick={handleSuggest}
                    disabled={suggesting || selectedScans.length === 0}
                    title="Estimate Lmax from the candidate edge-length distribution"
                    className={`flex items-center gap-1 text-[10px] transition-colors ${
                      suggesting || selectedScans.length === 0
                        ? 'text-neutral-600 cursor-not-allowed'
                        : 'text-green-400 hover:text-green-300'
                    }`}
                  >
                    {suggesting
                      ? <><Loader2 className="w-3 h-3 animate-spin" /> Analyzing…</>
                      : <><Wand2 className="w-3 h-3" /> Suggest</>}
                  </button>
                </div>
                <input
                  data-testid="helios-input-lmax"
                  type="number"
                  value={lmaxStr}
                  onChange={(e) => setLmaxStr(e.target.value)}
                  step="0.01"
                  min="0.001"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Filters large triangles</p>
              </div>

              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Max Aspect Ratio
                </label>
                <input
                  data-testid="helios-input-aspect"
                  type="number"
                  value={maxAspectRatioStr}
                  onChange={(e) => setMaxAspectRatioStr(e.target.value)}
                  step="0.5"
                  min="1"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Filters skinny triangles</p>
              </div>
            </div>

            {/* Lmax suggestion result: confidence (Otsu separability) + the merged-
                multi-scan-cloud guard. Confidence reflects how cleanly the intra-leaf
                and inter-leaf edge scales separate; it is independent of the merged
                warning (a merged cloud can still score high). */}
            {suggestion && (
              <div data-testid="helios-suggestion-result" className="mt-3 space-y-2">
                <div
                  className={`rounded px-2.5 py-2 border text-[10px] ${
                    suggestion.confidence_label === 'High'
                      ? 'bg-green-500/5 border-green-500/30 text-green-200'
                      : suggestion.confidence_label === 'Medium'
                      ? 'bg-amber-500/5 border-amber-500/30 text-amber-200'
                      : 'bg-red-500/5 border-red-500/30 text-red-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      Applied Lmax {(suggestion.suggested_lmax * 100).toFixed(1)} cm
                    </span>
                    <span data-testid="helios-suggestion-confidence">
                      Separation: {suggestion.confidence_label} (η {suggestion.confidence.toFixed(2)})
                    </span>
                  </div>
                  <p className="text-neutral-400 mt-1">
                    From {suggestion.candidate_count.toLocaleString()} candidate triangles;
                    {' '}{Math.round(suggestion.drop_fraction * 100)}% filtered at this Lmax.
                    {suggestion.confidence_label !== 'High' &&
                      ' Low separation — the leaf and gap scales overlap, so the result is sensitive to Lmax; review the mesh.'}
                  </p>
                </div>
                {suggestion.merged_warning && (
                  <div
                    data-testid="helios-merged-warning"
                    className="flex gap-1.5 rounded px-2.5 py-2 border bg-amber-500/10 border-amber-500/40 text-[10px] text-amber-200"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>{suggestion.merged_message}</span>
                  </div>
                )}
              </div>
            )}

            {/* Per-scan angular bounds (Ntheta/Nphi, theta/phi) come from each
                scan's own parameters — edit them per scan via the Scans panel,
                not here. */}

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
            data-testid="helios-triangulate-button"
            onClick={handleTriangulate}
            disabled={selectedScans.length === 0}
            className={`px-4 py-2 text-xs rounded font-medium flex items-center gap-2 ${
              selectedScans.length === 0
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-500 text-white'
            }`}
          >
            <Triangle className="w-3.5 h-3.5" />
            Triangulate
          </button>
        </div>
      </div>
    </div>
  );
}
