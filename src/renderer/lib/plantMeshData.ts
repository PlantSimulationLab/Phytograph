import type { MeshData, PlantMaterialDef } from './pointCloudTypes';

// The geometry + texture fields shared by every backend response that yields a
// plant/textured mesh: /api/plant/generate, /api/plant/session/.../advance,
// /api/plant/morph, and /api/mesh/import. Centralizing the flatten step keeps
// the many viewer call sites from each re-implementing it (and silently
// dropping UVs / materials, which is how plant textures regressed before).
export interface PlantMeshResponseLike {
  vertices: number[][];
  indices: number[][];
  normals?: number[][] | null;
  colors?: number[][] | null;
  uv_coordinates?: number[][] | null;
  materials?: { name: string; color?: number[]; texture_name?: string; has_alpha: boolean }[] | null;
  material_groups?: { material_name: string; triangle_indices: number[] }[] | null;
  textures?: Record<string, string> | null;
  vertex_count: number;
  triangle_count: number;
}

/**
 * Flatten a plant/textured-mesh backend response into the renderer's MeshData +
 * PlantMaterialDef[] shape. Returns `plantMaterials` as `undefined` when the
 * response carries no material groups (untextured mesh).
 */
export function plantResponseToMeshData(resp: PlantMeshResponseLike): {
  data: MeshData;
  plantMaterials?: PlantMaterialDef[];
} {
  const vertices = new Float32Array(resp.vertices.length * 3);
  for (let i = 0; i < resp.vertices.length; i++) {
    vertices[i * 3] = resp.vertices[i][0];
    vertices[i * 3 + 1] = resp.vertices[i][1];
    vertices[i * 3 + 2] = resp.vertices[i][2];
  }

  const indices = new Uint32Array(resp.indices.length * 3);
  for (let i = 0; i < resp.indices.length; i++) {
    indices[i * 3] = resp.indices[i][0];
    indices[i * 3 + 1] = resp.indices[i][1];
    indices[i * 3 + 2] = resp.indices[i][2];
  }

  let normals: Float32Array | undefined;
  if (resp.normals && resp.normals.length > 0) {
    normals = new Float32Array(resp.normals.length * 3);
    for (let i = 0; i < resp.normals.length; i++) {
      normals[i * 3] = resp.normals[i][0];
      normals[i * 3 + 1] = resp.normals[i][1];
      normals[i * 3 + 2] = resp.normals[i][2];
    }
  }

  let vertexColors: Float32Array | undefined;
  if (resp.colors && resp.colors.length > 0) {
    vertexColors = new Float32Array(resp.colors.length * 3);
    for (let i = 0; i < resp.colors.length; i++) {
      vertexColors[i * 3] = resp.colors[i][0];
      vertexColors[i * 3 + 1] = resp.colors[i][1];
      vertexColors[i * 3 + 2] = resp.colors[i][2];
    }
  }

  let uvCoordinates: Float32Array | undefined;
  if (resp.uv_coordinates && resp.uv_coordinates.length > 0) {
    uvCoordinates = new Float32Array(resp.uv_coordinates.length * 2);
    for (let i = 0; i < resp.uv_coordinates.length; i++) {
      uvCoordinates[i * 2] = resp.uv_coordinates[i][0];
      uvCoordinates[i * 2 + 1] = resp.uv_coordinates[i][1];
    }
  }

  let plantMaterials: PlantMaterialDef[] | undefined;
  if (resp.materials && resp.material_groups) {
    plantMaterials = resp.materials.map((mat) => {
      const group = resp.material_groups?.find((g) => g.material_name === mat.name);
      const textureData = mat.texture_name && resp.textures ? resp.textures[mat.texture_name] : undefined;
      return {
        name: mat.name,
        color: mat.color as [number, number, number] | undefined,
        textureData,
        hasAlpha: mat.has_alpha,
        triangleIndices: group?.triangle_indices ?? [],
      };
    });
  }

  const data: MeshData = {
    vertices,
    indices,
    normals,
    vertexColors,
    uvCoordinates,
    vertexCount: resp.vertex_count,
    triangleCount: resp.triangle_count,
  };
  return { data, plantMaterials };
}
