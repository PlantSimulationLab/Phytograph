import { useState, useCallback, useMemo, useEffect } from 'react';
import { X } from 'lucide-react';
import type { Scan } from '../lib/scan';
import { hasData } from '../lib/scan';
import { QsmIcon } from './icons/QsmIcon';

export interface QSMStartOptions {
  // Fuse all selected scans into ONE QSM (multi-view of a single, pre-aligned
  // tree) vs build one QSM per scan. Only meaningful for >1 scan.
  aggregate: boolean;
  twigRadiusMm: number;
}

interface QSMPopupProps {
  isOpen: boolean;
  onClose: () => void;
  // Fires when the user clicks Build. `opts` carries the multi-scan mode and the
  // twig-radius anchor.
  onStart: (scanIds: string[], opts: QSMStartOptions) => void;
  scans: Scan[];
  initialSelectedIds?: Set<string>;
  // True while a QSM build is running — disables Build so a second can't be fired.
  inProgress?: boolean;
  error?: string | null;
}

// Decide which eligible-scan ids to check when the modal opens. Mirrors
// seedBackfillSelection / TriangulationPopup:
//   - no incoming    → opened with nothing selected, so default to all eligible.
//   - incoming given → honor it, intersected with eligibility (may be EMPTY when
//     the selected scans aren't eligible — intentional, so we never silently
//     check a different, unselected scan).
// Computed FRESH from `incoming` on every open, so reopening with a different
// Scans-panel selection picks it up.
export function seedQSMSelection(
  eligibleIds: string[],
  incoming: Set<string>,
): Set<string> {
  const eligibleSet = new Set(eligibleIds);
  if (incoming.size === 0) {
    return new Set(eligibleIds);
  }
  return new Set([...incoming].filter(id => eligibleSet.has(id)));
}

