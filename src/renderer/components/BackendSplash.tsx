import { useEffect, useState } from 'react';
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

  // First launch is much slower (PyInstaller unpack + open3d/pyhelios import +
  // first-run OS scan), so we tailor the splash copy. main reports it via
  // backend.getInfo().firstRun; default to false so an unexpected IPC failure
  // shows the plainer (non-alarming) message rather than a false "first launch".
  const [firstRun, setFirstRun] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.backend
      .getInfo()
      .then((i) => {
        if (!cancelled) setFirstRun(i.firstRun);
      })
      .catch(() => {
        /* keep default false */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
              <span className="text-base font-medium">
                {firstRun ? 'Setting up Phytograph…' : 'Starting backend…'}
              </span>
              <span className="text-sm text-neutral-500 font-mono">{seconds}s</span>
            </div>
            {firstRun ? (
              <p className="max-w-sm text-xs text-amber-200/80 leading-relaxed">
                <span className="font-medium text-amber-200">First launch</span> —
                initialising the Python compute backend (open3d, pyhelios) for the
                first time. This can take up to a minute; every launch after this
                will be much faster.
              </p>
            ) : (
              <p className="max-w-sm text-xs text-neutral-500 leading-relaxed">
                Initialising the Python compute backend (open3d, pyhelios).
              </p>
            )}
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
