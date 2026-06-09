import { describe, it, expect } from 'vitest';
import { meshDisplayName, meshDisplayNameFor, type MeshEntry } from './pointCloudTypes';

let idSeq = 0;
// Minimal MeshEntry factory — only the fields the name functions read matter;
// the rest are filled with inert placeholders. Each mesh gets a unique id so
// dedup tests can build a list.
function makeMesh(over: Partial<MeshEntry>): MeshEntry {
  return {
    id: `m${idSeq++}`,
    sourceCloudId: 'c',
    data: { vertices: new Float32Array(), indices: new Uint32Array(), vertexCount: 0, triangleCount: 0 },
    visible: true,
    color: '#fff',
    method: 'ball_pivoting',
    ...over,
  };
}

describe('meshDisplayName', () => {
  it('prefers a user-assigned name over every computed default', () => {
    const mesh = makeMesh({ name: 'My mesh', triangulationParams: {}, method: 'poisson' });
    expect(meshDisplayName(mesh, 'tree.xyz')).toBe('My mesh');
  });

  it('names a triangulated mesh after its method and source filename', () => {
    const mesh = makeMesh({ method: 'poisson', triangulationParams: { depth: 8 } });
    expect(meshDisplayName(mesh, 'tree.xyz')).toBe('Poisson triangulation (tree.xyz)');
  });

  it('uses the right label per triangulation method', () => {
    expect(meshDisplayName(makeMesh({ method: 'ball_pivoting', triangulationParams: {} }), 'a'))
      .toBe('Ball-pivoting triangulation (a)');
    expect(meshDisplayName(makeMesh({ method: 'alpha_shape', triangulationParams: {} }), 'a'))
      .toBe('Alpha-shape triangulation (a)');
    expect(meshDisplayName(makeMesh({ method: 'delaunay', triangulationParams: {} }), 'a'))
      .toBe('Delaunay triangulation (a)');
  });

  it('omits the source suffix when the filename is unknown', () => {
    const mesh = makeMesh({ method: 'poisson', triangulationParams: {} });
    expect(meshDisplayName(mesh)).toBe('Poisson triangulation');
  });

  it('names a Helios triangulation distinctly from a Helios plant model', () => {
    // Helios *triangulation* meshes carry triangulationParams but sourceCloudId
    // 'helios' (no filename); the "triangulation" suffix keeps them apart from a
    // Helios-generated plant model (isPlant), which is named by type/age below.
    const mesh = makeMesh({ method: 'helios', triangulationParams: { lmax: 0.5, maxAspectRatio: 5, scanCount: 4 } });
    expect(meshDisplayName(mesh)).toBe('Helios triangulation');
  });

  it('falls back to the source filename for a mesh with no triangulation provenance (imported OBJ)', () => {
    const mesh = makeMesh({ method: 'ball_pivoting' });
    expect(meshDisplayName(mesh, 'imported.obj')).toBe('imported.obj');
  });

  it('falls back to a bare "Mesh" when there is neither provenance nor a filename', () => {
    expect(meshDisplayName(makeMesh({}))).toBe('Mesh');
  });

  it('names plants by type/age, ignoring triangulation params', () => {
    const single = makeMesh({ isPlant: true, plantType: 'bean', plantAge: 30, method: 'helios' });
    expect(meshDisplayName(single)).toBe('bean (30d)');
    const canopy = makeMesh({
      isPlant: true, plantType: 'bean', plantAge: 30, method: 'helios',
      plantCanopy: { countX: 3, countY: 2, plantCount: 6 },
    });
    expect(meshDisplayName(canopy)).toBe('bean canopy 3×2 (30d)');
  });
});

describe('meshDisplayNameFor (collision numbering)', () => {
  const noFile = () => undefined;

  it('leaves a single auto-named triangulation unnumbered', () => {
    const a = makeMesh({ method: 'helios', triangulationParams: { lmax: 0.5 } });
    expect(meshDisplayNameFor(a, [a], noFile)).toBe('Helios triangulation');
  });

  it('numbers only the duplicates: first bare, rest (2), (3)…', () => {
    const a = makeMesh({ method: 'helios', triangulationParams: { lmax: 0.5 } });
    const b = makeMesh({ method: 'helios', triangulationParams: { lmax: 0.5 } });
    const c = makeMesh({ method: 'helios', triangulationParams: { lmax: 0.5 } });
    const list = [a, b, c];
    expect(meshDisplayNameFor(a, list, noFile)).toBe('Helios triangulation');
    expect(meshDisplayNameFor(b, list, noFile)).toBe('Helios triangulation (2)');
    expect(meshDisplayNameFor(c, list, noFile)).toBe('Helios triangulation (3)');
  });

  it('dedupes per distinct base name independently', () => {
    const h1 = makeMesh({ method: 'helios', triangulationParams: { lmax: 0.5 } });
    const p1 = makeMesh({ method: 'poisson', triangulationParams: { depth: 8 } });
    const h2 = makeMesh({ method: 'helios', triangulationParams: { lmax: 0.5 } });
    const list = [h1, p1, h2];
    expect(meshDisplayNameFor(h1, list, noFile)).toBe('Helios triangulation');
    expect(meshDisplayNameFor(p1, list, noFile)).toBe('Poisson triangulation');
    expect(meshDisplayNameFor(h2, list, noFile)).toBe('Helios triangulation (2)');
  });

  it('counts collisions by full base name, so different source files do not collide', () => {
    const a = makeMesh({ method: 'poisson', triangulationParams: { depth: 8 }, sourceCloudId: 'A' });
    const b = makeMesh({ method: 'poisson', triangulationParams: { depth: 8 }, sourceCloudId: 'B' });
    const fileFor = (m: MeshEntry) => (m.sourceCloudId === 'A' ? 'a.xyz' : 'b.xyz');
    const list = [a, b];
    expect(meshDisplayNameFor(a, list, fileFor)).toBe('Poisson triangulation (a.xyz)');
    expect(meshDisplayNameFor(b, list, fileFor)).toBe('Poisson triangulation (b.xyz)');
  });

  it('ignores user-renamed meshes: they keep their text and do not bump the counter', () => {
    const renamed = makeMesh({ name: 'Helios triangulation', method: 'helios', triangulationParams: { lmax: 0.5 } });
    const auto = makeMesh({ method: 'helios', triangulationParams: { lmax: 0.5 } });
    const list = [renamed, auto];
    // The renamed mesh shows its literal name, untouched.
    expect(meshDisplayNameFor(renamed, list, noFile)).toBe('Helios triangulation');
    // The auto mesh is the first AUTO of its kind → stays bare (the manual
    // name doesn't count as a prior collision).
    expect(meshDisplayNameFor(auto, list, noFile)).toBe('Helios triangulation');
  });
});
