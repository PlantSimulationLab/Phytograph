import { Loader2, AlertTriangle } from 'lucide-react';
import { useBackendReady } from '../hooks/useBackendReady';

// Non-blocking status banner shown at the top of the app until the bundled
// Python backend answers /version. Disappears silently once ready so the
// banner never lingers in a healthy session.
export function BackendStatusBanner() {
  const { status, elapsedMs, error } = useBackendReady();

  if (status === 'ready') return null;

  const seconds = Math.floor(elapsedMs / 1000);

  if (status === 'failed') {
    return (
      <div
        data-testid="backend-status-banner"
        data-status="failed"
        className="flex items-center gap-2 bg-red-900/80 px-4 py-2 text-sm text-red-100 border-b border-red-700/50"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          Backend failed to start{error ? `: ${error}` : '.'} Triangulation, plant generation, and
          mesh tools will not work. Try restarting the app.
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="backend-status-banner"
      data-status="starting"
      className="flex items-center gap-2 bg-amber-900/70 px-4 py-2 text-sm text-amber-100 border-b border-amber-700/40"
    >
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      <span>
        Starting backend… ({seconds}s)
      </span>
    </div>
  );
}
