import { describe, it, expect } from 'vitest';
import {
  serializeMeshObj,
  serializeMeshPly,
  serializeMeshStl,
  sanitizeMeshName,
  imageExtFromBytes,
  decodeBase64,
} from './meshExport';
import type { MeshData, PlantMaterialDef } from './pointCloudTypes';

// `Kd` in an MTL is an sRGB display colour, while MeshData.vertexColors and
// PlantMaterialDef.color are held in three.js's LINEAR working space. So the
// writer encodes on the way out, and these tests state the LINEAR colour they
// set and let the helper compute the sRGB text to look for — asserting the
// conversion happens, rather than hardcoding numbers that would still pass if
// the encode were silently dropped.
const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
const kdLine = (...linear: number[]): string =>
  `Kd ${linear.map(c => linearToSrgb(c).toFixed(6)).join(' ')}`;
// Same, but for a colour the writer read back out of a Float32Array (a mesh's
// vertexColors). The f32 round-trip shifts the value by an ulp, which is enough
// to move the 6th decimal place — so match what the code actually computes.
const kdLineF32 = (...linear: number[]): string =>
  kdLine(...Array.from(new Float32Array(linear)));

// Two triangles sharing an edge, forming a unit quad in the z=0 plane.
function quad(withUVs = false, withNormals = false): MeshData {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    normals: withNormals ? new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) : undefined,
    // V-up (three.js) space, which the exporter must flip back to OBJ's V-down.
    uvCoordinates: withUVs ? new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) : undefined,
    vertexCount: 4,
    triangleCount: 2,
  };
}

// The same quad, but flat-shaded per triangle in two distinct colours — the
// shape a generated plant's untextured organs take (petioles, internodes).
// Triangle 0 (verts 0,1,2) is olive; triangle 1 (verts 0,2,3) shares verts 0
// and 2, so we give each triangle its own vertices to keep the colours flat.
function coloredStrip(colors: [number, number, number][]): MeshData {
  const tris = colors.length;
  const vertices = new Float32Array(tris * 9);
  const vertexColors = new Float32Array(tris * 9);
  const indices = new Uint32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const v = t * 3 + k;
      vertices[v * 3] = t + k;
      vertices[v * 3 + 1] = k;
      vertices[v * 3 + 2] = 0;
      vertexColors[v * 3] = colors[t][0];
      vertexColors[v * 3 + 1] = colors[t][1];
      vertexColors[v * 3 + 2] = colors[t][2];
      indices[t * 3 + k] = v;
    }
  }
  return { vertices, indices, vertexColors, vertexCount: tris * 3, triangleCount: tris };
}

// Minimal real PNG/JPEG headers — enough bytes for magic-number sniffing.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const lines = (text: string) => text.split('\n');
const linesStartingWith = (text: string, prefix: string) =>
  lines(text).filter(l => l.startsWith(prefix));

