import { useState, useCallback, useMemo, useEffect } from 'react';
import { X, Triangle } from 'lucide-react';
import { HeliosTriangulationRequest } from '../utils/backendApi';
import type { Scan } from '../lib/scan';
import { hasData, hasParams } from '../lib/scan';

interface HeliosTriangulationPopupProps {
  isOpen: boolean;
  onClose: () => void;
  onStartTriangulate: (request: HeliosTriangulationRequest) => void;
  scans: Scan[];
  initialSelectedIds?: Set<string>;
  onOpenScanParams?: (scanId: string) => void;
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
}: HeliosTriangulationPopupProps) {
  const eligible = useMemo(() => scans.filter(s => hasData(s) && hasParams(s)), [scans]);
  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());

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
  const [thetaMinStr, setThetaMinStr] = useState('30');
  const [thetaMaxStr, setThetaMaxStr] = useState('130');
  const [phiMinStr, setPhiMinStr] = useState('0');
  const [phiMaxStr, setPhiMaxStr] = useState('360');
  const [error, setError] = useState<string | null>(null);

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

  const handleTriangulate = useCallback(() => {
    setError(null);

    if (selectedScans.length === 0) {
      setError('Select at least one scan');
      return;
    }

    // Assemble HeliosScanEntry[] directly from each scan's data + params.
    // Prefer sending the source file path so the backend reads bytes from
    // disk; fall back to serialising every point if the path wasn't tracked.
    const requestScans = selectedScans.map(scan => {
      const origin = [scan.params.origin.x, scan.params.origin.y, scan.params.origin.z];
      if (scan.sourcePath) {
        // Pass the known column format so the backend uses it instead of the
        // column-count heuristic, which can mis-map e.g. reflectance vs
        // intensity or RGB ordering. Octree scans always have a sourcePath.
        return { file_path: scan.sourcePath, ascii_format: scan.asciiFormat ?? null, origin };
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
      return { points, origin };
    });

    const lmax = parseFloat(lmaxStr) || 0.1;
    const maxAspectRatio = parseFloat(maxAspectRatioStr) || 4.0;
    const thetaMin = parseFloat(thetaMinStr) || 0;
    const thetaMax = parseFloat(thetaMaxStr) || 130;
    const phiMin = parseFloat(phiMinStr) || 0;
    const phiMax = parseFloat(phiMaxStr) || 360;

    const request: HeliosTriangulationRequest = {
      scans: requestScans,
      lmax,
      max_aspect_ratio: maxAspectRatio,
      theta_min: thetaMin,
      theta_max: thetaMax,
      phi_min: phiMin,
      phi_max: phiMax,
    };

    onStartTriangulate(request);
    onClose();
  }, [selectedScans, lmaxStr, maxAspectRatioStr, thetaMinStr, thetaMaxStr, phiMinStr, phiMaxStr, onStartTriangulate, onClose]);

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
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Max Edge Length (Lmax)
                </label>
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

            <label className="text-xs font-medium text-neutral-300 block mt-4 mb-3">Scan Angular Bounds</label>

            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">Theta Min</label>
                <input
                  type="number"
                  value={thetaMinStr}
                  onChange={(e) => setThetaMinStr(e.target.value)}
                  step="1"
                  min="0"
                  max="180"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Zenith min (deg)</p>
              </div>
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">Theta Max</label>
                <input
                  type="number"
                  value={thetaMaxStr}
                  onChange={(e) => setThetaMaxStr(e.target.value)}
                  step="1"
                  min="0"
                  max="180"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Zenith max (deg)</p>
              </div>
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">Phi Min</label>
                <input
                  type="number"
                  value={phiMinStr}
                  onChange={(e) => setPhiMinStr(e.target.value)}
                  step="1"
                  min="0"
                  max="360"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Azimuth min (deg)</p>
              </div>
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">Phi Max</label>
                <input
                  type="number"
                  value={phiMaxStr}
                  onChange={(e) => setPhiMaxStr(e.target.value)}
                  step="1"
                  min="0"
                  max="360"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Azimuth max (deg)</p>
              </div>
            </div>
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
