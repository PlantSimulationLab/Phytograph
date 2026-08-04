import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

export interface BulkImportProgressState {
  // 1-indexed position of the scan currently being processed (e.g. `1/2`
  // while the first of two scans is parsing). Renders as `current/total` in
  // the modal. The bar fills to *completed* work (`current - 1` of `total`),
  // so the first in-flight scan shows 0%, not `1/total`. The label below the
  // bar names that same in-flight scan.
  current: number;
  total: number;
  // Filename or scan label currently being processed. Shown below the bar.
  // Optional so a generic "Preparing…" state can render the same modal.
  label?: string;
  // Per-import override for the bottom-left hint. The point-cloud/scan default
  // ("large scans can take 30s+") is wrong for mesh/skeleton imports, so those
  // pathways set their own wording here. Takes precedence over the component's
  // `hint` prop when present.
  hint?: string;
  // 0..1 progress WITHIN the current item, from the backend's streamed PHP1
  // stage markers. Without it a single-file import shows a permanently empty
  // bar — `current - 1` of `total` is structurally 0 for `{current: 1, total: 1}`.
  // Left undefined by callers that report no sub-progress (batch QSM, stitch,
  // duplicate), which keeps their bars behaving exactly as before.
  fraction?: number | null;
}

interface Props {
  // null = modal is hidden. The parent controls show/hide via this prop,
  // not via mount/unmount, so animations could be added later without
  // re-architecting.
  progress: BulkImportProgressState | null;
  // Header text. Defaults to the import wording; batch QSM passes
  // "Building QSMs…" to reuse the same modal for a different operation.
  title?: string;
  // Bottom-left hint text. Defaults to the import wording.
  hint?: string;
  // When supplied, renders a Cancel button that ACTUALLY stops the work (the
  // caller aborts the request and tells the backend to kill its run). Omitted →
  // no button at all, so the batch-QSM / stitch / duplicate reuses are unchanged.
  onCancel?: () => void;
  cancelLabel?: string;
}

// Modal shown while a Helios XML bulk import is loading point data. The
// popup that launched the import closes immediately, so without this the
// user sees nothing for as long as the backend takes to parse — could be
// 30s+ on multi-GB scans. Renders above the rest of the UI but below the
// backend splash (z-90 vs z-100) so a backend restart still wins.
export function BulkImportProgress({
  progress,
  title = 'Importing scans…',
  hint = 'Reading from disk — large scans can take 30s+',
  onCancel,
  cancelLabel = 'Cancel',
}: Props) {
  // Reset to the idle label whenever a new operation starts, so a second import
  // doesn't open with "Cancelling…" left over from the one before it.
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    if (!progress) setCancelling(false);
  }, [progress]);

  if (!progress) return null;

  // Fill to *completed* scans plus how far the in-flight one has got. `current`
  // is 1-indexed and points at the scan being processed, so `current - 1` is how
  // many have actually finished. Without `fraction` this is the original
  // completed-only bar — which meant a single-file import ({current: 1,
  // total: 1}) sat at 0% for its entire duration.
  const completed = Math.max(0, progress.current - 1);
  const within = progress.fraction != null
    ? Math.min(1, Math.max(0, progress.fraction))
    : 0;
  const pct = progress.total > 0
    ? Math.min(100, Math.round(((completed + within) / progress.total) * 100))
    : 0;

  return (
    <div
      data-testid="bulk-import-progress"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="bg-neutral-800 rounded-xl border border-neutral-700 shadow-2xl p-6 min-w-[360px] max-w-md">
        <div className="flex items-center gap-3 mb-4">
          <Loader2 className="h-5 w-5 animate-spin text-blue-400 shrink-0" />
          <span className="text-sm font-medium text-white">{title}</span>
        </div>
        {progress.label && (
          <div
            data-testid="bulk-import-progress-label"
            className="text-xs text-neutral-300 mb-2 truncate"
            title={progress.label}
          >
            {progress.label}
          </div>
        )}
        <div className="w-full h-2 bg-neutral-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px] text-neutral-500">
            {progress.hint ?? hint}
          </span>
          <span
            data-testid="bulk-import-progress-count"
            className="text-[10px] text-neutral-400 font-mono"
          >
            {progress.current} / {progress.total}
          </span>
        </div>
        {/* Explicit button only — deliberately no backdrop-click and no
            Escape-to-cancel. An accidental click killing a multi-minute import
            is far worse than the missing shortcut. */}
        {onCancel && (
          <div className="flex justify-end mt-4">
            <button
              type="button"
              data-testid="bulk-import-cancel"
              disabled={cancelling}
              onClick={() => {
                // Latch immediately: the backend takes a moment to unwind, and a
                // second click would fire a duplicate cancel at a finished run.
                setCancelling(true);
                onCancel();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border
                         border-neutral-600 text-neutral-300 hover:bg-neutral-700
                         hover:text-white disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              {cancelling ? 'Cancelling…' : cancelLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
