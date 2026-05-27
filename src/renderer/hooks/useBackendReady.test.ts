import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useBackendReady } from './useBackendReady';

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

  it('transitions to "ready" when /version returns 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
    );
    // minSplashMs=0 so the test doesn't need to wait out the splash floor.
    const { result } = renderHook(() => useBackendReady(120_000, 1000, 0));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.version).toBe('0.2.0');
  });

  it('keeps polling on connection failure until backend becomes ready', async () => {
    let calls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error('connection refused');
      return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 });
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
      return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 });
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
      return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 });
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
      new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
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
