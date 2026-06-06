import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useBackendReady } from './useBackendReady';
import { EXPECTED_BACKEND_VERSION } from '@shared/constants';

// The splash only accepts a backend whose /version matches this exactly.
const OK = JSON.stringify({ version: EXPECTED_BACKEND_VERSION });
const okResponse = () => new Response(OK, { status: 200 });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useBackendReady', () => {
  it('starts in "starting" state with elapsedMs 0', () => {
    vi.spyOn(global, 'fetch').mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    const { result } = renderHook(() => useBackendReady());
    expect(result.current.status).toBe('starting');
    expect(result.current.elapsedMs).toBe(0);
    expect(result.current.version).toBeUndefined();
  });

  it('transitions to "ready" when /version returns 200 with a matching version', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    // minSplashMs=0 so the test doesn't need to wait out the splash floor.
    const { result } = renderHook(() => useBackendReady(120_000, 1000, 0));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.version).toBe(EXPECTED_BACKEND_VERSION);
  });

  it('stays in "starting" while a stale backend reports a mismatched version, then times out to "failed"', async () => {
    // A leftover/incompatible backend on the port answers 200 but with the
    // wrong version — must NOT be accepted as ready.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '0.0.1-stale' }), { status: 200 }),
    );
    const { result } = renderHook(() => useBackendReady(50, 5, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.version).toBeUndefined();
  });

  it('accepts the backend once a mismatched version is replaced by a matching one', async () => {
    let calls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      calls += 1;
      // Supervisor is killing the stale backend and booting the bundled one:
      // first few probes hit the wrong version, then the right one appears.
      if (calls < 3) return new Response(JSON.stringify({ version: 'wrong' }), { status: 200 });
      return okResponse();
    });
    const { result } = renderHook(() => useBackendReady(120_000, 10, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.version).toBe(EXPECTED_BACKEND_VERSION);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('advances elapsedMs while waiting even when the backend answers on the first tick', async () => {
    // Backend is immediately reachable, but minSplashMs holds the splash up.
    // The displayed counter must climb during that wait rather than stay at 0.
    vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    const { result } = renderHook(() => useBackendReady(120_000, 1000, 5000));
    // Let a couple of poll intervals elapse while we're inside minSplashMs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.status).toBe('starting');
    expect(result.current.elapsedMs).toBeGreaterThan(0);
  });

  it('keeps polling on connection failure until backend becomes ready', async () => {
    let calls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error('connection refused');
      return okResponse();
    });
    const { result } = renderHook(() => useBackendReady(120_000, 10, 0));
    // Drive the setTimeout-based polling forward.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('transitions to "failed" when timeoutMs elapses without a 200', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('refused'));
    // Use a tiny timeout so the test completes quickly.
    const { result } = renderHook(() => useBackendReady(50, 5));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.error).toMatch(/did not start/);
  });

  it('treats non-2xx responses as not-ready and keeps polling', async () => {
    let calls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls < 2) {
        return new Response('starting', { status: 503 });
      }
      return okResponse();
    });
    const { result } = renderHook(() => useBackendReady(60_000, 10, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('retry() restarts polling from a failed state and reaches ready', async () => {
    let failNextNCalls = 100;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      if (failNextNCalls > 0) {
        failNextNCalls -= 1;
        throw new Error('refused');
      }
      return okResponse();
    });
    const { result } = renderHook(() => useBackendReady(50, 5, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await waitFor(() => expect(result.current.status).toBe('failed'));

    // Now flip the fixture so subsequent fetches succeed, then trigger retry.
    failNextNCalls = 0;
    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('stops polling after unmount (no state updates on cancelled hook)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      okResponse(),
    );
    const { unmount } = renderHook(() => useBackendReady(60_000, 100));
    unmount();
    const callsAfterUnmount = fetchSpy.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // Allow for at most the one in-flight call that was already issued before
    // unmount; the loop should not schedule additional fetches.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(callsAfterUnmount + 1);
  });
});
