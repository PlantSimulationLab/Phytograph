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
  parsePLYMesh,
  plyHasFaces,
  parsePointCloud,
  parsePointCloudFromPath,
  parsePointCloudsFromPath,
  parseSkeleton,
  parseSkeletonJSON,
  parseSkeletonOBJ,
  parseSTLMesh,
  parseXYZ,
  looksLikeAsciiPointCloud,
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
  // The backend streams a packed PHX1 binary frame (positions, optional
  // colors/intensity) — no JSON point list. Build a minimal two-point frame.
  function packPhx1(points: number[][]): ArrayBuffer {
    const n = points.length;
    const HEADER = 32;
    const buf = new ArrayBuffer(HEADER + n * 3 * 4);
    const u8 = new Uint8Array(buf);
    u8.set([0x50, 0x48, 0x58, 0x31], 0); // 'PHX1'
    new DataView(buf).setUint32(4, n, true);
    const pos = new Float32Array(buf, HEADER, n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = points[i][0];
      pos[i * 3 + 1] = points[i][1];
      pos[i * 3 + 2] = points[i][2];
    }
    return buf;
  }

  it('forwards to the backend and returns a PointCloudData', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(packPhx1([[1, 2, 3], [4, 5, 6]]), { status: 200 }),
    );
    const file = new File([new Uint8Array([0])], 'cloud.laz');
    const data = await parseLAZ(file);
    expect(data.pointCount).toBe(2);
    expect(Array.from(data.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(data.fileName).toBe('cloud.laz');
  });

  it('surfaces backend error', async () => {
    // Errors come back as a non-OK HTTP response with a JSON {detail}.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'bad file' }), { status: 400 }),
    );
    const file = new File([new Uint8Array([0])], 'cloud.laz');
    await expect(parseLAZ(file)).rejects.toThrow(/bad file/);
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

  it("does not let a malformed facet steal the next facet's vertices", async () => {
    // The first facet is missing its third vertex. An unbounded scan would pull
    // the second facet's first vertex into it, emitting a spliced triangle and
    // shifting everything after — silent wrong geometry, no error.
    const content = [
      'solid test',
      'facet normal 0 0 1',
      'outer loop',
      'vertex 0 0 0',
      'vertex 1 0 0',
      'endloop',
      'endfacet',
      'facet normal 0 1 0',
      'outer loop',
      'vertex 5 5 5',
      'vertex 6 5 5',
      'vertex 5 6 5',
      'endloop',
      'endfacet',
      'endsolid test',
      '',
    ].join('\n');
    const mesh = await parseSTLMesh(textFile(content, 'malformed.stl'));
    // Only the well-formed second facet survives.
    expect(mesh.triangleCount).toBe(1);
    expect(Array.from(mesh.vertices)).toEqual([5, 5, 5, 6, 5, 5, 5, 6, 5]);
    // ...and it carries its OWN normal, not the malformed facet's.
    expect(Array.from(mesh.normals!)).toEqual([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  });
});

// Binary STL. Layout: 80-byte header, uint32 LE triangle count, then 50 bytes per
// triangle (12 float32 + a uint16 attribute word).
interface StlTri {
  normal: [number, number, number];
  verts: [[number, number, number], [number, number, number], [number, number, number]];
}

function makeBinaryStlBuffer(
  triangles: StlTri[],
  opts: {
    header?: string;
    attrs?: number[];
    trailingBytes?: number;
    declaredCount?: number;
  } = {},
): ArrayBuffer {
  const trailing = opts.trailingBytes ?? 0;
  const buf = new ArrayBuffer(84 + 50 * triangles.length + trailing);
  const view = new DataView(buf);

  // Header defaults to 80 zero bytes — the shape a Blender-exported binary STL has,
  // and the one that defeats a `solid`-prefix heuristic.
  if (opts.header) {
    const bytes = new TextEncoder().encode(opts.header);
    new Uint8Array(buf).set(bytes.subarray(0, 80), 0);
  }

  view.setUint32(80, opts.declaredCount ?? triangles.length, true);

  triangles.forEach((tri, i) => {
    const off = 84 + i * 50;
    view.setFloat32(off, tri.normal[0], true);
    view.setFloat32(off + 4, tri.normal[1], true);
    view.setFloat32(off + 8, tri.normal[2], true);
    tri.verts.forEach((v, vi) => {
      const vo = off + 12 + vi * 12;
      view.setFloat32(vo, v[0], true);
      view.setFloat32(vo + 4, v[1], true);
      view.setFloat32(vo + 8, v[2], true);
    });
    view.setUint16(off + 48, opts.attrs?.[i] ?? 0, true);
  });

  return buf;
}

const TRI_A: StlTri = {
  normal: [0, 0, 1],
  verts: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
};
const TRI_B: StlTri = {
  normal: [0, 1, 0],
  verts: [
    [2, 0, 0],
    [3, 0, 0],
    [2, 1, 0],
  ],
};
const TRI_C: StlTri = {
  normal: [1, 0, 0],
  verts: [
    [4, 0, 0],
    [5, 0, 0],
    [4, 1, 0],
  ],
};

function binaryStlFile(buf: ArrayBuffer, name = 'tri.stl'): File {
  return new File([buf], name);
}

describe('parseSTLMesh (binary)', () => {
  it('parses a single-triangle binary STL', async () => {
    const mesh = await parseSTLMesh(binaryStlFile(makeBinaryStlBuffer([TRI_A])));
    expect(mesh.vertexCount).toBe(3);
    expect(mesh.triangleCount).toBe(1);
    expect(Array.from(mesh.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
    expect(mesh.fileName).toBe('tri.stl');
  });

  it('replicates the facet normal to all three vertices', async () => {
    const mesh = await parseSTLMesh(binaryStlFile(makeBinaryStlBuffer([TRI_A])));
    expect(Array.from(mesh.normals!)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(mesh.normals!.length).toBe(mesh.vertices.length);
  });

  it('parses multiple triangles unwelded with sequential indices', async () => {
    const mesh = await parseSTLMesh(binaryStlFile(makeBinaryStlBuffer([TRI_A, TRI_B, TRI_C])));
    expect(mesh.vertexCount).toBe(9);
    expect(mesh.triangleCount).toBe(3);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // Triangle 2's first vertex — only a correct 50-byte stride lands here.
    expect(Array.from(mesh.vertices.slice(18, 21))).toEqual([4, 0, 0]);
  });

  it('detects binary even when the header starts with "solid"', async () => {
    const buf = makeBinaryStlBuffer([TRI_A], { header: 'solid exported by SomeTool' });
    const mesh = await parseSTLMesh(binaryStlFile(buf));
    expect(mesh.triangleCount).toBe(1);
    expect(Array.from(mesh.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('detects binary when the header is 80 zero bytes', async () => {
    // The reported bug: no `solid` prefix at all, so only the length test classifies it.
    const mesh = await parseSTLMesh(binaryStlFile(makeBinaryStlBuffer([TRI_A, TRI_B])));
    expect(mesh.triangleCount).toBe(2);
    expect(Array.from(mesh.vertices.slice(9, 18))).toEqual([2, 0, 0, 3, 0, 0, 2, 1, 0]);
  });

  it('returns no vertexColors when no facet sets the color-valid bit', async () => {
    // All-zero attributes, as in the reported file. Under the SolidWorks dialect
    // this would read as "every facet is black"; we must leave it uncolored.
    const mesh = await parseSTLMesh(binaryStlFile(makeBinaryStlBuffer([TRI_A, TRI_B], { attrs: [0, 0] })));
    expect(mesh.vertexColors).toBeUndefined();
  });

  it('reads VisCAM RGB555 color when a facet sets the valid bit', async () => {
    const red = 0x8000 | (31 << 10);
    const mesh = await parseSTLMesh(binaryStlFile(makeBinaryStlBuffer([TRI_A, TRI_B], { attrs: [red, 0] })));
    expect(mesh.vertexColors).toBeDefined();
    // Facet 0 is red on all three of its vertices.
    expect(Array.from(mesh.vertexColors!.slice(0, 9))).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    // Facet 1 didn't opt in — neutral, not black.
    expect(Array.from(mesh.vertexColors!.slice(9, 18))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('tolerates trailing bytes after the triangle data', async () => {
    const mesh = await parseSTLMesh(binaryStlFile(makeBinaryStlBuffer([TRI_A], { trailingBytes: 7 })));
    expect(mesh.triangleCount).toBe(1);
    expect(Array.from(mesh.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('reports truncation when the declared count exceeds the file', async () => {
    const buf = makeBinaryStlBuffer([TRI_A], { declaredCount: 100 });
    await expect(parseSTLMesh(binaryStlFile(buf))).rejects.toThrow(/truncated/i);
    // Must NOT fall through to the generic message — that's what made this opaque.
    await expect(parseSTLMesh(binaryStlFile(buf))).rejects.not.toThrow(/No mesh data/);
  });

  it('rejects an absurd triangle count without attempting the allocation', async () => {
    const buf = makeBinaryStlBuffer([TRI_A], { declaredCount: 0xffffffff });
    await expect(parseSTLMesh(binaryStlFile(buf))).rejects.toThrow(Error);
    // A RangeError would mean we tried to allocate ~154 GB before validating.
    await expect(parseSTLMesh(binaryStlFile(buf))).rejects.not.toThrow(RangeError);
  });

  it('rejects NaN vertex coordinates', async () => {
    const bad: StlTri = { normal: [0, 0, 1], verts: [[0, 0, 0], [NaN, 0, 0], [0, 1, 0]] };
    await expect(parseSTLMesh(binaryStlFile(makeBinaryStlBuffer([bad])))).rejects.toThrow(/NaN or infinite/i);
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

  it('dispatches to STL for a binary file', async () => {
    const mesh = await parseMesh(binaryStlFile(makeBinaryStlBuffer([TRI_A, TRI_B]), 'x.stl'));
    expect(mesh.triangleCount).toBe(2);
    expect(Array.from(mesh.vertices.slice(0, 3))).toEqual([0, 0, 0]);
  });

  it('rejects unsupported extensions', async () => {
    await expect(parseMesh(textFile('x', 'mesh.xyz'))).rejects.toThrow(/Unsupported mesh/);
  });

  it('dispatches PLY-with-faces to the mesh parser', async () => {
    const content = [
      'ply', 'format ascii 1.0',
      'element vertex 3',
      'property float x', 'property float y', 'property float z',
      'element face 1',
      'property list uchar int vertex_indices',
      'end_header',
      '0 0 0', '1 0 0', '0 1 0',
      '3 0 1 2', '',
    ].join('\n');
    const mesh = await parseMesh(textFile(content, 'tri.ply'));
    expect(mesh.triangleCount).toBe(1);
    expect(mesh.vertexCount).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────
// PLY mesh detection + parsing (the ambiguous PLY container).
// ────────────────────────────────────────────────────────────────────────

const PLY_QUAD_MESH = [
  'ply', 'format ascii 1.0',
  'element vertex 4',
  'property float x', 'property float y', 'property float z',
  'property uchar red', 'property uchar green', 'property uchar blue',
  'element face 2',
  'property list uchar int vertex_indices',
  'end_header',
  '0 0 0 255 0 0',
  '1 0 0 0 255 0',
  '1 1 0 0 0 255',
  '0 1 0 255 255 0',
  '4 0 1 2 3',  // a quad face — should fan-triangulate to 2 triangles
  '3 0 1 2',
  '',
].join('\n');

const PLY_POINTCLOUD = [
  'ply', 'format ascii 1.0',
  'element vertex 3',
  'property float x', 'property float y', 'property float z',
  'end_header',
  '0 0 0', '1 0 0', '0 1 0', '',
].join('\n');

describe('plyHasFaces', () => {
  it('returns true for a PLY declaring faces', async () => {
    expect(await plyHasFaces(textFile(PLY_QUAD_MESH, 'm.ply'))).toBe(true);
  });

  it('returns false for a vertices-only PLY (point cloud)', async () => {
    expect(await plyHasFaces(textFile(PLY_POINTCLOUD, 'c.ply'))).toBe(false);
  });

  it('returns false for element face 0', async () => {
    const content = PLY_POINTCLOUD.replace('end_header', 'element face 0\nproperty list uchar int vertex_indices\nend_header');
    expect(await plyHasFaces(textFile(content, 'z.ply'))).toBe(false);
  });
});

describe('parsePLYMesh', () => {
  it('parses vertices, fan-triangulated faces, and per-vertex colors', async () => {
    const mesh = await parsePLYMesh(textFile(PLY_QUAD_MESH, 'm.ply'));
    expect(mesh.vertexCount).toBe(4);
    // quad (2 tris) + triangle (1 tri) = 3 triangles
    expect(mesh.triangleCount).toBe(3);
    expect(mesh.indices.length).toBe(9);
    expect(mesh.vertexColors).toBeDefined();
    expect(mesh.vertexColors!.length).toBe(12); // 4 verts * rgb
    // First vertex is red (255,0,0) → normalized to (1,0,0).
    expect(mesh.vertexColors![0]).toBeCloseTo(1, 5);
    expect(mesh.vertexColors![1]).toBeCloseTo(0, 5);
  });

  it('rejects a vertices-only PLY as not a mesh', async () => {
    await expect(parsePLYMesh(textFile(PLY_POINTCLOUD, 'c.ply'))).rejects.toThrow(/point cloud|No faces/i);
  });

  it('rejects binary PLY (must use a file path)', async () => {
    const content = PLY_QUAD_MESH.replace('format ascii 1.0', 'format binary_little_endian 1.0');
    await expect(parsePLYMesh(textFile(content, 'bin.ply'))).rejects.toThrow(/Binary PLY/);
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

  // PTX is numeric ASCII, so the XYZ fallback used to ACCEPT this file and
  // produce a silently wrong cloud: the 4x4 transform rows became four junk
  // points at the origin and the `x y z intensity r g b` data row read its
  // colour from (intensity, r, g). It is now genuinely supported, and because
  // the raster + scanner pose only mean anything to the backend converter it is
  // octree-only (like E57) rather than parsed here.
  const PTX_SAMPLE = [
    '1024', '1024',
    '0 0 0', '1 0 0', '0 1 0', '0 0 1',
    '1 0 0 0', '0 1 0 0', '0 0 1 0', '0 0 0 1',
    '0.1 0.2 0.3 0.5 10 20 30',
    '',
  ].join('\n');

  it('does not hand a path-less PTX to the XYZ parser', async () => {
    // A Blob with no on-disk path can't reach the backend converter, and the
    // XYZ fallback would mangle it. Refuse rather than import junk.
    const file = textFile(PTX_SAMPLE, 'scan.ptx');
    await expect(parsePointCloud(file)).rejects.toThrow(/PTX structured scan.*read from disk/s);
  });

  it('lists PTX among the supported formats', () => {
    expect(POINT_CLOUD_FORMATS.map(f => f.ext)).toContain('.ptx');
  });

  it('names the other scanner formats it cannot read', async () => {
    for (const [ext, needle] of [['fls', /FARO/], ['rcs', /ReCap/], ['zfs', /Z\+F/],
                                 ['ptg', /PTG structured scan/]] as const) {
      await expect(parsePointCloud(textFile('x', `scan.${ext}`))).rejects.toThrow(needle);
    }
  });

  it('rejects an unknown binary extension from the head, not a full parse', async () => {
    const bytes = new Uint8Array(4096);
    bytes[0] = 0x89;
    bytes[3] = 0x00;
    const file = new File([bytes], 'scan.zzz');
    const textSpy = vi.spyOn(file, 'text');
    await expect(parsePointCloud(file)).rejects.toThrow(/Unsupported file format: \.zzz/);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('lists every supported format in the rejection message', async () => {
    await expect(parsePointCloud(textFile('nope nope\n', 'a.zzz'))).rejects.toThrow(
      new RegExp(POINT_CLOUD_FORMATS.map(f => f.name).join(', ')),
    );
  });

  it('rejects a numeric file with fewer than three columns', async () => {
    await expect(parsePointCloud(textFile('1 2\n3 4\n5 6\n', 'a.zzz'))).rejects.toThrow(
      /Unsupported file format: \.zzz/,
    );
  });
});

describe('looksLikeAsciiPointCloud', () => {
  it('accepts a delimited coordinate table with a header row', async () => {
    const body = Array.from({ length: 50 }, (_, i) => `${i} ${i + 1} ${i + 2}`).join('\n');
    expect(await looksLikeAsciiPointCloud(textFile(`X,Y,Z\n${body}\n`, 'a.zzz'))).toBe(true);
  });

  it('accepts comma / tab / semicolon delimiters', async () => {
    expect(await looksLikeAsciiPointCloud(textFile('1,2,3\n4,5,6\n', 'a.zzz'))).toBe(true);
    expect(await looksLikeAsciiPointCloud(textFile('1\t2\t3\n4\t5\t6\n', 'a.zzz'))).toBe(true);
    expect(await looksLikeAsciiPointCloud(textFile('1;2;3\n4;5;6\n', 'a.zzz'))).toBe(true);
  });

  it('rejects prose, markup and comment-only files', async () => {
    expect(await looksLikeAsciiPointCloud(textFile('# only comments\n# here\n', 'a.zzz'))).toBe(false);
    expect(await looksLikeAsciiPointCloud(textFile('<scene><n>1 2 3</n></scene>\n', 'a.zzz'))).toBe(false);
    expect(await looksLikeAsciiPointCloud(textFile('hello there friend\n'.repeat(20), 'a.zzz'))).toBe(false);
  });

  it('rejects binary content', async () => {
    const bytes = new Uint8Array([0x4c, 0x41, 0x53, 0x46, 0x00, 0x01, 0x02, 0xff, 0xfe]);
    expect(await looksLikeAsciiPointCloud(new File([bytes], 'a.zzz'))).toBe(false);
  });

  it('only reads the first 64 KB of a large file', async () => {
    const line = '1.5 2.5 3.5\n';
    const file = textFile(line.repeat(40_000), 'big.zzz'); // ~480 KB
    const sliceSpy = vi.spyOn(file, 'slice');
    const textSpy = vi.spyOn(file, 'text');
    expect(await looksLikeAsciiPointCloud(file)).toBe(true);
    expect(sliceSpy).toHaveBeenCalledWith(0, 64 * 1024);
    expect(textSpy).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────
// parsePointCloudFromPath — every supported point-cloud format (XYZ-family,
// PLY, PCD, LAS, LAZ) routes to the backend's convert_to_octree. Only inputs
// with no on-disk path fall back to the in-renderer parsers via fs.readBinary.
// ────────────────────────────────────────────────────────────────────────


describe('parsePointCloudFromPath', () => {
  // Helper: build a CloudSessionMetadata-shaped JSON response, matching the
  // backend's create_cloud_session contract (octree metadata + session_id).
  const makeOctreeMetadataResponse = (overrides: Record<string, unknown> = {}) => new Response(
    JSON.stringify({
      session_id: 'sess1234',
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

  it('routes .xyz to create_cloud_session and produces a session-backed octree cloud', async () => {
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
    // Session-backed: the cloud carries the backend session id for edits.
    expect(data.octree?.sessionId).toBe('sess1234');
    expect(data.positions.length).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/api/cloud/session/create');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ source_path: '/abs/path/scan.xyz', ascii_format: null, column_plan: null, world_shift: null, miss_distance_threshold: null, origin: null, drop_slugs: null, role_overrides: null });
  });

  it('forwards the wizard column plan, carrying a skipped column as role "skip"', async () => {
    // The wizard's Import checkbox becomes role 'skip' on the ASCII path. It has
    // to survive serialisation, or the untick is silently ignored and the field
    // still lands in the octree.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(makeOctreeMetadataResponse());
    await parsePointCloudFromPath('/p/a.xyz', null, {
      columns: [
        { index: 0, role: 'x' }, { index: 1, role: 'y' }, { index: 2, role: 'z' },
        { index: 3, role: 'skip' },
      ],
      rgbIs255: true,
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.column_plan.columns[3]).toMatchObject({ index: 3, role: 'skip' });
    expect(body.column_plan.rgb_is_255).toBe(true);
  });

  it('forwards droppedSlugs as drop_slugs for in-file formats', async () => {
    // LAS/PLY/E57 fix their own layout, so an unticked column can't ride the
    // positional plan — it travels as a slug list instead.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(makeOctreeMetadataResponse());
    await parsePointCloudFromPath('/p/cloud.las', null, null, undefined, null, undefined,
      null, null, undefined, ['Deviation', 'amplitude']);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.drop_slugs).toEqual(['Deviation', 'amplitude']);
    // No plan is invented for an in-file format.
    expect(body.column_plan).toBeNull();
  });

  it('sends drop_slugs as null when nothing was unticked', async () => {
    // An empty list must not reach the wire as [] — the backend treats null as
    // "drop nothing", and an empty array would be a needless difference.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(makeOctreeMetadataResponse());
    await parsePointCloudFromPath('/p/cloud.las', null, null, undefined, null, undefined,
      null, null, undefined, []);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.drop_slugs).toBeNull();
  });

  it('forwards ascii_format to create_cloud_session when provided', async () => {
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

  // PLY / PCD / LAS / LAZ now route to create_cloud_session like the XYZ family —
  // every path-backed format produces a session-backed streaming octree.
  it.each(['/p/cloud.ply', '/p/cloud.pcd', '/p/cloud.las', '/p/cloud.laz',
           '/p/cloud.e57', '/p/cloud.ptx'])(
    'routes %s to create_cloud_session',
    async (path) => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(makeOctreeMetadataResponse());
      const data = await parsePointCloudFromPath(path);
      expect(data.pointCount).toBe(2);
      // Octree-backed: positions stay empty, the octree handle drives rendering.
      expect(data.positions.length).toBe(0);
      expect(data.octree?.cacheId).toBe('a'.repeat(40));
      expect(data.octree?.sourceXyzPath).toBe(path);
      expect(data.octree?.sessionId).toBe('sess1234');
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/cloud/session/create');
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

// ────────────────────────────────────────────────────────────────────────
// parsePointCloudsFromPath — the plural path. A multi-scan E57 / multi-block
// PTX becomes one cloud PER SCAN POSITION, because a scan is defined by its
// pose and merging positions leaves one origin standing in for all of them.
// ────────────────────────────────────────────────────────────────────────

describe('parsePointCloudsFromPath', () => {
  const sessionMeta = (id: string, overrides: Record<string, unknown> = {}) => ({
    session_id: id,
    cache_id: id.padEnd(40, 'z'),
    cache_dir: `/cache/${id}`,
    hierarchy_step_size: 5,
    point_count: 2,
    spacing: 0.1,
    scale: [0.001, 0.001, 0.001],
    offset: [0, 0, 0],
    bounds: { min: [1, 2, 3], max: [4, 5, 6] },
    attributes: [{ name: 'position', size: 12, type: 'int32', num_elements: 3 }],
    ...overrides,
  });

  const multiResponse = (scans: unknown[]) => new Response(
    JSON.stringify({ scans, scan_count: scans.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

  it('returns one entry per scan position, each with its own session and params', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(multiResponse([
      { scan_index: 0, name: 'scan — scan 1',
        session: sessionMeta('s0', { scan_params: { origin: [1, 2, 3], n_theta: 8 } }) },
      { scan_index: 1, name: 'scan — scan 2',
        session: sessionMeta('s1', { scan_params: { origin: [9, 9, 9], n_theta: 7 } }) },
    ]));
    const out = await parsePointCloudsFromPath('/abs/scan.ptx');
    expect(out).toHaveLength(2);
    expect(out.map(o => o.name)).toEqual(['scan — scan 1', 'scan — scan 2']);
    expect(out.map(o => o.scanIndex)).toEqual([0, 1]);
    // Each cloud is backed by ITS OWN session and carries ITS OWN scan params —
    // that separation is the entire point of the split.
    expect(out.map(o => o.data.octree?.sessionId)).toEqual(['s0', 's1']);
    expect(out[0].data.octree?.scanParams?.n_theta).toBe(8);
    expect(out[1].data.octree?.scanParams?.n_theta).toBe(7);
    expect(out[1].data.octree?.scanParams?.origin).toEqual([9, 9, 9]);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/api/cloud/session/create-multi');
  });

  it('returns a single element for an ordinary single-scan source', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(multiResponse([
      { scan_index: 0, name: 'cloud', session: sessionMeta('only') },
    ]));
    const out = await parsePointCloudsFromPath('/abs/cloud.xyz');
    expect(out).toHaveLength(1);
    // The stem the backend sends — this string becomes the scan's label, and
    // the extension is noise in the scans panel.
    expect(out[0].name).toBe('cloud');
  });

  it('keeps the positions that imported when one of them failed', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(multiResponse([
      { scan_index: 0, name: 'a', error: 'octree build failed' },
      { scan_index: 1, name: 'b', session: sessionMeta('ok') },
    ]));
    const out = await parsePointCloudsFromPath('/abs/scan.ptx');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('b');
  });

  it('surfaces the real reason when every position failed', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(multiResponse([
      { scan_index: 0, name: 'a', error: 'grid was unreadable' },
      { scan_index: 1, name: 'b', error: 'grid was unreadable' },
    ]));
    await expect(parsePointCloudsFromPath('/abs/scan.ptx'))
      .rejects.toThrow(/grid was unreadable/);
  });

  it('does not use the multi endpoint for a format that cannot fan out', async () => {
    // A path-less / non-octree route is inherently 1:1, so it must go through
    // the singular path rather than asking the backend to split it.
    const fetchSpy = vi.spyOn(global, 'fetch');
    const out = await parsePointCloudsFromPath('/abs/cloud.obj').catch(() => null);
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain('create-multi');
    }
    expect(out === null || out.length === 1).toBe(true);
  });
});