describe('imageExtFromBytes', () => {
  it('identifies PNG and JPEG from their magic numbers', () => {
    expect(imageExtFromBytes(PNG_BYTES)).toBe('.png');
    expect(imageExtFromBytes(JPEG_BYTES)).toBe('.jpg');
  });

  it('returns null for formats no downstream reader is promised', () => {
    // GIF header — a real image, but not one we name a file for.
    expect(imageExtFromBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
    expect(imageExtFromBytes(new Uint8Array([]))).toBeNull();
    // A truncated PNG signature must not pass as PNG.
    expect(imageExtFromBytes(PNG_BYTES.slice(0, 4))).toBeNull();
  });

  it('ignores what the material claims and reads the bytes', () => {
    // The bug this guards: a JPEG written under a .png name because a flag said
    // so. The sniffed extension must follow the bytes, not any label.
    expect(imageExtFromBytes(JPEG_BYTES)).not.toBe('.png');
  });
});

describe('decodeBase64', () => {
  it('round-trips bytes', () => {
    expect(Array.from(decodeBase64(toBase64(PNG_BYTES))!)).toEqual(Array.from(PNG_BYTES));
  });

  it('returns null on malformed input rather than throwing', () => {
    expect(decodeBase64('not!valid!base64!!')).toBeNull();
  });
});

describe('sanitizeMeshName', () => {
  it('strips path separators and whitespace', () => {
    expect(sanitizeMeshName('my plant/model')).toBe('my_plant_model');
    expect(sanitizeMeshName('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('falls back when nothing survives', () => {
    expect(sanitizeMeshName('///')).toBe('mesh');
    expect(sanitizeMeshName('', 'material_0')).toBe('material_0');
  });
});

describe('serializeMeshObj — geometry', () => {
  it('writes one v line per vertex and one f line per triangle', () => {
    const [obj] = serializeMeshObj(quad(), { baseName: 'tiny' });
    expect(obj.name).toBe('tiny.obj');
    expect(linesStartingWith(obj.text!, 'v ')).toHaveLength(4);
    expect(linesStartingWith(obj.text!, 'f ')).toHaveLength(2);
    // No materials → no mtllib reference, and no sibling files.
    expect(obj.text!).not.toContain('mtllib');
  });

  it('emits only the .obj when the mesh has no materials', () => {
    expect(serializeMeshObj(quad(), { baseName: 'tiny' })).toHaveLength(1);
  });

  it('uses 1-based indices in valid range', () => {
    const [obj] = serializeMeshObj(quad(), { baseName: 'tiny' });
    for (const f of linesStartingWith(obj.text!, 'f ')) {
      const idxs = f.slice(2).trim().split(/\s+/).map(tok => parseInt(tok.split('/')[0], 10));
      expect(idxs).toHaveLength(3);
      for (const i of idxs) {
        expect(i).toBeGreaterThanOrEqual(1);
        expect(i).toBeLessThanOrEqual(4);
      }
    }
  });

  it('writes v//vn when there are normals but no UVs', () => {
    const [obj] = serializeMeshObj(quad(false, true), { baseName: 'tiny' });
    expect(linesStartingWith(obj.text!, 'vn ')).toHaveLength(4);
    expect(linesStartingWith(obj.text!, 'f ')[0]).toMatch(/^f \d+\/\/\d+ \d+\/\/\d+ \d+\/\/\d+$/);
  });

  it('writes v/vt/vn when the mesh carries both', () => {
    const [obj] = serializeMeshObj(quad(true, true), { baseName: 'tiny' });
    expect(linesStartingWith(obj.text!, 'f ')[0]).toMatch(/^f \d+\/\d+\/\d+( \d+\/\d+\/\d+){2}$/);
  });

  it('V-flips UVs back into OBJ texture space', () => {
    // The importer stores [u, 1-v]; the exporter must undo it or every texture
    // comes back upside down on re-import.
    const [obj] = serializeMeshObj(quad(true), { baseName: 'tiny' });
    const vt = linesStartingWith(obj.text!, 'vt ');
    expect(vt).toHaveLength(4);
    expect(vt[0]).toBe('vt 0.000000 1.000000'); // stored (0,0) → written (0,1)
    expect(vt[2]).toBe('vt 1.000000 0.000000'); // stored (1,1) → written (1,0)
  });

  it('drops UVs that do not match the vertex count instead of emitting garbage', () => {
    const data = quad(true);
    data.uvCoordinates = new Float32Array([0, 0]); // wrong length
    const [obj] = serializeMeshObj(data, { baseName: 'tiny' });
    expect(linesStartingWith(obj.text!, 'vt ')).toHaveLength(0);
    expect(linesStartingWith(obj.text!, 'f ')[0]).toBe('f 1 2 3');
  });

  it('writes provenance comments', () => {
    const [obj] = serializeMeshObj(quad(), {
      baseName: 'tiny',
      comments: ['Helios Plant: bean, Age: 30 days'],
    });
    expect(obj.text!).toContain('# Helios Plant: bean, Age: 30 days');
    expect(obj.text!.startsWith('# Mesh exported from Phytograph')).toBe(true);
  });
});

describe('serializeMeshObj — material bundle', () => {
  const texturedMaterials = (): PlantMaterialDef[] => [
    {
      name: 'leaf',
      color: [0.2, 0.6, 0.2],
      textureData: toBase64(PNG_BYTES),
      hasAlpha: true,
      triangleIndices: [0],
    },
    {
      name: 'bark',
      color: [0.4, 0.3, 0.2],
      textureData: toBase64(JPEG_BYTES),
      hasAlpha: false,
      triangleIndices: [1],
    },
  ];

  it('emits the obj, the mtl, and one image per textured material', () => {
    const files = serializeMeshObj(quad(true), {
      baseName: 'bean',
      materials: texturedMaterials(),
    });
    expect(files.map(f => f.name)).toEqual([
      'bean.obj', 'bean.mtl', 'bean_leaf.png', 'bean_bark.jpg',
    ]);
    // Texture files carry raw bytes; the text files carry strings.
    expect(files[2].bytes).toBeInstanceOf(Uint8Array);
    expect(files[3].bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(files[3].bytes!)).toEqual(Array.from(JPEG_BYTES));
  });

  it('names each texture by its sniffed format, not by the material flags', () => {
    // `bark` says hasAlpha:false yet its bytes are JPEG; `leaf` is a real PNG.
    // A .jpg written as .png is a hard load error downstream.
    const files = serializeMeshObj(quad(true), {
      baseName: 'bean',
      materials: texturedMaterials(),
    });
    expect(files.find(f => f.name.includes('leaf'))!.name).toMatch(/\.png$/);
    expect(files.find(f => f.name.includes('bark'))!.name).toMatch(/\.jpg$/);
  });

  it('references the mtl from the obj and groups faces by usemtl', () => {
    const [obj] = serializeMeshObj(quad(true), {
      baseName: 'bean',
      materials: texturedMaterials(),
    });
    expect(obj.text!).toContain('mtllib bean.mtl');
    const body = lines(obj.text!);
    const leafAt = body.indexOf('usemtl leaf');
    const barkAt = body.indexOf('usemtl bark');
    expect(leafAt).toBeGreaterThan(-1);
    expect(barkAt).toBeGreaterThan(leafAt);
    // One face under each group; both triangles still present exactly once.
    expect(linesStartingWith(obj.text!, 'f ')).toHaveLength(2);
  });

  it('declares Kd and map_Kd for each material, plus map_d for alpha cutouts', () => {
    const files = serializeMeshObj(quad(true), {
      baseName: 'bean',
      materials: texturedMaterials(),
    });
    const mtl = files[1].text!;
    expect(mtl).toContain('newmtl leaf');
    expect(mtl).toContain(kdLine(0.2, 0.6, 0.2));
    expect(mtl).toContain('map_Kd bean_leaf.png');
    // The leaf's alpha mask must survive the round-trip.
    expect(mtl).toContain('map_d bean_leaf.png');
    expect(mtl).toContain('newmtl bark');
    expect(mtl).toContain('map_Kd bean_bark.jpg');
    // Bark has no alpha, so no dissolve map.
    expect(mtl.split('newmtl bark')[1]).not.toContain('map_d');
  });

  it('every usemtl name in the obj is declared in the mtl', () => {
    const files = serializeMeshObj(quad(true), {
      baseName: 'bean',
      materials: texturedMaterials(),
    });
    const used = linesStartingWith(files[0].text!, 'usemtl ').map(l => l.slice(7).trim());
    const declared = linesStartingWith(files[1].text!, 'newmtl ').map(l => l.slice(7).trim());
    for (const name of used) expect(declared).toContain(name);
  });

  it('falls back to a declared default material when there are no vertex colours', () => {
    // Materials cover only triangle 0, and this quad has no vertex colours to
    // derive one from — so triangle 1 lands in `default`. It must still be
    // exported either way.
    const files = serializeMeshObj(quad(true), {
      baseName: 'bean',
      materials: [{ name: 'leaf', textureData: toBase64(PNG_BYTES), hasAlpha: true, triangleIndices: [0] }],
    });
    expect(linesStartingWith(files[0].text!, 'f ')).toHaveLength(2);
    expect(files[0].text!).toContain('usemtl default');
    expect(files[1].text!).toContain('newmtl default');
  });

  it('does not declare a default material when every triangle is claimed', () => {
    const files = serializeMeshObj(quad(true), {
      baseName: 'bean',
      materials: texturedMaterials(),
    });
    expect(files[0].text!).not.toContain('usemtl default');
    expect(files[1].text!).not.toContain('newmtl default');
  });

  it('never writes a triangle twice when material groups overlap', () => {
    const files = serializeMeshObj(quad(true), {
      baseName: 'bean',
      materials: [
        { name: 'a', color: [1, 0, 0], hasAlpha: false, triangleIndices: [0, 1] },
        { name: 'b', color: [0, 1, 0], hasAlpha: false, triangleIndices: [1] },
      ],
    });
    expect(linesStartingWith(files[0].text!, 'f ')).toHaveLength(2);
  });

  it('keeps a flat-colour material but omits map_Kd when its texture is unusable', () => {
    const files = serializeMeshObj(quad(true), {
      baseName: 'bean',
      materials: [
        { name: 'stem', color: [0.3, 0.5, 0.1], textureData: toBase64(new Uint8Array([1, 2, 3, 4])), hasAlpha: false, triangleIndices: [0, 1] },
      ],
    });
    // obj + mtl only — no image file for an unrecognised format.
    expect(files.map(f => f.name)).toEqual(['bean.obj', 'bean.mtl']);
    expect(files[1].text!).toContain(kdLine(0.3, 0.5, 0.1));
    expect(files[1].text!).not.toContain('map_Kd');
  });

  it('ignores a material list where nothing claims a triangle', () => {
    const files = serializeMeshObj(quad(), {
      baseName: 'bean',
      materials: [{ name: 'leaf', color: [0, 1, 0], hasAlpha: false, triangleIndices: [] }],
    });
    expect(files).toHaveLength(1);
    expect(files[0].text!).not.toContain('mtllib');
  });

  it('de-duplicates material names that sanitize to the same string', () => {
    const files = serializeMeshObj(quad(), {
      baseName: 'bean',
      materials: [
        { name: 'leaf top', color: [0, 1, 0], hasAlpha: false, triangleIndices: [0] },
        { name: 'leaf/top', color: [0, 0, 1], hasAlpha: false, triangleIndices: [1] },
      ],
    });
    const declared = linesStartingWith(files[1].text!, 'newmtl ').map(l => l.slice(7).trim());
    expect(declared).toEqual(['leaf_top', 'leaf_top_2']);
  });

  it('sanitizes the base name so the bundle cross-references resolve', () => {
    const files = serializeMeshObj(quad(true), {
      baseName: 'my plant/v2',
      materials: texturedMaterials(),
    });
    expect(files[0].name).toBe('my_plant_v2.obj');
    expect(files[0].text!).toContain('mtllib my_plant_v2.mtl');
    expect(files[1].name).toBe('my_plant_v2.mtl');
    expect(files[1].text!).toContain('map_Kd my_plant_v2_leaf.png');
    expect(files[2].name).toBe('my_plant_v2_leaf.png');
  });
});

// The reported bug: a round-tripped bean had correct leaves but wrong-coloured
// petioles and internodes. Those organs carry no texture, so the backend leaves
// them out of `material_groups` entirely and they render from vertex colours —
// ~72% of a bean's triangles. OBJ has no portable per-vertex colour and our
// importer rebuilds colour from each triangle's material `Kd`, so the only way
// they survive is as generated `Kd` materials.
describe('serializeMeshObj — untextured organs keep their colour', () => {
  const OLIVE: [number, number, number] = [0.21, 0.25, 0.05];
  const STEM: [number, number, number] = [0.28, 0.35, 0.07];

  it('writes a Kd material per distinct vertex colour, not one flat grey', () => {
    const files = serializeMeshObj(coloredStrip([OLIVE, STEM]), { baseName: 'bean' });
    const mtl = files[1].text!;
    expect(mtl).toContain(kdLine(0.21, 0.25, 0.05));
    expect(mtl).toContain(kdLine(0.28, 0.35, 0.07));
    // The old behaviour — everything flattened to the default grey — is exactly
    // what made the petioles come back wrong.
    expect(mtl).not.toContain('Kd 0.800000 0.800000 0.800000');
    expect(files[0].text!).not.toContain('usemtl default');
  });

  it('emits an .obj + .mtl bundle for a mesh with only vertex colours', () => {
    // No textures at all, so no image files — but still a material library.
    const files = serializeMeshObj(coloredStrip([OLIVE, STEM]), { baseName: 'bean' });
    expect(files.map(f => f.name)).toEqual(['bean.obj', 'bean.mtl']);
    expect(files[0].text!).toContain('mtllib bean.mtl');
  });

  it('groups triangles sharing a colour under one material', () => {
    const files = serializeMeshObj(coloredStrip([OLIVE, STEM, OLIVE, OLIVE]), { baseName: 'bean' });
    const declared = linesStartingWith(files[1].text!, 'newmtl ');
    expect(declared).toHaveLength(2); // 4 triangles, 2 colours
    const used = linesStartingWith(files[0].text!, 'usemtl ');
    expect(used).toHaveLength(2);
    // All four faces still present, exactly once each.
    expect(linesStartingWith(files[0].text!, 'f ')).toHaveLength(4);
  });

  it('collapses float noise so one organ colour does not split into many materials', () => {
    // Colours arrive as float32; bit-level wobble must not fragment a material.
    const nudged: [number, number, number] = [0.21 + 1e-7, 0.25 - 1e-7, 0.05];
    const files = serializeMeshObj(coloredStrip([OLIVE, nudged]), { baseName: 'bean' });
    expect(linesStartingWith(files[1].text!, 'newmtl ')).toHaveLength(1);
  });

  it('colours the untextured remainder of a textured plant', () => {
    // The real bean shape: a textured leaf material claiming some triangles,
    // with the flat-coloured organs left over.
    const data = coloredStrip([OLIVE, STEM, OLIVE]);
    data.uvCoordinates = new Float32Array(data.vertexCount * 2);
    const files = serializeMeshObj(data, {
      baseName: 'bean',
      materials: [{
        name: 'bean_leaf', textureData: toBase64(PNG_BYTES), hasAlpha: true, triangleIndices: [0],
      }],
    });
    const mtl = files[1].text!;
    // The leaf keeps its texture…
    expect(mtl).toContain('newmtl bean_leaf');
    expect(mtl).toContain('map_Kd bean_bean_leaf.png');
    // …and the two leftover organs keep their own colours.
    expect(mtl).toContain(kdLine(0.28, 0.35, 0.07));
    expect(mtl).toContain(kdLine(0.21, 0.25, 0.05));
    expect(files[0].text!).not.toContain('usemtl default');
    expect(linesStartingWith(files[0].text!, 'f ')).toHaveLength(3);
  });

  it('derives Kd from geometry for a textured material that declares no colour', () => {
    // Generated plants set `color` only on UNtextured materials — a textured
    // leaf arrives with color undefined. Writing the grey 0.8 fallback there
    // meant the leaves re-imported grey too (masked by the texture, but wrong,
    // and visible wherever the texture can't be applied).
    const LEAF: [number, number, number] = [0.3, 0.55, 0.2];
    const data = coloredStrip([LEAF, LEAF, OLIVE]);
    data.uvCoordinates = new Float32Array(data.vertexCount * 2);
    const files = serializeMeshObj(data, {
      baseName: 'bean',
      materials: [{
        name: 'bean_leaf', textureData: toBase64(PNG_BYTES), hasAlpha: true,
        triangleIndices: [0, 1], // no `color` — the real plant shape
      }],
    });
    const mtl = files[1].text!;
    expect(mtl).toContain('newmtl bean_leaf');
    // The leaf's own vertex colour, not grey.
    expect(mtl).toContain(kdLineF32(0.3, 0.55, 0.2));
    expect(mtl).not.toContain('Kd 0.800000 0.800000 0.800000');
  });

  it('does not write the conventional white Kd under a texture', () => {
    // `Kd 1 1 1` is the usual idiom for "the texture is authoritative" (renderers
    // multiply Kd by map_Kd). It is WRONG for our round-trip: the importer copies
    // Kd into per-vertex colours regardless of texturing, and those are the
    // viewer's fallback when a texture isn't applied — so white Kd would bring
    // every leaf back white. Guard against a well-meaning "fix" to the convention.
    const LEAF: [number, number, number] = [0.3, 0.55, 0.2];
    const data = coloredStrip([LEAF, LEAF]);
    data.uvCoordinates = new Float32Array(data.vertexCount * 2);
    const files = serializeMeshObj(data, {
      baseName: 'bean',
      materials: [{
        name: 'bean_leaf', textureData: toBase64(PNG_BYTES), hasAlpha: true,
        triangleIndices: [0, 1],
      }],
    });
    expect(files[1].text!).not.toContain('Kd 1.000000 1.000000 1.000000');
    expect(files[1].text!).toContain(kdLineF32(0.3, 0.55, 0.2));
  });

  it('keeps an explicitly declared material colour over the geometry mean', () => {
    const data = coloredStrip([OLIVE, OLIVE]);
    const files = serializeMeshObj(data, {
      baseName: 'bean',
      materials: [{ name: 'stem', color: [0.9, 0.1, 0.1], hasAlpha: false, triangleIndices: [0, 1] }],
    });
    expect(files[1].text!).toContain(kdLine(0.9, 0.1, 0.1));
  });

  it('gives colour materials names that do not collide with supplied ones', () => {
    const data = coloredStrip([OLIVE, STEM]);
    const files = serializeMeshObj(data, {
      baseName: 'bean',
      materials: [{ name: 'color_0', color: [1, 0, 0], hasAlpha: false, triangleIndices: [0] }],
    });
    const declared = linesStartingWith(files[1].text!, 'newmtl ').map(l => l.slice(7).trim());
    expect(new Set(declared).size).toBe(declared.length);
    // Every name the OBJ references is declared exactly once.
    const used = [...new Set(linesStartingWith(files[0].text!, 'usemtl ').map(l => l.slice(7).trim()))];
    for (const n of used) expect(declared).toContain(n);
  });

  it('ignores vertex colours that do not match the vertex count', () => {
    const data = coloredStrip([OLIVE, STEM]);
    data.vertexColors = new Float32Array([0.1, 0.2, 0.3]); // wrong length
    const files = serializeMeshObj(data, { baseName: 'bean' });
    // Nothing to derive materials from → plain geometry, no MTL.
    expect(files).toHaveLength(1);
    expect(linesStartingWith(files[0].text!, 'f ')).toHaveLength(2);
  });
});

describe('serializeMeshPly', () => {
  it('writes a header whose counts match the body', () => {
    const ply = serializeMeshPly(quad());
    expect(ply.startsWith('ply\n')).toBe(true);
    expect(ply).toContain('element vertex 4');
    expect(ply).toContain('element face 2');
    const body = lines(ply).slice(lines(ply).indexOf('end_header') + 1);
    expect(body).toHaveLength(6);
    expect(body.slice(4).every(l => l.startsWith('3 '))).toBe(true);
  });

  it('carries provenance comments', () => {
    expect(serializeMeshPly(quad(), { comments: ['Helios Plant: bean, Age: 30 days'] }))
      .toContain('comment Helios Plant: bean, Age: 30 days');
  });
});

describe('serializeMeshStl', () => {
  it('writes one facet per triangle with a unit normal', () => {
    const stl = serializeMeshStl(quad());
    expect(stl.startsWith('solid mesh')).toBe(true);
    expect(stl.trimEnd().endsWith('endsolid mesh')).toBe(true);
    const facets = linesStartingWith(stl, '  facet normal ');
    expect(facets).toHaveLength(2);
    for (const f of facets) {
      const n = f.trim().split(/\s+/).slice(2).map(Number);
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
      // The quad lies in z=0 with CCW winding, so every normal is +z.
      expect(n[2]).toBeCloseTo(1, 5);
    }
    expect(linesStartingWith(stl, '      vertex ')).toHaveLength(6);
  });
});
