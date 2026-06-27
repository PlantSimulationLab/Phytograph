import { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import type { MeshData, PlantMaterialDef } from '../../../lib/pointCloudTypes';
import { TriangleMesh } from './TriangleMesh';
import { buildBoundsTree, freeBoundsTree } from '../../../lib/bvhRaycast';

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
      // UVs are V-flipped on the backend (Helios is V-down, three.js is V-up),
      // so disable three.js's own image flip to avoid double-flipping.
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
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
  wireframe?: boolean;
}

function MaterialSubmesh({ vertices, normals, uvs, materialDef, opacity, wireframe }: MaterialSubmeshProps) {
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

    return geo;
  }, [vertices, normals, uvs, materialDef.name]);

  const material = useMemo(() => {
    // Leaf textures are RGBA: the diffuse map's OWN alpha channel cuts out the
    // leaf silhouette via alphaTest, which discards transparent pixels cleanly
    // (no blending, so leaves don't vanish behind each other from transparency
    // sorting). Do NOT use alphaMap — alphaMap reads the green channel, not the
    // alpha channel, so it would cut leaves out by greenness. Render opaque so a
    // textured plant isn't washed out by the mesh-opacity slider's 0.7 default;
    // only blend when the user explicitly dials opacity below 1.
    const isCutout = !!(texture && materialDef.hasAlpha);
    const blended = opacity < 1 && !isCutout;

    const mat = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide,
      transparent: blended,
      opacity: isCutout ? 1 : opacity,
      wireframe: !!wireframe,
      roughness: 0.85,
      metalness: 0.0,
    });

    if (texture) {
      mat.map = texture;
      if (isCutout) {
        mat.alphaTest = 0.5;  // cut out the leaf shape using the map's alpha
      }
    } else if (materialDef.color) {
      mat.color = new THREE.Color(materialDef.color[0], materialDef.color[1], materialDef.color[2]);
    } else {
      mat.color = new THREE.Color(0.3, 0.5, 0.1);  // Default green
    }

    return mat;
  }, [texture, materialDef, opacity, wireframe]);

  // Attach the texture once it finishes loading (the material is created before
  // the async image resolves).
  useEffect(() => {
    if (meshRef.current && texture) {
      const mat = meshRef.current.material as THREE.MeshStandardMaterial;
      mat.map = texture;
      if (materialDef.hasAlpha) {
        mat.alphaTest = 0.5;
      }
      mat.needsUpdate = true;
    }
  }, [texture, materialDef.hasAlpha]);

  // Build the picking BVH in the same effect that frees it, so StrictMode's
  // build → cleanup → build cycle can't leave boundsTree=null (which would make
  // acceleratedRaycast fall back to brute force). See TriangleMesh for the full
  // rationale; accelerates picking on large imported OBJ surfaces.
  useEffect(() => {
    buildBoundsTree(geometry);
    return () => { freeBoundsTree(geometry); geometry.dispose(); };
  }, [geometry]);
  useEffect(() => () => { material.dispose(); }, [material]);

  return <mesh ref={meshRef} geometry={geometry} material={material} />;
}

export interface TexturedPlantMeshProps {
  data: MeshData;
  plantMaterials: PlantMaterialDef[];
  opacity?: number;
  wireframe?: boolean;
}

