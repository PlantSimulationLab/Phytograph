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
  // Pre-built non-indexed per-triangle pseudocolor buffers (e.g. color by
  // inclination/azimuth/area). When present these take precedence over the
  // solid color and any baked vertexColors: the geometry is rebuilt
  // non-indexed (3 unique vertices per triangle) so each face carries its own
  // color. positions/colors are both 9 floats per triangle.
  triangleColors?: { positions: Float32Array; colors: Float32Array } | null;
}

export function TriangleMesh({ data, color = '#4ade80', opacity = 0.7, wireframe = false, useVertexColors = false, triangleColors = null }: TriangleMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const hasLoggedRef = useRef(false);

  // Per-triangle pseudocolor (non-indexed) wins over baked per-vertex colors.
  const hasTriangleColors = !!triangleColors && triangleColors.colors.length > 0;
  const hasVertexColors = !hasTriangleColors && useVertexColors && !!data.vertexColors && data.vertexColors.length > 0;

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

    if (hasTriangleColors && triangleColors) {
      // Non-indexed: one set of 3 vertices per triangle, each carrying the
      // triangle's pseudocolor. Normals are recomputed flat per face so
      // shading doesn't smear across the per-triangle color boundaries.
      geo.setAttribute('position', new THREE.BufferAttribute(triangleColors.positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(triangleColors.colors, 3));
      geo.computeVertexNormals();
      return geo;
    }

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
  }, [data, hasVertexColors, hasTriangleColors, triangleColors]);

  const useColorAttr = hasTriangleColors || hasVertexColors;

  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: useColorAttr ? 0xffffff : new THREE.Color(color),  // White when using a color attribute
      transparent: true,
      opacity,
      wireframe,
      side: THREE.DoubleSide,
      flatShading: hasTriangleColors,  // Flat per-face shading for pseudocolor
      vertexColors: useColorAttr,  // Enable the color attribute
    });
  }, [color, opacity, wireframe, useColorAttr, hasTriangleColors]);

  // Update material properties when they change
  useEffect(() => {
    if (meshRef.current) {
      const mat = meshRef.current.material as THREE.MeshStandardMaterial;
      if (!useColorAttr) {
        mat.color.set(color);
      }
      mat.opacity = opacity;
      mat.wireframe = wireframe;
    }
  }, [color, opacity, wireframe, useColorAttr]);

  useEffect(() => () => { geometry.dispose(); }, [geometry]);
  useEffect(() => () => { material.dispose(); }, [material]);

  return <mesh ref={meshRef} geometry={geometry} material={material} />;
}
