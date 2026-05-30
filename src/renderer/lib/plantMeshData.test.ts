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
});