export function TexturedPlantMesh({ data, plantMaterials, opacity = 1, wireframe }: TexturedPlantMeshProps) {
  // Partition triangles into one textured submesh per material group plus a
  // single untextured remainder (stems, branches, flowers — vertex-colored).
  // Plant geometry is non-indexed and triangle-expanded: triangle t occupies
  // vertices [t*3, t*3+1, t*3+2] in `data.vertices`.
  const { submeshes, untexturedMesh } = useMemo(() => {
    const subs: {
      materialDef: PlantMaterialDef;
      vertices: Float32Array;
      normals?: Float32Array;
      uvs: Float32Array;
    }[] = [];

    const totalTris = data.triangleCount;
    const hasUVs = !!(data.uvCoordinates && data.uvCoordinates.length > 0);
    const claimed = new Uint8Array(totalTris);

    if (hasUVs) {
      for (const mat of plantMaterials) {
        if (!mat.textureData || mat.triangleIndices.length === 0) continue;

        const numTris = mat.triangleIndices.length;
        const numVerts = numTris * 3;
        const verts = new Float32Array(numVerts * 3);
        const uvs = new Float32Array(numVerts * 2);
        const norms = data.normals ? new Float32Array(numVerts * 3) : undefined;

        for (let t = 0; t < numTris; t++) {
          const triIdx = mat.triangleIndices[t];
          if (triIdx < totalTris) claimed[triIdx] = 1;
          for (let v = 0; v < 3; v++) {
            const src = triIdx * 3 + v;
            const dst = t * 3 + v;
            if (src * 3 + 2 >= data.vertices!.length) continue;
            if (src * 2 + 1 >= data.uvCoordinates!.length) continue;

            verts[dst * 3] = data.vertices[src * 3];
            verts[dst * 3 + 1] = data.vertices[src * 3 + 1];
            verts[dst * 3 + 2] = data.vertices[src * 3 + 2];

            uvs[dst * 2] = data.uvCoordinates![src * 2];
            uvs[dst * 2 + 1] = data.uvCoordinates![src * 2 + 1];

            if (norms && data.normals) {
              norms[dst * 3] = data.normals[src * 3];
              norms[dst * 3 + 1] = data.normals[src * 3 + 1];
              norms[dst * 3 + 2] = data.normals[src * 3 + 2];
            }
          }
        }

        subs.push({ materialDef: mat, vertices: verts, normals: norms, uvs });
      }
    }

    // Remaining (unclaimed) triangles → vertex-colored TriangleMesh.
    let remainder: MeshData | null = null;
    let unclaimedCount = 0;
    for (let t = 0; t < totalTris; t++) if (!claimed[t]) unclaimedCount++;

    if (unclaimedCount > 0) {
      const rVerts = new Float32Array(unclaimedCount * 9);
      const rIdx = new Uint32Array(unclaimedCount * 3);
      const rNorm = data.normals ? new Float32Array(unclaimedCount * 9) : undefined;
      const rCol = data.vertexColors ? new Float32Array(unclaimedCount * 9) : undefined;
      let w = 0;
      for (let t = 0; t < totalTris; t++) {
        if (claimed[t]) continue;
        for (let v = 0; v < 3; v++) {
          const src = t * 3 + v;
          rVerts[w * 3] = data.vertices[src * 3];
          rVerts[w * 3 + 1] = data.vertices[src * 3 + 1];
          rVerts[w * 3 + 2] = data.vertices[src * 3 + 2];
          if (rNorm && data.normals) {
            rNorm[w * 3] = data.normals[src * 3];
            rNorm[w * 3 + 1] = data.normals[src * 3 + 1];
            rNorm[w * 3 + 2] = data.normals[src * 3 + 2];
          }
          if (rCol && data.vertexColors) {
            rCol[w * 3] = data.vertexColors[src * 3];
            rCol[w * 3 + 1] = data.vertexColors[src * 3 + 1];
            rCol[w * 3 + 2] = data.vertexColors[src * 3 + 2];
          }
          rIdx[w] = w;
          w++;
        }
      }
      remainder = {
        vertices: rVerts,
        indices: rIdx,
        normals: rNorm,
        vertexColors: rCol,
        vertexCount: unclaimedCount * 3,
        triangleCount: unclaimedCount,
      };
    }

    return { submeshes: subs, untexturedMesh: remainder };
  }, [data, plantMaterials]);

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
          wireframe={wireframe}
        />
      ))}
      {untexturedMesh && (
        <TriangleMesh
          data={untexturedMesh}
          color="#4ade80"
          opacity={opacity}
          wireframe={wireframe}
          useVertexColors={untexturedMesh.vertexColors !== undefined && untexturedMesh.vertexColors.length > 0}
        />
      )}
    </group>
  );
}
