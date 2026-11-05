import { useEffect, useReducer, useRef } from 'react';
import { previewPointCloud } from '../utils/backendApi';
import type { PreviewState } from '../lib/fileBrowserModel';

// Header previews for the files the browser currently has selected.
//
// The modal wizard previews a fixed list once, on mount. The browser's list
// changes with every click, so this hook adds what that model never needed:
//  - a short debounce, so arrowing down a folder of 200 scans previews the one
//    you stop on, not all 200;
//  - cancellation, so a file you clicked past stops costing backend time;
//  - a cache for the life of the dialog, so clicking back to a file is instant
//    and keeps nothing stale (a preview is a pure function of the file);
//  - a concurrency cap, because a shift-click can select hundreds of files.
//
// `skip(path)` lets the caller answer for a file without asking the backend
// (a cloud placeholder: reading it would trigger, or block on, a download).

export const PREVIEW_DEBOUNCE_MS = 150;
export const PREVIEW_CONCURRENCY = 4;
export const PREVIEW_RETRY_MS = 2_000;
export const PREVIEW_MAX_ATTEMPTS = 3;

export interface ScanPreviews {
  previews: ReadonlyMap<string, PreviewState>;
  // Bumped whenever an entry changes. The map itself is one long-lived
  // object, so callers memoize on this rather than on its identity.
  version: number;
}

export function useScanPreviews(
  paths: string[],
  skip?: (path: string) => string | null,
): ScanPreviews {
  const cache = useRef(new Map<string, PreviewState>());
  const inflight = useRef(new Map<string, AbortController>());
  const wanted = useRef<string[]>([]);
  const attempts = useRef(new Map<string, number>());
  const retryTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const skipRef = useRef(skip);
  skipRef.current = skip;
  const [version, rerender] = useReducer((n: number) => n + 1, 0);
  const key = paths.join('\n');

  useEffect(() => {
    wanted.current = paths;
    const want = new Set(paths);
    // Stop paying for files no longer selected. Their entry is dropped too, so
    // reselecting one starts a fresh preview instead of showing "loading"
    // forever.
    for (const [p, ctl] of inflight.current) {
      if (!want.has(p)) {
        ctl.abort();
        inflight.current.delete(p);
        cache.current.delete(p);
      }
    }

    // A transient failure that ran out of retries gets fresh ones when the
    // file is selected again: by then the backend has likely recovered.
    for (const p of paths) {
      const cur = cache.current.get(p);
      if (cur?.status === 'error' && cur.transient && (attempts.current.get(p) ?? 0) >= PREVIEW_MAX_ATTEMPTS) {
        cache.current.delete(p);
        attempts.current.delete(p);
      }
    }

    const pump = () => {
      for (const p of wanted.current) {
        if (inflight.current.size >= PREVIEW_CONCURRENCY) return;
        if (cache.current.has(p)) continue;
        const reason = skipRef.current?.(p) ?? null;
        if (reason) {
          cache.current.set(p, { status: 'error', message: reason });
          rerender();
          continue;
        }
        const ctl = new AbortController();
        inflight.current.set(p, ctl);
        cache.current.set(p, { status: 'loading' });
        previewPointCloud(p, null, 20, ctl.signal).then(
          (preview) => {
            if (ctl.signal.aborted) return;
            attempts.current.delete(p);
            cache.current.set(p, { status: 'ok', preview });
          },
          (err) => {
            if (ctl.signal.aborted) return;
            const message = err instanceof Error ? err.message : String(err);
            const transient = !!(err as { transient?: boolean })?.transient;
            cache.current.set(p, { status: 'error', message, transient });
            // A backend that was restarting or busy says nothing about the
            // file, so don't keep the failure for the dialog's life (the file
            // would silently import as auto-detect-only): retry a few times.
            const tries = (attempts.current.get(p) ?? 0) + 1;
            attempts.current.set(p, tries);
            if (transient && tries < PREVIEW_MAX_ATTEMPTS) {
              const t = setTimeout(() => {
                retryTimers.current.delete(t);
                const cur = cache.current.get(p);
                if (!wanted.current.includes(p) || cur?.status !== 'error') return;
                cache.current.delete(p);
                rerender();
                pump();
              }, PREVIEW_RETRY_MS);
              retryTimers.current.add(t);
            }
          },
        ).finally(() => {
          if (ctl.signal.aborted) return;
          inflight.current.delete(p);
          rerender();
          pump();
        });
      }
    };
    const t = setTimeout(pump, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // `key` stands for `paths` by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Abort everything when the dialog closes, and forget those entries: an
  // aborted preview left as 'loading' would never be retried if the effects
  // run again (Fast Refresh in dev).
  useEffect(() => () => {
    for (const [p, ctl] of inflight.current) {
      ctl.abort();
      cache.current.delete(p);
    }
    inflight.current.clear();
    for (const t of retryTimers.current) clearTimeout(t);
    retryTimers.current.clear();
  }, []);

  return { previews: cache.current, version };
}
