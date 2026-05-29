import { Loader2 } from 'lucide-react';

export interface BulkImportProgressState {
  // 1-indexed position of the scan currently being processed (e.g. `1/2`
  // while the first of two scans is parsing). Renders as `current/total` in
  // the modal and as a filled bar at `current/total` width. The label below
  // the bar names that same in-flight scan.
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
}

// Modal shown while a Helios XML bulk import is loading point data. The
// popup that launched the import closes immediately, so without this the
// user sees nothing for as long as the backend takes to parse — could be
// 30s+ on multi-GB scans. Renders above the rest of the UI but below the
// backend splash (z-90 vs z-100) so a backend restart still wins.
export function BulkImportProgress({ progress }: Props) {
  if (!progress) return null;

  const pct = progress.total > 0
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;

  return (
    <div
      data-testid="bulk-import-progress"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="bg-neutral-800 rounded-xl border border-neutral-700 shadow-2xl p-6 min-w-[360px] max-w-md">
        <div className="flex items-center gap-3 mb-4">
          <Loader2 className="h-5 w-5 animate-spin text-blue-400 shrink-0" />
          <span className="text-sm font-medium text-white">Importing scans…</span>
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
            Reading from disk — large scans can take 30s+
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
