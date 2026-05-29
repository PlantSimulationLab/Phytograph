import { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { MeshData } from '../../../lib/pointCloudTypes';

// Triangle mesh component for rendering triangulated surfaces
export interface TriangleMeshProps {
  data: MeshData;
  color?: string;
  opacity?: number;
  wireframe?: boolean;
  useVertexColors?: boolean;  // Use per-vertex colors from data.vertexColors
}

export function TriangleMesh({ data, color = '#4ade80', opacity = 0.7, wireframe = false, useVertexColors = false }: TriangleMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const hasLoggedRef = useRef(false);

  // Check if we should use vertex colors
  const hasVertexColors = useVertexColors && data.vertexColors && data.vertexColors.length > 0;

  // Debug log only once per data change
  useEffect(() => {
    if (!hasLoggedRef.current) {
      console.log('[TriangleMesh] Rendering:', {
        vertexCount: data.vertexCount,
        triangleCount: data.triangleCount,
        verticesLen: data.vertices.length,
        indicesLen: data.indices.length,
        hasVertexColors,
        useVertexColors,
        color,
        opacity,
      });
      hasLoggedRef.current = true;
    }
  }, [data, hasVertexColors, useVertexColors, color, opacity]);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));

    if (data.normals) {
      geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    } else {
      geo.computeVertexNormals();
    }

    // Add vertex colors if available
    if (hasVertexColors && data.vertexColors) {
      geo.setAttribute('color', new THREE.BufferAttribute(data.vertexColors, 3));
    }

    return geo;
  }, [data, hasVertexColors]);

  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: hasVertexColors ? 0xffffff : new THREE.Color(color),  // White when using vertex colors
      transparent: true,
      opacity,
      wireframe,
      side: THREE.DoubleSide,
      flatShading: false,
      vertexColors: hasVertexColors,  // Enable vertex colors
    });
  }, [color, opacity, wireframe, hasVertexColors]);

  // Update material properties when they change
  useEffect(() => {
    if (meshRef.current) {
      const mat = meshRef.current.material as THREE.MeshStandardMaterial;
      if (!hasVertexColors) {
        mat.color.set(color);
      }
      mat.opacity = opacity;
      mat.wireframe = wireframe;
    }
  }, [color, opacity, wireframe, hasVertexColors]);

  useEffect(() => () => { geometry.dispose(); }, [geometry]);
  useEffect(() => () => { material.dispose(); }, [material]);

  return <mesh ref={meshRef} geometry={geometry} material={material} />;
}
