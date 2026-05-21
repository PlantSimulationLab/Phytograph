import { useEffect, useRef, useState } from 'react';
import { getBackendUrl } from '../utils/backendApi';

export type BackendStatus = 'starting' | 'ready' | 'failed';

export interface BackendReadyState {
  status: BackendStatus;
  elapsedMs: number;
  version?: string;
  error?: string;
}

// Polls GET /version until the backend answers. Cold-start of the bundled
// PyInstaller backend is 10-40s (open3d + pyhelios + uvicorn init), so we
// keep retrying for up to `timeoutMs` before declaring failure.
export function useBackendReady(timeoutMs = 120_000, intervalMs = 1000): BackendReadyState {
  const [state, setState] = useState<BackendReadyState>({ status: 'starting', elapsedMs: 0 });
  const startedAt = useRef<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    const baseUrl = getBackendUrl();

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const elapsedMs = Date.now() - startedAt.current;

      try {
        const res = await fetch(`${baseUrl}/version`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const json = (await res.json()) as { version?: string };
          if (!cancelled) setState({ status: 'ready', elapsedMs, version: json.version });
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
  }, [timeoutMs, intervalMs]);

  return state;
}
