import { describe, it, expect } from 'vitest';
import { plantResponseToMeshData, type PlantMeshResponseLike } from './plantMeshData';

describe('plantResponseToMeshData', () => {
  const base: PlantMeshResponseLike = {
    vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
    indices: [[0, 1, 2]],
    vertex_count: 3,
    triangle_count: 1,
  };

  it('flattens vertices and indices into typed arrays', () => {
    const { data } = plantResponseToMeshData(base);
    expect(Array.from(data.vertices)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    expect(Array.from(data.indices)).toEqual([0, 1, 2]);
    expect(data.vertexCount).toBe(3);
    expect(data.triangleCount).toBe(1);
  });

  it('omits optional attributes when the response has none', () => {
    const { data, plantMaterials } = plantResponseToMeshData(base);
    expect(data.normals).toBeUndefined();
    expect(data.vertexColors).toBeUndefined();
    expect(data.uvCoordinates).toBeUndefined();
    expect(plantMaterials).toBeUndefined();
  });

  it('flattens normals, colors, and UVs when present', () => {
    const { data } = plantResponseToMeshData({
      ...base,
      normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
      colors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      uv_coordinates: [[0, 1], [1, 1], [1, 0]],
    });
    expect(Array.from(data.normals!)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(Array.from(data.vertexColors!)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(Array.from(data.uvCoordinates!)).toEqual([0, 1, 1, 1, 1, 0]);
  });

  it('maps per-material Kd colors (no UVs/textures) into vertexColors only', () => {
    // A multi-material OBJ with solid Kd colors and no textures — the backend
    // bakes each material's Kd into per-vertex colors and returns no UVs and no
    // material groups. This must surface as vertexColors with uvCoordinates and
    // plantMaterials both undefined, so the mesh renders vertex-colored rather
    // than flat (the riegl_vz.obj regression: imported flat blue).
    // Three distinct materials → three distinct per-vertex colors (values
    // chosen to be exactly representable in Float32 so equality is exact).
    const { data, plantMaterials } = plantResponseToMeshData({
      ...base,
      colors: [[0.75, 0.5, 0.25], [0.5, 0.25, 0.125], [0.125, 0.25, 0.5]],
    });
    expect(Array.from(data.vertexColors!)).toEqual([
      0.75, 0.5, 0.25, 0.5, 0.25, 0.125, 0.125, 0.25, 0.5,
    ]);
    expect(data.uvCoordinates).toBeUndefined();
    expect(plantMaterials).toBeUndefined();
  });

  it('builds plantMaterials with texture data and triangle groups', () => {
    const { plantMaterials } = plantResponseToMeshData({
      ...base,
      uv_coordinates: [[0, 1], [1, 1], [1, 0]],
      materials: [{ name: 'leaf', color: [0.3, 0.55, 0.2], texture_name: 'leaf.png', has_alpha: true }],
      material_groups: [{ material_name: 'leaf', triangle_indices: [0] }],
      textures: { 'leaf.png': 'BASE64DATA' },
    });
    expect(plantMaterials).toHaveLength(1);
    expect(plantMaterials![0]).toMatchObject({
      name: 'leaf',
      color: [0.3, 0.55, 0.2],
      textureData: 'BASE64DATA',
      hasAlpha: true,
      triangleIndices: [0],
    });
  });

  it('leaves textureData undefined when the named texture is missing', () => {
    const { plantMaterials } = plantResponseToMeshData({
      ...base,
      materials: [{ name: 'leaf', texture_name: 'leaf.png', has_alpha: true }],
      material_groups: [{ material_name: 'leaf', triangle_indices: [0] }],
      textures: {},
    });
    expect(plantMaterials![0].textureData).toBeUndefined();
  });

  it('consumes a QSMLeavesResponse-shaped object (extra success/leaf_count fields)', () => {
    // The /api/qsm/leaves response carries success/leaf_count/error on top of the
    // plant-mesh fields. Those extras must not interfere with the flatten step —
    // this is the contract the AddLeaves wiring relies on.
    const leavesResp = {
      success: true,
      leaf_count: 2,
      error: undefined,
      vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
      indices: [[0, 1, 2]],
      uv_coordinates: [[0, 1], [1, 1], [1, 0]],
      materials: [{ name: 'leaf', color: [0.3, 0.5, 0.1], texture_name: 'AlmondLeaf.png', has_alpha: true }],
      material_groups: [{ material_name: 'leaf', triangle_indices: [0] }],
      textures: { 'AlmondLeaf.png': 'PNGDATA' },
      vertex_count: 3,
      triangle_count: 1,
    } as unknown as PlantMeshResponseLike;
    const { data, plantMaterials } = plantResponseToMeshData(leavesResp);
    expect(data.triangleCount).toBe(1);
    expect(plantMaterials![0]).toMatchObject({
      textureData: 'PNGDATA',
      hasAlpha: true,
      triangleIndices: [0],
    });
  });
});
