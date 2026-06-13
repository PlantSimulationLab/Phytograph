import { useEffect, useState } from 'react';
import { X, Radio } from 'lucide-react';
import {
  DEFAULT_SYNTHETIC_SCAN_OPTIONS,
  SYNTHETIC_SCAN_OPTIONS_STORE_KEY,
  coerceSyntheticScanOptions,
  type SyntheticScanOptions,
} from '../lib/syntheticScanOptions';
import { DebouncedNumberInput } from './DebouncedNumberInput';

interface SyntheticScanOptionsPopupProps {
  isOpen: boolean;
  onClose: () => void;
  // Called with the chosen options when the user confirms the run. The caller
  // proceeds with the scan (and its overwrite-confirm flow) from here.
  onRun: (options: SyntheticScanOptions) => void;
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
  hasMultiReturn,
  gridAvailable,
}: SyntheticScanOptionsPopupProps) {
  const [opts, setOpts] = useState<SyntheticScanOptions>(DEFAULT_SYNTHETIC_SCAN_OPTIONS);

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

  const handleRun = (e: React.FormEvent) => {
    e.preventDefault();
    // crop-to-grid can't apply without exactly one visible grid — never persist
    // or send it set in that case.
    const finalOpts: SyntheticScanOptions = {
      ...opts,
      cropToGrid: opts.cropToGrid && gridAvailable,
    };
    void window.electronAPI.store.set(SYNTHETIC_SCAN_OPTIONS_STORE_KEY, finalOpts);
    onRun(finalOpts);
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
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-white font-medium transition-colors"
          >
            <Radio className="w-4 h-4" />
            Run scan
          </button>
        </form>
      </div>
    </div>
  );
}
