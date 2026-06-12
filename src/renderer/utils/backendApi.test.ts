import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advancePlantSession,
  computeAlignmentDistance,
  createPlantSession,
  deletePlantSession,
  exportPointCloudLasLaz,
  exportScanXml,
  extractSkeleton,
  generatePlantCanopy,
  generatePlantModel,
  generatePlantStreaming,
  getAvailablePlantModels,
  getBackendUrl,
  getPlantSessionStatus,
  heliosTriangulate,
  icpRegisterCloudToCloud,
  icpRegisterMeshToCloud,
  icpRegisterMeshToMesh,
  importPointCloudLasLaz,
  importPointCloudByPath,
  importTexturedMesh,
  morphPlant,
  parsePlantMorphParameters,
  runLidarScan,
  segmentGround,
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

function mockFetchOk(body: unknown) {
  return vi
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
}

function mockFetchError(status: number, body: unknown) {
  return vi
    .spyOn(global, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status, statusText: 'Error' }),
    );
}

// Build a PHB1 binary frame (matching _bin_frame_bytes / decodeBinaryFrame) and
// mock fetch to return it, for endpoints that use the binary transport.
function mockFetchBinaryFrame(
  meta: Record<string, unknown>,
  buffers: Array<{ name: string; dtype: 'f32' | 'u32'; data: number[] }>,
) {
  const enc = new TextEncoder();
  const descs = buffers.map(b => ({ name: b.name, dtype: b.dtype, length: b.data.length }));
  let headerBytes = enc.encode(JSON.stringify({ meta, buffers: descs }));
  const pad = (4 - (headerBytes.length % 4)) % 4;
  if (pad) headerBytes = enc.encode(JSON.stringify({ meta, buffers: descs }) + ' '.repeat(pad));
  const payloadLen = buffers.reduce((n, b) => n + b.data.length * 4, 0);
  const buf = new ArrayBuffer(8 + headerBytes.length + payloadLen);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  u8[0] = 0x50; u8[1] = 0x48; u8[2] = 0x42; u8[3] = 0x31; // 'PHB1'
  dv.setUint32(4, headerBytes.length, true);
  u8.set(headerBytes, 8);
  let off = 8 + headerBytes.length;
  for (const b of buffers) {
    if (b.dtype === 'f32') new Float32Array(buf, off, b.data.length).set(b.data);
    else new Uint32Array(buf, off, b.data.length).set(b.data);
    off += b.data.length * 4;
  }
  return vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(buf, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
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

  it('POSTs to /api/triangulate and decodes the binary frame', async () => {
    const spy = mockFetchBinaryFrame(
      { success: true, num_vertices: 3, num_triangles: 1, method_used: 'ball_pivoting', surface_area: 0.5 },
      [
        { name: 'vertices', dtype: 'f32', data: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
        { name: 'indices', dtype: 'u32', data: [0, 1, 2] },
      ],
    );
    const result = await triangulatePointCloud(req);
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/triangulate');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
    expect(result.success).toBe(true);
    expect(result.numTriangles).toBe(1);
    expect(Array.from(result.triangles)).toEqual([0, 1, 2]);
    expect(result.methodUsed).toBe('ball_pivoting');
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

  it('POSTs to /api/triangulate/helios and decodes the binary frame', async () => {
    const spy = mockFetchBinaryFrame(
      { success: true, num_triangles: 1, num_vertices: 3, cap_lmax: 1, cap_aspect: 1e9, candidate_count: 1 },
      [
        { name: 'vertices', dtype: 'f32', data: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
        { name: 'triangles', dtype: 'u32', data: [0, 1, 2] },
        { name: 'triangle_scan_ids', dtype: 'u32', data: [0] },
        { name: 'triangle_cell_ids', dtype: 'u32', data: [0] },
      ],
    );
    const result = await heliosTriangulate(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/triangulate/helios');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
    expect(result.success).toBe(true);
    expect(result.numTriangles).toBe(1);
    expect(Array.from(result.triangles)).toEqual([0, 1, 2]);
    expect(result.vertices.length).toBe(9);
    expect(result.capLmax).toBe(1);
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

describe('segmentGround', () => {
  const req = {
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    cloth_resolution: 0.05,
    class_threshold: 0.02,
  };

  it('POSTs to /api/segment/ground and returns labels', async () => {
    const expected = {
      success: true,
      labels: [1, 1, 2],
      num_ground: 2,
      num_plant: 1,
      num_points: 3,
    };
    const spy = mockFetchOk(expected);
    const result = await segmentGround(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/segment/ground');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
    expect(result).toEqual(expected);
  });

  it('accepts a source descriptor instead of inline points', async () => {
    const spy = mockFetchOk({ success: true, labels: [], num_ground: 0, num_plant: 0, num_points: 0 });
    await segmentGround({ source: { source_path: '/tmp/scan.xyz', ascii_format: 'x y z' } });
    const body = JSON.parse(spy.mock.calls[0][1]?.body as string);
    expect(body.source.source_path).toBe('/tmp/scan.xyz');
  });

  it('surfaces detail on error', async () => {
    mockFetchError(500, { detail: 'CSF not installed' });
    await expect(segmentGround(req)).rejects.toThrow('CSF not installed');
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

describe('generatePlantCanopy', () => {
  const req = {
    plant_type: 'bean', age: 15,
    center_x: 0, center_y: 0, center_z: 0,
    spacing_x: 0.5, spacing_y: 0.5,
    count_x: 2, count_y: 2, germination_rate: 1.0,
  };

  it('POSTs the canopy request to /api/plant/canopy/generate', async () => {
    const expected = {
      success: true, vertices: [], indices: [], vertex_count: 0, triangle_count: 0,
      plant_type: 'bean', age: 15, plant_count: 4, count_x: 2, count_y: 2,
    };
    const spy = mockFetchOk(expected);
    await generatePlantCanopy(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/plant/canopy/generate');
    expect(JSON.parse(init?.body as string)).toEqual(req);
  });

  it('surfaces detail on error', async () => {
    mockFetchError(400, { detail: 'counts must be positive' });
    await expect(generatePlantCanopy(req)).rejects.toThrow('counts must be positive');
  });
});

// Build a text/event-stream Response from raw SSE frame strings.
function mockSSE(frames: string[]) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return vi
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
}

describe('generatePlantStreaming', () => {
  const payload = { mode: 'canopy' as const, request: { plant_type: 'bean', age: 10, count_x: 2, count_y: 2 } };

  it('reports progress and resolves with the result event', async () => {
    const spy = mockSSE([
      'event: progress\ndata: {"progress":0.3,"message":"Growing plants..."}\n\n',
      'event: progress\ndata: {"progress":0.8,"message":"Packing geometry..."}\n\n',
      'event: result\ndata: {"success":true,"triangle_count":1234,"plant_count":4}\n\n',
    ]);
    const seen: Array<[number, string]> = [];
    const res = await generatePlantStreaming(payload, (p, m) => seen.push([p, m]));

    // POSTs the flattened mode + request to the stream endpoint.
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/plant/generate/stream');
    expect(JSON.parse(init?.body as string)).toEqual({ mode: 'canopy', plant_type: 'bean', age: 10, count_x: 2, count_y: 2 });

    expect(seen).toEqual([[0.3, 'Growing plants...'], [0.8, 'Packing geometry...']]);
    expect(res.success).toBe(true);
    expect(res.triangle_count).toBe(1234);
  });

  it('throws on an error event', async () => {
    mockSSE(['event: error\ndata: {"detail":"No plants germinated."}\n\n']);
    await expect(generatePlantStreaming(payload, () => {})).rejects.toThrow('No plants germinated.');
  });

  it('handles frames split across stream chunks', async () => {
    // The result frame arrives in two reads; the parser must buffer across them.
    mockSSE([
      'event: result\ndata: {"success":true,',
      '"triangle_count":7}\n\n',
    ]);
    const res = await generatePlantStreaming(payload, () => {});
    expect(res.triangle_count).toBe(7);
  });
});

describe('importTexturedMesh', () => {
  it('POSTs the disk path to /api/mesh/import', async () => {
    const expected = {
      success: true,
      vertices: [[0, 0, 0]],
      indices: [[0, 1, 2]],
      vertex_count: 6,
      triangle_count: 2,
      has_textures: true,
    };
    const spy = mockFetchOk(expected);
    const res = await importTexturedMesh('/abs/path/model.obj');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/mesh/import');
    expect(JSON.parse(init?.body as string)).toEqual({ path: '/abs/path/model.obj' });
    expect(res.has_textures).toBe(true);
  });

  it('surfaces detail on error', async () => {
    mockFetchError(404, { detail: 'Mesh file not found' });
    await expect(importTexturedMesh('/missing.obj')).rejects.toThrow('Mesh file not found');
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
    const req = { plant_type: 'bean', helios_xml: '<xml/>' };
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
      morphPlant({ plant_type: 'bean', helios_xml: '<xml/>' }),
    ).rejects.toThrow('morph blew up');
  });
});

describe('runLidarScan', () => {
  it('POSTs to /api/lidar/scan with meshes and scanners', async () => {
    const req = {
      meshes: [{ vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]] }],
      scanners: [{
        id: 'scanner-1',
        origin: [0, 0, 2],
        n_theta: 50, n_phi: 50,
        theta_min_deg: 0, theta_max_deg: 180,
        phi_min_deg: 0, phi_max_deg: 360,
        return_type: 'single' as const,
        exit_diameter_m: 0, beam_divergence_mrad: 0,
        tilt_roll_deg: 0, tilt_pitch_deg: 0,
        range_noise_m: 0, angle_noise_mrad: 0,
      }],
    };
    const spy = mockFetchBinaryFrame(
      {
        success: true,
        scanners: [{
          scanner_id: 'scanner-1', num_points: 1, has_colors: true,
          scalar_fields: ['intensity'],
        }],
      },
      [
        { name: 's0.points', dtype: 'f32', data: [0.1, 0.1, 0] },
        { name: 's0.colors', dtype: 'f32', data: [1, 1, 1] },
        { name: 's0.scalar0', dtype: 'f32', data: [0.9] },
      ],
    );
    const res = await runLidarScan(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/lidar/scan');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
    expect(res.results).toHaveLength(1);
    expect(res.results[0].scannerId).toBe('scanner-1');
    expect(res.results[0].numPoints).toBe(1);
    expect(Array.from(res.results[0].scalars.intensity)).toEqual([expect.closeTo(0.9, 5)]);
  });

  it('surfaces error', async () => {
    mockFetchError(500, { detail: 'lidar plugin unavailable' });
    await expect(
      runLidarScan({ meshes: [], scanners: [] }),
    ).rejects.toThrow('lidar plugin unavailable');
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

  it('exportScanXml POSTs to /api/scan/export-xml with the scan bundle request', async () => {
    const req = {
      scans: [{
        origin: [0, 0, 3] as [number, number, number],
        session_id: 'sess-1',
        translation: [1, 2, 3] as [number, number, number],
      }],
      base_name: 'myscan',
      include_misses: false,
      write_xml: true,
    };
    const spy = mockFetchOk({
      success: true,
      files: [{ name: 'myscan.xml', data: 'eA==', is_xml: true }],
      point_count: 10,
      scan_count: 1,
    });
    const resp = await exportScanXml(req);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/scan/export-xml');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
    expect(resp.files?.[0].name).toBe('myscan.xml');
  });

  it('exportScanXml forwards data_format for the data-only path', async () => {
    const req = {
      scans: [{ origin: [0, 0, 3] as [number, number, number], session_id: 's' }],
      base_name: 'out',
      include_misses: true,
      write_xml: false,
      data_format: 'e57',
    };
    const spy = mockFetchOk({ success: true, files: [{ name: 'out_0.e57', data: 'eA==', is_xml: false }] });
    await exportScanXml(req);
    expect(JSON.parse(spy.mock.calls[0][1]?.body as string)).toEqual(req);
  });

  it('exportScanXml surfaces error', async () => {
    mockFetchError(500, { detail: 'export boom' });
    await expect(
      exportScanXml({ scans: [], include_misses: true, write_xml: true }),
    ).rejects.toThrow('export boom');
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

describe('importPointCloudByPath (renamed from importXyzByPath; now also serves PLY/PCD)', () => {
  // Build the same packed binary the backend streams back. Layout is
  // documented on /api/pointcloud/import_xyz_by_path. Kept duplicate from
  // pointCloudParsers.test.ts so each suite can be read in isolation.
  function pack(
    points: number[][],
    opts: { colors?: number[][]; intensity?: number[] } = {},
  ): ArrayBuffer {
    const n = points.length;
    const hasColors = !!opts.colors;
    const hasIntensity = !!opts.intensity;
    const HEADER = 32;
    const posBytes = n * 3 * 4;
    const colBytes = hasColors ? n * 3 * 4 : 0;
    const intBytes = hasIntensity ? n * 4 : 0;
    const buf = new ArrayBuffer(HEADER + posBytes + colBytes + intBytes);
    const u8 = new Uint8Array(buf);
    u8.set([0x50, 0x48, 0x58, 0x31], 0); // 'PHX1'
    new DataView(buf).setUint32(4, n, true);
    u8[8] = hasColors ? 1 : 0;
    u8[9] = hasIntensity ? 1 : 0;
    const pos = new Float32Array(buf, HEADER, n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = points[i][0];
      pos[i * 3 + 1] = points[i][1];
      pos[i * 3 + 2] = points[i][2];
    }
    if (hasColors) {
      const c = new Float32Array(buf, HEADER + posBytes, n * 3);
      for (let i = 0; i < n; i++) {
        c[i * 3] = opts.colors![i][0];
        c[i * 3 + 1] = opts.colors![i][1];
        c[i * 3 + 2] = opts.colors![i][2];
      }
    }
    if (hasIntensity) {
      const a = new Float32Array(buf, HEADER + posBytes + colBytes, n);
      for (let i = 0; i < n; i++) a[i] = opts.intensity![i];
    }
    return buf;
  }

  it('POSTs JSON to /api/pointcloud/import_xyz_by_path and decodes a positions-only response', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(pack([[1, 2, 3], [4, 5, 6]]), { status: 200 }));
    const result = await importPointCloudByPath('/abs/scan.xyz');
    expect(result.pointCount).toBe(2);
    expect(Array.from(result.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.colors).toBeNull();
    expect(result.intensity).toBeNull();
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8008/api/pointcloud/import_by_path');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      file_path: '/abs/scan.xyz',
      ascii_format: null,
      column_plan: null,
    });
  });

  it('forwards ascii_format when provided', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(pack([[0, 0, 0]]), { status: 200 }));
    await importPointCloudByPath('/a.xyz', 'x y z reflectance');
    const body = JSON.parse(spy.mock.calls[0][1]?.body as string);
    expect(body.ascii_format).toBe('x y z reflectance');
  });

  it('decodes colors and intensity from the binary payload', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        pack([[0, 0, 0]], { colors: [[0.25, 0.5, 0.75]], intensity: [42] }),
        { status: 200 },
      ),
    );
    const result = await importPointCloudByPath('/a.xyz');
    expect(Array.from(result.colors!)).toEqual([0.25, 0.5, 0.75]);
    expect(Array.from(result.intensity!)).toEqual([42]);
  });

  it('rejects a non-OK response by parsing the JSON detail field', async () => {
    mockFetchError(404, { detail: 'File not found: /missing.xyz' });
    await expect(importPointCloudByPath('/missing.xyz')).rejects.toThrow(/File not found/);
  });

  it('rejects when the binary magic is wrong', async () => {
    const bad = new ArrayBuffer(32);
    new Uint8Array(bad).set([0, 0, 0, 0]);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(bad, { status: 200 }));
    await expect(importPointCloudByPath('/a.xyz')).rejects.toThrow(/magic/);
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
      morphPlant({ plant_type: 'bean', helios_xml: '<x/>' }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('runLidarScan falls back', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(noDetailResponse());
    await expect(
      runLidarScan({ meshes: [], scanners: [] }),
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
