import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBackendUrl, triangulatePointCloud } from './backendApi';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getBackendUrl', () => {
  it('always returns the production backend URL', () => {
    // Pinning the contract: renderer always hits 8008, even in dev.
    // See src/shared/constants.ts BACKEND_PORT_PROD and CLAUDE.md port wiring.
    expect(getBackendUrl()).toBe('http://127.0.0.1:8008');
  });
});

describe('triangulatePointCloud', () => {
  const request = {
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    method: 'ball_pivoting' as const,
    parameters: { radii: [0.1] },
  };

  it('POSTs JSON to /api/triangulate and returns the parsed response', async () => {
    const expected = {
      success: true,
      vertices: [[0, 0, 0]],
      triangles: [[0, 0, 0]],
      num_vertices: 1,
      num_triangles: 1,
      method_used: 'ball_pivoting',
    };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(expected), { status: 200 }),
    );

    const result = await triangulatePointCloud(request);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/triangulate');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual(request);
    expect(result).toEqual(expected);
  });

  it('surfaces server error detail message on non-2xx', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'bad point cloud' }), { status: 422 }),
    );
    await expect(triangulatePointCloud(request)).rejects.toThrow('bad point cloud');
  });

  it('falls back to HTTP status text when no detail field is present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('not json', { status: 500, statusText: 'Internal Server Error' }),
    );
    await expect(triangulatePointCloud(request)).rejects.toThrow(/HTTP 500/);
  });
});
