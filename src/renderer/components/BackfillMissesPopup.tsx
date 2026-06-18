import { useState, useCallback, useMemo, useEffect } from 'react';
import { X, CloudFog } from 'lucide-react';
import type { Scan } from '../lib/scan';
import { hasData, isBackfillEligible, scanHasKnownOrigin, missReconSources } from '../lib/scan';

interface BackfillMissesPopupProps {
  isOpen: boolean;
  onClose: () => void;
  // Fires when the user clicks Run. `showAfter` reflects the "show misses after
  // completion" toggle (already forced false when no selected scan can display
  // them — see the origin gating below).
  onStart: (scanIds: string[], showAfter: boolean) => void;
  scans: Scan[];
  initialSelectedIds?: Set<string>;
  // True while a backfill is running — disables Run so a second can't be fired.
  inProgress?: boolean;
  error?: string | null;
}

// A small chip naming an ancillary signal a scan carries for miss reconstruction
// (timestamp / row-col). `used` highlights the one the backend will actually use
// (timestamp is preferred when both are present); the other reads muted.
function SourceBadge({ label, used }: { label: string; used: boolean }) {
  return (
    <span
      data-testid={`backfill-source-${label.replace('/', '')}`}
      data-used={used}
      title={used
        ? `Misses will be reconstructed from the ${label} column${label === 'row/col' ? 's' : ''}`
        : `${label} is available but the timestamp path is used instead`}
      className={`px-1.5 py-0.5 rounded text-[9px] font-medium border ${
        used
          ? 'bg-green-500/15 border-green-500/40 text-green-300'
          : 'bg-neutral-700/40 border-neutral-600/50 text-neutral-400'
      }`}
    >
      {label}
    </span>
  );
}

// Decide which eligible-scan ids to check when the modal opens. `eligibleIds` are
// the backfill-eligible scans; `incoming` is the current Scans-panel selection.
// Rules:
//   - no incoming    → opened with nothing selected, so default to all eligible.
//   - incoming given → honor it, intersected with eligibility. This may be EMPTY
//     when the user's selected scan isn't eligible — intentional, so we never
//     silently check a different, unselected scan (the "backwards-select" bug).
// Computed FRESH from `incoming` on every open (not carried from a prior session's
// selection), so reopening with a different panel selection picks it up.
export function seedBackfillSelection(
  eligibleIds: string[],
  incoming: Set<string>,
): Set<string> {
  const eligibleSet = new Set(eligibleIds);
  if (incoming.size === 0) {
    return new Set(eligibleIds);
  }
  return new Set([...incoming].filter(id => eligibleSet.has(id)));
}

