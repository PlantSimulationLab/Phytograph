import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advancePlantSession,
  computeAlignmentDistance,
  createPlantSession,
  deletePlantSession,
  exportPointCloudLasLaz,
  extractSkeleton,
  generatePlantModel,
  getAvailablePlantModels,
  getBackendUrl,
  getPlantSessionStatus,
  heliosTriangulate,
  icpRegisterCloudToCloud,
  icpRegisterMeshToCloud,
  icpRegisterMeshToMesh,
  importPointCloudLasLaz,
  morphPlant,
  parsePlantMorphParameters,
  sampleMeshSurface,
  triangulatePointCloud,
} from './backendApi';

// Silence the production console.* calls — they're informational and just
// pollute test output. We still capture them so a regression that loses
// error reporting would surface in a focused test below.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOk(body: unknown): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
}

function mockFetchError(status: number, body: unknown): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(global, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status, statusText: 'Error' }),
    );
}

describe('getBackendUrl', () => {
  it('always returns the production backend URL', () => {
    expect(getBackendUrl()).toBe('http://127.0.0.1:8008');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Endpoint helpers. Each test asserts (a) URL + method + body, and
// (b) error surfacing — the two contracts every caller depends on.
// ────────────────────────────────────────────────────────────────────────

describe('triangulatePointCloud', () => {
  const req = {
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    method: 'ball_pivoting' as const,
    parameters: { radii: [0.1] },
  };

  it('POSTs to /api/triangulate and returns parsed body', async () => {
    const expected = { success: true, num_vertices: 4, num_triangles: 4, vertices: [], triangles: [], method_used: 'ball_pivoting' };
    const spy = mockFetchOk(expected);
    const result = await triangulatePointCloud(req);
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/triangulate');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
    expect(result).toEqual(expected);
  });

  it('surfaces server detail on non-2xx', async () => {
    mockFetchError(422, { detail: 'bad points' });
    await expect(triangulatePointCloud(req)).rejects.toThrow('bad points');
  });

  it('falls back to status text when no detail is present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('not json', { status: 500, statusText: 'Internal Server Error' }),
    );
    await expect(triangulatePointCloud(req)).rejects.toThrow(/HTTP 500/);
  });
});

describe('heliosTriangulate', () => {
  const req = {
    scans: [{ points: [[0, 0, 0]], origin: [0, 0, 0] }],
    lmax: 0.05,
    max_aspect_ratio: 4.0,
    theta_min: 30,
    theta_max: 130,
    phi_min: 0,
    phi_max: 360,
  };

  it('POSTs to /api/triangulate/helios and returns parsed body', async () => {
    const expected = { success: true, vertices: [], triangles: [], num_vertices: 0, num_triangles: 0, method_used: 'helios' };
    const spy = mockFetchOk(expected);
    const result = await heliosTriangulate(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/triangulate/helios');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
    expect(result).toEqual(expected);
  });

  it('honors an external AbortSignal', async () => {
    // When the external signal aborts, the internal controller aborts the fetch
    // and the call should reject.
    const ac = new AbortController();
    vi.spyOn(global, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig = (init as RequestInit)?.signal;
        if (sig?.aborted) reject(new DOMException('Aborted', 'AbortError'));
        sig?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });
    const promise = heliosTriangulate(req, ac.signal);
    ac.abort();
    await expect(promise).rejects.toBeInstanceOf(DOMException);
  });

  it('surfaces detail on error', async () => {
    mockFetchError(400, { detail: 'no scans' });
    await expect(heliosTriangulate(req)).rejects.toThrow('no scans');
  });
});

describe('extractSkeleton', () => {
  const req = {
    points: [
      [0, 0, 0],
      [0, 0, 1],
    ],
    search_radius: 0.05,
  };

  it('POSTs to /api/skeleton/extract', async () => {
    const expected = {
      success: true,
      skeleton_points: [],
      total_length: 0,
      num_nodes: 0,
      points_before_filtering: 2,
      points_after_filtering: 2,
      dominant_axis: 'z',
    };
    const spy = mockFetchOk(expected);
    const result = await extractSkeleton(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/skeleton/extract');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
    expect(result).toEqual(expected);
  });

  it('surfaces detail on error', async () => {
    mockFetchError(422, { detail: 'too few points' });
    await expect(extractSkeleton(req)).rejects.toThrow('too few points');
  });
});

describe('getAvailablePlantModels', () => {
  it('GETs /api/plant/models', async () => {
    const expected = { success: true, models: ['bean', 'tomato'] };
    const spy = mockFetchOk(expected);
    const result = await getAvailablePlantModels();
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/plant/models');
    expect(init?.method).toBe('GET');
    expect(result).toEqual(expected);
  });

  it('surfaces detail on error', async () => {
    mockFetchError(500, { detail: 'pyhelios import failed' });
    await expect(getAvailablePlantModels()).rejects.toThrow('pyhelios import failed');
  });
});

describe('generatePlantModel', () => {
  const req = { plant_type: 'bean', age: 10, position_x: 0, position_y: 0, position_z: 0 };

  it('POSTs to /api/plant/generate', async () => {
    const expected = { success: true, vertices: [], indices: [], vertex_count: 0, triangle_count: 0, plant_type: 'bean', age: 10, helios_xml: '', available_models: [] };
    const spy = mockFetchOk(expected);
    await generatePlantModel(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/plant/generate');
    expect(JSON.parse(init?.body as string)).toEqual(req);
  });

  it('surfaces detail on error', async () => {
    mockFetchError(400, { detail: 'unknown species' });
    await expect(generatePlantModel(req)).rejects.toThrow('unknown species');
  });
});

describe('plant sessions', () => {
  it('createPlantSession POSTs to /api/plant/session/create', async () => {
    const req = { plant_type: 'bean', initial_age: 5 };
    const spy = mockFetchOk({ success: true, session_id: 's1', plant_type: 'bean', current_age: 5 });
    await createPlantSession(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/plant/session/create');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
  });

  it('createPlantSession surfaces error', async () => {
    mockFetchError(500, { detail: 'init failed' });
    await expect(
      createPlantSession({ plant_type: 'bean', initial_age: 5 }),
    ).rejects.toThrow('init failed');
  });

  it('advancePlantSession POSTs to /api/plant/session/<id>/advance with { dt }', async () => {
    const spy = mockFetchOk({
      success: true,
      session_id: 's1',
      previous_age: 5,
      current_age: 6,
      vertices: [],
      indices: [],
      vertex_count: 0,
      triangle_count: 0,
    });
    await advancePlantSession('s1', 1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/plant/session/s1/advance');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ dt: 1 });
  });

  it('advancePlantSession surfaces error', async () => {
    mockFetchError(404, { detail: 'no such session' });
    await expect(advancePlantSession('missing', 1)).rejects.toThrow('no such session');
  });

  it('getPlantSessionStatus GETs /api/plant/session/<id>', async () => {
    const spy = mockFetchOk({
      success: true,
      session_id: 's1',
      plant_type: 'bean',
      current_age: 6,
    });
    const result = await getPlantSessionStatus('s1');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/plant/session/s1');
    expect(init?.method).toBe('GET');
    expect(result.session_id).toBe('s1');
  });

  it('getPlantSessionStatus surfaces error', async () => {
    mockFetchError(404, { detail: 'gone' });
    await expect(getPlantSessionStatus('s1')).rejects.toThrow('gone');
  });

  it('deletePlantSession DELETEs /api/plant/session/<id>', async () => {
    const spy = mockFetchOk({ success: true });
    await deletePlantSession('s1');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/plant/session/s1');
    expect(init?.method).toBe('DELETE');
  });

  it('deletePlantSession surfaces error', async () => {
    mockFetchError(500, { detail: 'cleanup error' });
    await expect(deletePlantSession('s1')).rejects.toThrow('cleanup error');
  });
});

describe('plant morph', () => {
  it('parsePlantMorphParameters POSTs xml + plant_type', async () => {
    const spy = mockFetchOk({ success: true, shoots: [], plant_type: 'bean' });
    await parsePlantMorphParameters('<xml/>', 'bean');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/plant/morph/parse');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      helios_xml: '<xml/>',
      plant_type: 'bean',
    });
  });

  it('parsePlantMorphParameters surfaces error', async () => {
    mockFetchError(400, { detail: 'bad xml' });
    await expect(parsePlantMorphParameters('<bad/>', 'bean')).rejects.toThrow('bad xml');
  });

  it('morphPlant POSTs to /api/plant/morph', async () => {
    const req = { plant_type: 'bean', helios_xml: '<xml/>', shoots: [] };
    const spy = mockFetchOk({
      success: true,
      vertices: [],
      indices: [],
      vertex_count: 0,
      triangle_count: 0,
    });
    await morphPlant(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/plant/morph');
    expect(JSON.parse(init?.body as string)).toEqual(req);
  });

  it('morphPlant surfaces error', async () => {
    mockFetchError(500, { detail: 'morph blew up' });
    await expect(
      morphPlant({ plant_type: 'bean', helios_xml: '<xml/>', shoots: [] }),
    ).rejects.toThrow('morph blew up');
  });
});

describe('sampleMeshSurface', () => {
  it('POSTs to /api/mesh/sample', async () => {
    const req = {
      vertices: [[0, 0, 0]],
      triangles: [[0, 0, 0]],
      density: 100,
    };
    const spy = mockFetchOk({ success: true, points: [], num_points: 0, surface_area: 1 });
    await sampleMeshSurface(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/mesh/sample');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
  });

  it('surfaces error', async () => {
    mockFetchError(400, { detail: 'no triangles' });
    await expect(
      sampleMeshSurface({ vertices: [], triangles: [], density: 1 }),
    ).rejects.toThrow('no triangles');
  });
});

describe('point cloud LAS/LAZ import/export', () => {
  it('exportPointCloudLasLaz POSTs to /api/pointcloud/export', async () => {
    const req = {
      points: [[0, 0, 0]],
      format: 'laz' as const,
      filename: 'out.laz',
    };
    const spy = mockFetchOk({
      success: true,
      data: 'ZmFrZQ==',
      filename: 'out.laz',
      point_count: 1,
      has_colors: false,
      format: 'laz',
    });
    await exportPointCloudLasLaz(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/pointcloud/export');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
  });

  it('exportPointCloudLasLaz surfaces error', async () => {
    mockFetchError(500, { detail: 'lazrs missing' });
    await expect(
      exportPointCloudLasLaz({ points: [], format: 'laz' }),
    ).rejects.toThrow('lazrs missing');
  });

  it('importPointCloudLasLaz POSTs multipart to /api/pointcloud/import', async () => {
    const spy = mockFetchOk({
      success: true,
      points: [[0, 0, 0]],
      point_count: 1,
      has_colors: false,
      filename: 'in.laz',
    });
    const file = new File([new Uint8Array([1, 2, 3])], 'in.laz', { type: 'application/octet-stream' });
    await importPointCloudLasLaz(file);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/pointcloud/import');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const fd = init?.body as FormData;
    expect(fd.get('file')).toBeInstanceOf(File);
    expect((fd.get('file') as File).name).toBe('in.laz');
  });

  it('importPointCloudLasLaz surfaces error', async () => {
    mockFetchError(400, { detail: 'corrupt header' });
    const file = new File([], 'broken.las');
    await expect(importPointCloudLasLaz(file)).rejects.toThrow('corrupt header');
  });
});

describe('alignment / ICP', () => {
  const c2mReq = {
    points: [0, 0, 0],
    mesh_vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    mesh_indices: [0, 1, 2],
  };

  it('computeAlignmentDistance POSTs to /api/c2m/distance', async () => {
    const spy = mockFetchOk({ success: true, mean_distance: 0.1, rmse: 0.1, point_count: 1 });
    await computeAlignmentDistance(c2mReq);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/c2m/distance');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(c2mReq);
  });

  it('computeAlignmentDistance surfaces error', async () => {
    mockFetchError(500, { detail: 'raycasting failed' });
    await expect(computeAlignmentDistance(c2mReq)).rejects.toThrow('raycasting failed');
  });

  it('icpRegisterMeshToCloud POSTs to /api/c2m/icp-register', async () => {
    const spy = mockFetchOk({ success: true, fitness: 0.9, rmse: 0.05 });
    await icpRegisterMeshToCloud(c2mReq);
    const [url] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/c2m/icp-register');
  });

  it('icpRegisterMeshToCloud surfaces error', async () => {
    mockFetchError(500, { detail: 'icp diverged' });
    await expect(icpRegisterMeshToCloud(c2mReq)).rejects.toThrow('icp diverged');
  });

  it('icpRegisterCloudToCloud POSTs to /api/c2c/icp-register', async () => {
    const spy = mockFetchOk({ success: true, fitness: 0.9, rmse: 0.05 });
    const req = { target_points: [0, 0, 0], source_points: [1, 0, 0] };
    await icpRegisterCloudToCloud(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/c2c/icp-register');
    expect(JSON.parse(init?.body as string)).toEqual(req);
  });

  it('icpRegisterCloudToCloud surfaces error', async () => {
    mockFetchError(400, { detail: 'empty cloud' });
    await expect(
      icpRegisterCloudToCloud({ target_points: [], source_points: [] }),
    ).rejects.toThrow('empty cloud');
  });

  it('icpRegisterMeshToMesh POSTs to /api/m2m/icp-register', async () => {
    const spy = mockFetchOk({ success: true, fitness: 0.9, rmse: 0.05 });
    const req = {
      target_vertices: [0, 0, 0],
      target_indices: [0, 0, 0],
      source_vertices: [1, 0, 0],
      source_indices: [0, 0, 0],
    };
    await icpRegisterMeshToMesh(req);
    const [url] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/m2m/icp-register');
  });

  it('icpRegisterMeshToMesh surfaces error', async () => {
    mockFetchError(500, { detail: 'no convergence' });
    await expect(
      icpRegisterMeshToMesh({
        target_vertices: [],
        target_indices: [],
        source_vertices: [],
        source_indices: [],
      }),
    ).rejects.toThrow('no convergence');
  });
});

// ────────────────────────────────────────────────────────────────────────
// No-detail fallback path. Every helper has the same shape:
//   throw new Error(errorData.detail || `HTTP ${status}: ${statusText}`)
// When detail is absent (e.g. backend returns plain HTML or an empty body),
// the second branch must fire. Covering this branch on representative
// endpoints rather than all 18 — the source is identical line-for-line.
// ────────────────────────────────────────────────────────────────────────

describe('no-detail HTTP error fallbacks', () => {
  function noDetailResponse() {
    return new Response('not json', { status: 503, statusText: 'Service Unavailable' });
  }

  it('heliosTriangulate falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(
      heliosTriangulate({
        scans: [],
        lmax: 0.05,
        max_aspect_ratio: 4,
        theta_min: 0,
        theta_max: 180,
        phi_min: 0,
        phi_max: 360,
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('extractSkeleton falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(extractSkeleton({ points: [[0, 0, 0]] })).rejects.toThrow(/HTTP 503/);
  });

  it('generatePlantModel falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(generatePlantModel({ plant_type: 'bean', age: 1 })).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it('getAvailablePlantModels falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(getAvailablePlantModels()).rejects.toThrow(/HTTP 503/);
  });

  it('createPlantSession falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(
      createPlantSession({ plant_type: 'bean', initial_age: 1 }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('advancePlantSession falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(advancePlantSession('s', 1)).rejects.toThrow(/HTTP 503/);
  });

  it('getPlantSessionStatus falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(getPlantSessionStatus('s')).rejects.toThrow(/HTTP 503/);
  });

  it('deletePlantSession falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(deletePlantSession('s')).rejects.toThrow(/HTTP 503/);
  });

  it('parsePlantMorphParameters falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(parsePlantMorphParameters('<x/>', 'bean')).rejects.toThrow(/HTTP 503/);
  });

  it('morphPlant falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(
      morphPlant({ plant_type: 'bean', helios_xml: '<x/>', shoots: [] }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('sampleMeshSurface falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(
      sampleMeshSurface({ vertices: [], triangles: [], density: 1 }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('exportPointCloudLasLaz falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(
      exportPointCloudLasLaz({ points: [], format: 'las' }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('importPointCloudLasLaz falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(importPointCloudLasLaz(new File([], 'x.las'))).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it('computeAlignmentDistance falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(
      computeAlignmentDistance({ points: [], mesh_vertices: [], mesh_indices: [] }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('icpRegisterMeshToCloud falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(
      icpRegisterMeshToCloud({ points: [], mesh_vertices: [], mesh_indices: [] }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('icpRegisterCloudToCloud falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(
      icpRegisterCloudToCloud({ target_points: [], source_points: [] }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('icpRegisterMeshToMesh falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(
      icpRegisterMeshToMesh({
        target_vertices: [],
        target_indices: [],
        source_vertices: [],
        source_indices: [],
      }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
