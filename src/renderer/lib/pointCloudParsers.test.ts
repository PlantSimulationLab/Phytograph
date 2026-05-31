import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isMeshFile,
  isSkeletonFile,
  MESH_FORMATS,
  parseLAS,
  parseLAZ,
  parseMesh,
  parseOBJMesh,
  parsePCD,
  parsePLY,
  parsePointCloud,
  parsePointCloudFromPath,
  parseSkeleton,
  parseSkeletonJSON,
  parseSkeletonOBJ,
  parseSTLMesh,
  parseXYZ,
  POINT_CLOUD_FORMATS,
  SKELETON_FORMATS,
  SUPPORTED_FORMATS,
} from './pointCloudParsers';

// Helper to wrap text content in a File object that the parsers accept.
function textFile(content: string, name: string): File {
  return new File([content], name, { type: 'text/plain' });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────
// parseXYZ — covers CSV / TXT / XYZ / PTS / ASC paths.
// ────────────────────────────────────────────────────────────────────────

describe('parseXYZ', () => {
  it('parses headerless space-separated XYZ', async () => {
    const file = textFile('1.0 2.0 3.0\n4.0 5.0 6.0\n', 'cloud.xyz');
    const data = await parseXYZ(file);
    expect(data.pointCount).toBe(2);
    expect(Array.from(data.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(data.bounds.min.x).toBeCloseTo(1);
    expect(data.bounds.max.x).toBeCloseTo(4);
    expect(data.fileName).toBe('cloud.xyz');
  });

  it('handles comments and blank lines', async () => {
    const file = textFile('# header comment\n\n1 2 3\n// another comment\n4 5 6\n', 'cloud.txt');
    const data = await parseXYZ(file);
    expect(data.pointCount).toBe(2);
  });

  it('parses CSV with a header row and min-max-normalises intensity', async () => {
    const file = textFile('x,y,z,intensity\n0,0,0,0.5\n1,1,1,0.8\n', 'cloud.csv');
    const data = await parseXYZ(file);
    expect(data.pointCount).toBe(2);
    expect(Array.from(data.positions.slice(0, 3))).toEqual([0, 0, 0]);
    // The parser min-max normalises intensities to [0, 1]:
    // min=0.5, max=0.8 → values become (0, 1).
    expect(data.intensities?.[0]).toBeCloseTo(0);
    expect(data.intensities?.[1]).toBeCloseTo(1);
  });

  it('detects RGB columns and normalises 0-255 to 0-1', async () => {
    const file = textFile('x y z r g b\n0 0 0 255 0 0\n1 1 1 0 255 0\n', 'cloud.txt');
    const data = await parseXYZ(file);
    expect(data.colors).toBeDefined();
    expect(data.colors![0]).toBeCloseTo(1);
    expect(data.colors![4]).toBeCloseTo(1);
  });

  it('rejects an empty file', async () => {
    const file = textFile('', 'empty.xyz');
    await expect(parseXYZ(file)).rejects.toThrow(/No data found/);
  });

  it('rejects a file with lines but no parseable coordinates', async () => {
    // Non-empty, but no line yields a numeric X Y Z triplet — must fail loudly
    // instead of returning 0 points with a NaN center.
    const file = textFile('<helios>\n  <scan>\n  </scan>\n</helios>\n', 'meta.xyz');
    await expect(parseXYZ(file)).rejects.toThrow(/No point coordinates found/);
  });

  it('parses tab-delimited variant', async () => {
    const file = textFile('1\t2\t3\n4\t5\t6\n', 'cloud.txt');
    const data = await parseXYZ(file);
    expect(data.pointCount).toBe(2);
  });

  it('parses semicolon-delimited variant', async () => {
    const file = textFile('1;2;3\n4;5;6\n', 'cloud.csv');
    const data = await parseXYZ(file);
    expect(data.pointCount).toBe(2);
  });

  // RIEGL and some other LiDAR exporters write a comma-delimited header
  // above space-delimited data rows. Detect the data delimiter from the
  // first data row, not the header.
  it('handles comma-delimited header over space-delimited data', async () => {
    const content =
      'XYZ[0][m],XYZ[1][m],XYZ[2][m],Reflectance[dB]\n' +
      '2.79 -21.54 -16.10 -16.08\n' +
      '2.80 -21.55 -16.09 -14.10\n';
    const file = textFile(content, 'cloud.txt');
    const data = await parseXYZ(file);
    expect(data.pointCount).toBe(2);
    expect(Array.from(data.positions.slice(0, 3))).toEqual([
      expect.closeTo(2.79, 2),
      expect.closeTo(-21.54, 2),
      expect.closeTo(-16.10, 2),
    ]);
    expect(data.bounds.center.x).not.toBeNaN();
    expect(data.intensities).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// parsePointCloud — format dispatch / actionable rejections.
// ────────────────────────────────────────────────────────────────────────

describe('parsePointCloud', () => {
  it('routes a supported extension to the right parser', async () => {
    const data = await parsePointCloud(textFile('1 2 3\n4 5 6\n', 'cloud.xyz'));
    expect(data.pointCount).toBe(2);
  });

  it('rejects a Helios scan XML with a message pointing at New Scan', async () => {
    // Importing scan-definition XML directly used to fall through to the XYZ
    // parser and silently produce 0 points / a NaN center. It must now fail
    // with an actionable message instead.
    const xml =
      '<?xml version="1.0"?>\n<helios>\n  <scan>\n    <origin>0 0 0.5</origin>\n' +
      '    <filename>ground_scan_0.xyz</filename>\n  </scan>\n</helios>\n';
    await expect(parsePointCloud(textFile(xml, 'ground_scan.xml'))).rejects.toThrow(
      /scan definition.*Add Scan.*Import from XML file/s,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// parsePLY — ASCII PLY only; binary path tested as expected error.
// ────────────────────────────────────────────────────────────────────────

describe('parsePLY', () => {
  it('parses ASCII PLY without colors', async () => {
    const content = [
      'ply',
      'format ascii 1.0',
      'element vertex 2',
      'property float x',
      'property float y',
      'property float z',
      'end_header',
      '0 0 0',
      '1 2 3',
      '',
    ].join('\n');
    const file = textFile(content, 'cloud.ply');
    const data = await parsePLY(file);
    expect(data.pointCount).toBe(2);
    expect(Array.from(data.positions.slice(3, 6))).toEqual([1, 2, 3]);
  });

  it('parses ASCII PLY with colors (0-255 range)', async () => {
    const content = [
      'ply',
      'format ascii 1.0',
      'element vertex 1',
      'property float x',
      'property float y',
      'property float z',
      'property uchar red',
      'property uchar green',
      'property uchar blue',
      'end_header',
      '0 0 0 255 128 0',
      '',
    ].join('\n');
    const file = textFile(content, 'cloud.ply');
    const data = await parsePLY(file);
    expect(data.colors).toBeDefined();
    expect(data.colors![0]).toBeCloseTo(1);
    expect(data.colors![1]).toBeCloseTo(128 / 255);
  });

  it('throws on missing end_header', async () => {
    const file = textFile('ply\nformat ascii 1.0\n', 'bad.ply');
    await expect(parsePLY(file)).rejects.toThrow(/no end_header/);
  });

  it('throws on zero vertex count', async () => {
    const file = textFile('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n', 'empty.ply');
    await expect(parsePLY(file)).rejects.toThrow(/No vertices/);
  });

  it('throws when x/y/z properties are missing', async () => {
    const content = [
      'ply',
      'format ascii 1.0',
      'element vertex 1',
      'property float r',
      'end_header',
      '0.5',
      '',
    ].join('\n');
    await expect(parsePLY(textFile(content, 'bad.ply'))).rejects.toThrow(/x, y, z properties/);
  });

  it('rejects binary PLY format', async () => {
    const content = [
      'ply',
      'format binary_little_endian 1.0',
      'element vertex 1',
      'property float x',
      'property float y',
      'property float z',
      'end_header',
      '',
    ].join('\n');
    await expect(parsePLY(textFile(content, 'bin.ply'))).rejects.toThrow(/Binary PLY/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// parsePCD — ASCII PCD only.
// ────────────────────────────────────────────────────────────────────────

describe('parsePCD', () => {
  it('parses ASCII PCD', async () => {
    const content = [
      'FIELDS x y z intensity',
      'POINTS 2',
      'DATA ascii',
      '0 0 0 0.5',
      '1 2 3 0.8',
      '',
    ].join('\n');
    const data = await parsePCD(textFile(content, 'cloud.pcd'));
    expect(data.pointCount).toBe(2);
    expect(Array.from(data.positions.slice(3, 6))).toEqual([1, 2, 3]);
    expect(data.intensities?.[0]).toBeCloseTo(0.5);
  });

  it('throws on missing POINTS', async () => {
    const content = ['FIELDS x y z', 'DATA ascii', '0 0 0', ''].join('\n');
    await expect(parsePCD(textFile(content, 'bad.pcd'))).rejects.toThrow(/No points/);
  });

  it('throws on missing xyz fields', async () => {
    const content = ['FIELDS intensity', 'POINTS 1', 'DATA ascii', '0.5', ''].join('\n');
    await expect(parsePCD(textFile(content, 'bad.pcd'))).rejects.toThrow(/x, y, z fields/);
  });

  it('rejects binary PCD', async () => {
    const content = ['FIELDS x y z', 'POINTS 1', 'DATA binary', ''].join('\n');
    await expect(parsePCD(textFile(content, 'bin.pcd'))).rejects.toThrow(/Binary PCD/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// parseLAS — build a tiny LAS 1.2 point-format-0 file in memory.
// Header layout reference: ASPRS LAS 1.2 spec.
// ────────────────────────────────────────────────────────────────────────

function makeMinimalLasBuffer(): ArrayBuffer {
  const headerSize = 227; // LAS 1.2 header size
  const recordLength = 20; // Point format 0
  const numPoints = 2;
  const buf = new ArrayBuffer(headerSize + recordLength * numPoints);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Signature 'LASF'
  bytes[0] = 0x4c;
  bytes[1] = 0x41;
  bytes[2] = 0x53;
  bytes[3] = 0x46;
  // Version major/minor at offsets 24, 25.
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  // Header size (uint16 LE @ 94).
  view.setUint16(94, headerSize, true);
  // Point data offset (uint32 LE @ 96).
  view.setUint32(96, headerSize, true);
  // Point data format (uint8 @ 104) — 0 = xyz + intensity + return info + class.
  view.setUint8(104, 0);
  // Point record length (uint16 LE @ 105).
  view.setUint16(105, recordLength, true);
  // Point count (uint32 LE @ 107) for LAS 1.0-1.3.
  view.setUint32(107, numPoints, true);
  // Scale x/y/z @ 131/139/147.
  view.setFloat64(131, 0.01, true);
  view.setFloat64(139, 0.01, true);
  view.setFloat64(147, 0.01, true);
  // Offset x/y/z @ 155/163/171 — all zero (default ArrayBuffer state).

  // Two points: (100, 200, 300) and (400, 500, 600) in scaled int32 form.
  // With scale=0.01, real values become (1.0, 2.0, 3.0) and (4.0, 5.0, 6.0).
  let off = headerSize;
  view.setInt32(off, 100, true);
  view.setInt32(off + 4, 200, true);
  view.setInt32(off + 8, 300, true);
  view.setUint16(off + 12, 32768, true); // intensity (mid-range)
  view.setUint8(off + 14, 0); // return byte
  view.setUint8(off + 15, 2); // classification = ground
  view.setInt8(off + 16, 5); // scan angle
  view.setUint8(off + 17, 0); // user data
  view.setUint16(off + 18, 1, true); // point source ID

  off += recordLength;
  view.setInt32(off, 400, true);
  view.setInt32(off + 4, 500, true);
  view.setInt32(off + 8, 600, true);
  view.setUint16(off + 12, 16384, true);
  view.setUint8(off + 14, 0);
  view.setUint8(off + 15, 5); // classification = high veg (different from point 1)
  view.setInt8(off + 16, -3);
  view.setUint8(off + 17, 0);
  view.setUint16(off + 18, 2, true);

  return buf;
}

describe('parseLAS', () => {
  it('parses a synthetic LAS 1.2 point-format-0 file', async () => {
    const buf = makeMinimalLasBuffer();
    const file = new File([buf], 'cloud.las');
    const data = await parseLAS(file);
    expect(data.pointCount).toBe(2);
    expect(Array.from(data.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    // Classification has variance (2 and 5), so it should surface as scalar field.
    expect(data.scalarFields?.['Classification']).toBeDefined();
    expect(data.scalarFields?.['Classification'].min).toBe(2);
    expect(data.scalarFields?.['Classification'].max).toBe(5);
    expect(data.scalarFields?.['Point Source ID']).toBeDefined();
  });

  it('rejects files with a wrong signature', async () => {
    const buf = new ArrayBuffer(300);
    const file = new File([buf], 'bad.las');
    await expect(parseLAS(file)).rejects.toThrow(/signature mismatch/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// parseLAZ — goes through the backend; we stub fetch.
// ────────────────────────────────────────────────────────────────────────

describe('parseLAZ', () => {
  it('forwards to the backend and returns a PointCloudData', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          points: [
            [1, 2, 3],
            [4, 5, 6],
          ],
          point_count: 2,
          has_colors: false,
        }),
        { status: 200 },
      ),
    );
    const file = new File([new Uint8Array([0])], 'cloud.laz');
    const data = await parseLAZ(file);
    expect(data.pointCount).toBe(2);
    expect(Array.from(data.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(data.fileName).toBe('cloud.laz');
  });

  it('surfaces backend error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'bad file' }), { status: 200 }),
    );
    const file = new File([new Uint8Array([0])], 'cloud.laz');
    await expect(parseLAZ(file)).rejects.toThrow(/bad file|Failed to import LAZ/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Mesh parsers.
// ────────────────────────────────────────────────────────────────────────

describe('parseOBJMesh', () => {
  it('parses vertices, normals, and triangles', async () => {
    const content = [
      '# comment',
      'v 0 0 0',
      'v 1 0 0',
      'v 0 1 0',
      'vn 0 0 1',
      'f 1//1 2//1 3//1',
      '',
    ].join('\n');
    const mesh = await parseOBJMesh(textFile(content, 'tri.obj'));
    expect(mesh.vertexCount).toBe(3);
    expect(mesh.triangleCount).toBe(1);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
    expect(mesh.normals).toBeDefined();
  });

  it('fan-triangulates polygons with more than 3 vertices', async () => {
    const content = ['v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'f 1 2 3 4', ''].join('\n');
    const mesh = await parseOBJMesh(textFile(content, 'quad.obj'));
    // Fan triangulation of 4 verts → 2 triangles.
    expect(mesh.triangleCount).toBe(2);
  });

  it('throws when the file has no mesh data', async () => {
    await expect(parseOBJMesh(textFile('# only comments\n', 'empty.obj'))).rejects.toThrow(
      /No mesh data/,
    );
  });
});

describe('parseSTLMesh', () => {
  it('parses ASCII STL', async () => {
    const content = [
      'solid test',
      'facet normal 0 0 1',
      'outer loop',
      'vertex 0 0 0',
      'vertex 1 0 0',
      'vertex 0 1 0',
      'endloop',
      'endfacet',
      'endsolid test',
      '',
    ].join('\n');
    const mesh = await parseSTLMesh(textFile(content, 'tri.stl'));
    expect(mesh.vertexCount).toBe(3);
    expect(mesh.triangleCount).toBe(1);
    expect(mesh.normals![2]).toBeCloseTo(1);
  });

  it('throws on empty STL', async () => {
    await expect(parseSTLMesh(textFile('solid empty\nendsolid empty\n', 'empty.stl'))).rejects.toThrow(
      /No mesh data/,
    );
  });
});

describe('parseMesh (auto-detect)', () => {
  it('dispatches to OBJ', async () => {
    const mesh = await parseMesh(textFile('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', 'x.obj'));
    expect(mesh.triangleCount).toBe(1);
  });

  it('dispatches to STL', async () => {
    const content = [
      'solid s',
      'facet normal 0 0 1',
      'outer loop',
      'vertex 0 0 0',
      'vertex 1 0 0',
      'vertex 0 1 0',
      'endloop',
      'endfacet',
      'endsolid',
      '',
    ].join('\n');
    const mesh = await parseMesh(textFile(content, 'x.stl'));
    expect(mesh.triangleCount).toBe(1);
  });

  it('rejects unsupported extensions', async () => {
    await expect(parseMesh(textFile('x', 'mesh.xyz'))).rejects.toThrow(/Unsupported mesh/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Skeleton parsers.
// ────────────────────────────────────────────────────────────────────────

describe('parseSkeletonJSON', () => {
  it('parses our exported skeleton JSON format', async () => {
    const json = JSON.stringify({
      nodes: [
        { x: 0, y: 0, z: 0, branchOrder: 1 },
        { x: 0, y: 0, z: 1, branchOrder: 1 },
      ],
      edges: [[0, 1]],
      metadata: { totalLength: 1, maxBranchOrder: 1 },
    });
    const sk = await parseSkeletonJSON(textFile(json, 'sk.json'));
    expect(sk.pointCount).toBe(2);
    expect(sk.edges).toEqual([[0, 1]]);
    expect(sk.totalLength).toBe(1);
    expect(sk.maxBranchOrder).toBe(1);
  });

  it('rejects JSON without a nodes array', async () => {
    await expect(parseSkeletonJSON(textFile('{}', 'bad.json'))).rejects.toThrow(
      /Invalid skeleton JSON/,
    );
  });
});

describe('parseSkeletonOBJ', () => {
  it('parses vertices and line edges and computes total length', async () => {
    const content = ['v 0 0 0', 'v 0 0 1', 'v 0 0 3', 'l 1 2', 'l 2 3', ''].join('\n');
    const sk = await parseSkeletonOBJ(textFile(content, 'sk.obj'));
    expect(sk.pointCount).toBe(3);
    expect(sk.edges).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(sk.totalLength).toBeCloseTo(3);
  });

  it('throws when no vertices are present', async () => {
    await expect(parseSkeletonOBJ(textFile('# nothing\n', 'empty.obj'))).rejects.toThrow(
      /No skeleton data/,
    );
  });
});

describe('parseSkeleton (auto-detect)', () => {
  it('dispatches to JSON', async () => {
    const json = JSON.stringify({ nodes: [{ x: 0, y: 0, z: 0, branchOrder: 1 }] });
    const sk = await parseSkeleton(textFile(json, 'sk.json'));
    expect(sk.pointCount).toBe(1);
  });

  it('rejects unsupported extensions', async () => {
    await expect(parseSkeleton(textFile('x', 'sk.txt'))).rejects.toThrow(/Unsupported skeleton/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// parsePointCloud (auto-detect) and predicates / format lists.
// ────────────────────────────────────────────────────────────────────────

describe('parsePointCloud (auto-detect)', () => {
  it('routes .xyz to parseXYZ', async () => {
    const data = await parsePointCloud(textFile('1 2 3\n', 'a.xyz'));
    expect(data.pointCount).toBe(1);
  });

  it('routes .csv to parseXYZ', async () => {
    const data = await parsePointCloud(textFile('1,2,3\n', 'a.csv'));
    expect(data.pointCount).toBe(1);
  });

  it('routes .ply to parsePLY', async () => {
    const content = [
      'ply',
      'format ascii 1.0',
      'element vertex 1',
      'property float x',
      'property float y',
      'property float z',
      'end_header',
      '0 0 0',
      '',
    ].join('\n');
    const data = await parsePointCloud(textFile(content, 'a.ply'));
    expect(data.pointCount).toBe(1);
  });

  it('routes .pcd to parsePCD', async () => {
    const content = ['FIELDS x y z', 'POINTS 1', 'DATA ascii', '0 0 0', ''].join('\n');
    const data = await parsePointCloud(textFile(content, 'a.pcd'));
    expect(data.pointCount).toBe(1);
  });

  it('routes .las to parseLAS', async () => {
    const file = new File([makeMinimalLasBuffer()], 'a.las');
    const data = await parsePointCloud(file);
    expect(data.pointCount).toBe(2);
  });

  it('falls back to XYZ for unknown extensions when content looks valid', async () => {
    const data = await parsePointCloud(textFile('1 2 3\n4 5 6\n', 'a.weird'));
    expect(data.pointCount).toBe(2);
  });

  it('throws on unknown extension with non-XYZ content', async () => {
    await expect(
      parsePointCloud(textFile('# this has no numbers\n', 'a.weird')),
    ).rejects.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────
// parsePointCloudFromPath — every supported point-cloud format (XYZ-family,
// PLY, PCD, LAS, LAZ) routes to the backend's convert_to_octree. Only inputs
// with no on-disk path fall back to the in-renderer parsers via fs.readBinary.
// ────────────────────────────────────────────────────────────────────────


describe('parsePointCloudFromPath', () => {
  // Helper: build an OctreeMetadata-shaped JSON response, matching the
  // backend's convert_to_octree contract.
  const makeOctreeMetadataResponse = (overrides: Record<string, unknown> = {}) => new Response(
    JSON.stringify({
      cache_id: 'a'.repeat(40),
      cache_dir: `/cache/${'a'.repeat(40)}`,
      cached: false,
      version: '2.0',
      point_count: 2,
      spacing: 0.1,
      scale: [0.001, 0.001, 0.001],
      offset: [0, 0, 0],
      bounds: { min: [1, 2, 3], max: [4, 5, 6] },
      attributes: [
        { name: 'position', size: 12, type: 'int32', num_elements: 3 },
        { name: 'rgb', size: 6, type: 'uint16', num_elements: 3 },
        { name: 'intensity', size: 2, type: 'uint16', num_elements: 1 },
      ],
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

  it('routes .xyz to convert_to_octree and produces an octree-backed cloud', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(makeOctreeMetadataResponse());
    const data = await parsePointCloudFromPath('/abs/path/scan.xyz');
    expect(data.pointCount).toBe(2);
    expect(data.fileName).toBe('scan.xyz');
    // Bounds come straight from the converter's metadata.
    expect(data.bounds.min.x).toBe(1);
    expect(data.bounds.max.x).toBe(4);
    // The octree handle is the source of truth for rendering; positions
    // is intentionally empty so V8 doesn't hold the whole flat cloud.
    expect(data.octree?.cacheId).toBe('a'.repeat(40));
    expect(data.octree?.sourceXyzPath).toBe('/abs/path/scan.xyz');
    expect(data.positions.length).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/api/pointcloud/convert_to_octree');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ source_path: '/abs/path/scan.xyz', ascii_format: null });
  });

  it('forwards ascii_format to convert_to_octree when provided', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(makeOctreeMetadataResponse());
    await parsePointCloudFromPath('/p/a.xyz', 'x y z r255 g255 b255 reflectance');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.ascii_format).toBe('x y z r255 g255 b255 reflectance');
    expect(body.source_path).toBe('/p/a.xyz');
  });

  it('preserves the asciiFormat hint on the octree handle for later re-crops', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeOctreeMetadataResponse());
    const data = await parsePointCloudFromPath('/p/scan.xyz', 'x y z reflectance');
    expect(data.octree?.asciiFormat).toBe('x y z reflectance');
  });

  it('surfaces a backend error response as a thrown Error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Source file not found: /missing.xyz' }), { status: 404 }),
    );
    await expect(parsePointCloudFromPath('/missing.xyz')).rejects.toThrow(/Source file not found/);
  });

  // PLY / PCD / LAS / LAZ now route to convert_to_octree like the XYZ family —
  // every path-backed format produces a streaming octree, not a flat cloud.
  it.each(['/p/cloud.ply', '/p/cloud.pcd', '/p/cloud.las', '/p/cloud.laz'])(
    'routes %s to convert_to_octree',
    async (path) => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(makeOctreeMetadataResponse());
      const data = await parsePointCloudFromPath(path);
      expect(data.pointCount).toBe(2);
      // Octree-backed: positions stay empty, the octree handle drives rendering.
      expect(data.positions.length).toBe(0);
      expect(data.octree?.cacheId).toBe('a'.repeat(40));
      expect(data.octree?.sourceXyzPath).toBe(path);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/pointcloud/convert_to_octree');
    },
  );
});

describe('format predicates and lists', () => {
  it('isMeshFile recognises obj and stl, rejects others', () => {
    expect(isMeshFile('foo.obj')).toBe(true);
    expect(isMeshFile('foo.OBJ')).toBe(true);
    expect(isMeshFile('foo.stl')).toBe(true);
    expect(isMeshFile('foo.xyz')).toBe(false);
  });

  it('isSkeletonFile recognises only json', () => {
    expect(isSkeletonFile('sk.json')).toBe(true);
    expect(isSkeletonFile('sk.JSON')).toBe(true);
    expect(isSkeletonFile('sk.obj')).toBe(false);
  });

  it('SUPPORTED_FORMATS aggregates all three format lists', () => {
    expect(SUPPORTED_FORMATS).toEqual([
      ...POINT_CLOUD_FORMATS,
      ...MESH_FORMATS,
      ...SKELETON_FORMATS,
    ]);
  });
});