// Backfill Misses setup. Models TriangulationPopup / LADPopup: a scan picker that
// auto-selects from the current selection, plus a "show misses after completion"
// toggle. Recovers sky/miss points (gapfillMisses) for the selected scans, which
// LAD requires. Only scans that lack misses but carry the columns to reconstruct
// them (timestamp and/or row/column grid) are eligible — see isBackfillEligible.
export function BackfillMissesPopup({
  isOpen,
  onClose,
  onStart,
  scans,
  initialSelectedIds,
  inProgress = false,
  error = null,
}: BackfillMissesPopupProps) {
  // Eligible = has data, no misses yet, recoverable columns.
  const eligible = useMemo(() => scans.filter(s => isBackfillEligible(s)), [scans]);

  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());
  const [showAfter, setShowAfter] = useState(true);

  // Seed the selection from the caller's ids (the Scans-panel selection),
  // intersected with the eligible set. Only fall back to "all eligible" when the
  // caller passed NO selection at all — if the user DID select scans but none are
  // eligible (e.g. the selected scan already has misses), select nothing and let
  // the ineligibility note explain, rather than silently checking a DIFFERENT,
  // unselected scan (which read as the modal "backwards-selecting").
  // Re-seed from the live Scans-panel selection every time the modal opens (like
  // LADPopup). Depending only on `isOpen` — not `eligible` — means a previous
  // session's selection is never carried over: reopening with a different panel
  // selection picks up the new one.
  useEffect(() => {
    if (!isOpen) return;
    setSelectedScanIds(seedBackfillSelection(
      eligible.map(s => s.id), initialSelectedIds ?? new Set<string>()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const selectedScans = useMemo(
    () => eligible.filter(s => selectedScanIds.has(s.id)),
    [eligible, selectedScanIds],
  );

  // Misses can only be DRAWN for a scan with a known scanner origin (the overlay
  // relocates them about that apex). When none of the selected scans qualify,
  // disable the "show after" toggle — enabling it would render nothing.
  const canShowAny = useMemo(
    () => selectedScans.some(s => scanHasKnownOrigin(s)),
    [selectedScans],
  );

  // Selected-but-ineligible scans (have data but can't be backfilled), split so
  // the note can say WHY: already has misses vs no recoverable columns.
  const selectedDataScans = useMemo(
    () => scans.filter(s => hasData(s) && (initialSelectedIds?.has(s.id) ?? false)),
    [scans, initialSelectedIds],
  );
  const alreadyHasMisses = selectedDataScans.filter(s => s.data?.octree?.hasMisses === true).length;
  const unrecoverable = selectedDataScans.filter(
    s => s.data?.octree?.hasMisses !== true && !isBackfillEligible(s),
  ).length;

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

  const handleRun = useCallback(() => {
    if (selectedScans.length === 0) return;
    onStart(selectedScans.map(s => s.id), showAfter && canShowAny);
    onClose();
  }, [selectedScans, showAfter, canShowAny, onStart, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div data-testid="backfill-popup" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-2xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <CloudFog className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Backfill Misses</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-[10px] text-neutral-500">
            Recover sky/miss points (beams that returned nothing) so leaf area
            density can use them. The <span className="text-green-300">Reconstructs from</span>{' '}
            column shows the ancillary data each scan carries — a per-pulse
            <span className="text-neutral-300"> timestamp</span> and/or scan-grid
            <span className="text-neutral-300"> row/column</span> indices; the
            highlighted one is what's used (timestamp is preferred).
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
            <div className="p-4 text-center text-xs text-neutral-500" data-testid="backfill-none-eligible">
              No selected scan can be backfilled. Eligible scans have point data, no
              sky/miss points yet, and a per-pulse timestamp or row/column grid to
              recover them from.
            </div>
          ) : (
            <div className="border border-neutral-700 rounded-lg overflow-hidden">
              <div className="grid grid-cols-[auto_1fr_auto] gap-2 px-3 py-2 bg-neutral-900/80 border-b border-neutral-700 items-center">
                <div className="w-4" />
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider">Scan</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider">Reconstructs from</span>
              </div>
              <div className="max-h-[35vh] overflow-y-auto">
                {eligible.map(scan => {
                  const isSelected = selectedScanIds.has(scan.id);
                  const fileName = scan.label || scan.data!.fileName || 'Unnamed';
                  // Which ancillary signals this scan carries, and which the
                  // backend will use (timestamp preferred over the grid).
                  const sources = missReconSources(scan);
                  return (
                    <div
                      key={scan.id}
                      data-testid="backfill-scan-row"
                      data-scan-id={scan.id}
                      data-selected={isSelected}
                      data-recon={sources.preferred ?? 'none'}
                      className={`grid grid-cols-[auto_1fr_auto] gap-2 px-3 py-2 items-center border-b border-neutral-700/50 transition-colors ${
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
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {sources.hasTimestamp && <SourceBadge label="timestamp" used={sources.preferred === 'timestamp'} />}
                        {sources.hasGrid && <SourceBadge label="row/col" used={sources.preferred === 'grid'} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(alreadyHasMisses > 0 || unrecoverable > 0) && (
            <div className="text-[10px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5 space-y-1" data-testid="backfill-skip-note">
              {alreadyHasMisses > 0 && (
                <div>{alreadyHasMisses} selected scan(s) already have sky/miss points — nothing to recover.</div>
              )}
              {unrecoverable > 0 && (
                <div>
                  {unrecoverable} selected scan(s) can't recover misses (no timestamp or
                  row/column grid). Re-import a miss-retaining format (E57 / structured PLY).
                </div>
              )}
            </div>
          )}

          {/* Show-after toggle. Disabled when no selected scan can display misses
              (no scanner origin), since enabling would render nothing. */}
          <div className="border-t border-neutral-700 pt-4">
            <label
              className={`flex items-center gap-2 text-[11px] ${canShowAny ? 'text-neutral-300 cursor-pointer' : 'text-neutral-500 cursor-not-allowed'}`}
              title={canShowAny ? undefined : 'Misses can’t be shown without scanner origin info (add scan parameters).'}
            >
              <input
                data-testid="backfill-show-after"
                type="checkbox"
                checked={showAfter && canShowAny}
                disabled={!canShowAny}
                onChange={(e) => setShowAfter(e.target.checked)}
                className="rounded bg-neutral-700 border-neutral-600 text-green-500 focus:ring-0 focus:ring-offset-0"
              />
              Show misses in the viewer after completion
            </label>
            {!canShowAny && selectedScans.length > 0 && (
              <p className="text-[9px] text-neutral-500 mt-1">
                The selected scan(s) have no scanner origin, so recovered misses
                can’t be drawn — they’ll still be used for leaf area density.
              </p>
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
            data-testid="backfill-run-button"
            onClick={handleRun}
            disabled={selectedScans.length === 0 || inProgress}
            className={`px-4 py-2 text-xs rounded font-medium flex items-center gap-2 ${
              selectedScans.length === 0 || inProgress
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-500 text-white'
            }`}
          >
            <CloudFog className="w-3.5 h-3.5" />
            {inProgress ? 'Backfilling…' : 'Backfill Misses'}
          </button>
        </div>
      </div>
    </div>
  );
}
