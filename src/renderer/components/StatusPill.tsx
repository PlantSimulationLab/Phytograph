import { X } from 'lucide-react';

interface StatusPillProps {
  /** Stage label, e.g. "Triangulating scan 2 of 3". */
  label: string;
  /** 0..1 fraction. When a finite number, a slim bar + percentage is shown. */
  progress?: number | null;
  /** When provided, a cancel (X) button is rendered. */
  onCancel?: () => void;
  testId?: string;
}

/**
 * The small top-center status pill shown during long-running viewer operations
 * (cropping, triangulating, leaf-area density). A pulsing green dot, a label,
 * an optional thin progress bar + percentage, and an optional cancel button.
 *
 * Extracted from the formerly-duplicated inline markup in PointCloudViewer so
 * every long operation gets a consistent indicator.
 */
export default function StatusPill({ label, progress, onCancel, testId }: StatusPillProps) {
  const hasProgress = typeof progress === 'number' && Number.isFinite(progress);
  const pct = hasProgress ? Math.max(0, Math.min(1, progress as number)) : 0;

  return (
    <div
      data-testid={testId}
      className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-neutral-800/80 backdrop-blur-sm rounded-full border border-neutral-700/50 z-20"
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
      </span>
      <span className="text-[11px] text-neutral-300">{label}</span>
      {hasProgress && (
        <>
          <span className="relative h-1 w-16 overflow-hidden rounded-full bg-neutral-600/60">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-green-500 transition-[width] duration-200"
              style={{ width: `${pct * 100}%` }}
            />
          </span>
          <span className="text-[10px] tabular-nums text-neutral-400">{Math.round(pct * 100)}%</span>
        </>
      )}
      {onCancel && (
        <button
          onClick={onCancel}
          data-testid={testId ? `${testId}-cancel` : undefined}
          className="ml-1 p-0.5 rounded hover:bg-neutral-600/60 transition-colors"
          title="Cancel"
        >
          <X className="w-3 h-3 text-neutral-400 hover:text-neutral-200" />
        </button>
      )}
    </div>
  );
}
