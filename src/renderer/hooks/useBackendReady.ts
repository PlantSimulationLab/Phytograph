import { useCallback, useEffect, useRef, useState } from 'react';
import { getBackendUrl } from '../utils/backendApi';

export type BackendStatus = 'starting' | 'ready' | 'failed';

export interface BackendReadyState {
  status: BackendStatus;
  elapsedMs: number;
  version?: string;
  error?: string;
  // Restart the polling loop from a 'failed' (or any) state. Mostly used by
  // the splash screen's Retry button. No-op if already polling.
  retry: () => void;
}

// Polls GET /version until the backend answers. Cold-start of the bundled
// PyInstaller backend is 10-40s (open3d + pyhelios + uvicorn init), so we
// keep retrying for up to `timeoutMs` before declaring failure.
//
// `minSplashMs` is a floor on how long the splash stays up even if the
// backend responds instantly (which happens in dev when uvicorn is already
// hot, or on warm restarts). Without it the splash flashes for a frame
// and looks like a render glitch.
export function useBackendReady(timeoutMs = 120_000, intervalMs = 1000, minSplashMs = 2500): BackendReadyState {
  // `retryNonce` re-runs the polling effect when the splash's Retry button
  // fires. We bump it instead of pulling polling logic out of useEffect so the
  // cleanup story (cancellation, timer teardown) stays in one place.
  const [retryNonce, setRetryNonce] = useState(0);
  const [state, setState] = useState<Omit<BackendReadyState, 'retry'>>({ status: 'starting', elapsedMs: 0 });
  const startedAt = useRef<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    const baseUrl = getBackendUrl();
    startedAt.current = Date.now();
    if (retryNonce > 0) {
      // Don't clobber the very first render's initial state — only reset on
      // an explicit retry. Otherwise React's strict-mode double-invocation
      // would briefly flash 'starting' on top of an already-ready state.
      setState({ status: 'starting', elapsedMs: 0 });
    }

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const elapsedMs = Date.now() - startedAt.current;

      try {
        const res = await fetch(`${baseUrl}/version`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const json = (await res.json()) as { version?: string };
          // Honour the minimum splash time. If the backend was already warm
          // (typical in dev or on a warm restart) we'd otherwise unmount the
          // splash within a single frame.
          const remaining = Math.max(0, minSplashMs - elapsedMs);
          if (remaining > 0) {
            setTimeout(() => {
              if (!cancelled) {
                setState({ status: 'ready', elapsedMs: Date.now() - startedAt.current, version: json.version });
              }
            }, remaining);
          } else if (!cancelled) {
            setState({ status: 'ready', elapsedMs, version: json.version });
          }
          return;
        }
      } catch {
        // Connection refused / timeout — backend not up yet.
      }

      if (elapsedMs >= timeoutMs) {
        if (!cancelled) {
          setState({ status: 'failed', elapsedMs, error: 'Backend did not start within the expected time.' });
        }
        return;
      }

      if (!cancelled) {
        setState((prev) => (prev.status === 'starting' ? { ...prev, elapsedMs } : prev));
      }
      setTimeout(tick, intervalMs);
    };

    tick();
    return () => {
      cancelled = true;
    };
  }, [timeoutMs, intervalMs, minSplashMs, retryNonce]);

  const retry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  return { ...state, retry };
}
