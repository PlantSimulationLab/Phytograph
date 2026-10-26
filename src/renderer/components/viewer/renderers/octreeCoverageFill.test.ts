import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PointCloudMaterial, PointSizeType } from 'potree-core';
import {
  MAX_FILL_FACTOR,
  VISIBLE_NODES_TEXTURE_WIDTH,
  basePointSize,
  buildVisibleNodesTexels,
  fillFactor,
  installCoverageFill,
  patchLodShader,
  type VisibleNodeLike,
} from './octreeCoverageFill';

// potree's material constructor paints its gradient textures on a 2D canvas,
// which happy-dom does not implement. Nothing here reads those textures.
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    rect() {}, fill() {}, createLinearGradient: () => ({ addColorStop() {} }),
  })) as never);
});
afterAll(() => vi.restoreAllMocks());

// A visible node with `own` points whose hierarchy children (octant -> points)
// are given.
function node(name: string, children: Record<number, number> = {}, own = 100): VisibleNodeLike {
  const kids: ({ numPoints: number } | null)[] = new Array(8).fill(null);
  for (const [i, n] of Object.entries(children)) kids[Number(i)] = { numPoints: n };
  return { name, index: name === 'r' ? 0 : Number(name.at(-1)), geometryNode: { numPoints: own, children: kids } };
}

const W = VISIBLE_NODES_TEXTURE_WIDTH;
const texel = (data: Uint8Array, i: number, row = 0) =>
  Array.from(data.slice(4 * (row * W + i), 4 * (row * W + i) + 4));

describe('fillFactor', () => {
  it('is the diameter that keeps coverage: sqrt((own + children) / own)', () => {
    // 100 drawn where 400 would be: a quarter of the points, so twice the diameter.
    expect(fillFactor(node('r', { 0: 150, 3: 150 }, 100))).toBeCloseTo(2);
    expect(fillFactor(node('r', {}, 100))).toBe(1);
    expect(fillFactor(node('r', { 0: 50 }, 0))).toBe(1);
    expect(fillFactor(node('r', { 0: 1e9 }, 1))).toBe(MAX_FILL_FACTOR);
  });
});

describe('buildVisibleNodesTexels', () => {
  it('encodes visible children, first-child advance, hierarchy children and the factor', () => {
    // r: hierarchy children 0,2,5 (0 and 5 visible); r5: children 1,3 (r53 visible); r0 a leaf.
    const nodes = [
      node('r53'), node('r0'), node('r', { 0: 100, 2: 100, 5: 100 }, 100), node('r5', { 1: 200, 3: 100 }, 100),
    ];
    const { data, offsets } = buildVisibleNodesTexels(nodes);
    // Breadth-first, lexicographic within a level.
    expect([...offsets.entries()]).toEqual([['r', 0], ['r0', 1], ['r5', 2], ['r53', 3]]);
    expect(texel(data, 0)).toEqual([0b100001, 0, 1, 0b100101]);
    expect(texel(data, 1)).toEqual([0, 0, 0, 0]);
    expect(texel(data, 2)).toEqual([0b1000, 0, 1, 0b1010]);
    expect(texel(data, 3)).toEqual([0, 0, 0, 0]);
    expect(texel(data, 0, 1)[0]).toBe(32); // sqrt(4) x 16
    expect(texel(data, 1, 1)[0]).toBe(16); // leaf: 1 x 16
    expect(texel(data, 2, 1)[0]).toBe(32);
  });

  it('stores advances past 255 in the high byte', () => {
    const names = ['r'];
    for (let a = 0; a < 8; a++) names.push(`r${a}`);
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) names.push(`r${a}${b}`);
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) for (let c = 0; c < 8; c++) names.push(`r${a}${b}${c}`);
    // r000 is the FIRST node of level 3, its child the first of level 4, so
    // every other level-3 node sits between them.
    names.push('r0000');
    const { data, offsets } = buildVisibleNodesTexels(names.map((n) => node(n)));
    const parent = offsets.get('r000')!;
    const child = offsets.get('r0000')!;
    const t = texel(data, parent);
    expect(t[0]).toBe(1);
    expect(t[1] * 256 + t[2]).toBe(child - parent);
    expect(child - parent).toBeGreaterThan(255);
  });

  it('never throws past the texture capacity and parks overflow on an all-zero texel', () => {
    // potree's own builder throws a RangeError here (data.set past the end).
    const names = ['r'];
    for (let a = 0; a < 8; a++) names.push(`r${a}`);
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) names.push(`r${a}${b}`);
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) for (let c = 0; c < 8; c++) names.push(`r${a}${b}${c}`);
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) for (let c = 0; c < 8; c++) for (let d = 0; d < 8; d++) {
      names.push(`r${a}${b}${c}${d}`);
    }
    expect(names.length).toBeGreaterThan(W);
    const { data, offsets } = buildVisibleNodesTexels(names.map((n) => node(n, { 0: 100 })));
    expect(data.length).toBe(4 * W * 2);
    const reserved = W - 1;
    expect(offsets.get('r7777')).toBe(reserved);
    expect(texel(data, reserved)).toEqual([0, 0, 0, 0]);
    expect(texel(data, reserved, 1)).toEqual([0, 0, 0, 0]);
    // A kept parent does not point at an overflowed child.
    const last = names[reserved];
    const parent = offsets.get(last.slice(0, -1))!;
    expect(texel(data, parent)[0] & (1 << Number(last.at(-1)))).toBe(0);
  });

  it('does not reorder the caller array', () => {
    const nodes = [node('r0'), node('r')];
    buildVisibleNodesTexels(nodes);
    expect(nodes.map((n) => n.name)).toEqual(['r0', 'r']);
  });
});

