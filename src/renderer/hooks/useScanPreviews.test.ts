import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { PointCloudPreviewResponse } from '../utils/backendApi';

vi.mock('../utils/backendApi', () => ({ previewPointCloud: vi.fn() }));
import { previewPointCloud } from '../utils/backendApi';
import { PREVIEW_MAX_ATTEMPTS, useScanPreviews } from './useScanPreviews';

const preview = vi.mocked(previewPointCloud);

const ok = (): PointCloudPreviewResponse => ({
  kind: 'ascii', delimiter: 'whitespace', has_header: false, columns: [], sample_rows: [],
});
const transientError = () => Object.assign(new Error('Preview failed: could not reach the backend'), { transient: true });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  preview.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useScanPreviews', () => {
  it('previews each selected file once and caches it', async () => {
    preview.mockResolvedValue(ok());
    const { result, rerender } = renderHook(({ paths }) => useScanPreviews(paths), {
      initialProps: { paths: ['/a.xyz'] },
    });
    await waitFor(() => expect(result.current.previews.get('/a.xyz')?.status).toBe('ok'));
    rerender({ paths: ['/a.xyz', '/b.xyz'] });
    await waitFor(() => expect(result.current.previews.get('/b.xyz')?.status).toBe('ok'));
    expect(preview).toHaveBeenCalledTimes(2); // a.xyz was not previewed again
  });

  it('retries a transient failure (backend unreachable) instead of keeping it', async () => {
    preview.mockRejectedValueOnce(transientError()).mockResolvedValueOnce(ok());
    const { result } = renderHook(() => useScanPreviews(['/a.xyz']));
    await waitFor(() => expect(result.current.previews.get('/a.xyz')?.status).toBe('error'));
    await vi.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(result.current.previews.get('/a.xyz')?.status).toBe('ok'));
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('stops retrying after a few attempts', async () => {
    preview.mockRejectedValue(transientError());
    const { result } = renderHook(() => useScanPreviews(['/a.xyz']));
    for (let i = 0; i < PREVIEW_MAX_ATTEMPTS + 2; i++) await vi.advanceTimersByTimeAsync(2_500);
    expect(result.current.previews.get('/a.xyz')).toMatchObject({ status: 'error', transient: true });
    expect(preview).toHaveBeenCalledTimes(PREVIEW_MAX_ATTEMPTS);
  });

  it('keeps a failure that is about the file itself', async () => {
    preview.mockRejectedValue(new Error('not a point cloud'));
    const { result } = renderHook(() => useScanPreviews(['/a.xyz']));
    await waitFor(() => expect(result.current.previews.get('/a.xyz')?.status).toBe('error'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('answers for a skipped file without asking the backend', async () => {
    const { result } = renderHook(() => useScanPreviews(['/cloud.las'], () => 'online only'));
    await waitFor(() => expect(result.current.previews.get('/cloud.las')).toEqual({ status: 'error', message: 'online only' }));
    expect(preview).not.toHaveBeenCalled();
  });

  it('cancels the preview of a file that is deselected', async () => {
    let signal: AbortSignal | undefined;
    preview.mockImplementation((_p, _f, _n, s) => { signal = s; return new Promise(() => {}); });
    const { rerender } = renderHook(({ paths }) => useScanPreviews(paths), { initialProps: { paths: ['/a.xyz'] } });
    await waitFor(() => expect(signal).toBeDefined());
    rerender({ paths: [] });
    expect(signal?.aborted).toBe(true);
  });
});
