import { Loader2, AlertTriangle, RotateCw } from 'lucide-react';
import splashImage from '../assets/splash.png';
import { useBackendReady } from '../hooks/useBackendReady';

// Blocks the rest of the UI until the bundled Python backend answers /version.
// Returns null once ready. Loading anything before the backend is up silently
// fails (point-cloud import, triangulation, plant generation all depend on
// it), so we gate the whole app rather than just warning in a banner strip.
//
// Rendered as a fixed-position overlay with a high z-index, which catches
// all pointer events while the splash is up — the rest of App is still
// mounted underneath but unreachable to the user.
export function BackendSplash() {
  const { status, elapsedMs, error, retry } = useBackendReady();

  if (status === 'ready') return null;

  const seconds = Math.floor(elapsedMs / 1000);

  return (
    <div
      data-testid="backend-splash"
      data-status={status}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-950"
    >
      <div className="flex flex-col items-center gap-6 px-6 max-w-3xl w-full text-center">
        {/* Hero art carries the Phytograph wordmark and UC Davis branding; no
            need to repeat the logo separately above. Rounded + shadowed so
            it reads as a card rather than a wallpaper. */}
        <img
          src={splashImage}
          alt="Phytograph"
          className="w-full max-w-3xl rounded-xl shadow-2xl ring-1 ring-white/5"
        />

        {status === 'starting' && (
          <>
            <div className="flex items-center gap-3 text-neutral-200">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-base font-medium">Starting backend…</span>
              <span className="text-sm text-neutral-500 font-mono">{seconds}s</span>
            </div>
            <p className="max-w-sm text-xs text-neutral-500 leading-relaxed">
              Initialising the Python compute backend (open3d, pyhelios). First
              launch after install can take 30–60 seconds.
            </p>
          </>
        )}

        {status === 'failed' && (
          <>
            <div className="flex items-center gap-3 text-red-300">
              <AlertTriangle className="h-5 w-5" />
              <span className="text-base font-medium">Backend failed to start</span>
            </div>
            <p className="max-w-sm text-xs text-red-200/80 leading-relaxed">
              {error ?? 'The backend did not respond in time.'} Point-cloud
              import, triangulation, and plant generation all require the
              backend. Try again, or quit and reopen the app.
            </p>
            <button
              type="button"
              data-testid="backend-splash-retry"
              onClick={retry}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
            >
              <RotateCw className="h-4 w-4" />
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
}