describe('patchLodShader against potree-core', () => {
  it('rewrites the real adaptive shader into the coverage fill', () => {
    const m = new PointCloudMaterial();
    m.pointSizeType = PointSizeType.ADAPTIVE;
    const { source, patched } = patchLodShader(m.vertexShader);
    expect(patched).toBe(true);
    expect(source).toContain('float fillFactor = 1.0;');
    expect(source).toContain('pointSize = size * fillFactor;');
    expect(source).not.toContain('worldSpaceSize');
    // Declared once, before the octree getLOD that assigns it.
    expect(source.match(/float fillFactor = 1\.0;/g)).toHaveLength(1);
    expect(source.indexOf('float fillFactor')).toBeLessThan(source.indexOf('fillFactor = texture('));
    // The kd-tree variant is untouched.
    expect(source).toContain('if (children == 0 || children == 2) { return depth; }');
  });

  it('refuses a shader it does not recognize', () => {
    expect(patchLodShader('void main() {}').patched).toBe(false);
  });
});

describe('installCoverageFill', () => {
  it('swaps in the two-row texture and keeps the patch across shader rebuilds', () => {
    const m = new PointCloudMaterial();
    installCoverageFill(m);
    const tex = (m as any).visibleNodesTexture;
    expect(tex.image.width).toBe(W);
    expect(tex.image.height).toBe(2);
    expect((m as any).uniforms.visibleNodes.value).toBe(tex);

    m.pointSizeType = PointSizeType.FIXED;
    m.pointSizeType = PointSizeType.ADAPTIVE; // the setter rebuilds the shader
    expect(m.vertexShader).toContain('#define adaptive_point_size');
    expect(m.vertexShader).toContain('pointSize = size * fillFactor;');

    (m as any).updateVisibilityTextureData([node('r0'), node('r', { 0: 100, 1: 200 }, 100)]);
    const offsets = (m as any).visibleNodeTextureOffsets as Map<string, number>;
    expect(offsets.get('r')).toBe(0);
    expect(offsets.get('r0')).toBe(1);
    const data = tex.image.data as Uint8Array;
    expect(Array.from(data.slice(0, 4))).toEqual([1, 0, 1, 0b11]);
    expect(data[4 * W]).toBe(32);
  });
});

describe('basePointSize', () => {
  it('floors at what FIXED sizing drew, so full-detail regions are unchanged', () => {
    expect(basePointSize(1)).toBe(2);
    expect(basePointSize(4)).toBe(4);
  });
});
