import { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import type { MeshData, PlantMaterialDef } from '../../../lib/pointCloudTypes';
import { TriangleMesh } from './TriangleMesh';

// Textured plant mesh component - renders plant with multiple materials and textures
export interface TexturedPlantMeshProps {
  data: MeshData;
  plantMaterials: PlantMaterialDef[];
  opacity?: number;
}

// Helper to load base64 image as Three.js texture
function useBase64Texture(base64Data: string | undefined): THREE.Texture | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  // Track the latest texture in a ref so cleanup disposes the actual current
  // value, not the stale `texture` closed over at effect setup time.
  const currentRef = useRef<THREE.Texture | null>(null);

  useEffect(() => {
    if (!base64Data) {
      if (currentRef.current) {
        currentRef.current.dispose();
        currentRef.current = null;
      }
      setTexture(null);
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const tex = new THREE.Texture(img);
      tex.needsUpdate = true;
      tex.colorSpace = THREE.SRGBColorSpace;
      if (currentRef.current) currentRef.current.dispose();
      currentRef.current = tex;
      setTexture(tex);
    };
    img.onerror = (e) => {
      if (cancelled) return;
      console.error('[useBase64Texture] Failed to load texture from base64:', e);
      setTexture(null);
    };
    img.src = `data:image/png;base64,${base64Data}`;

    return () => {
      cancelled = true;
      if (currentRef.current) {
        currentRef.current.dispose();
        currentRef.current = null;
      }
    };
  }, [base64Data]);

  return texture;
}

// Single material submesh within a textured plant
interface MaterialSubmeshProps {
  vertices: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  materialDef: PlantMaterialDef;
  opacity: number;
}

function MaterialSubmesh({ vertices, normals, uvs, materialDef, opacity }: MaterialSubmeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const texture = useBase64Texture(materialDef.textureData);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    // Don't use index buffer since vertices are already in triangle order (non-indexed geometry)
    // This is simpler and avoids potential index issues

    if (normals) {
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    } else {
      geo.computeVertexNormals();
    }

    if (uvs) {
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    }

    console.log(`[MaterialSubmesh] ${materialDef.name} geo created: ${vertices.length / 3} verts, ${(uvs?.length ?? 0) / 2} uvs`);
    return geo;
  }, [vertices, normals, uvs, materialDef.name]);

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      opacity,
      // Use polygon offset to render textured mesh in front of base mesh (prevents z-fighting)
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    // Apply texture or color
    if (texture && materialDef.hasAlpha) {
      mat.map = texture;
      mat.alphaMap = texture;
      mat.alphaTest = 0.5;  // Alpha cutoff for leaf shapes
      mat.transparent = true;
    } else if (texture) {
      mat.map = texture;
    } else if (materialDef.color) {
      mat.color = new THREE.Color(materialDef.color[0], materialDef.color[1], materialDef.color[2]);
    } else {
      mat.color = new THREE.Color(0.3, 0.5, 0.1);  // Default green
    }

    return mat;
  }, [texture, materialDef, opacity]);

  // Update material when texture loads
  useEffect(() => {
    if (meshRef.current && texture) {
      const mat = meshRef.current.material as THREE.MeshStandardMaterial;
      mat.map = texture;
      if (materialDef.hasAlpha) {
        mat.alphaMap = texture;
        mat.alphaTest = 0.5;
      }
      mat.needsUpdate = true;
    }
  }, [texture, materialDef.hasAlpha]);

  useEffect(() => () => { geometry.dispose(); }, [geometry]);
  useEffect(() => () => { material.dispose(); }, [material]);

  return <mesh ref={meshRef} geometry={geometry} material={material} />;
}

