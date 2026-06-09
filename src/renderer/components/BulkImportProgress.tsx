import { Loader2 } from 'lucide-react';

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
}: Props) {
  if (!progress) return null;

  // Fill to *completed* scans, not the in-flight one: while scan 1/2 is
  // parsing nothing has finished yet, so the bar should read 0%, not 50%.
  // `current` is 1-indexed and points at the scan being processed, so
  // `current - 1` is how many have actually completed.
  const completed = Math.max(0, progress.current - 1);
  const pct = progress.total > 0
    ? Math.min(100, Math.round((completed / progress.total) * 100))
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
            {hint}
          </span>
          <span
            data-testid="bulk-import-progress-count"
            className="text-[10px] text-neutral-400 font-mono"
          >
            {progress.current} / {progress.total}
          </span>
        </div>
      </div>
    </div>
  );
}