// QSM build setup. Models BackfillMissesPopup / TriangulationPopup: a scan picker
// that auto-selects from the current Scans-panel selection, plus the QSM-specific
// controls (multi-scan mode + twig radius). QSM needs point data, so every scan
// with data is eligible.
export function QSMPopup({
  isOpen,
  onClose,
  onStart,
  scans,
  initialSelectedIds,
  inProgress = false,
  error = null,
}: QSMPopupProps) {
  const eligible = useMemo(() => scans.filter(s => hasData(s)), [scans]);

  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());
  // Multi-scan mode: fuse multi-view scans of one tree, or one QSM per scan. Only
  // surfaced when >1 scan is selected (a single selection always builds one QSM).
  const [multiMode, setMultiMode] = useState<'aggregate' | 'per-scan'>('aggregate');
  const [twigRadiusMm, setTwigRadiusMm] = useState(4.23);

  // Re-seed from the live Scans-panel selection every time the modal opens (like
  // LADPopup / BackfillMissesPopup). Depending only on `isOpen` — not `eligible` —
  // means a previous session's selection is never carried over.
  useEffect(() => {
    if (!isOpen) return;
    setSelectedScanIds(seedQSMSelection(
      eligible.map(s => s.id), initialSelectedIds ?? new Set<string>()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const selectedScans = useMemo(
    () => eligible.filter(s => selectedScanIds.has(s.id)),
    [eligible, selectedScanIds],
  );

  const totalPoints = useMemo(
    () => selectedScans.reduce((sum, s) => sum + (s.data?.pointCount ?? 0), 0),
    [selectedScans],
  );

  const toggleScan = useCallback((id: string) => {
    setSelectedScanIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const selectAll = useCallback(() => setSelectedScanIds(new Set(eligible.map(s => s.id))), [eligible]);
  const deselectAll = useCallback(() => setSelectedScanIds(new Set()), []);

  const multi = selectedScans.length > 1;
  const aggregate = multi && multiMode === 'aggregate';

  const handleRun = useCallback(() => {
    if (selectedScans.length === 0) return;
    onStart(selectedScans.map(s => s.id), { aggregate, twigRadiusMm });
    onClose();
  }, [selectedScans, aggregate, twigRadiusMm, onStart, onClose]);

  if (!isOpen) return null;

  // Button label preserves the wording the inline panel used (and the E2E batch
  // test asserts): "Build 1 QSM from N scans" (aggregate) / "Build QSM (N scans)"
  // (per-scan) / "Build QSM" (single).
  const buildLabel = inProgress
    ? 'Building…'
    : multi
      ? (aggregate
          ? `Build 1 QSM from ${selectedScans.length} scans`
          : `Build ${selectedScans.length} QSMs from ${selectedScans.length} scans`)
      : 'Build QSM';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div data-testid="qsm-panel" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-2xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <QsmIcon className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Build QSM</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-[10px] text-neutral-500">
            Reconstruct the tree as connected cylinders with radii, segment continuous
            shoots, and classify them by shoot rank (trunk = 0, scaffolds = 1, …).
            Best on dormant (leaf-off) scans.
          </p>

          {/* Select controls + count */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-neutral-300">Scans</label>
              <span className="text-[10px] text-neutral-500">
                ({selectedScanIds.size}/{eligible.length} selected)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={selectAll} className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors">All</button>
              <span className="text-neutral-600 text-[10px]">|</span>
              <button onClick={deselectAll} className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors">None</button>
            </div>
          </div>

          {eligible.length === 0 ? (
            <div className="p-4 text-center text-xs text-neutral-500" data-testid="qsm-none-eligible">
              No scan has point data to build a QSM from. Import a point cloud first.
            </div>
          ) : (
            <div className="border border-neutral-700 rounded-lg overflow-hidden">
              <div className="grid grid-cols-[auto_1fr] gap-2 px-3 py-2 bg-neutral-900/80 border-b border-neutral-700 items-center">
                <div className="w-4" />
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider">Scan</span>
              </div>
              <div className="max-h-[35vh] overflow-y-auto">
                {eligible.map(scan => {
                  const isSelected = selectedScanIds.has(scan.id);
                  const fileName = scan.label || scan.data!.fileName || 'Unnamed';
                  return (
                    <div
                      key={scan.id}
                      data-testid="qsm-scan-row"
                      data-scan-id={scan.id}
                      data-selected={isSelected}
                      className={`grid grid-cols-[auto_1fr] gap-2 px-3 py-2 items-center border-b border-neutral-700/50 transition-colors ${
                        isSelected ? 'bg-neutral-700/30' : 'bg-neutral-800/50 opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleScan(scan.id)}
                        className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-amber-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                      />
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: scan.color }} />
                        <span className="text-xs text-white truncate" title={fileName}>{fileName}</span>
                        <span className="text-[9px] text-neutral-500 flex-shrink-0">
                          {scan.data!.pointCount.toLocaleString()} pts
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Multi-scan mode: fuse multi-view scans of one tree, or one QSM per
              scan. Only shown when >1 scan is selected. */}
          {multi && (
            <div data-testid="qsm-multi-mode" className="border-t border-neutral-700 pt-4">
              <div className="text-[10px] text-neutral-400 mb-2">
                {selectedScans.length} scans selected
              </div>
              <label className="flex items-start gap-2 mb-1.5 cursor-pointer">
                <input
                  data-testid="qsm-mode-aggregate"
                  type="radio"
                  name="qsm-multi-mode"
                  checked={multiMode === 'aggregate'}
                  onChange={() => setMultiMode('aggregate')}
                  disabled={inProgress}
                  className="mt-0.5 accent-amber-500"
                />
                <span className="text-[10px] text-neutral-300 leading-snug">
                  One QSM from all scans
                  <span className="block text-neutral-500">
                    Fuse multiple views of a single tree (must be pre-aligned).
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  data-testid="qsm-mode-per-scan"
                  type="radio"
                  name="qsm-multi-mode"
                  checked={multiMode === 'per-scan'}
                  onChange={() => setMultiMode('per-scan')}
                  disabled={inProgress}
                  className="mt-0.5 accent-amber-500"
                />
                <span className="text-[10px] text-neutral-300 leading-snug">
                  One QSM per scan
                  <span className="block text-neutral-500">
                    Build a separate QSM for each scan, in sequence.
                  </span>
                </span>
              </label>
            </div>
          )}

          {/* Twig radius anchor */}
          <div className="border-t border-neutral-700 pt-4">
            <label className="block text-[10px] text-neutral-400 mb-1">
              Twig radius: {twigRadiusMm.toFixed(2)} mm
            </label>
            <input
              data-testid="qsm-twig-radius"
              type="range"
              min={1}
              max={15}
              step={0.1}
              value={twigRadiusMm}
              onChange={(e) => setTwigRadiusMm(parseFloat(e.target.value))}
              disabled={inProgress}
              className="w-full accent-amber-500"
            />
            <div className="text-[9px] text-neutral-500 mt-1">
              Per-species twig diameter the radius taper is anchored to at the tips.
            </div>
          </div>

          {error && (
            <div data-testid="qsm-error" className="p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
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
            data-testid="qsm-build-button"
            onClick={handleRun}
            disabled={selectedScans.length === 0 || inProgress}
            className={`px-4 py-2 text-xs rounded font-medium flex items-center gap-2 ${
              selectedScans.length === 0 || inProgress
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-amber-600 hover:bg-amber-500 text-white'
            }`}
          >
            <QsmIcon className="w-3.5 h-3.5" />
            {buildLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
