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
  // Draw-order override for the transparent pass. three.js paints transparent
  // objects back-to-front by camera distance, which mis-orders two co-located
  // translucent surfaces (the green triangulated mesh and the 40%-opaque voxel
  // box) from some view angles. Giving the box a higher renderOrder forces it
  // to always blend ON TOP of the surface, so the volume tint is preserved
  // regardless of viewing direction. Default 0 = normal distance sorting.
  renderOrder?: number;
}

export function TriangleMesh({ data, color = '#4ade80', opacity = 0.7, wireframe = false, useVertexColors = false, triangleColors = null, renderOrder = 0 }: TriangleMeshProps) {
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

  // Geometry is keyed on the POSITIONS, not the colors: the non-indexed
  // positions are mode-independent (the viewer caches and reuses them across
  // color-mode changes), so switching inclination↔azimuth↔area or the colormap
  // doesn't rebuild the geometry — only the color attribute is swapped in place
  // (see the effect below). On multi-million-triangle meshes this is the
  // difference between a long freeze (rebuild + re-upload positions + normals)
  // and a near-instant recolor.
  const trianglePositions = hasTriangleColors && triangleColors ? triangleColors.positions : null;
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();

    if (trianglePositions) {
      // Non-indexed: one set of 3 vertices per triangle, each carrying the
      // triangle's pseudocolor. No normal attribute — the material uses
      // flatShading, which derives the face normal in the fragment shader from
      // screen-space position derivatives, so an explicit normal buffer would
      // be unused dead weight (another full-size buffer + GPU upload, ~100+ MB
      // at multi-million-triangle counts). The color attribute is seeded here
      // for a correct first paint; subsequent color-only changes (which don't
      // rebuild this geometry) are swapped in by the effect below.
      geo.setAttribute('position', new THREE.BufferAttribute(trianglePositions, 3));
      if (triangleColors) {
        geo.setAttribute('color', new THREE.BufferAttribute(triangleColors.colors, 3));
      }
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
  }, [data, hasVertexColors, trianglePositions]);

  // Per-triangle colors: update the color attribute on the (stable) non-indexed
  // geometry without rebuilding it. Runs on mount and whenever the color buffer
  // changes (mode or colormap switch).
  //
  // CRITICAL for large meshes: when the new colors are the same length as the
  // current ones (always true for a mode/colormap switch on the same mesh — the
  // triangle count is unchanged), copy them INTO the existing buffer and flag it
  // for re-upload, rather than `setAttribute`-ing a fresh BufferAttribute.
  // three.js does NOT free the GPU buffer of a replaced attribute, so swapping a
  // new ~100 MB color buffer on every recolor leaks one buffer per switch and
  // marches the process toward the renderer's ~4 GB heap cap (OOM after enough
  // switches). In-place reuse keeps exactly one color buffer for the mesh's life.
  const triangleColorBuffer = hasTriangleColors && triangleColors ? triangleColors.colors : null;
  useEffect(() => {
    if (!triangleColorBuffer) return;
    const existing = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (existing && existing.array.length === triangleColorBuffer.length) {
      // Same size → overwrite in place and re-upload. No new GPU buffer.
      (existing.array as Float32Array).set(triangleColorBuffer);
      existing.needsUpdate = true;
    } else if (!existing || existing.array !== triangleColorBuffer) {
      geometry.setAttribute('color', new THREE.BufferAttribute(triangleColorBuffer, 3));
    }
  }, [geometry, triangleColorBuffer]);

  const useColorAttr = hasTriangleColors || hasVertexColors;

  // A translucent surface must NOT write depth — otherwise a transparent mesh
  // (e.g. the 40%-opaque voxel box) stamps the depth buffer and, because
  // three.js sorts transparent objects by camera distance, can render before
  // another transparent mesh (the triangulated surface) and occlude it from
  // certain view angles. Only write depth when fully opaque. (See the matching
  // pattern in LADVoxelGrid.) The `key` forces a fresh material when the
  // transparent flag flips, since three.js needs a recompile for that change.
  const isTranslucent = opacity < 1;
  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: useColorAttr ? 0xffffff : new THREE.Color(color),  // White when using a color attribute
      transparent: isTranslucent,
      depthWrite: !isTranslucent,
      opacity,
      wireframe,
      side: THREE.DoubleSide,
      flatShading: hasTriangleColors,  // Flat per-face shading for pseudocolor
      vertexColors: useColorAttr,  // Enable the color attribute
    });
  }, [color, isTranslucent, wireframe, useColorAttr, hasTriangleColors]);

  // Update material properties when they change. opacity flows in here (not the
  // memo) so dragging the slider doesn't rebuild the material; transparent /
  // depthWrite track the opaque⇄translucent boundary and need needsUpdate.
  useEffect(() => {
    if (meshRef.current) {
      const mat = meshRef.current.material as THREE.MeshStandardMaterial;
      if (!useColorAttr) {
        mat.color.set(color);
      }
      mat.opacity = opacity;
      mat.wireframe = wireframe;
      const translucent = opacity < 1;
      if (mat.transparent !== translucent || mat.depthWrite !== !translucent) {
        mat.transparent = translucent;
        mat.depthWrite = !translucent;
        mat.needsUpdate = true;
      }
    }
  }, [color, opacity, wireframe, useColorAttr]);

  useEffect(() => () => { geometry.dispose(); }, [geometry]);
  useEffect(() => () => { material.dispose(); }, [material]);

  return <mesh ref={meshRef} geometry={geometry} material={material} renderOrder={renderOrder} />;
}