export function TexturedPlantMesh({ data, plantMaterials, opacity = 0.9 }: TexturedPlantMeshProps) {
  // Build submeshes for each material group
  const submeshes = useMemo(() => {
    // If no UVs or no materials with textures, render as single colored mesh
    if (!data.uvCoordinates || data.uvCoordinates.length === 0) {
      console.log('[TexturedPlantMesh] No UV coordinates, falling back');
      return null;
    }

    console.log('[TexturedPlantMesh] Building submeshes', {
      vertexCount: data.vertexCount,
      triangleCount: data.triangleCount,
      verticesLength: data.vertices.length,
      uvsLength: data.uvCoordinates.length,
      materialsCount: plantMaterials.length,
    });

    // Group triangles by material and extract submesh data
    const results: {
      materialDef: PlantMaterialDef;
      vertices: Float32Array;
      normals?: Float32Array;
      uvs: Float32Array;
    }[] = [];

    for (const mat of plantMaterials) {
      if (mat.triangleIndices.length === 0) continue;

      const numTris = mat.triangleIndices.length;
      const numVerts = numTris * 3;

      console.log(`[TexturedPlantMesh] Material ${mat.name}: ${numTris} triangles, indices range [${Math.min(...mat.triangleIndices)}-${Math.max(...mat.triangleIndices)}]`);

      // Extract vertices for this material group using actual triangle indices
      const verts = new Float32Array(numVerts * 3);
      const uvs = new Float32Array(numVerts * 2);
      const norms = data.normals ? new Float32Array(numVerts * 3) : undefined;

      for (let t = 0; t < numTris; t++) {
        const triIdx = mat.triangleIndices[t];
        // Each triangle has 3 vertices in the expanded geometry
        for (let v = 0; v < 3; v++) {
          const srcVertIdx = triIdx * 3 + v;  // Source vertex index in expanded geometry
          const dstVertIdx = t * 3 + v;        // Destination vertex index in submesh

          // Bounds checking
          if (srcVertIdx * 3 + 2 >= data.vertices.length) {
            console.error(`[TexturedPlantMesh] Vertex out of bounds: srcVertIdx=${srcVertIdx}, max=${data.vertices.length / 3}`);
            continue;
          }
          if (srcVertIdx * 2 + 1 >= data.uvCoordinates.length) {
            console.error(`[TexturedPlantMesh] UV out of bounds: srcVertIdx=${srcVertIdx}, max=${data.uvCoordinates.length / 2}`);
            continue;
          }

          // Copy vertex position
          verts[dstVertIdx * 3] = data.vertices[srcVertIdx * 3];
          verts[dstVertIdx * 3 + 1] = data.vertices[srcVertIdx * 3 + 1];
          verts[dstVertIdx * 3 + 2] = data.vertices[srcVertIdx * 3 + 2];

          // Copy UVs
          uvs[dstVertIdx * 2] = data.uvCoordinates[srcVertIdx * 2];
          uvs[dstVertIdx * 2 + 1] = data.uvCoordinates[srcVertIdx * 2 + 1];

          // Copy normals if available
          if (norms && data.normals) {
            norms[dstVertIdx * 3] = data.normals[srcVertIdx * 3];
            norms[dstVertIdx * 3 + 1] = data.normals[srcVertIdx * 3 + 1];
            norms[dstVertIdx * 3 + 2] = data.normals[srcVertIdx * 3 + 2];
          }
        }
      }

      // Log first triangle for debugging
      if (numTris > 0) {
        console.log(`[TexturedPlantMesh] ${mat.name} first tri verts:`, [
          [verts[0], verts[1], verts[2]],
          [verts[3], verts[4], verts[5]],
          [verts[6], verts[7], verts[8]],
        ]);
        console.log(`[TexturedPlantMesh] ${mat.name} first tri UVs:`, [
          [uvs[0], uvs[1]],
          [uvs[2], uvs[3]],
          [uvs[4], uvs[5]],
        ]);
      }

      results.push({
        materialDef: mat,
        vertices: verts,
        normals: norms,
        uvs,
      });
    }

    console.log(`[TexturedPlantMesh] Created ${results.length} submeshes`);
    return results;
  }, [data, plantMaterials]);

  // Fallback: render with vertex colors if no texture data
  if (!submeshes) {
    return (
      <TriangleMesh
        data={data}
        color="#4ade80"
        opacity={opacity}
        useVertexColors={data.vertexColors !== undefined && data.vertexColors.length > 0}
      />
    );
  }

  return (
    <group>
      {submeshes.map((sm, idx) => (
        <MaterialSubmesh
          key={`${sm.materialDef.name}-${idx}`}
          vertices={sm.vertices}
          normals={sm.normals}
          uvs={sm.uvs}
          materialDef={sm.materialDef}
          opacity={opacity}
        />
      ))}
    </group>
  );
}
