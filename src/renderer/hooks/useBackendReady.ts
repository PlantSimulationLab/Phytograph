import { useCallback, useEffect, useRef, useState } from 'react';
import { getBackendUrl } from '../utils/backendApi';
import { EXPECTED_BACKEND_VERSION } from '@shared/constants';

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

// Polls GET /version until the backend answers WITH A MATCHING VERSION.
// Cold-start of the bundled PyInstaller backend is 10-40s (open3d + pyhelios
// + uvicorn init), so we keep retrying for up to `timeoutMs` before declaring
// failure.
//
// We require the reported version to equal EXPECTED_BACKEND_VERSION, not just
// any 200. A stale/incompatible backend left on the port (see the "Stale
// backend on 8008" note in CLAUDE.md) answers /version too; accepting it would
// flip the splash to 'ready' against a backend the supervisor is about to kill
// and respawn, leaving the UI live against a doomed process. While the version
// mismatches we stay in 'starting' — the supervisor in src/main/backend.ts is
// killing the wrong backend and booting the bundled one, which will report the
// expected version once it's up.
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
          // A 200 isn't enough — a stale/incompatible backend answers /version
          // too. Only treat a version-matched backend as ready; otherwise fall
          // through and keep polling (the supervisor is replacing it).
          if (json.version === EXPECTED_BACKEND_VERSION) {
            // Honour the minimum splash time. If the backend was already warm
            // (typical in dev or on a warm restart) we'd otherwise unmount the
            // splash within a single frame. Rather than schedule a one-shot
            // timer (which would freeze the displayed counter at its first-tick
            // value for the whole floor), keep looping until the floor is met —
            // each pass advances elapsedMs below, so the timer keeps climbing.
            if (elapsedMs >= minSplashMs) {
              if (!cancelled) {
                setState({ status: 'ready', elapsedMs, version: json.version });
              }
              return;
            }
            // else: backend is up but we're still under the floor — fall
            // through to the keep-ticking path and re-check next interval.
          }
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

      // Advance the displayed timer every tick while we're still waiting —
      // regardless of whether the last fetch refused, timed out, or returned a
      // mismatched version. (Previously this only ran after a failed fetch, so
      // a backend that answered on the first tick left the counter pinned at 0
      // for the whole minSplashMs wait.)
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
