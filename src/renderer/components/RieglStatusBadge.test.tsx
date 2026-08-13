import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { RieglStatusBadge } from './RieglStatusBadge';

vi.mock('../utils/backendApi', () => ({ getRieglStatus: vi.fn() }));
import { getRieglStatus } from '../utils/backendApi';

const READY = {
  available: true,
  platformSupported: true,
  dockerPresent: true,
  imageBuilt: true,
  rivlibPath: '/riv',
  rivlibValid: true,
  image: 'phytograph-riegl:latest',
  reason: 'RIEGL .rxp import is ready.',
};

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe('RieglStatusBadge', () => {
  it('reports ready when the probe succeeds', async () => {
    vi.mocked(getRieglStatus).mockResolvedValue(READY as never);
    render(<RieglStatusBadge rivlibPath="/riv" />);
    await waitFor(() =>
      expect(screen.getByTestId('riegl-status-badge').dataset.state).toBe('ready'),
    );
  });

  it('recovers when the backend is briefly unreachable, without a restart', async () => {
    // THE DEV-LOOP BUG. A rebuild restarts the backend while the renderer is
    // up, so a probe fired in that window fails with a connection error. A
    // single-shot probe then showed "Docker not running / image not built"
    // until the whole `npm run dev` session was restarted — a claim about the
    // machine that simply wasn't true.
    vi.mocked(getRieglStatus)
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(READY as never);

    render(<RieglStatusBadge rivlibPath="/riv" />);

    // Nothing claimed while the backend is down: no false "unavailable".
    await waitFor(() =>
      expect(screen.queryByTestId('riegl-status-badge')).toBeNull(),
    );

    await vi.advanceTimersByTimeAsync(2000); // covers the 0.5s + 1s backoff

    await waitFor(() =>
      expect(screen.getByTestId('riegl-status-badge').dataset.state).toBe('ready'),
    );
    expect(vi.mocked(getRieglStatus).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('gives up after a bounded number of retries rather than polling forever', async () => {
    vi.mocked(getRieglStatus).mockRejectedValue(new Error('fetch failed'));
    render(<RieglStatusBadge rivlibPath="/riv" />);

    await vi.advanceTimersByTimeAsync(60_000);
    // 1 initial + 5 retries. An unbounded loop would hammer a dead backend for
    // the life of the session.
    expect(vi.mocked(getRieglStatus).mock.calls.length).toBe(6);
    expect(screen.queryByTestId('riegl-status-badge')).toBeNull();
  });

  it('clears the parent status when the backend goes away', async () => {
    // The Settings checklist is rendered from this callback's value. Leaving a
    // parent holding the last good status paints a checklist describing a
    // machine we can no longer see.
    const onStatus = vi.fn();
    vi.mocked(getRieglStatus).mockRejectedValue(new Error('fetch failed'));
    render(<RieglStatusBadge rivlibPath="/riv" onStatus={onStatus} />);

    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(null));
  });

  it('re-probes when refreshKey changes', async () => {
    vi.mocked(getRieglStatus).mockResolvedValue(READY as never);
    const { rerender } = render(<RieglStatusBadge rivlibPath="/riv" refreshKey={0} />);
    await waitFor(() => expect(getRieglStatus).toHaveBeenCalledTimes(1));

    rerender(<RieglStatusBadge rivlibPath="/riv" refreshKey={1} />);
    await waitFor(() => expect(getRieglStatus).toHaveBeenCalledTimes(2));
  });
});
