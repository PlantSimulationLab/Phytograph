import { useEffect, useMemo, useState } from 'react';
import { X, Radio } from 'lucide-react';
import {
  DEFAULT_SYNTHETIC_SCAN_OPTIONS,
  SYNTHETIC_SCAN_OPTIONS_STORE_KEY,
  coerceSyntheticScanOptions,
  type SyntheticScanOptions,
} from '../lib/syntheticScanOptions';
import { scanDisplayName, type Scan } from '../lib/scan';
import { DebouncedNumberInput } from './DebouncedNumberInput';

interface SyntheticScanOptionsPopupProps {
  isOpen: boolean;
  onClose: () => void;
  // Called with the chosen options + the IDs of the scan positions to run when
  // the user confirms. The caller proceeds with the scan (and its
  // overwrite-confirm flow) from here, restricted to those scanners.
  onRun: (options: SyntheticScanOptions, scannerIds: string[]) => void;
  // Candidate scan positions (every scan with scanner parameters, regardless of
  // visibility/selection). Each can be toggled off so the run only ray-traces
  // the chosen subset.
  scanners: Scan[];
  // Whether the scene has at least one visible scannable mesh to ray-trace.
  // When false the modal still opens (so you can review positions/options) but
  // explains the missing geometry and keeps Run disabled.
  hasGeometry: boolean;
  // Whether any active scanner is multi-return — gates the full-waveform fields.
  hasMultiReturn: boolean;
  // Whether exactly one voxel grid is visible — gates the crop-to-grid toggle.
  gridAvailable: boolean;
}

// Pre-run dialog for the run-time options of a synthetic LiDAR scan (noise,
// misses, full-waveform tuning, crop-to-grid). Distinct from the Add/Edit Scan
// popup, which edits a scan's persistent PROPERTIES. Last-used options are
// remembered in the electron store and pre-filled on open.
export function SyntheticScanOptionsPopup({
  isOpen,
  onClose,
  onRun,
  scanners,
  hasGeometry,
  hasMultiReturn,
  gridAvailable,
}: SyntheticScanOptionsPopupProps) {
  const [opts, setOpts] = useState<SyntheticScanOptions>(DEFAULT_SYNTHETIC_SCAN_OPTIONS);
  // Which scan positions to ray-trace. Defaults to all; reset whenever the
  // popup opens (the candidate set can change between runs).
  const [selectedScannerIds, setSelectedScannerIds] = useState<Set<string>>(new Set());

  // Load the remembered options each time the popup opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void window.electronAPI.store
      .get(SYNTHETIC_SCAN_OPTIONS_STORE_KEY)
      .then((stored) => {
        if (!cancelled) setOpts(coerceSyntheticScanOptions(stored));
      })
      .catch(() => {
        if (!cancelled) setOpts({ ...DEFAULT_SYNTHETIC_SCAN_OPTIONS });
      });
    return () => { cancelled = true; };
  }, [isOpen]);

  // Seed the scan-position selection (all on) each time the popup opens.
  useEffect(() => {
    if (!isOpen) return;
    setSelectedScannerIds(new Set(scanners.map(s => s.id)));
    // Keyed on isOpen only: re-seeding on every `scanners` identity change would
    // clobber the user's toggles mid-session. The candidate set is fixed for the
    // lifetime of one open popup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Only count selections that still correspond to a candidate scanner.
  // NOTE: this hook must run on every render, so it lives ABOVE the
  // `if (!isOpen) return null` early return — putting a hook after a
  // conditional return violates the Rules of Hooks and crashes the component
  // the first time `isOpen` flips.
  const selectedCount = useMemo(
    () => scanners.reduce((n, s) => n + (selectedScannerIds.has(s.id) ? 1 : 0), 0),
    [scanners, selectedScannerIds],
  );

  if (!isOpen) return null;

  // DebouncedNumberInput owns each field's text draft and only commits finite
  // values, so clearing the field to retype works (no snap-back to the min).
  // Clamping to the min happens on the committed value inside the component.
  const setNum = (key: 'rangeNoiseMm' | 'angleNoiseMrad' | 'pulseDistanceThresholdM') =>
    (v: number) => {
      setOpts(o => ({ ...o, [key]: v }));
    };

  const setRays = (v: number) => {
    setOpts(o => ({ ...o, raysPerPulse: v }));
  };

  const toggleScanner = (id: string) =>
    setSelectedScannerIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const selectAllScanners = () => setSelectedScannerIds(new Set(scanners.map(s => s.id)));
  const deselectAllScanners = () => setSelectedScannerIds(new Set());

  const handleRun = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasGeometry) return;  // guarded by the disabled Run button too
    const scannerIds = scanners.filter(s => selectedScannerIds.has(s.id)).map(s => s.id);
    if (scannerIds.length === 0) return;  // guarded by the disabled Run button too
    // crop-to-grid can't apply without exactly one visible grid — never persist
    // or send it set in that case.
    const finalOpts: SyntheticScanOptions = {
      ...opts,
      cropToGrid: opts.cropToGrid && gridAvailable,
    };
    void window.electronAPI.store.set(SYNTHETIC_SCAN_OPTIONS_STORE_KEY, finalOpts);
    onRun(finalOpts, scannerIds);
  };

  const inputCls =
    'w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        data-testid="synthetic-scan-options-popup"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-md mx-4 overflow-hidden max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Radio className="w-5 h-5 text-neutral-400" />
            <h2 className="text-lg font-semibold text-white">Synthetic Scan Options</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-neutral-400" />
          </button>
        </div>

        <form onSubmit={handleRun} className="p-4 space-y-4 overflow-y-auto">
          {/* Missing-geometry notice — the modal opens even with nothing to
              scan (e.g. just-loaded scanner positions) so you can review the
              positions and options, but a scan can't run without a mesh. */}
          {!hasGeometry && (
            <div
              data-testid="scan-opt-no-geometry"
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300"
            >
              No scannable geometry in the scene — add a plant or import a mesh
              (and make it visible) to run a scan. You can still review your scan
              positions and options below.
            </div>
          )}

          {/* Scan positions — each scanner can be toggled off so the run only
              ray-traces the chosen subset (mirrors the triangulation / LAD
              source pickers). */}
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-neutral-300">Scan positions</label>
                <span className="text-[10px] text-neutral-500">
                  ({selectedCount}/{scanners.length} selected)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAllScanners}
                  className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                  All
                </button>
                <span className="text-neutral-600 text-[10px]">|</span>
                <button
                  type="button"
                  onClick={deselectAllScanners}
                  className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                  None
                </button>
              </div>
            </div>

            <div className="mt-1.5 border border-neutral-700 rounded-lg overflow-hidden">
              <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 px-3 py-2 bg-neutral-900/80 border-b border-neutral-700 items-center">
                <div className="w-4" />
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider">Scanner</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-14 text-center">X</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-14 text-center">Y</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-14 text-center">Z</span>
              </div>
              <div className="max-h-[28vh] overflow-y-auto">
                {scanners.map(scan => {
                  const isSelected = selectedScannerIds.has(scan.id);
                  const origin = scan.params?.origin;
                  return (
                    <label
                      key={scan.id}
                      data-testid="scan-opt-scanner-row"
                      data-scan-id={scan.id}
                      className={`grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 px-3 py-2 items-center border-b border-neutral-700/50 cursor-pointer transition-colors ${
                        isSelected ? 'bg-neutral-700/30' : 'bg-neutral-800/50 opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleScanner(scan.id)}
                        className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                      />
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: scan.color }} />
                        <span className="text-xs text-white truncate" title={scanDisplayName(scan)}>
                          {scanDisplayName(scan)}
                        </span>
                      </div>
                      <span className="w-14 px-1 py-1 text-[11px] text-neutral-300 text-center font-mono">{origin ? origin.x.toFixed(2) : '—'}</span>
                      <span className="w-14 px-1 py-1 text-[11px] text-neutral-300 text-center font-mono">{origin ? origin.y.toFixed(2) : '—'}</span>
                      <span className="w-14 px-1 py-1 text-[11px] text-neutral-300 text-center font-mono">{origin ? origin.z.toFixed(2) : '—'}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            {selectedCount === 0 && (
              <p className="mt-1 text-[11px] text-amber-300">
                Select at least one scan position to run.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              Measurement noise
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Range (mm)</label>
                <DebouncedNumberInput
                  data-testid="scan-opt-range-noise"
                  min={0}
                  step="any"
                  debounceMs={0}
                  value={opts.rangeNoiseMm}
                  onCommit={setNum('rangeNoiseMm')}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Angle (mrad)</label>
                <DebouncedNumberInput
                  data-testid="scan-opt-angle-noise"
                  min={0}
                  step="any"
                  debounceMs={0}
                  value={opts.angleNoiseMrad}
                  onCommit={setNum('angleNoiseMrad')}
                  className={inputCls}
                />
              </div>
            </div>
            <p className="mt-1 text-[11px] text-neutral-500">
              Gaussian noise added during ray-tracing. 0 = ideal. Range noise displaces hits
              along the beam; angle noise jitters the beam direction.
            </p>
          </div>

          <label
            data-testid="scan-opt-include-misses"
            className="flex items-center gap-2 cursor-pointer select-none"
          >
            <input
              type="checkbox"
              checked={opts.includeMisses}
              onChange={(e) => setOpts(o => ({ ...o, includeMisses: e.target.checked }))}
              className="w-4 h-4 accent-blue-600"
            />
            <span className="text-sm text-neutral-300">Include sky / miss points</span>
          </label>

          <div>
            <label
              data-testid="scan-opt-crop-grid"
              className={`flex items-center gap-2 select-none ${gridAvailable ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
            >
              <input
                type="checkbox"
                disabled={!gridAvailable}
                checked={opts.cropToGrid && gridAvailable}
                onChange={(e) => setOpts(o => ({ ...o, cropToGrid: e.target.checked }))}
                className="w-4 h-4 accent-blue-600"
              />
              <span className="text-sm text-neutral-300">Crop scan to grid</span>
            </label>
            {!gridAvailable && (
              <p className="mt-1 text-[11px] text-neutral-500">
                Needs exactly one visible voxel grid to bound the scan.
              </p>
            )}
          </div>

          {hasMultiReturn && (
            <div data-testid="scan-opt-waveform-fields" className="border border-neutral-700 rounded-lg p-3 space-y-3 bg-neutral-800/50">
              <p className="text-xs text-neutral-400">Full-waveform (multi-return)</p>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Rays per pulse</label>
                <DebouncedNumberInput
                  data-testid="scan-opt-rays-per-pulse"
                  min={1}
                  step={1}
                  debounceMs={0}
                  parse={(s) => parseInt(s, 10)}
                  value={opts.raysPerPulse}
                  onCommit={setRays}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Pulse distance threshold (m)</label>
                <DebouncedNumberInput
                  data-testid="scan-opt-pulse-threshold"
                  min={0}
                  step="any"
                  debounceMs={0}
                  value={opts.pulseDistanceThresholdM}
                  onCommit={setNum('pulseDistanceThresholdM')}
                  className={inputCls}
                />
              </div>
            </div>
          )}

          <button
            data-testid="scan-opt-run"
            type="submit"
            disabled={selectedCount === 0 || !hasGeometry}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors"
          >
            <Radio className="w-4 h-4" />
            {!hasGeometry
              ? 'Add geometry to scan'
              : selectedCount > 0
                ? `Run scan (${selectedCount} position${selectedCount === 1 ? '' : 's'})`
                : 'Run scan'}
          </button>
        </form>
      </div>
    </div>
  );
}
