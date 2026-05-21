import { useRef, useMemo, useState, useCallback, useEffect } from 'react';
import { Canvas, useThree, ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Grid, Html } from '@react-three/drei';
import * as THREE from 'three';
import { ZoomIn, ZoomOut, Eye, EyeOff, Maximize2, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Circle, Square, Move, Crop, RotateCcw, Undo2, Redo2, Trash2, Layers, CheckSquare, XSquare, Triangle, Loader2, Box, Merge, GitBranch, ChevronRight, ChevronDown, Download, Shapes, Plus, Home, Leaf, Sprout, ClockPlus, CircleDot, Minus, Grid3x3, X, ChartScatter, Eraser, Film, Play, StopCircle, Palette, Filter, Globe, Search, Dna } from 'lucide-react';
import GIF from 'gif.js';
import { triangulatePointCloud, TriangulationMethod, extractSkeleton, SkeletonResponse, generatePlantModel, PlantGenerationRequest, sampleMeshSurface, exportPointCloudLasLaz, createPlantSession, advancePlantSession, computeAlignmentDistance, AlignmentDistanceResponse, icpRegisterMeshToCloud, icpRegisterCloudToCloud, icpRegisterMeshToMesh, HeliosTriangulationRequest, HeliosTriangulationResponse, heliosTriangulate, morphPlant, PlantMorphRequest, deletePlantSession } from '../utils/backendApi';
import { showToast } from './Toast';
import { PlantGenerationPopup } from './PlantGenerationPopup';
import { HeliosTriangulationPopup } from './HeliosTriangulationPopup';
import { MorphPopup } from './MorphPopup';

// Scalar field data with min/max for normalization
export interface ScalarField {
  values: Float32Array;
  min: number;
  max: number;
}

// Point cloud data interface
export interface PointCloudData {
  positions: Float32Array;  // x, y, z interleaved
  colors?: Float32Array;    // r, g, b interleaved (0-1 range)
  intensities?: Float32Array;
  scalarFields?: Record<string, ScalarField>;  // name -> values with min/max
  pointCount: number;
  bounds: {
    min: THREE.Vector3;
    max: THREE.Vector3;
    center: THREE.Vector3;
    size: THREE.Vector3;
  };
  fileName?: string;
}

// Point cloud entry with metadata
export interface PointCloudEntry {
  id: string;
  data: PointCloudData;
  visible: boolean;
  color: string; // Label color for identification
}

// Per-cloud edit state
interface CloudEditState {
  translation: { x: number; y: number; z: number };
  cropMin: { x: number; y: number; z: number } | null;
  cropMax: { x: number; y: number; z: number } | null;
  cropEnabled: boolean;
  cropInvert: boolean;
  erasedIndices: Set<number>;  // Set of erased point indices
}

// State snapshot for mesh/skeleton
interface ObjectState {
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
}

// History entry for undo/redo (supports all object types)
interface HistoryEntry {
  type: 'cloud' | 'mesh' | 'skeleton';
  id: string;
  // Before and after states for proper undo/redo
  before: {
    cloudState?: CloudEditState;
    objectState?: ObjectState;
  };
  after: {
    cloudState?: CloudEditState;
    objectState?: ObjectState;
  };
}

// Mesh data from triangulation
export interface MeshData {
  vertices: Float32Array;  // x, y, z interleaved
  indices: Uint32Array;    // triangle indices
  normals?: Float32Array;  // vertex normals
  vertexColors?: Float32Array;  // r, g, b interleaved (0-1 range)
  uvCoordinates?: Float32Array;  // u, v interleaved (for textures)
  vertexCount: number;
  triangleCount: number;
  surfaceArea?: number;
}

// Material definition for textured meshes
export interface PlantMaterialDef {
  name: string;
  color?: [number, number, number];  // RGB 0-1
  textureData?: string;  // base64 PNG data
  hasAlpha: boolean;
  triangleIndices: number[];  // Indices of triangles using this material
}

// Mesh entry with metadata
export interface MeshEntry {
  id: string;
  sourceCloudId: string;  // Which point cloud this mesh came from
  data: MeshData;
  visible: boolean;
  color: string;
  method: TriangulationMethod;
  // Plant-specific fields (for Helios plants)
  isPlant?: boolean;
  plantType?: string;
  plantAge?: number;
  plantPosition?: { x: number; y: number; z: number };  // Position for regeneration
  plantSeed?: number;  // Random seed for reproducible regeneration
  plantSessionId?: string;  // Session ID for stateful time-stepping (keeps plant consistent across ages)
  regenerationKey?: number;  // Counter that increments on each regeneration to force React remount
  heliosXml?: string;  // Plant structure XML for Helios simulation export
  plantMaterials?: PlantMaterialDef[];  // Materials with textures for plant rendering
}

// Skeleton data from extraction
export interface SkeletonData {
  points: Float32Array;  // x, y, z interleaved
  edges: number[][] | null;  // [[from_idx, to_idx], ...] - connections between points
  branchOrders: number[] | null;  // Branch order (Strahler number) for each point
  maxBranchOrder: number;  // Maximum branch order in the skeleton
  diameters: Float32Array | null;  // diameter at each point
  pointCount: number;
  totalLength: number;
}

// Skeleton entry with metadata
export interface SkeletonEntry {
  id: string;
  sourceCloudId: string;
  data: SkeletonData;
  visible: boolean;
  color: string;
}

// Color mapping modes
type ColorMode = 'x' | 'y' | 'height' | 'intensity' | 'rgb' | 'single' | 'scalar';

// Shape types for shape creator
type ShapeType = 'voxel' | 'cylinder' | 'sphere' | 'cone';

// Filter range for a single field
interface FilterRange {
  min: number;
  max: number;
  enabled: boolean;
}

// All filters for a point cloud
interface CloudFilters {
  x: FilterRange;
  y: FilterRange;
  z: FilterRange;
  intensity?: FilterRange;
  scalarFields: Record<string, FilterRange>;
}

interface PointCloudProps {
  data: PointCloudData;
  pointSize?: number;
  colorMode?: ColorMode;
  singleColor?: string;
  selectedScalarField?: string;  // Name of scalar field to color by when colorMode='scalar'
  filters?: CloudFilters;  // Active filters
}

// Viridis-like colormap for height visualization
const heightToColor = (t: number): [number, number, number] => {
  const r = Math.max(0, Math.min(1, 0.267004 + t * (0.329415 + t * (0.417642 + t * -0.601044))));
  const g = Math.max(0, Math.min(1, 0.004874 + t * (0.873465 + t * (-0.348827 + t * 0.470363))));
  const b = Math.max(0, Math.min(1, 0.329415 + t * (0.694719 + t * (-1.178884 + t * 0.154613))));
  return [r, g, b];
};

// Point cloud mesh component
function PointCloud({ data, pointSize = 2, colorMode = 'height', singleColor = '#a1a1aa', selectedScalarField, filters }: PointCloudProps) {
  const pointsRef = useRef<THREE.Points>(null);

  const geometry = useMemo(() => {
    // Handle empty point cloud or invalid data
    if (!data || data.pointCount === 0 || !data.positions || data.positions.length === 0) {
      return null;
    }

    // Validate positions array length matches pointCount
    if (data.positions.length < data.pointCount * 3) {
      console.warn('[PointCloud] Invalid positions array length:', data.positions.length, 'expected:', data.pointCount * 3);
      return null;
    }

    // Apply filters to determine which points to show
    let filteredIndices: number[] | null = null;
    if (filters) {
      const indices: number[] = [];
      for (let i = 0; i < data.pointCount; i++) {
        const x = data.positions[i * 3];
        const y = data.positions[i * 3 + 1];
        const z = data.positions[i * 3 + 2];

        // Check X filter
        if (filters.x.enabled && (x < filters.x.min || x > filters.x.max)) continue;
        // Check Y filter
        if (filters.y.enabled && (y < filters.y.min || y > filters.y.max)) continue;
        // Check Z filter
        if (filters.z.enabled && (z < filters.z.min || z > filters.z.max)) continue;
        // Check intensity filter
        if (filters.intensity?.enabled && data.intensities) {
          const intensity = data.intensities[i];
          if (intensity < filters.intensity.min || intensity > filters.intensity.max) continue;
        }
        // Check scalar field filters
        let passScalarFilters = true;
        for (const [fieldName, fieldFilter] of Object.entries(filters.scalarFields)) {
          if (fieldFilter.enabled && data.scalarFields?.[fieldName]) {
            const value = data.scalarFields[fieldName].values[i];
            if (value < fieldFilter.min || value > fieldFilter.max) {
              passScalarFilters = false;
              break;
            }
          }
        }
        if (!passScalarFilters) continue;

        indices.push(i);
      }
      filteredIndices = indices;
    }

    const pointCount = filteredIndices ? filteredIndices.length : data.pointCount;
    if (pointCount === 0) return null;

    // Build filtered positions and colors
    const positions = new Float32Array(pointCount * 3);
    const colors = new Float32Array(pointCount * 3);

    // Helper to get original index
    const getOriginalIndex = (i: number) => filteredIndices ? filteredIndices[i] : i;

    // Copy positions
    for (let i = 0; i < pointCount; i++) {
      const origIdx = getOriginalIndex(i);
      positions[i * 3] = data.positions[origIdx * 3];
      positions[i * 3 + 1] = data.positions[origIdx * 3 + 1];
      positions[i * 3 + 2] = data.positions[origIdx * 3 + 2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    if (colorMode === 'rgb' && data.colors && data.colors.length >= data.pointCount * 3) {
      for (let i = 0; i < pointCount; i++) {
        const origIdx = getOriginalIndex(i);
        colors[i * 3] = data.colors[origIdx * 3];
        colors[i * 3 + 1] = data.colors[origIdx * 3 + 1];
        colors[i * 3 + 2] = data.colors[origIdx * 3 + 2];
      }
    } else if (colorMode === 'intensity' && data.intensities && data.intensities.length >= data.pointCount) {
      for (let i = 0; i < pointCount; i++) {
        const origIdx = getOriginalIndex(i);
        const intensity = data.intensities[origIdx];
        colors[i * 3] = intensity;
        colors[i * 3 + 1] = intensity;
        colors[i * 3 + 2] = intensity;
      }
    } else if (colorMode === 'scalar' && selectedScalarField && data.scalarFields?.[selectedScalarField]) {
      // Color by scalar field using viridis colormap
      const field = data.scalarFields[selectedScalarField];
      const range = (field.max - field.min) || 1;
      for (let i = 0; i < pointCount; i++) {
        const origIdx = getOriginalIndex(i);
        const t = Math.max(0, Math.min(1, (field.values[origIdx] - field.min) / range));
        const [r, g, b] = heightToColor(t);
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
    } else if (colorMode === 'x') {
      const { min, max } = data.bounds;
      const minX = isFinite(min.x) ? min.x : 0;
      const maxX = isFinite(max.x) ? max.x : 1;
      const rangeX = (maxX - minX) || 1;
      for (let i = 0; i < pointCount; i++) {
        const x = positions[i * 3];
        const t = Math.max(0, Math.min(1, (x - minX) / rangeX));
        const [r, g, b] = heightToColor(t);
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
    } else if (colorMode === 'y') {
      const { min, max } = data.bounds;
      const minY = isFinite(min.y) ? min.y : 0;
      const maxY = isFinite(max.y) ? max.y : 1;
      const rangeY = (maxY - minY) || 1;
      for (let i = 0; i < pointCount; i++) {
        const y = positions[i * 3 + 1];
        const t = Math.max(0, Math.min(1, (y - minY) / rangeY));
        const [r, g, b] = heightToColor(t);
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
    } else if (colorMode === 'height') {
      const { min, max } = data.bounds;
      // Validate bounds are finite numbers
      const minZ = isFinite(min.z) ? min.z : 0;
      const maxZ = isFinite(max.z) ? max.z : 1;
      const heightRange = (maxZ - minZ) || 1;
      for (let i = 0; i < pointCount; i++) {
        const z = positions[i * 3 + 2];
        const t = Math.max(0, Math.min(1, (z - minZ) / heightRange)); // Clamp t to 0-1
        const [r, g, b] = heightToColor(t);
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
    } else {
      const color = new THREE.Color(singleColor);
      for (let i = 0; i < pointCount; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [data, colorMode, singleColor, selectedScalarField, filters]);

  const material = useMemo(() => {
    return new THREE.PointsMaterial({
      size: pointSize,
      vertexColors: true,
      sizeAttenuation: false,
    });
  }, [pointSize]);

  // Don't render if no geometry (empty point cloud)
  if (!geometry) {
    return null;
  }

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}

// Triangle mesh component for rendering triangulated surfaces
interface TriangleMeshProps {
  data: MeshData;
  color?: string;
  opacity?: number;
  wireframe?: boolean;
  useVertexColors?: boolean;  // Use per-vertex colors from data.vertexColors
}

function TriangleMesh({ data, color = '#4ade80', opacity = 0.7, wireframe = false, useVertexColors = false }: TriangleMeshProps) {
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

  return <mesh ref={meshRef} geometry={geometry} material={material} />;
}

// Textured plant mesh component - renders plant with multiple materials and textures
interface TexturedPlantMeshProps {
  data: MeshData;
  plantMaterials: PlantMaterialDef[];
  opacity?: number;
}

// Helper to load base64 image as Three.js texture
function useBase64Texture(base64Data: string | undefined): THREE.Texture | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (!base64Data) {
      console.log('[useBase64Texture] No base64 data provided');
      setTexture(null);
      return;
    }

    console.log(`[useBase64Texture] Loading texture, data length: ${base64Data.length}`);

    const img = new Image();
    img.onload = () => {
      console.log(`[useBase64Texture] Image loaded: ${img.width}x${img.height}`);
      const tex = new THREE.Texture(img);
      tex.needsUpdate = true;
      tex.colorSpace = THREE.SRGBColorSpace;
      setTexture(tex);
    };
    img.onerror = (e) => {
      console.error('[useBase64Texture] Failed to load texture from base64:', e);
      setTexture(null);
    };
    img.src = `data:image/png;base64,${base64Data}`;

    return () => {
      if (texture) {
        texture.dispose();
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

  return <mesh ref={meshRef} geometry={geometry} material={material} />;
}

function TexturedPlantMesh({ data, plantMaterials, opacity = 0.9 }: TexturedPlantMeshProps) {
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

// Skeleton visualization component - renders skeleton as connected tubes
interface Skeleton3DProps {
  data: SkeletonData;
  color?: string;
  opacity?: number;
  tubeRadius?: number;
  showDiameters?: boolean;
  colorByBranchOrder?: boolean;
}

// Branch order color palette (from high order/trunk to low order/tips)
const BRANCH_ORDER_COLORS = [
  new THREE.Color('#dc2626'),  // Order 1 (tips) - red
  new THREE.Color('#f97316'),  // Order 2 - orange
  new THREE.Color('#eab308'),  // Order 3 - yellow
  new THREE.Color('#22c55e'),  // Order 4 - green
  new THREE.Color('#06b6d4'),  // Order 5 - cyan
  new THREE.Color('#3b82f6'),  // Order 6 - blue
  new THREE.Color('#8b5cf6'),  // Order 7 - violet
  new THREE.Color('#ec4899'),  // Order 8+ (trunk) - pink
];

function Skeleton3D({ data, color = '#f59e0b', opacity = 1.0, tubeRadius = 0.02, showDiameters = false, colorByBranchOrder = false }: Skeleton3DProps) {
  const geometry = useMemo(() => {
    // Get all skeleton points
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < data.pointCount; i++) {
      points.push(new THREE.Vector3(
        data.points[i * 3],
        data.points[i * 3 + 1],
        data.points[i * 3 + 2]
      ));
    }

    if (points.length < 2) return null;

    // If we have edges, render each edge as a cylinder
    if (data.edges && data.edges.length > 0) {
      const mergedGeometry = new THREE.BufferGeometry();
      const positions: number[] = [];
      const normals: number[] = [];
      const colors: number[] = [];
      const indices: number[] = [];
      let indexOffset = 0;

      // Create cylinder geometry for each edge
      const radialSegments = 6;  // Segments around the cylinder

      // Helper to get color for a branch order
      const getOrderColor = (order: number): THREE.Color => {
        const idx = Math.min(order - 1, BRANCH_ORDER_COLORS.length - 1);
        return BRANCH_ORDER_COLORS[Math.max(0, idx)];
      };

      for (const edge of data.edges) {
        const [fromIdx, toIdx] = edge;
        if (fromIdx >= points.length || toIdx >= points.length) continue;

        const start = points[fromIdx];
        const end = points[toIdx];
        const direction = new THREE.Vector3().subVectors(end, start);
        const length = direction.length();

        if (length < 0.0001) continue;  // Skip zero-length edges

        // Normalize direction
        direction.normalize();

        // Find perpendicular vectors for the circle
        const up = Math.abs(direction.y) < 0.99
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(1, 0, 0);
        const perp1 = new THREE.Vector3().crossVectors(direction, up).normalize();
        const perp2 = new THREE.Vector3().crossVectors(direction, perp1).normalize();

        // Create vertices for start and end circles
        const radius = showDiameters && data.diameters
          ? (data.diameters[fromIdx] + data.diameters[toIdx]) / 4
          : tubeRadius;

        // Get branch order colors for this edge
        const fromOrder = data.branchOrders ? data.branchOrders[fromIdx] || 1 : 1;
        const toOrder = data.branchOrders ? data.branchOrders[toIdx] || 1 : 1;
        const fromColor = getOrderColor(fromOrder);
        const toColor = getOrderColor(toOrder);

        // Generate circle vertices at start and end
        for (let ring = 0; ring <= 1; ring++) {
          const center = ring === 0 ? start : end;
          const edgeColor = ring === 0 ? fromColor : toColor;
          for (let j = 0; j < radialSegments; j++) {
            const angle = (j / radialSegments) * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            // Position on circle
            const px = center.x + radius * (cos * perp1.x + sin * perp2.x);
            const py = center.y + radius * (cos * perp1.y + sin * perp2.y);
            const pz = center.z + radius * (cos * perp1.z + sin * perp2.z);
            positions.push(px, py, pz);

            // Normal pointing outward from center
            const nx = cos * perp1.x + sin * perp2.x;
            const ny = cos * perp1.y + sin * perp2.y;
            const nz = cos * perp1.z + sin * perp2.z;
            normals.push(nx, ny, nz);

            // Vertex color based on branch order
            colors.push(edgeColor.r, edgeColor.g, edgeColor.b);
          }
        }

        // Create indices for cylinder faces
        for (let j = 0; j < radialSegments; j++) {
          const j1 = (j + 1) % radialSegments;
          // Two triangles per quad
          const a = indexOffset + j;
          const b = indexOffset + j1;
          const c = indexOffset + radialSegments + j;
          const d = indexOffset + radialSegments + j1;
          indices.push(a, c, b);
          indices.push(b, c, d);
        }

        indexOffset += radialSegments * 2;
      }

      if (positions.length === 0) return null;

      mergedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      mergedGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      mergedGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      mergedGeometry.setIndex(indices);

      return mergedGeometry;
    }

    // Fallback: if no edges, create a simple curve (legacy behavior)
    const curve = new THREE.CatmullRomCurve3(points);
    const radius = showDiameters && data.diameters
      ? data.diameters[Math.floor(data.pointCount / 2)] / 2
      : tubeRadius;
    return new THREE.TubeGeometry(curve, Math.max(8, data.pointCount * 4), radius, 8, false);
  }, [data, tubeRadius, showDiameters, colorByBranchOrder]);

  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: colorByBranchOrder ? 0xffffff : new THREE.Color(color),
      vertexColors: colorByBranchOrder,
      transparent: opacity < 1,
      opacity,
      roughness: 0.6,
      metalness: 0.2,
    });
  }, [color, opacity, colorByBranchOrder]);

  if (!geometry) return null;

  return <mesh geometry={geometry} material={material} />;
}

// Skeleton visualization as node points only
interface SkeletonPointsProps {
  data: SkeletonData;
  color?: string;
  pointSize?: number;
  colorByBranchOrder?: boolean;
}

function SkeletonPoints({ data, color = '#f59e0b', pointSize = 8, colorByBranchOrder = false }: SkeletonPointsProps) {
  const geometry = useMemo(() => {
    // Early return if no points
    if (!data.points || data.pointCount === 0) {
      return null;
    }

    const geo = new THREE.BufferGeometry();
    // Clone the points array to avoid issues with shared references
    const positions = new Float32Array(data.points);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const colors = new Float32Array(data.pointCount * 3);

    if (colorByBranchOrder && data.branchOrders) {
      for (let i = 0; i < data.pointCount; i++) {
        const order = data.branchOrders[i] || 1;
        const idx = Math.min(order - 1, BRANCH_ORDER_COLORS.length - 1);
        const orderColor = BRANCH_ORDER_COLORS[Math.max(0, idx)];
        colors[i * 3] = orderColor.r;
        colors[i * 3 + 1] = orderColor.g;
        colors[i * 3 + 2] = orderColor.b;
      }
    } else {
      const baseColor = new THREE.Color(color);
      for (let i = 0; i < data.pointCount; i++) {
        colors[i * 3] = baseColor.r;
        colors[i * 3 + 1] = baseColor.g;
        colors[i * 3 + 2] = baseColor.b;
      }
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
    return geo;
  }, [data, color, colorByBranchOrder]);

  const material = useMemo(() => {
    return new THREE.PointsMaterial({
      size: pointSize,
      vertexColors: true,
      sizeAttenuation: false,
    });
  }, [pointSize]);

  // Return null if geometry couldn't be created
  if (!geometry) return null;

  return <points geometry={geometry} material={material} />;
}

// View direction type
type ViewDirection = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

// Camera controller
function CameraController({ bounds, enabled = true }: { bounds: PointCloudData['bounds']; enabled?: boolean }) {
  const { camera } = useThree();
  const controlsRef = useRef<any>(null);
  const initializedRef = useRef(false);
  const boundsRef = useRef(bounds);

  // Keep bounds ref updated for snap functions (but don't trigger camera changes)
  boundsRef.current = bounds;

  const snapToView = useCallback((direction: ViewDirection, target?: { center: THREE.Vector3, size: THREE.Vector3 }) => {
    if (!controlsRef.current) return;

    // Use provided target or fall back to global bounds
    const { center, size } = target || boundsRef.current;
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const distance = maxDim * 2;

    let newPos: THREE.Vector3;

    switch (direction) {
      case 'top':
        newPos = new THREE.Vector3(center.x, center.y, center.z + distance);
        camera.up.set(0, 1, 0);
        break;
      case 'bottom':
        newPos = new THREE.Vector3(center.x, center.y, center.z - distance);
        camera.up.set(0, 1, 0);
        break;
      case 'front':
        newPos = new THREE.Vector3(center.x, center.y - distance, center.z);
        camera.up.set(0, 0, 1);
        break;
      case 'back':
        newPos = new THREE.Vector3(center.x, center.y + distance, center.z);
        camera.up.set(0, 0, 1);
        break;
      case 'left':
        newPos = new THREE.Vector3(center.x - distance, center.y, center.z);
        camera.up.set(0, 0, 1);
        break;
      case 'right':
        newPos = new THREE.Vector3(center.x + distance, center.y, center.z);
        camera.up.set(0, 0, 1);
        break;
      case 'iso':
      default:
        newPos = new THREE.Vector3(
          center.x + distance * 0.6,
          center.y - distance * 0.6,
          center.z + distance * 0.5
        );
        camera.up.set(0, 0, 1);
        break;
    }

    camera.position.copy(newPos);
    controlsRef.current.target.copy(center);
    controlsRef.current.update();
  }, [camera]);

  const resetCamera = useCallback(() => {
    snapToView('iso');
  }, [snapToView]);

  // Initialize camera once on mount - fixed position, not dependent on bounds
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!initializedRef.current && controlsRef.current) {
        // Set a fixed reasonable camera position (iso view of origin, distance ~20)
        camera.up.set(0, 0, 1);
        camera.position.set(12, -12, 10);
        controlsRef.current.target.set(0, 0, 0);
        controlsRef.current.update();
        initializedRef.current = true;
      }
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - truly only run once on mount

  useEffect(() => {
    (window as any).__resetPointCloudCamera = resetCamera;
    (window as any).__snapToView = snapToView;
    return () => {
      delete (window as any).__resetPointCloudCamera;
      delete (window as any).__snapToView;
    };
  }, [resetCamera, snapToView]);

  return (
    <OrbitControls
      ref={controlsRef}
      enabled={enabled}
      enableDamping
      dampingFactor={0.05}
      screenSpacePanning={true}
      minDistance={0.1}
      maxDistance={10000}
      mouseButtons={{
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
      }}
    />
  );
}

// Axes helper
function AxesDisplay({ size }: { size: number }) {
  return <axesHelper args={[size]} />;
}

// Scene background component
function SceneBackground({ color, style }: { color: 'black' | 'white'; style: 'solid' | 'gradient' }) {
  const { scene, gl } = useThree();

  useEffect(() => {
    if (style === 'solid') {
      // Solid background
      scene.background = null;
      gl.setClearColor(color === 'black' ? '#171717' : '#f5f5f5');
    } else {
      // Gradient background using a canvas texture
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const gradient = ctx.createLinearGradient(0, 0, 0, 512);
        if (color === 'black') {
          // Dark gradient: from dark gray at top to black at bottom
          gradient.addColorStop(0, '#2a2a2a');
          gradient.addColorStop(1, '#0a0a0a');
        } else {
          // Light gradient: from white at top to darker gray at bottom
          gradient.addColorStop(0, '#ffffff');
          gradient.addColorStop(1, '#737373');
        }
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 2, 512);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        scene.background = texture;
      }
    }

    return () => {
      if (scene.background instanceof THREE.Texture) {
        scene.background.dispose();
      }
      scene.background = null;
    };
  }, [color, style, scene, gl]);

  return null;
}

// Camera capture component - exposes camera state to parent ref
interface CameraCaptureProps {
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
}

function CameraCapture({ cameraRef }: CameraCaptureProps) {
  const { camera } = useThree();

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera, cameraRef]);

  return null;
}

// Translation gizmo arrow
interface TranslationArrowProps {
  axis: 'x' | 'y' | 'z';
  position: THREE.Vector3;
  size: number;
  onDragStart: (axis: 'x' | 'y' | 'z') => void;
  onHover: (hovered: boolean) => void;
}

function TranslationArrow({ axis, position, size, onDragStart, onHover }: TranslationArrowProps) {
  const [hovered, setHovered] = useState(false);
  const { gl } = useThree();

  const color = axis === 'x' ? '#ef4444' : axis === 'y' ? '#22c55e' : '#3b82f6';
  const hoverColor = axis === 'x' ? '#f87171' : axis === 'y' ? '#4ade80' : '#60a5fa';

  const direction = useMemo(() => {
    switch (axis) {
      case 'x': return new THREE.Vector3(1, 0, 0);
      case 'y': return new THREE.Vector3(0, 1, 0);
      case 'z': return new THREE.Vector3(0, 0, 1);
    }
  }, [axis]);

  const shaftLength = size * 0.8;
  const coneLength = size * 0.25;
  const shaftRadius = size * 0.03;
  const coneRadius = size * 0.08;

  const shaftPosition = useMemo(() => direction.clone().multiplyScalar(shaftLength / 2), [direction, shaftLength]);
  const conePosition = useMemo(() => direction.clone().multiplyScalar(shaftLength + coneLength / 2), [direction, shaftLength, coneLength]);

  const rotation = useMemo(() => {
    if (axis === 'x') return new THREE.Euler(0, 0, -Math.PI / 2);
    if (axis === 'y') return new THREE.Euler(0, 0, 0);
    return new THREE.Euler(Math.PI / 2, 0, 0);
  }, [axis]);

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onDragStart(axis);
  };

  const handlePointerOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(true);
    onHover(true);
    gl.domElement.style.cursor = 'grab';
  };

  const handlePointerOut = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(false);
    onHover(false);
    gl.domElement.style.cursor = 'auto';
  };

  const currentColor = hovered ? hoverColor : color;

  return (
    <group position={position}>
      <mesh position={shaftPosition} rotation={rotation} onPointerOver={handlePointerOver} onPointerOut={handlePointerOut} onPointerDown={handlePointerDown}>
        <cylinderGeometry args={[shaftRadius, shaftRadius, shaftLength, 12]} />
        <meshBasicMaterial color={currentColor} />
      </mesh>
      <mesh position={conePosition} rotation={rotation} onPointerOver={handlePointerOver} onPointerOut={handlePointerOut} onPointerDown={handlePointerDown}>
        <coneGeometry args={[coneRadius, coneLength, 16]} />
        <meshBasicMaterial color={currentColor} />
      </mesh>
    </group>
  );
}

// Drag handler for screen-space dragging
interface DragHandlerProps {
  activeAxis: 'x' | 'y' | 'z' | null;
  gizmoCenter: THREE.Vector3;
  onDrag: (delta: { x: number; y: number; z: number }) => void;
  onDragEnd: () => void;
}

function DragHandler({ activeAxis, gizmoCenter, onDrag, onDragEnd }: DragHandlerProps) {
  const { camera, gl, size } = useThree();
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!activeAxis) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!lastMouseRef.current) {
        lastMouseRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      const deltaX = e.clientX - lastMouseRef.current.x;
      const deltaY = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };

      const axisDir = new THREE.Vector3(
        activeAxis === 'x' ? 1 : 0,
        activeAxis === 'y' ? 1 : 0,
        activeAxis === 'z' ? 1 : 0
      );

      const worldStart = gizmoCenter.clone();
      const worldEnd = gizmoCenter.clone().add(axisDir);
      const screenStart = worldStart.clone().project(camera);
      const screenEnd = worldEnd.clone().project(camera);

      const pixelStart = new THREE.Vector2((screenStart.x + 1) * size.width / 2, (-screenStart.y + 1) * size.height / 2);
      const pixelEnd = new THREE.Vector2((screenEnd.x + 1) * size.width / 2, (-screenEnd.y + 1) * size.height / 2);

      const screenAxis = pixelEnd.clone().sub(pixelStart);
      const screenAxisLength = screenAxis.length();
      if (screenAxisLength < 0.001) return;
      screenAxis.normalize();

      const mouseDelta = new THREE.Vector2(deltaX, deltaY);
      const projectedDelta = mouseDelta.dot(screenAxis);
      const worldDelta = projectedDelta / screenAxisLength;

      const translationDelta = { x: 0, y: 0, z: 0 };
      translationDelta[activeAxis] = worldDelta;
      onDrag(translationDelta);
    };

    const handleMouseUp = () => {
      lastMouseRef.current = null;
      onDragEnd();
    };

    gl.domElement.style.cursor = 'grabbing';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      gl.domElement.style.cursor = 'auto';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [activeAxis, camera, gl, gizmoCenter, onDrag, onDragEnd, size]);

  return null;
}

// Translation gizmo
interface TranslationGizmoProps {
  center: THREE.Vector3;
  size: number;
  onTranslate: (delta: { x: number; y: number; z: number }) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

function TranslationGizmo({ center, size, onTranslate, onDragStart, onDragEnd }: TranslationGizmoProps) {
  const [activeAxis, setActiveAxis] = useState<'x' | 'y' | 'z' | null>(null);

  const handleAxisDragStart = useCallback((axis: 'x' | 'y' | 'z') => {
    setActiveAxis(axis);
    onDragStart();
  }, [onDragStart]);

  const handleDragEnd = useCallback(() => {
    setActiveAxis(null);
    onDragEnd();
  }, [onDragEnd]);

  return (
    <group>
      <TranslationArrow axis="x" position={center} size={size} onDragStart={handleAxisDragStart} onHover={() => {}} />
      <TranslationArrow axis="y" position={center} size={size} onDragStart={handleAxisDragStart} onHover={() => {}} />
      <TranslationArrow axis="z" position={center} size={size} onDragStart={handleAxisDragStart} onHover={() => {}} />
      <mesh position={center}>
        <sphereGeometry args={[size * 0.05, 16, 16]} />
        <meshBasicMaterial color="#a3a3a3" />
      </mesh>
      <DragHandler activeAxis={activeAxis} gizmoCenter={center} onDrag={onTranslate} onDragEnd={handleDragEnd} />
    </group>
  );
}

// Crop box with draggable handles
interface CropBoxProps {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  onMinChange: (min: { x: number; y: number; z: number }) => void;
  onMaxChange: (max: { x: number; y: number; z: number }) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  keepInside: boolean;
}

function CropBox({ min, max, onMinChange, onMaxChange, onDragStart, onDragEnd, keepInside }: CropBoxProps) {
  const { camera, gl, size } = useThree();
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);

  const center = useMemo(() => new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2), [min, max]);
  const dimensions = useMemo(() => new THREE.Vector3(max.x - min.x, max.y - min.y, max.z - min.z), [min, max]);

  const handles = useMemo(() => [
    { id: 'x-min', position: new THREE.Vector3(min.x, center.y, center.z), axis: 'x', isMin: true, color: '#ef4444' },
    { id: 'x-max', position: new THREE.Vector3(max.x, center.y, center.z), axis: 'x', isMin: false, color: '#ef4444' },
    { id: 'y-min', position: new THREE.Vector3(center.x, min.y, center.z), axis: 'y', isMin: true, color: '#22c55e' },
    { id: 'y-max', position: new THREE.Vector3(center.x, max.y, center.z), axis: 'y', isMin: false, color: '#22c55e' },
    { id: 'z-min', position: new THREE.Vector3(center.x, center.y, min.z), axis: 'z', isMin: true, color: '#3b82f6' },
    { id: 'z-max', position: new THREE.Vector3(center.x, center.y, max.z), axis: 'z', isMin: false, color: '#3b82f6' },
  ], [min, max, center]);

  const handleSize = Math.min(dimensions.x, dimensions.y, dimensions.z) * 0.08;

  useEffect(() => {
    if (!activeHandle) return;

    const handle = handles.find(h => h.id === activeHandle);
    if (!handle) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!lastMouseRef.current) {
        lastMouseRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      const deltaX = e.clientX - lastMouseRef.current.x;
      const deltaY = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };

      const axisDir = new THREE.Vector3(handle.axis === 'x' ? 1 : 0, handle.axis === 'y' ? 1 : 0, handle.axis === 'z' ? 1 : 0);
      const worldStart = handle.position.clone();
      const worldEnd = handle.position.clone().add(axisDir);
      const screenStart = worldStart.clone().project(camera);
      const screenEnd = worldEnd.clone().project(camera);

      const pixelStart = new THREE.Vector2((screenStart.x + 1) * size.width / 2, (-screenStart.y + 1) * size.height / 2);
      const pixelEnd = new THREE.Vector2((screenEnd.x + 1) * size.width / 2, (-screenEnd.y + 1) * size.height / 2);

      const screenAxis = pixelEnd.clone().sub(pixelStart);
      const screenAxisLength = screenAxis.length();
      if (screenAxisLength < 0.001) return;
      screenAxis.normalize();

      const mouseDelta = new THREE.Vector2(deltaX, deltaY);
      const projectedDelta = mouseDelta.dot(screenAxis);
      const worldDelta = projectedDelta / screenAxisLength;

      if (handle.isMin) {
        const newMin = { ...min };
        newMin[handle.axis as 'x' | 'y' | 'z'] = Math.min(min[handle.axis as 'x' | 'y' | 'z'] + worldDelta, max[handle.axis as 'x' | 'y' | 'z'] - 0.1);
        onMinChange(newMin);
      } else {
        const newMax = { ...max };
        newMax[handle.axis as 'x' | 'y' | 'z'] = Math.max(max[handle.axis as 'x' | 'y' | 'z'] + worldDelta, min[handle.axis as 'x' | 'y' | 'z'] + 0.1);
        onMaxChange(newMax);
      }
    };

    const handleMouseUp = () => {
      lastMouseRef.current = null;
      setActiveHandle(null);
      onDragEnd();
    };

    gl.domElement.style.cursor = 'grabbing';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      gl.domElement.style.cursor = 'auto';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [activeHandle, handles, min, max, camera, gl, size, onMinChange, onMaxChange, onDragEnd]);

  const boxColor = keepInside ? '#22c55e' : '#ef4444';

  return (
    <group>
      <lineSegments position={center}>
        <edgesGeometry args={[new THREE.BoxGeometry(dimensions.x, dimensions.y, dimensions.z)]} />
        <lineBasicMaterial color={boxColor} linewidth={2} transparent opacity={0.8} />
      </lineSegments>
      <mesh position={center}>
        <boxGeometry args={[dimensions.x, dimensions.y, dimensions.z]} />
        <meshBasicMaterial color={boxColor} transparent opacity={0.05} side={THREE.DoubleSide} />
      </mesh>
      {handles.map(handle => (
        <mesh
          key={handle.id}
          position={handle.position}
          onPointerDown={(e) => { e.stopPropagation(); setActiveHandle(handle.id); onDragStart(); }}
          onPointerOver={(e) => { e.stopPropagation(); gl.domElement.style.cursor = 'grab'; }}
          onPointerOut={(e) => { e.stopPropagation(); if (!activeHandle) gl.domElement.style.cursor = 'auto'; }}
        >
          <sphereGeometry args={[handleSize, 16, 16]} />
          <meshBasicMaterial color={activeHandle === handle.id ? '#ffffff' : handle.color} transparent opacity={0.9} />
        </mesh>
      ))}
    </group>
  );
}

// Erase brush component for erasing points
interface EraseBrushProps {
  brushSize: number;
  brushPosition: THREE.Vector3 | null;
  isErasing: boolean;
  cloudData: PointCloudData;
  cloudTranslation: { x: number; y: number; z: number };
  alreadyErasedIndices: Set<number>;
  onErase: (indicesToErase: Set<number>) => void;
  onBrushPositionChange: (position: THREE.Vector3 | null) => void;
  onEraseStart: () => void;
  onEraseEnd: () => void;
  setIsErasing: (value: boolean) => void;
}

function EraseBrush({ brushSize, brushPosition, isErasing, cloudData, cloudTranslation, alreadyErasedIndices, onErase, onBrushPositionChange, onEraseStart, onEraseEnd, setIsErasing }: EraseBrushProps) {
  const { camera, gl, size, raycaster } = useThree();
  const planeRef = useRef(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));
  const intersectionPoint = useRef(new THREE.Vector3());

  // Update brush position based on mouse movement
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Convert mouse to normalized device coordinates
      const rect = gl.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );

      // Cast ray from camera
      raycaster.setFromCamera(mouse, camera);

      // Find the closest point in the cloud to the ray
      let closestDistance = Infinity;
      let closestPoint: THREE.Vector3 | null = null;

      for (let i = 0; i < cloudData.pointCount; i++) {
        // Skip already-erased points
        if (alreadyErasedIndices.has(i)) continue;

        const point = new THREE.Vector3(
          cloudData.positions[i * 3] + cloudTranslation.x,
          cloudData.positions[i * 3 + 1] + cloudTranslation.y,
          cloudData.positions[i * 3 + 2] + cloudTranslation.z
        );

        // Find distance from point to ray
        const closestOnRay = raycaster.ray.closestPointToPoint(point, new THREE.Vector3());
        const distance = point.distanceTo(closestOnRay);

        // Check if this point is within a screen-space threshold
        if (distance < brushSize * 2 && distance < closestDistance) {
          closestDistance = distance;
          closestPoint = point;
        }
      }

      if (closestPoint) {
        onBrushPositionChange(closestPoint);

        // If erasing, find all points within brush radius
        if (isErasing) {
          const indicesToErase = new Set<number>();
          for (let i = 0; i < cloudData.pointCount; i++) {
            // Skip already-erased points
            if (alreadyErasedIndices.has(i)) continue;

            const point = new THREE.Vector3(
              cloudData.positions[i * 3] + cloudTranslation.x,
              cloudData.positions[i * 3 + 1] + cloudTranslation.y,
              cloudData.positions[i * 3 + 2] + cloudTranslation.z
            );
            if (point.distanceTo(closestPoint!) < brushSize) {
              indicesToErase.add(i);
            }
          }
          if (indicesToErase.size > 0) {
            onErase(indicesToErase);
          }
        }
      } else {
        onBrushPositionChange(null);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'e' || e.key === 'E') {
        if (!isErasing) {
          onEraseStart();
          setIsErasing(true);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'e' || e.key === 'E') {
        if (isErasing) {
          setIsErasing(false);
          onEraseEnd();
        }
      }
    };

    gl.domElement.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      gl.domElement.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [camera, gl, size, raycaster, cloudData, cloudTranslation, brushSize, isErasing, alreadyErasedIndices, onErase, onBrushPositionChange, onEraseStart, onEraseEnd, setIsErasing]);

  if (!brushPosition) return null;

  return (
    <mesh position={brushPosition}>
      <sphereGeometry args={[brushSize, 32, 32]} />
      <meshBasicMaterial
        color={isErasing ? '#ef4444' : '#f97316'}
        transparent
        opacity={isErasing ? 0.4 : 0.25}
        depthWrite={false}
      />
    </mesh>
  );
}

// Grid plane options
type GridPlane = 'z-up' | 'y-up';
type EditMode = 'none' | 'translate' | 'crop' | 'rotate' | 'erase';

// Compute bounding box center and size from interleaved [x,y,z,...] positions
function computeBoundsFromPositions(positions: Float32Array, count: number) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    min.x = Math.min(min.x, x);
    min.y = Math.min(min.y, y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  }
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const size = new THREE.Vector3().subVectors(max, min);
  return { center, size };
}

// Import function refs for mesh/skeleton
export interface ImportRefs {
  importMesh: (mesh: Omit<MeshEntry, 'id'>) => void;
  importSkeleton: (skeleton: Omit<SkeletonEntry, 'id'>) => void;
}

interface PointCloudViewerProps {
  clouds: PointCloudEntry[];
  selectedIds: Set<string>;
  onToggleVisibility: (id: string) => void;
  onToggleSelection: (id: string, multiSelect: boolean) => void;
  onRemoveCloud: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onUpdateCloud: (id: string, data: PointCloudData) => void;
  onSave: (data: PointCloudData, fileName: string) => void;
  onAddCloud?: (cloud: PointCloudEntry) => void;
  onStitchClouds?: (ids: string[]) => void;
  onUndoStitch?: () => boolean;
  canUndoStitch?: () => boolean;
  className?: string;
  importRefsCallback?: (refs: ImportRefs) => void;
}

export default function PointCloudViewer({
  clouds,
  selectedIds,
  onToggleVisibility,
  onToggleSelection,
  onRemoveCloud,
  onSelectAll,
  onDeselectAll,
  onUpdateCloud,
  onSave,
  onAddCloud,
  onStitchClouds,
  onUndoStitch,
  canUndoStitch,
  className = '',
  importRefsCallback
}: PointCloudViewerProps) {
  const [pointSize, setPointSize] = useState(1);
  const [colorMode, setColorMode] = useState<ColorMode>('height');
  const [selectedScalarField, setSelectedScalarField] = useState<string | undefined>(undefined);
  const [colorDropdownCloudId, setColorDropdownCloudId] = useState<string | null>(null);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showResamplePanel, setShowResamplePanel] = useState(false);
  const [resampleFraction, setResampleFraction] = useState(0.5);
  const [resamplePreview, setResamplePreview] = useState<{
    cloudId: string;
    previewData: PointCloudData;
    originalPointCount: number;
  } | null>(null);
  const [cloudFilters, setCloudFilters] = useState<Map<string, CloudFilters>>(new Map());
  const [selectedFilterField, setSelectedFilterField] = useState<string | null>(null);
  const [pendingFilterMin, setPendingFilterMin] = useState<string>('');
  const [pendingFilterMax, setPendingFilterMax] = useState<string>('');
  const [showGrid, setShowGrid] = useState(true);
  const [gridPlane, setGridPlane] = useState<GridPlane>('z-up');
  const [showAxes, setShowAxes] = useState(true);
  const [displayPanelCollapsed, setDisplayPanelCollapsed] = useState(true);
  const [gizmoDragging, setGizmoDragging] = useState(false);
  const [bgColor, setBgColor] = useState<'black' | 'white'>('black');
  const [bgStyle, setBgStyle] = useState<'solid' | 'gradient'>('solid');

  // Mesh state
  const [meshes, setMeshes] = useState<MeshEntry[]>([]);
  const [meshOpacity, setMeshOpacity] = useState(0.7);
  const [meshWireframe, setMeshWireframe] = useState(false);

  // Triangulation state
  const [showTriangulationPanel, setShowTriangulationPanel] = useState(false);
  const [triangulationMethod, setTriangulationMethod] = useState<TriangulationMethod>('ball_pivoting');
  const [triangulationInProgress, setTriangulationInProgress] = useState(false);
  const [triangulationError, setTriangulationError] = useState<string | null>(null);

  // Triangulation parameters
  const [poissonDepth, setPoissonDepth] = useState(8);
  const [alphaValue, setAlphaValue] = useState<number | null>(null);  // null = auto

  // Skeleton state
  const [skeletons, setSkeletons] = useState<SkeletonEntry[]>([]);
  const [skeletonTubeRadius, setSkeletonTubeRadius] = useState(0.02);
  const [skeletonColorByBranchOrder, setSkeletonColorByBranchOrder] = useState(false);
  const [skeletonShowAsCylinders, setSkeletonShowAsCylinders] = useState(true);

  // Selection state for meshes and skeletons (internal)
  const [selectedMeshIds, setSelectedMeshIds] = useState<Set<string>>(new Set());
  // Derived single mesh ID for backward compatibility (first selected mesh)
  const selectedMeshId = selectedMeshIds.size > 0 ? Array.from(selectedMeshIds)[0] : null;
  const [selectedSkeletonId, setSelectedSkeletonId] = useState<string | null>(null);

  // Copy confirmation flash state
  const [coordsCopied, setCoordsCopied] = useState(false);

  // Delete confirmation dialog state
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: 'mesh' | 'skeleton' | 'cloud';
    id: string;
    name: string;
  } | null>(null);

  // Command palette state
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandSearch, setCommandSearch] = useState('');
  const [commandSelectedIndex, setCommandSelectedIndex] = useState(0);

  // Skeleton extraction state
  const [showSkeletonPanel, setShowSkeletonPanel] = useState(false);
  const [skeletonInProgress, setSkeletonInProgress] = useState(false);
  const [skeletonError, setSkeletonError] = useState<string | null>(null);
  // BFS Algorithm Options
  const [skeletonRemoveOutliers, setSkeletonRemoveOutliers] = useState(true);
  const [skeletonSearchRadius, setSkeletonSearchRadius] = useState(0); // 0 = auto-calculate
  const [skeletonRootThreshold, setSkeletonRootThreshold] = useState(0.02);
  const [skeletonThresholdFilter, setSkeletonThresholdFilter] = useState(5); // Lower for better branch detection
  const [skeletonSmooth, setSkeletonSmooth] = useState(true);
  const [skeletonSmoothIterations, setSkeletonSmoothIterations] = useState(2);
  // Advanced BFS options
  const [skeletonShowAdvanced, setSkeletonShowAdvanced] = useState(false);
  const [skeletonQuantizationLevels, setSkeletonQuantizationLevels] = useState(100); // More levels for better detail
  const [skeletonUseNonlinearQuant, setSkeletonUseNonlinearQuant] = useState(true);
  const [skeletonUseProportionFilter, setSkeletonUseProportionFilter] = useState(true);
  const [skeletonProportionThreshold, setSkeletonProportionThreshold] = useState(0.1);

  // Import functions for external use
  const importMesh = useCallback((mesh: Omit<MeshEntry, 'id'>) => {
    const newMesh: MeshEntry = {
      ...mesh,
      id: crypto.randomUUID(),
    };
    setMeshes(prev => [...prev, newMesh]);
  }, []);

  const importSkeleton = useCallback((skeleton: Omit<SkeletonEntry, 'id'>) => {
    const newSkeleton: SkeletonEntry = {
      ...skeleton,
      id: crypto.randomUUID(),
    };
    setSkeletons(prev => [...prev, newSkeleton]);
  }, []);

  // Expose import functions to parent
  useEffect(() => {
    if (importRefsCallback) {
      importRefsCallback({ importMesh, importSkeleton });
    }
  }, [importRefsCallback, importMesh, importSkeleton]);

  // Export panel state
  const [showExportPanel, setShowExportPanel] = useState(false);

  // Alignment comparison state
  const [showAlignmentPanel, setShowAlignmentPanel] = useState(false);
  const [alignmentResults, setAlignmentResults] = useState<AlignmentDistanceResponse | null>(null);
  const [isComputingAlignment, setIsComputingAlignment] = useState(false);
  // Live alignment mode - automatically computes alignment when mesh is moved
  const [liveAlignmentEnabled, setLiveAlignmentEnabled] = useState(true); // Auto-enabled by default in mixed mode
  const alignmentDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMeshPositionRef = useRef<string>(''); // Track mesh position for debounced updates
  // ICP (Iterative Closest Point) snap-to-fit state
  const [isRunningICP, setIsRunningICP] = useState(false);

  // Shift key tracking for mixed selection (cloud + mesh together)
  const isShiftHeldRef = useRef(false);

  // Shape creator state
  const [shapeCounter, setShapeCounter] = useState(1);
  // Plant generation state
  const [isGeneratingPlant, setIsGeneratingPlant] = useState(false);
  const [showPlantPopup, setShowPlantPopup] = useState(false);
  // Helios triangulation popup + background task state
  const [showHeliosPopup, setShowHeliosPopup] = useState(false);
  const [isHeliosRunning, setIsHeliosRunning] = useState(false);
  const heliosAbortRef = useRef<AbortController | null>(null);
  // Mesh sampling state
  const [isSamplingMesh, setIsSamplingMesh] = useState(false);
  const [showSamplingPopup, setShowSamplingPopup] = useState(false);
  const [samplingDensity, setSamplingDensity] = useState(10000); // Points per m²
  // Plant age stepping state (stateless regeneration approach)
  const [isAdvancingAge, setIsAdvancingAge] = useState(false);
  const [ageStep, setAgeStep] = useState(5); // Custom step for age increment/decrement
  const [targetAge, setTargetAge] = useState<string>(''); // Direct age input
  // Growth animation state
  const [animationStartAge, setAnimationStartAge] = useState<string>('0');
  const [animationEndAge, setAnimationEndAge] = useState<string>('30');
  const [isAnimating, setIsAnimating] = useState(false);
  const [animationProgress, setAnimationProgress] = useState<number | null>(null); // Current age during animation
  const animationAbortRef = useRef(false);
  // GIF generation state
  const [gifBackground, setGifBackground] = useState<'transparent' | 'black' | 'white'>('black');
  const [gifCameraView, setGifCameraView] = useState<'current' | 'front' | 'side' | 'top' | 'iso'>('current');
  const [isGeneratingGif, setIsGeneratingGif] = useState(false);
  const [gifProgress, setGifProgress] = useState<{ current: number; total: number; phase: 'frames' | 'encoding' } | null>(null);
  const gifAbortRef = useRef(false);
  const mainCameraRef = useRef<THREE.Camera | null>(null);
  // Mesh scales - stored per mesh id, default is {x: 1, y: 1, z: 1}
  const [meshScales, setMeshScales] = useState<Map<string, { x: number; y: number; z: number }>>(new Map());
  // Mesh positions - stored per mesh id, default is {x: 0, y: 0, z: 0}
  const [meshPositions, setMeshPositions] = useState<Map<string, { x: number; y: number; z: number }>>(new Map());
  // Mesh rotations - stored per mesh id in degrees, default is {x: 0, y: 0, z: 0}
  const [meshRotations, setMeshRotations] = useState<Map<string, { x: number; y: number; z: number }>>(new Map());
  // Skeleton positions - stored per skeleton id, default is {x: 0, y: 0, z: 0}
  const [skeletonPositions, setSkeletonPositions] = useState<Map<string, { x: number; y: number; z: number }>>(new Map());
  // Show resize panel when a mesh is selected
  const [showResizePanel, setShowResizePanel] = useState(false);
  const [showPlantGrowthPanel, setShowPlantGrowthPanel] = useState(false);
  const [showMorphPopup, setShowMorphPopup] = useState(false);
  const [isMorphing, setIsMorphing] = useState(false);

  // Edit mode and per-cloud edit states
  const [editMode, setEditMode] = useState<EditMode>('none');
  const [editStates, setEditStates] = useState<Map<string, CloudEditState>>(new Map());

  // Erase brush state
  const [eraseBrushSize, setEraseBrushSize] = useState(0.1);  // Default brush radius
  const [eraseBrushPosition, setEraseBrushPosition] = useState<THREE.Vector3 | null>(null);
  const [isErasing, setIsErasing] = useState(false);

  // History for undo/redo
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const isUndoingRef = useRef(false);

  // Refs to track latest positions synchronously (for history capture during drag)
  const meshPositionsRef = useRef<Map<string, { x: number; y: number; z: number }>>(new Map());
  const meshRotationsRef = useRef<Map<string, { x: number; y: number; z: number }>>(new Map());
  const meshScalesRef = useRef<Map<string, { x: number; y: number; z: number }>>(new Map());
  const skeletonPositionsRef = useRef<Map<string, { x: number; y: number; z: number }>>(new Map());

  // Track previous cloud IDs to detect new additions
  const prevCloudIdsRef = useRef<Set<string>>(new Set());

  // Snap to isometric view when a new cloud is added
  useEffect(() => {
    const currentIds = new Set(clouds.map(c => c.id));
    const prevIds = prevCloudIdsRef.current;

    // Find newly added clouds
    const newCloudIds = [...currentIds].filter(id => !prevIds.has(id));

    if (newCloudIds.length > 0) {
      // Get the first new cloud
      const newCloud = clouds.find(c => c.id === newCloudIds[0]);
      if (newCloud && newCloud.data.bounds) {
        // Small delay to ensure camera controller is ready
        setTimeout(() => {
          const snapToView = (window as any).__snapToView;
          if (snapToView) {
            snapToView('iso', {
              center: newCloud.data.bounds.center,
              size: newCloud.data.bounds.size,
            });
          }
        }, 50);
      }
    }

    // Update ref with current IDs
    prevCloudIdsRef.current = currentIds;
  }, [clouds]);

  // Track previous mesh IDs to detect new additions
  const prevMeshIdsRef = useRef<Set<string>>(new Set());

  // Snap to isometric view when a new mesh is added
  useEffect(() => {
    const currentIds = new Set(meshes.map(m => m.id));
    const prevIds = prevMeshIdsRef.current;

    const newMeshIds = [...currentIds].filter(id => !prevIds.has(id));

    if (newMeshIds.length > 0) {
      const newMesh = meshes.find(m => m.id === newMeshIds[0]);
      if (newMesh && newMesh.data.vertices && newMesh.data.vertexCount > 0) {
        setTimeout(() => {
          const snapToView = (window as any).__snapToView;
          if (snapToView) {
            const bounds = computeBoundsFromPositions(newMesh.data.vertices, newMesh.data.vertexCount);
            snapToView('iso', bounds);
          }
        }, 50);
      }
    }

    prevMeshIdsRef.current = currentIds;
  }, [meshes]);

  // Track previous skeleton IDs to detect new additions
  const prevSkeletonIdsRef = useRef<Set<string>>(new Set());

  // Snap to isometric view when a new skeleton is added
  useEffect(() => {
    const currentIds = new Set(skeletons.map(s => s.id));
    const prevIds = prevSkeletonIdsRef.current;

    const newSkeletonIds = [...currentIds].filter(id => !prevIds.has(id));

    if (newSkeletonIds.length > 0) {
      const newSkeleton = skeletons.find(s => s.id === newSkeletonIds[0]);
      if (newSkeleton && newSkeleton.data.points && newSkeleton.data.pointCount > 0) {
        setTimeout(() => {
          const snapToView = (window as any).__snapToView;
          if (snapToView) {
            const bounds = computeBoundsFromPositions(newSkeleton.data.points, newSkeleton.data.pointCount);
            snapToView('iso', bounds);
          }
        }, 50);
      }
    }

    prevSkeletonIdsRef.current = currentIds;
  }, [skeletons]);

  // Initialize edit state for new clouds
  useEffect(() => {
    const newEditStates = new Map(editStates);
    let changed = false;

    for (const cloud of clouds) {
      if (!newEditStates.has(cloud.id)) {
        newEditStates.set(cloud.id, {
          translation: { x: 0, y: 0, z: 0 },
          cropMin: { x: cloud.data.bounds.min.x, y: cloud.data.bounds.min.y, z: cloud.data.bounds.min.z },
          cropMax: { x: cloud.data.bounds.max.x, y: cloud.data.bounds.max.y, z: cloud.data.bounds.max.z },
          cropEnabled: false,
          cropInvert: false,
          erasedIndices: new Set<number>(),
        });
        changed = true;
      }
    }

    // Remove states for deleted clouds
    for (const id of newEditStates.keys()) {
      if (!clouds.find(c => c.id === id)) {
        newEditStates.delete(id);
        changed = true;
      }
    }

    if (changed) {
      setEditStates(newEditStates);
    }
  }, [clouds, editStates]);

  // Keep position refs in sync with state (for history capture)
  useEffect(() => {
    meshPositionsRef.current = new Map(meshPositions);
  }, [meshPositions]);
  useEffect(() => {
    meshRotationsRef.current = new Map(meshRotations);
  }, [meshRotations]);
  useEffect(() => {
    meshScalesRef.current = new Map(meshScales);
  }, [meshScales]);
  useEffect(() => {
    skeletonPositionsRef.current = new Map(skeletonPositions);
  }, [skeletonPositions]);

  // Helper to close all tool panels and reset edit mode (for mutual exclusivity)
  const closeAllToolPanels = useCallback((except?: string) => {
    if (except !== 'editMode') setEditMode('none');
    if (except !== 'filter') setShowFilterPanel(false);
    if (except !== 'resample') {
      setShowResamplePanel(false);
      setResamplePreview(null); // Clear resample preview when closing resample panel
    }
    if (except !== 'triangulation') setShowTriangulationPanel(false);
    if (except !== 'skeleton') setShowSkeletonPanel(false);
    if (except !== 'export') setShowExportPanel(false);
    if (except !== 'morph') setShowMorphPopup(false);
  }, []);

  // Get edit state for a cloud
  const getEditState = useCallback((id: string): CloudEditState => {
    return editStates.get(id) || {
      translation: { x: 0, y: 0, z: 0 },
      cropMin: null,
      cropMax: null,
      cropEnabled: false,
      cropInvert: false,
      erasedIndices: new Set<number>(),
    };
  }, [editStates]);

  // Update edit state for selected clouds
  const updateSelectedEditStates = useCallback((updater: (state: CloudEditState) => CloudEditState) => {
    setEditStates(prev => {
      const next = new Map(prev);
      for (const id of selectedIds) {
        const current = next.get(id);
        if (current) {
          next.set(id, updater(current));
        }
      }
      return next;
    });
  }, [selectedIds]);

  // Save to history - supports cloud, mesh, and skeleton
  // Ref to store pending history entry (before state captured on drag start)
  const pendingHistoryRef = useRef<{ type: 'cloud' | 'mesh' | 'skeleton'; id: string; before: HistoryEntry['before'] } | null>(null);

  // Capture current state for an object (uses refs for synchronous capture during drag)
  const captureState = useCallback((type: 'cloud' | 'mesh' | 'skeleton', id: string): HistoryEntry['before'] => {
    if (type === 'mesh') {
      // Use refs for mesh state to get synchronous values during drag
      const pos = meshPositionsRef.current.get(id) || { x: 0, y: 0, z: 0 };
      const rot = meshRotationsRef.current.get(id) || { x: 0, y: 0, z: 0 };
      const scl = meshScalesRef.current.get(id) || { x: 1, y: 1, z: 1 };
      return {
        objectState: {
          position: { ...pos },
          rotation: { ...rot },
          scale: { ...scl },
        }
      };
    } else if (type === 'skeleton') {
      // Use ref for skeleton position
      const pos = skeletonPositionsRef.current.get(id) || { x: 0, y: 0, z: 0 };
      return {
        objectState: {
          position: { ...pos },
        }
      };
    } else {
      const state = editStates.get(id);
      // Deep clone the cloudState, including the erasedIndices Set
      return { cloudState: state ? {
        ...state,
        erasedIndices: new Set(state.erasedIndices)  // Clone the Set
      } : undefined };
    }
  }, [editStates]);

  // Start a history entry (call before operation begins)
  const startHistoryEntry = useCallback((type: 'cloud' | 'mesh' | 'skeleton', id: string) => {
    if (isUndoingRef.current) return;
    pendingHistoryRef.current = {
      type,
      id,
      before: captureState(type, id),
    };
  }, [captureState]);

  // Commit a history entry (call after operation completes)
  const commitHistoryEntry = useCallback(() => {
    if (isUndoingRef.current || !pendingHistoryRef.current) return;

    const { type, id, before } = pendingHistoryRef.current;
    const after = captureState(type, id);

    const entry: HistoryEntry = { type, id, before, after };

    setHistory(prev => {
      // Defensive check: ensure prev is an array
      if (!Array.isArray(prev)) {
        console.warn('[commitHistoryEntry] History state corrupted, resetting to empty array');
        return [entry];
      }
      const newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push(entry);
      if (newHistory.length > 100) newHistory.splice(0, newHistory.length - 100);
      return newHistory;
    });
    setHistoryIndex(prev => Math.min(prev + 1, 99));
    pendingHistoryRef.current = null;
  }, [captureState, historyIndex]);

  // Save to history in one step (for immediate operations like move-to-origin)
  const saveToHistory = useCallback((overrideType?: 'cloud' | 'mesh' | 'skeleton', overrideId?: string) => {
    if (isUndoingRef.current) return;

    // For mesh/skeleton with override, capture before state now
    if (overrideType && overrideId) {
      startHistoryEntry(overrideType, overrideId);
    } else if (selectedIds.size > 0) {
      // For clouds, save each selected cloud
      for (const id of selectedIds) {
        startHistoryEntry('cloud', id);
      }
    }
  }, [selectedIds, startHistoryEntry]);

  // Apply a state snapshot to an object
  const applyState = useCallback((type: 'cloud' | 'mesh' | 'skeleton', id: string, state: HistoryEntry['before']) => {
    if (type === 'cloud' && state.cloudState) {
      setEditStates(prev => {
        const next = new Map(prev);
        next.set(id, { ...state.cloudState! });
        return next;
      });
    } else if (type === 'mesh' && state.objectState) {
      setMeshPositions(prev => {
        const next = new Map(prev);
        next.set(id, { ...state.objectState!.position });
        return next;
      });
      if (state.objectState.rotation) {
        setMeshRotations(prev => {
          const next = new Map(prev);
          next.set(id, { ...state.objectState!.rotation! });
          return next;
        });
      }
      if (state.objectState.scale) {
        setMeshScales(prev => {
          const next = new Map(prev);
          next.set(id, { ...state.objectState!.scale! });
          return next;
        });
      }
    } else if (type === 'skeleton' && state.objectState) {
      setSkeletonPositions(prev => {
        const next = new Map(prev);
        next.set(id, { ...state.objectState!.position });
        return next;
      });
    }
  }, []);

  // Undo - first check for stitch operations, then local edit history
  const handleUndo = useCallback(() => {
    // First try to undo a stitch operation
    if (canUndoStitch?.() && onUndoStitch?.()) {
      return;
    }

    // Then try local edit history
    if (historyIndex < 0) return;

    const entry = history[historyIndex];
    if (entry) {
      isUndoingRef.current = true;
      applyState(entry.type, entry.id, entry.before);
      setHistoryIndex(prev => prev - 1);
      setTimeout(() => { isUndoingRef.current = false; }, 0);
    }
  }, [history, historyIndex, canUndoStitch, onUndoStitch, applyState]);

  // Redo
  const handleRedo = useCallback(() => {
    if (historyIndex >= history.length - 1) return;

    const entry = history[historyIndex + 1];
    if (entry) {
      isUndoingRef.current = true;
      applyState(entry.type, entry.id, entry.after);
      setHistoryIndex(prev => prev + 1);
      setTimeout(() => { isUndoingRef.current = false; }, 0);
    }
  }, [history, historyIndex, applyState]);

  // Apply crop to the selected cloud
  const handleApplyCrop = useCallback(() => {
    if (editMode !== 'crop' || selectedIds.size !== 1) return;

    const cloudId = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === cloudId);
    const state = editStates.get(cloudId);

    if (!cloud || !state || !state.cropMin || !state.cropMax) return;

    // Filter points based on crop bounds (respecting cropInvert)
    const newPositions: number[] = [];
    const newColors: number[] = [];
    const newIntensities: number[] = [];

    for (let i = 0; i < cloud.data.pointCount; i++) {
      // Skip erased points
      if (state.erasedIndices.has(i)) continue;

      const x = cloud.data.positions[i * 3];
      const y = cloud.data.positions[i * 3 + 1];
      const z = cloud.data.positions[i * 3 + 2];

      const isInside = (
        x >= state.cropMin!.x && x <= state.cropMax!.x &&
        y >= state.cropMin!.y && y <= state.cropMax!.y &&
        z >= state.cropMin!.z && z <= state.cropMax!.z
      );

      const keepPoint = state.cropInvert ? !isInside : isInside;

      if (keepPoint) {
        // Apply translation to the point
        newPositions.push(
          x + state.translation.x,
          y + state.translation.y,
          z + state.translation.z
        );
        if (cloud.data.colors) {
          newColors.push(
            cloud.data.colors[i * 3],
            cloud.data.colors[i * 3 + 1],
            cloud.data.colors[i * 3 + 2]
          );
        }
        if (cloud.data.intensities) {
          newIntensities.push(cloud.data.intensities[i]);
        }
      }
    }

    const pointCount = newPositions.length / 3;
    if (pointCount === 0) {
      // All points would be removed - trigger delete confirmation
      setDeleteConfirm({
        type: 'cloud',
        id: cloud.id,
        name: cloud.data.fileName || 'Unnamed'
      });
      setEditMode('none');
      return;
    }

    // Calculate new bounds
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < pointCount; i++) {
      min.x = Math.min(min.x, newPositions[i * 3]);
      min.y = Math.min(min.y, newPositions[i * 3 + 1]);
      min.z = Math.min(min.z, newPositions[i * 3 + 2]);
      max.x = Math.max(max.x, newPositions[i * 3]);
      max.y = Math.max(max.y, newPositions[i * 3 + 1]);
      max.z = Math.max(max.z, newPositions[i * 3 + 2]);
    }
    const center = new THREE.Vector3(
      (min.x + max.x) / 2,
      (min.y + max.y) / 2,
      (min.z + max.z) / 2
    );
    const size = new THREE.Vector3(
      max.x - min.x,
      max.y - min.y,
      max.z - min.z
    );

    // Create new point cloud data
    const newData: PointCloudData = {
      positions: new Float32Array(newPositions),
      colors: cloud.data.colors ? new Float32Array(newColors) : undefined,
      intensities: cloud.data.intensities ? new Float32Array(newIntensities) : undefined,
      pointCount,
      bounds: { min, max, center, size },
      fileName: cloud.data.fileName,
    };

    // Update the cloud permanently
    onUpdateCloud(cloud.id, newData);

    // Reset edit state for this cloud (new bounds, no translation, no erased)
    setEditStates(prev => {
      const next = new Map(prev);
      next.set(cloud.id, {
        translation: { x: 0, y: 0, z: 0 },
        cropMin: { x: min.x, y: min.y, z: min.z },
        cropMax: { x: max.x, y: max.y, z: max.z },
        cropEnabled: false,
        cropInvert: false,
        erasedIndices: new Set<number>(),
      });
      return next;
    });

    // Clear history entries for this cloud since data changed
    setHistory(prev => prev.filter(entry => entry.id !== cloud.id));
    setHistoryIndex(prev => Math.max(-1, prev - 1));

    setEditMode('none');
  }, [editMode, selectedIds, clouds, editStates, onUpdateCloud]);

  // Apply erased points permanently - removes erased points and bakes in translation
  const handleApplyErase = useCallback(() => {
    if (editMode !== 'erase' || selectedIds.size !== 1) return;

    const cloudId = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === cloudId);
    const state = editStates.get(cloudId);

    if (!cloud || !state || state.erasedIndices.size === 0) return;

    // Filter out erased points and apply translation
    const newPositions: number[] = [];
    const newColors: number[] = [];
    const newIntensities: number[] = [];
    const newScalarFields: Record<string, number[]> = {};

    // Initialize scalar field arrays
    if (cloud.data.scalarFields) {
      for (const fieldName of Object.keys(cloud.data.scalarFields)) {
        newScalarFields[fieldName] = [];
      }
    }

    for (let i = 0; i < cloud.data.pointCount; i++) {
      // Skip erased points
      if (state.erasedIndices.has(i)) continue;

      const x = cloud.data.positions[i * 3];
      const y = cloud.data.positions[i * 3 + 1];
      const z = cloud.data.positions[i * 3 + 2];

      // Apply translation to the point
      newPositions.push(
        x + state.translation.x,
        y + state.translation.y,
        z + state.translation.z
      );
      if (cloud.data.colors) {
        newColors.push(
          cloud.data.colors[i * 3],
          cloud.data.colors[i * 3 + 1],
          cloud.data.colors[i * 3 + 2]
        );
      }
      if (cloud.data.intensities) {
        newIntensities.push(cloud.data.intensities[i]);
      }
      // Copy scalar field values
      if (cloud.data.scalarFields) {
        for (const [fieldName, field] of Object.entries(cloud.data.scalarFields)) {
          newScalarFields[fieldName].push(field.values[i]);
        }
      }
    }

    const pointCount = newPositions.length / 3;
    if (pointCount === 0) {
      // All points would be removed - trigger delete confirmation
      setDeleteConfirm({
        type: 'cloud',
        id: cloud.id,
        name: cloud.data.fileName || 'Unnamed'
      });
      setEditMode('none');
      return;
    }

    // Calculate new bounds
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < pointCount; i++) {
      min.x = Math.min(min.x, newPositions[i * 3]);
      min.y = Math.min(min.y, newPositions[i * 3 + 1]);
      min.z = Math.min(min.z, newPositions[i * 3 + 2]);
      max.x = Math.max(max.x, newPositions[i * 3]);
      max.y = Math.max(max.y, newPositions[i * 3 + 1]);
      max.z = Math.max(max.z, newPositions[i * 3 + 2]);
    }
    const center = new THREE.Vector3(
      (min.x + max.x) / 2,
      (min.y + max.y) / 2,
      (min.z + max.z) / 2
    );
    const size = new THREE.Vector3(
      max.x - min.x,
      max.y - min.y,
      max.z - min.z
    );

    // Convert scalar fields to typed arrays with min/max
    const finalScalarFields: Record<string, ScalarField> | undefined = cloud.data.scalarFields
      ? Object.fromEntries(
          Object.entries(newScalarFields).map(([name, values]) => {
            const arr = new Float32Array(values);
            let sfMin = Infinity, sfMax = -Infinity;
            for (const v of arr) {
              if (v < sfMin) sfMin = v;
              if (v > sfMax) sfMax = v;
            }
            return [name, { values: arr, min: sfMin, max: sfMax }];
          })
        )
      : undefined;

    // Create new point cloud data
    const newData: PointCloudData = {
      positions: new Float32Array(newPositions),
      colors: cloud.data.colors ? new Float32Array(newColors) : undefined,
      intensities: cloud.data.intensities ? new Float32Array(newIntensities) : undefined,
      scalarFields: finalScalarFields,
      pointCount,
      bounds: { min, max, center, size },
      fileName: cloud.data.fileName,
    };

    // Update the cloud permanently
    onUpdateCloud(cloud.id, newData);

    // Reset edit state for this cloud (new bounds, no translation, no erased)
    setEditStates(prev => {
      const next = new Map(prev);
      next.set(cloud.id, {
        translation: { x: 0, y: 0, z: 0 },
        cropMin: { x: min.x, y: min.y, z: min.z },
        cropMax: { x: max.x, y: max.y, z: max.z },
        cropEnabled: false,
        cropInvert: false,
        erasedIndices: new Set<number>(),
      });
      return next;
    });

    // Clear history entries for this cloud since data changed
    setHistory(prev => prev.filter(entry => entry.id !== cloud.id));
    setHistoryIndex(prev => Math.max(-1, prev - 1));

    setEditMode('none');
  }, [editMode, selectedIds, clouds, editStates, onUpdateCloud]);

  // Apply filter permanently - removes filtered out points from the point cloud
  const handleApplyFilterPermanently = useCallback(() => {
    if (selectedIds.size !== 1) return;

    const cloudId = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === cloudId);
    const filters = cloudFilters.get(cloudId);

    if (!cloud || !filters) return;

    // Check if any filter is active
    const hasAnyFilter = filters.x.enabled || filters.y.enabled || filters.z.enabled ||
      filters.intensity?.enabled ||
      Object.values(filters.scalarFields).some(f => f.enabled);

    if (!hasAnyFilter) return;

    const state = editStates.get(cloudId) || {
      translation: { x: 0, y: 0, z: 0 },
      erasedIndices: new Set<number>(),
      cropEnabled: false,
      cropInvert: false,
    };

    // Filter points based on active filters
    const newPositions: number[] = [];
    const newColors: number[] = [];
    const newIntensities: number[] = [];
    const newScalarFields: Record<string, number[]> = {};

    // Initialize scalar field arrays
    if (cloud.data.scalarFields) {
      Object.keys(cloud.data.scalarFields).forEach(name => {
        newScalarFields[name] = [];
      });
    }

    for (let i = 0; i < cloud.data.pointCount; i++) {
      // Skip erased points
      if (state.erasedIndices.has(i)) continue;

      const x = cloud.data.positions[i * 3];
      const y = cloud.data.positions[i * 3 + 1];
      const z = cloud.data.positions[i * 3 + 2];

      // Check coordinate filters
      if (filters.x.enabled && (x < filters.x.min || x > filters.x.max)) continue;
      if (filters.y.enabled && (y < filters.y.min || y > filters.y.max)) continue;
      if (filters.z.enabled && (z < filters.z.min || z > filters.z.max)) continue;

      // Check intensity filter
      if (filters.intensity?.enabled && cloud.data.intensities) {
        const intensity = cloud.data.intensities[i];
        if (intensity < filters.intensity.min || intensity > filters.intensity.max) continue;
      }

      // Check scalar field filters
      let passScalar = true;
      for (const [name, sf] of Object.entries(filters.scalarFields)) {
        if (sf.enabled && cloud.data.scalarFields?.[name]) {
          const v = cloud.data.scalarFields[name].values[i];
          if (v < sf.min || v > sf.max) {
            passScalar = false;
            break;
          }
        }
      }
      if (!passScalar) continue;

      // Point passed all filters - keep it (apply translation)
      newPositions.push(
        x + state.translation.x,
        y + state.translation.y,
        z + state.translation.z
      );
      if (cloud.data.colors) {
        newColors.push(
          cloud.data.colors[i * 3],
          cloud.data.colors[i * 3 + 1],
          cloud.data.colors[i * 3 + 2]
        );
      }
      if (cloud.data.intensities) {
        newIntensities.push(cloud.data.intensities[i]);
      }
      if (cloud.data.scalarFields) {
        Object.entries(cloud.data.scalarFields).forEach(([name, field]) => {
          newScalarFields[name].push(field.values[i]);
        });
      }
    }

    const pointCount = newPositions.length / 3;
    if (pointCount === 0) {
      // All points would be removed - trigger delete confirmation
      setDeleteConfirm({
        type: 'cloud',
        id: cloud.id,
        name: cloud.data.fileName || 'Unnamed'
      });
      return;
    }

    // Calculate new bounds
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < pointCount; i++) {
      min.x = Math.min(min.x, newPositions[i * 3]);
      min.y = Math.min(min.y, newPositions[i * 3 + 1]);
      min.z = Math.min(min.z, newPositions[i * 3 + 2]);
      max.x = Math.max(max.x, newPositions[i * 3]);
      max.y = Math.max(max.y, newPositions[i * 3 + 1]);
      max.z = Math.max(max.z, newPositions[i * 3 + 2]);
    }
    const center = new THREE.Vector3(
      (min.x + max.x) / 2,
      (min.y + max.y) / 2,
      (min.z + max.z) / 2
    );
    const size = new THREE.Vector3(
      max.x - min.x,
      max.y - min.y,
      max.z - min.z
    );

    // Build new scalar fields with recalculated min/max
    const newScalarFieldsData: Record<string, { values: Float32Array; min: number; max: number }> = {};
    Object.entries(newScalarFields).forEach(([name, values]) => {
      const arr = new Float32Array(values);
      let sfMin = Infinity, sfMax = -Infinity;
      for (let i = 0; i < arr.length; i++) {
        sfMin = Math.min(sfMin, arr[i]);
        sfMax = Math.max(sfMax, arr[i]);
      }
      newScalarFieldsData[name] = { values: arr, min: sfMin, max: sfMax };
    });

    // Create new point cloud data
    const newData: PointCloudData = {
      positions: new Float32Array(newPositions),
      colors: cloud.data.colors ? new Float32Array(newColors) : undefined,
      intensities: cloud.data.intensities ? new Float32Array(newIntensities) : undefined,
      scalarFields: Object.keys(newScalarFieldsData).length > 0 ? newScalarFieldsData : undefined,
      pointCount,
      bounds: { min, max, center, size },
      fileName: cloud.data.fileName,
    };

    // Update the cloud permanently
    onUpdateCloud(cloud.id, newData);

    // Reset edit state for this cloud
    setEditStates(prev => {
      const next = new Map(prev);
      next.set(cloud.id, {
        translation: { x: 0, y: 0, z: 0 },
        cropMin: { x: min.x, y: min.y, z: min.z },
        cropMax: { x: max.x, y: max.y, z: max.z },
        cropEnabled: false,
        cropInvert: false,
        erasedIndices: new Set<number>(),
      });
      return next;
    });

    // Clear filters for this cloud
    setCloudFilters(prev => {
      const next = new Map(prev);
      next.delete(cloud.id);
      return next;
    });

    // Clear history entries for this cloud since data changed
    setHistory(prev => prev.filter(entry => entry.id !== cloud.id));
    setHistoryIndex(prev => Math.max(-1, prev - 1));

    // Close filter panel
    setShowFilterPanel(false);
  }, [selectedIds, clouds, cloudFilters, editStates, onUpdateCloud]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Undo: Ctrl/Cmd+Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      // Redo: Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      }
      // Enter: Apply crop (if in crop mode) or exit current edit mode
      if (e.key === 'Enter' && editMode !== 'none') {
        e.preventDefault();
        if (editMode === 'crop') {
          handleApplyCrop();
        } else {
          setEditMode('none');
        }
      }
      // Escape: Cancel/exit current edit mode
      if (e.key === 'Escape' && editMode !== 'none') {
        e.preventDefault();
        setEditMode('none');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, handleApplyCrop, editMode]);

  // Track shift key state for mixed selection (cloud + mesh)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') isShiftHeldRef.current = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') isShiftHeldRef.current = false;
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Calculate combined bounds (including clouds, meshes, and skeletons)
  const combinedBounds = useMemo(() => {
    const hasContent = clouds.length > 0 || meshes.length > 0 || skeletons.length > 0;

    // Return default bounds when scene is empty
    if (!hasContent) {
      return {
        min: new THREE.Vector3(-5, -5, -5),
        max: new THREE.Vector3(5, 5, 5),
        center: new THREE.Vector3(0, 0, 0),
        size: new THREE.Vector3(10, 10, 10),
      };
    }

    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    // Include cloud bounds
    for (const cloud of clouds) {
      if (!cloud.visible) continue;
      const editState = getEditState(cloud.id);
      min.x = Math.min(min.x, cloud.data.bounds.min.x + editState.translation.x);
      min.y = Math.min(min.y, cloud.data.bounds.min.y + editState.translation.y);
      min.z = Math.min(min.z, cloud.data.bounds.min.z + editState.translation.z);
      max.x = Math.max(max.x, cloud.data.bounds.max.x + editState.translation.x);
      max.y = Math.max(max.y, cloud.data.bounds.max.y + editState.translation.y);
      max.z = Math.max(max.z, cloud.data.bounds.max.z + editState.translation.z);
    }

    // Include mesh bounds
    for (const mesh of meshes) {
      if (!mesh.visible) continue;
      const { vertices, vertexCount } = mesh.data;
      for (let i = 0; i < vertexCount; i++) {
        min.x = Math.min(min.x, vertices[i * 3]);
        min.y = Math.min(min.y, vertices[i * 3 + 1]);
        min.z = Math.min(min.z, vertices[i * 3 + 2]);
        max.x = Math.max(max.x, vertices[i * 3]);
        max.y = Math.max(max.y, vertices[i * 3 + 1]);
        max.z = Math.max(max.z, vertices[i * 3 + 2]);
      }
    }

    // Include skeleton bounds
    for (const skeleton of skeletons) {
      if (!skeleton.visible) continue;
      const { points, pointCount } = skeleton.data;
      for (let i = 0; i < pointCount; i++) {
        min.x = Math.min(min.x, points[i * 3]);
        min.y = Math.min(min.y, points[i * 3 + 1]);
        min.z = Math.min(min.z, points[i * 3 + 2]);
        max.x = Math.max(max.x, points[i * 3]);
        max.y = Math.max(max.y, points[i * 3 + 1]);
        max.z = Math.max(max.z, points[i * 3 + 2]);
      }
    }

    // Fallback if no visible objects
    if (!isFinite(min.x)) {
      if (clouds.length > 0) return clouds[0].data.bounds;
      // Create default bounds for mesh/skeleton only scenarios
      return {
        min: new THREE.Vector3(-1, -1, -1),
        max: new THREE.Vector3(1, 1, 1),
        center: new THREE.Vector3(0, 0, 0),
        size: new THREE.Vector3(2, 2, 2),
      };
    }

    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(max, min);
    return { min, max, center, size };
  }, [clouds, meshes, skeletons, getEditState]);

  // Stable static bounds for grid/axes - only updates when objects are added, not removed.
  // This prevents the grid and axes from jumping when objects are deleted.
  const prevStaticBoundsIdsRef = useRef<Set<string>>(new Set());
  const stableStaticBoundsRef = useRef({
    min: new THREE.Vector3(-5, -5, -5),
    max: new THREE.Vector3(5, 5, 5),
    center: new THREE.Vector3(0, 0, 0),
    size: new THREE.Vector3(10, 10, 10),
  });

  const staticBounds = useMemo(() => {
    const allIds = new Set([
      ...clouds.map(c => c.id),
      ...meshes.map(m => m.id),
      ...skeletons.map(s => s.id),
    ]);
    const prevIds = prevStaticBoundsIdsRef.current;
    const hasNewIds = [...allIds].some(id => !prevIds.has(id));
    const hasRemovedIds = [...prevIds].some(id => !allIds.has(id));
    const isEmpty = allIds.size === 0;

    // Only removals (no new objects added): keep stable bounds even if scene is now empty.
    // This prevents the grid and axes from jumping when objects are deleted.
    if (hasRemovedIds && !hasNewIds) {
      prevStaticBoundsIdsRef.current = allIds;
      return stableStaticBoundsRef.current;
    }

    prevStaticBoundsIdsRef.current = allIds;

    // Scene empty (initial state, no removal): use defaults
    if (isEmpty) {
      const defaults = {
        min: new THREE.Vector3(-5, -5, -5),
        max: new THREE.Vector3(5, 5, 5),
        center: new THREE.Vector3(0, 0, 0),
        size: new THREE.Vector3(10, 10, 10),
      };
      stableStaticBoundsRef.current = defaults;
      return defaults;
    }

    // New objects added: recompute bounds from all current objects
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    // Include cloud bounds (original positions only, no translations)
    for (const cloud of clouds) {
      if (!cloud.visible) continue;
      min.x = Math.min(min.x, cloud.data.bounds.min.x);
      min.y = Math.min(min.y, cloud.data.bounds.min.y);
      min.z = Math.min(min.z, cloud.data.bounds.min.z);
      max.x = Math.max(max.x, cloud.data.bounds.max.x);
      max.y = Math.max(max.y, cloud.data.bounds.max.y);
      max.z = Math.max(max.z, cloud.data.bounds.max.z);
    }

    // Include mesh bounds (original vertex data, no positions/scales)
    for (const mesh of meshes) {
      if (!mesh.visible) continue;
      const { vertices, vertexCount } = mesh.data;
      for (let i = 0; i < vertexCount; i++) {
        min.x = Math.min(min.x, vertices[i * 3]);
        min.y = Math.min(min.y, vertices[i * 3 + 1]);
        min.z = Math.min(min.z, vertices[i * 3 + 2]);
        max.x = Math.max(max.x, vertices[i * 3]);
        max.y = Math.max(max.y, vertices[i * 3 + 1]);
        max.z = Math.max(max.z, vertices[i * 3 + 2]);
      }
    }

    // Include skeleton bounds (original points, no positions)
    for (const skeleton of skeletons) {
      if (!skeleton.visible) continue;
      const { points, pointCount } = skeleton.data;
      for (let i = 0; i < pointCount; i++) {
        min.x = Math.min(min.x, points[i * 3]);
        min.y = Math.min(min.y, points[i * 3 + 1]);
        min.z = Math.min(min.z, points[i * 3 + 2]);
        max.x = Math.max(max.x, points[i * 3]);
        max.y = Math.max(max.y, points[i * 3 + 1]);
        max.z = Math.max(max.z, points[i * 3 + 2]);
      }
    }

    if (!isFinite(min.x)) {
      const fallback = {
        min: new THREE.Vector3(-1, -1, -1),
        max: new THREE.Vector3(1, 1, 1),
        center: new THREE.Vector3(0, 0, 0),
        size: new THREE.Vector3(2, 2, 2),
      };
      stableStaticBoundsRef.current = fallback;
      return fallback;
    }

    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(max, min);
    const result = { min, max, center, size };
    stableStaticBoundsRef.current = result;
    return result;
  }, [clouds, meshes, skeletons]);

  // Fuzzy search helper
  const fuzzyMatch = useCallback((query: string, text: string): number => {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (!q) return 1;
    if (t.includes(q)) return 2; // Exact substring match
    // Check if all chars appear in order
    let qi = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) qi++;
    }
    return qi === q.length ? 1 : 0;
  }, []);

  // Determine what's currently selected
  const hasCloudSelected = selectedIds.size > 0;
  const hasMeshSelected = selectedMeshIds.size > 0;
  const hasSkeletonSelected = selectedSkeletonId !== null;
  const hasPlantMeshSelected = hasMeshSelected && meshes.find(m => selectedMeshIds.has(m.id))?.isPlant;

  // Command registry
  const commands = useMemo(() => {
    type Command = {
      id: string;
      name: string;
      keywords?: string[];
      action: () => void;
      category: string;
      requires?: 'cloud' | 'mesh' | 'skeleton' | 'plant' | 'multiple-clouds' | 'multiple-meshes' | null;
    };

    const cmds: Command[] = [
      // View commands - always available
      { id: 'reset-view', name: 'Reset View', keywords: ['home', 'camera'], action: () => (window as any).__resetPointCloudCamera?.(), category: 'View', requires: null },
      { id: 'view-top', name: 'Top View', keywords: ['camera', 'snap'], action: () => (window as any).__snapToView?.('top'), category: 'View', requires: null },
      { id: 'view-bottom', name: 'Bottom View', keywords: ['camera', 'snap'], action: () => (window as any).__snapToView?.('bottom'), category: 'View', requires: null },
      { id: 'view-front', name: 'Front View', keywords: ['camera', 'snap'], action: () => (window as any).__snapToView?.('front'), category: 'View', requires: null },
      { id: 'view-back', name: 'Back View', keywords: ['camera', 'snap'], action: () => (window as any).__snapToView?.('back'), category: 'View', requires: null },
      { id: 'view-left', name: 'Left View', keywords: ['camera', 'snap'], action: () => (window as any).__snapToView?.('left'), category: 'View', requires: null },
      { id: 'view-right', name: 'Right View', keywords: ['camera', 'snap'], action: () => (window as any).__snapToView?.('right'), category: 'View', requires: null },
      { id: 'view-iso', name: 'Isometric View', keywords: ['camera', 'snap', 'diagonal'], action: () => (window as any).__snapToView?.('iso'), category: 'View', requires: null },

      // Selection commands
      { id: 'select-all', name: 'Select All', keywords: ['pick', 'choose'], action: () => onSelectAll(), category: 'Selection', requires: null },
      { id: 'deselect-all', name: 'Deselect All', keywords: ['clear', 'none'], action: () => onDeselectAll(), category: 'Selection', requires: null },

      // Create commands - always available
      { id: 'create-voxel', name: 'Create Voxel', keywords: ['cube', 'box', 'shape'], action: () => handleCreateShape('voxel'), category: 'Create', requires: null },
      { id: 'create-cylinder', name: 'Create Cylinder', keywords: ['tube', 'shape'], action: () => handleCreateShape('cylinder'), category: 'Create', requires: null },
      { id: 'create-sphere', name: 'Create Sphere', keywords: ['ball', 'shape'], action: () => handleCreateShape('sphere'), category: 'Create', requires: null },
      { id: 'create-cone', name: 'Create Cone', keywords: ['shape'], action: () => handleCreateShape('cone'), category: 'Create', requires: null },
      { id: 'create-plant', name: 'Generate Plant', keywords: ['helios', 'leaf', 'vegetation'], action: () => setShowPlantPopup(true), category: 'Create', requires: null },

      // Point cloud tools
      { id: 'cloud-translate', name: 'Translate Point Cloud', keywords: ['move', 'position'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'translate' ? 'none' : 'translate'); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-crop', name: 'Crop Point Cloud', keywords: ['cut', 'trim', 'box'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'crop' ? 'none' : 'crop'); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-filter', name: 'Filter Points', keywords: ['range', 'intensity'], action: () => { closeAllToolPanels('filter'); setShowFilterPanel(!showFilterPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-resample', name: 'Resample Point Cloud', keywords: ['downsample', 'reduce', 'decimate'], action: () => { closeAllToolPanels('resample'); setShowResamplePanel(!showResamplePanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-erase', name: 'Erase Brush', keywords: ['delete', 'remove', 'paint'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'erase' ? 'none' : 'erase'); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-triangulate', name: 'Triangulate', keywords: ['mesh', 'surface', 'reconstruct'], action: () => { closeAllToolPanels('triangulation'); setShowTriangulationPanel(!showTriangulationPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-skeleton', name: 'Extract Skeleton', keywords: ['branch', 'structure'], action: () => { closeAllToolPanels('skeleton'); setShowSkeletonPanel(!showSkeletonPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-export', name: 'Export Point Cloud', keywords: ['save', 'las', 'laz', 'xyz'], action: () => { closeAllToolPanels('export'); setShowExportPanel(!showExportPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-stitch', name: 'Stitch Clouds', keywords: ['merge', 'combine', 'join'], action: () => { if (selectedIds.size >= 2 && onStitchClouds) onStitchClouds(Array.from(selectedIds)); }, category: 'Point Cloud', requires: 'multiple-clouds' },

      // Mesh tools
      { id: 'mesh-translate', name: 'Translate Mesh', keywords: ['move', 'position'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'translate' ? 'none' : 'translate'); }, category: 'Mesh', requires: 'mesh' },
      { id: 'mesh-rotate', name: 'Rotate Mesh', keywords: ['turn', 'spin'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'rotate' ? 'none' : 'rotate'); }, category: 'Mesh', requires: 'mesh' },
      { id: 'mesh-resize', name: 'Resize Mesh', keywords: ['scale', 'size'], action: () => setShowResizePanel(!showResizePanel), category: 'Mesh', requires: 'mesh' },
      { id: 'mesh-sample', name: 'Sample to Point Cloud', keywords: ['convert', 'points'], action: () => setShowSamplingPopup(true), category: 'Mesh', requires: 'mesh' },
      { id: 'mesh-export', name: 'Export Mesh', keywords: ['save', 'obj', 'ply'], action: () => { closeAllToolPanels('export'); setShowExportPanel(!showExportPanel); }, category: 'Mesh', requires: 'mesh' },

      // Plant-specific
      { id: 'plant-growth', name: 'Plant Growth Panel', keywords: ['age', 'time', 'animate'], action: () => setShowPlantGrowthPanel(!showPlantGrowthPanel), category: 'Plant', requires: 'plant' },
      { id: 'plant-morph', name: 'Morph Plant', keywords: ['parameter', 'shoot', 'tune', 'modify'], action: () => setShowMorphPopup(true), category: 'Plant', requires: 'plant' },

      // Skeleton tools
      { id: 'skeleton-translate', name: 'Translate Skeleton', keywords: ['move', 'position'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'translate' ? 'none' : 'translate'); }, category: 'Skeleton', requires: 'skeleton' },
      { id: 'skeleton-export', name: 'Export Skeleton', keywords: ['save', 'json'], action: () => { closeAllToolPanels('export'); setShowExportPanel(!showExportPanel); }, category: 'Skeleton', requires: 'skeleton' },

      // History
      { id: 'undo', name: 'Undo', keywords: ['back', 'revert'], action: () => handleUndo(), category: 'History', requires: null },
      { id: 'redo', name: 'Redo', keywords: ['forward'], action: () => handleRedo(), category: 'History', requires: null },
    ];

    return cmds;
  }, [editMode, showFilterPanel, showResamplePanel, showTriangulationPanel, showSkeletonPanel, showExportPanel, showResizePanel, showPlantGrowthPanel, closeAllToolPanels, onSelectAll, onDeselectAll, onStitchClouds, selectedIds, handleUndo, handleRedo]);

  // Filter and sort commands based on search
  const filteredCommands = useMemo(() => {
    const checkAvailable = (requires: string | null | undefined) => {
      if (!requires) return true;
      switch (requires) {
        case 'cloud': return hasCloudSelected;
        case 'mesh': return hasMeshSelected;
        case 'skeleton': return hasSkeletonSelected;
        case 'plant': return hasPlantMeshSelected;
        case 'multiple-clouds': return selectedIds.size >= 2;
        case 'multiple-meshes': return selectedMeshIds.size >= 2;
        default: return true;
      }
    };

    const getRequiresText = (requires: string | null | undefined) => {
      switch (requires) {
        case 'cloud': return 'point cloud';
        case 'mesh': return 'mesh';
        case 'skeleton': return 'skeleton';
        case 'plant': return 'plant mesh';
        case 'multiple-clouds': return '2+ point clouds';
        case 'multiple-meshes': return '2+ meshes';
        default: return '';
      }
    };

    return commands
      .map(cmd => {
        const nameScore = fuzzyMatch(commandSearch, cmd.name);
        const keywordScore = cmd.keywords?.reduce((max, kw) => Math.max(max, fuzzyMatch(commandSearch, kw)), 0) || 0;
        const score = Math.max(nameScore, keywordScore * 0.8);
        const available = checkAvailable(cmd.requires);
        const requiresText = getRequiresText(cmd.requires);
        return { ...cmd, score, available, requiresText };
      })
      .filter(cmd => cmd.score > 0)
      .sort((a, b) => {
        // Available commands first
        if (a.available !== b.available) return a.available ? -1 : 1;
        // Then by score
        return b.score - a.score;
      });
  }, [commands, commandSearch, fuzzyMatch, hasCloudSelected, hasMeshSelected, hasSkeletonSelected, hasPlantMeshSelected, selectedIds.size, selectedMeshIds.size]);

  // Reset selection when search changes
  useEffect(() => {
    setCommandSelectedIndex(0);
  }, [commandSearch]);

  // Keyboard shortcut for command palette (Cmd/Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette(prev => !prev);
        setCommandSearch('');
        setCommandSelectedIndex(0);
      }
      if (e.key === 'Escape' && showCommandPalette) {
        setShowCommandPalette(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showCommandPalette]);

  // Handle gizmo translation for selected clouds
  const handleGizmoTranslate = useCallback((delta: { x: number; y: number; z: number }) => {
    updateSelectedEditStates(state => ({
      ...state,
      translation: {
        x: state.translation.x + delta.x,
        y: state.translation.y + delta.y,
        z: state.translation.z + delta.z,
      },
    }));
  }, [updateSelectedEditStates]);

  // Handle gizmo translation for selected mesh
  const handleMeshTranslate = useCallback((delta: { x: number; y: number; z: number }) => {
    if (!selectedMeshId) return;
    const current = meshPositionsRef.current.get(selectedMeshId) || { x: 0, y: 0, z: 0 };
    const newPos = {
      x: current.x + delta.x,
      y: current.y + delta.y,
      z: current.z + delta.z,
    };
    // Update ref synchronously for history capture
    meshPositionsRef.current.set(selectedMeshId, newPos);
    // Update state for React render
    setMeshPositions(prev => {
      const next = new Map(prev);
      next.set(selectedMeshId, newPos);
      return next;
    });
  }, [selectedMeshId]);

  // Handle gizmo translation for selected skeleton
  const handleSkeletonTranslate = useCallback((delta: { x: number; y: number; z: number }) => {
    if (!selectedSkeletonId) return;
    const current = skeletonPositionsRef.current.get(selectedSkeletonId) || { x: 0, y: 0, z: 0 };
    const newPos = {
      x: current.x + delta.x,
      y: current.y + delta.y,
      z: current.z + delta.z,
    };
    // Update ref synchronously for history capture
    skeletonPositionsRef.current.set(selectedSkeletonId, newPos);
    // Update state for React render
    setSkeletonPositions(prev => {
      const next = new Map(prev);
      next.set(selectedSkeletonId, newPos);
      return next;
    });
  }, [selectedSkeletonId]);

  // Move selected object to origin
  const handleMoveToOrigin = useCallback(() => {
    if (selectedMeshId) {
      // For meshes, find the mesh and calculate center offset
      const mesh = meshes.find(m => m.id === selectedMeshId);
      if (mesh) {
        // Calculate mesh center from vertices
        const { vertices, vertexCount } = mesh.data;
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < vertexCount; i++) {
          cx += vertices[i * 3];
          cy += vertices[i * 3 + 1];
          cz += vertices[i * 3 + 2];
        }
        cx /= vertexCount;
        cy /= vertexCount;
        cz /= vertexCount;

        // Current position offset
        const currentPos = meshPositions.get(selectedMeshId) || { x: 0, y: 0, z: 0 };
        // New position should offset so that center ends up at origin
        const newPos = { x: -cx, y: -cy, z: -cz };

        startHistoryEntry('mesh', selectedMeshId);
        meshPositionsRef.current.set(selectedMeshId, newPos);
        setMeshPositions(prev => {
          const next = new Map(prev);
          next.set(selectedMeshId, newPos);
          return next;
        });
        commitHistoryEntry();
      }
    } else if (selectedSkeletonId) {
      // For skeletons, calculate center offset
      const skeleton = skeletons.find(s => s.id === selectedSkeletonId);
      if (skeleton) {
        const { points, pointCount } = skeleton.data;
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < pointCount; i++) {
          cx += points[i * 3];
          cy += points[i * 3 + 1];
          cz += points[i * 3 + 2];
        }
        cx /= pointCount;
        cy /= pointCount;
        cz /= pointCount;

        const newPos = { x: -cx, y: -cy, z: -cz };

        startHistoryEntry('skeleton', selectedSkeletonId);
        skeletonPositionsRef.current.set(selectedSkeletonId, newPos);
        setSkeletonPositions(prev => {
          const next = new Map(prev);
          next.set(selectedSkeletonId, newPos);
          return next;
        });
        commitHistoryEntry();
      }
    } else if (selectedIds.size > 0) {
      // For point clouds, calculate translation to move center to origin
      for (const id of selectedIds) {
        startHistoryEntry('cloud', id);
      }

      setEditStates(prev => {
        const next = new Map(prev);
        for (const id of selectedIds) {
          const cloud = clouds.find(c => c.id === id);
          if (cloud) {
            const currentState = next.get(id);
            if (currentState) {
              // Cloud's current center (in original coordinates)
              const center = cloud.data.bounds.center;
              // Current translation
              const currentTrans = currentState.translation;
              // New translation: offset so center + translation = origin
              const newTrans = {
                x: -center.x,
                y: -center.y,
                z: -center.z,
              };
              next.set(id, { ...currentState, translation: newTrans });
            }
          }
        }
        return next;
      });
      setTimeout(commitHistoryEntry, 0);
    }
  }, [selectedIds, selectedMeshId, selectedSkeletonId, meshes, skeletons, clouds, meshPositions, startHistoryEntry, commitHistoryEntry]);

  // Get the target for snap view based on selected object
  const getSnapViewTarget = useCallback(() => {
    // If mesh is selected, compute its bounds
    if (selectedMeshId) {
      const mesh = meshes.find(m => m.id === selectedMeshId);
      if (mesh) {
        const pos = meshPositions.get(selectedMeshId) || { x: 0, y: 0, z: 0 };
        const { vertices, vertexCount } = mesh.data;
        if (vertexCount > 0) {
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (let i = 0; i < vertexCount; i++) {
            const x = vertices[i * 3] + pos.x;
            const y = vertices[i * 3 + 1] + pos.y;
            const z = vertices[i * 3 + 2] + pos.z;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          }
          return {
            center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
            size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ)
          };
        }
      }
    }

    // If skeleton is selected, compute its bounds
    if (selectedSkeletonId) {
      const skeleton = skeletons.find(s => s.id === selectedSkeletonId);
      if (skeleton) {
        const pos = skeletonPositions.get(selectedSkeletonId) || { x: 0, y: 0, z: 0 };
        const { points, pointCount } = skeleton.data;
        if (pointCount > 0) {
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (let i = 0; i < pointCount; i++) {
            const x = points[i * 3] + pos.x;
            const y = points[i * 3 + 1] + pos.y;
            const z = points[i * 3 + 2] + pos.z;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          }
          return {
            center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
            size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ)
          };
        }
      }
    }

    // If point clouds are selected, compute combined bounds
    if (selectedIds.size > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let hasData = false;
      for (const id of selectedIds) {
        const cloud = clouds.find(c => c.id === id);
        if (cloud) {
          const editState = getEditState(id);
          const trans = editState.translation;
          const bounds = cloud.data.bounds;
          minX = Math.min(minX, bounds.min.x + trans.x);
          minY = Math.min(minY, bounds.min.y + trans.y);
          minZ = Math.min(minZ, bounds.min.z + trans.z);
          maxX = Math.max(maxX, bounds.max.x + trans.x);
          maxY = Math.max(maxY, bounds.max.y + trans.y);
          maxZ = Math.max(maxZ, bounds.max.z + trans.z);
          hasData = true;
        }
      }
      if (hasData) {
        return {
          center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
          size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ)
        };
      }
    }

    // No selection - use origin with a default size
    return {
      center: new THREE.Vector3(0, 0, 0),
      size: new THREE.Vector3(2, 2, 2)
    };
  }, [selectedMeshId, selectedSkeletonId, selectedIds, meshes, skeletons, clouds, meshPositions, skeletonPositions, getEditState]);

  // Apply erased points permanently - returns new PointCloudData with points removed and bounds recalculated
  const applyErasedPoints = useCallback((data: PointCloudData, erasedIndices: Set<number>): PointCloudData => {
    if (erasedIndices.size === 0) return data;

    const newPositions: number[] = [];
    const newColors: number[] = [];
    const newIntensities: number[] = [];

    for (let i = 0; i < data.pointCount; i++) {
      if (!erasedIndices.has(i)) {
        const i3 = i * 3;
        newPositions.push(data.positions[i3], data.positions[i3 + 1], data.positions[i3 + 2]);
        if (data.colors) {
          newColors.push(data.colors[i3], data.colors[i3 + 1], data.colors[i3 + 2]);
        }
        if (data.intensities) {
          newIntensities.push(data.intensities[i]);
        }
      }
    }

    const pointCount = newPositions.length / 3;

    // Recalculate bounds
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < pointCount; i++) {
      const i3 = i * 3;
      const x = newPositions[i3], y = newPositions[i3 + 1], z = newPositions[i3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    // Handle empty point cloud
    if (pointCount === 0) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 0;
    }

    return {
      ...data,
      positions: new Float32Array(newPositions),
      colors: data.colors ? new Float32Array(newColors) : undefined,
      intensities: data.intensities ? new Float32Array(newIntensities) : undefined,
      pointCount,
      bounds: {
        min: new THREE.Vector3(minX, minY, minZ),
        max: new THREE.Vector3(maxX, maxY, maxZ),
        center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
        size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ),
      },
    };
  }, []);

  // Get display data for a cloud (with edits applied)
  // showCropPreview: when true, apply crop filtering for preview (used in crop mode)
  const getDisplayData = useCallback((cloud: PointCloudEntry, showCropPreview: boolean = false): PointCloudData => {
    const editState = getEditState(cloud.id);
    const data = cloud.data;

    let positions = data.positions;
    let colors = data.colors;
    let intensities = data.intensities;
    let pointCount = data.pointCount;

    // Apply erasing first (uses original indices)
    if (editState.erasedIndices && editState.erasedIndices.size > 0) {
      const newPositions: number[] = [];
      const newColors: number[] = [];
      const newIntensities: number[] = [];

      for (let i = 0; i < data.pointCount; i++) {
        if (!editState.erasedIndices.has(i)) {
          newPositions.push(data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]);
          if (data.colors) {
            newColors.push(data.colors[i * 3], data.colors[i * 3 + 1], data.colors[i * 3 + 2]);
          }
          if (data.intensities) {
            newIntensities.push(data.intensities[i]);
          }
        }
      }

      pointCount = newPositions.length / 3;
      positions = new Float32Array(newPositions);
      if (data.colors) colors = new Float32Array(newColors);
      if (data.intensities) intensities = new Float32Array(newIntensities);
    }

    // Apply crop preview (when in crop mode)
    // Crop bounds are stored in LOCAL coordinates (relative to untranslated object)
    // This way the crop moves with the object when translated
    // IMPORTANT: Use the already-erased positions/colors/intensities, not original data
    if (showCropPreview && editState.cropMin && editState.cropMax) {
      const newPositions: number[] = [];
      const newColors: number[] = [];
      const newIntensities: number[] = [];

      for (let i = 0; i < pointCount; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];

        const isInside = (
          x >= editState.cropMin.x && x <= editState.cropMax.x &&
          y >= editState.cropMin.y && y <= editState.cropMax.y &&
          z >= editState.cropMin.z && z <= editState.cropMax.z
        );

        const keepPoint = editState.cropInvert ? !isInside : isInside;

        if (keepPoint) {
          newPositions.push(x, y, z);
          if (colors) {
            newColors.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
          }
          if (intensities) {
            newIntensities.push(intensities[i]);
          }
        }
      }

      pointCount = newPositions.length / 3;
      positions = new Float32Array(newPositions);
      if (colors) colors = new Float32Array(newColors);
      if (intensities) intensities = new Float32Array(newIntensities);
    }

    // Apply translation
    if (editState.translation.x !== 0 || editState.translation.y !== 0 || editState.translation.z !== 0) {
      const translatedPositions = new Float32Array(positions.length);
      for (let i = 0; i < pointCount; i++) {
        translatedPositions[i * 3] = positions[i * 3] + editState.translation.x;
        translatedPositions[i * 3 + 1] = positions[i * 3 + 1] + editState.translation.y;
        translatedPositions[i * 3 + 2] = positions[i * 3 + 2] + editState.translation.z;
      }
      positions = translatedPositions;
    }

    // Recalculate bounds
    let min: THREE.Vector3;
    let max: THREE.Vector3;
    let center: THREE.Vector3;
    let size: THREE.Vector3;

    if (pointCount === 0) {
      // Handle empty point cloud - use valid default bounds
      min = new THREE.Vector3(0, 0, 0);
      max = new THREE.Vector3(0, 0, 0);
      center = new THREE.Vector3(0, 0, 0);
      size = new THREE.Vector3(0, 0, 0);
    } else {
      min = new THREE.Vector3(Infinity, Infinity, Infinity);
      max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (let i = 0; i < pointCount; i++) {
        min.x = Math.min(min.x, positions[i * 3]);
        min.y = Math.min(min.y, positions[i * 3 + 1]);
        min.z = Math.min(min.z, positions[i * 3 + 2]);
        max.x = Math.max(max.x, positions[i * 3]);
        max.y = Math.max(max.y, positions[i * 3 + 1]);
        max.z = Math.max(max.z, positions[i * 3 + 2]);
      }
      center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
      size = new THREE.Vector3().subVectors(max, min);
    }

    // Final validation: ensure bounds are always valid (no Infinity or NaN)
    if (!isFinite(min.x) || !isFinite(min.y) || !isFinite(min.z) ||
        !isFinite(max.x) || !isFinite(max.y) || !isFinite(max.z)) {
      console.warn('[getDisplayData] Invalid bounds detected, using defaults');
      min = new THREE.Vector3(0, 0, 0);
      max = new THREE.Vector3(0, 0, 0);
      center = new THREE.Vector3(0, 0, 0);
      size = new THREE.Vector3(0, 0, 0);
    }

    return { positions, colors, intensities, pointCount, bounds: { min, max, center, size }, fileName: data.fileName };
  }, [getEditState]);

  // Helper to download a file
  const downloadFile = useCallback((content: string | Blob, fileName: string) => {
    const blob = content instanceof Blob ? content : new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, []);

  // Export point cloud in various formats
  const exportPointCloud = useCallback(async (format: 'xyz' | 'txt' | 'csv' | 'ply' | 'obj' | 'las' | 'laz') => {
    if (selectedIds.size !== 1) return;
    const id = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === id);
    if (!cloud) return;

    const data = getDisplayData(cloud);
    const baseName = cloud.data.fileName?.replace(/\.[^.]+$/, '') || 'pointcloud';

    // Handle LAZ export via backend (for compression)
    if (format === 'laz') {
      try {
        // Prepare points array for backend
        const points: number[][] = [];
        for (let i = 0; i < data.pointCount; i++) {
          points.push([
            data.positions[i * 3],
            data.positions[i * 3 + 1],
            data.positions[i * 3 + 2]
          ]);
        }

        // Prepare colors array if available
        let colors: number[][] | undefined;
        if (data.colors) {
          colors = [];
          for (let i = 0; i < data.pointCount; i++) {
            colors.push([
              data.colors[i * 3],
              data.colors[i * 3 + 1],
              data.colors[i * 3 + 2]
            ]);
          }
        }

        const response = await exportPointCloudLasLaz({
          points,
          colors,
          format: 'laz',
          filename: `${baseName}.laz`
        });

        if (response.success && response.data) {
          // Decode base64 and download
          const binaryString = atob(response.data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = response.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else {
          console.error('LAZ export failed:', response.error);
          showToast({ title: 'Export Failed', message: response.error || 'Unknown error', type: 'error' });
        }
      } catch (error) {
        console.error('LAZ export failed:', error);
        showToast({ title: 'Export Failed', message: error instanceof Error ? error.message : 'Unknown error', type: 'error' });
      }
      setShowExportPanel(false);
      return;
    }

    if (format === 'xyz') {
      const lines: string[] = [];
      for (let i = 0; i < data.pointCount; i++) {
        const x = data.positions[i * 3].toFixed(6);
        const y = data.positions[i * 3 + 1].toFixed(6);
        const z = data.positions[i * 3 + 2].toFixed(6);
        lines.push(`${x} ${y} ${z}`);
      }
      downloadFile(lines.join('\n'), `${baseName}.xyz`);
    } else if (format === 'txt') {
      // TXT format: space-delimited with header, includes all fields
      const scalarFieldNames = data.scalarFields ? Object.keys(data.scalarFields) : [];
      let header = 'X Y Z';
      if (data.colors) header += ' R G B';
      if (data.intensities) header += ' Intensity';
      for (const fieldName of scalarFieldNames) {
        // Replace spaces with underscores in field names for TXT format
        header += ` ${fieldName.replace(/\s+/g, '_')}`;
      }
      const lines: string[] = [header];

      for (let i = 0; i < data.pointCount; i++) {
        let line = `${data.positions[i * 3].toFixed(6)} ${data.positions[i * 3 + 1].toFixed(6)} ${data.positions[i * 3 + 2].toFixed(6)}`;
        if (data.colors) {
          line += ` ${Math.round(data.colors[i * 3] * 255)} ${Math.round(data.colors[i * 3 + 1] * 255)} ${Math.round(data.colors[i * 3 + 2] * 255)}`;
        }
        if (data.intensities) {
          line += ` ${data.intensities[i].toFixed(4)}`;
        }
        // Add scalar field values
        for (const fieldName of scalarFieldNames) {
          const field = data.scalarFields![fieldName];
          line += ` ${field.values[i]}`;
        }
        lines.push(line);
      }
      downloadFile(lines.join('\n'), `${baseName}.txt`);
    } else if (format === 'csv') {
      // Build header with all available fields
      const scalarFieldNames = data.scalarFields ? Object.keys(data.scalarFields) : [];
      let header = 'X,Y,Z';
      if (data.colors) header += ',R,G,B';
      if (data.intensities) header += ',Intensity';
      for (const fieldName of scalarFieldNames) {
        header += `,${fieldName}`;
      }
      const lines: string[] = [header];

      for (let i = 0; i < data.pointCount; i++) {
        let line = `${data.positions[i * 3].toFixed(6)},${data.positions[i * 3 + 1].toFixed(6)},${data.positions[i * 3 + 2].toFixed(6)}`;
        if (data.colors) {
          line += `,${Math.round(data.colors[i * 3] * 255)},${Math.round(data.colors[i * 3 + 1] * 255)},${Math.round(data.colors[i * 3 + 2] * 255)}`;
        }
        if (data.intensities) {
          line += `,${data.intensities[i].toFixed(4)}`;
        }
        // Add scalar field values
        for (const fieldName of scalarFieldNames) {
          const field = data.scalarFields![fieldName];
          line += `,${field.values[i]}`;
        }
        lines.push(line);
      }
      downloadFile(lines.join('\n'), `${baseName}.csv`);
    } else if (format === 'ply') {
      const hasColors = !!data.colors;
      const lines: string[] = [
        'ply',
        'format ascii 1.0',
        `element vertex ${data.pointCount}`,
        'property float x',
        'property float y',
        'property float z',
      ];
      if (hasColors) {
        lines.push('property uchar red', 'property uchar green', 'property uchar blue');
      }
      lines.push('end_header');
      for (let i = 0; i < data.pointCount; i++) {
        let line = `${data.positions[i * 3].toFixed(6)} ${data.positions[i * 3 + 1].toFixed(6)} ${data.positions[i * 3 + 2].toFixed(6)}`;
        if (hasColors) {
          line += ` ${Math.round(data.colors![i * 3] * 255)} ${Math.round(data.colors![i * 3 + 1] * 255)} ${Math.round(data.colors![i * 3 + 2] * 255)}`;
        }
        lines.push(line);
      }
      downloadFile(lines.join('\n'), `${baseName}.ply`);
    } else if (format === 'obj') {
      const lines: string[] = [`# Point cloud exported from Phytograph`, `# ${data.pointCount} points`];
      for (let i = 0; i < data.pointCount; i++) {
        lines.push(`v ${data.positions[i * 3].toFixed(6)} ${data.positions[i * 3 + 1].toFixed(6)} ${data.positions[i * 3 + 2].toFixed(6)}`);
      }
      downloadFile(lines.join('\n'), `${baseName}.obj`);
    } else if (format === 'las') {
      // Export as LAS 1.2 format (binary)
      const hasColors = !!data.colors;
      const pointFormat = hasColors ? 2 : 0; // Format 2 has RGB, Format 0 is XYZ only
      const pointRecordLength = hasColors ? 26 : 20; // 20 bytes base + 6 for RGB
      const headerSize = 227;
      const pointDataOffset = headerSize;

      // Calculate bounding box and scale factors
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < data.pointCount; i++) {
        const x = data.positions[i * 3];
        const y = data.positions[i * 3 + 1];
        const z = data.positions[i * 3 + 2];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }

      // Use scale to fit coordinates in int32 range
      const scale = 0.0001; // 0.1mm precision
      const offsetX = minX;
      const offsetY = minY;
      const offsetZ = minZ;

      // Create buffer
      const fileSize = headerSize + data.pointCount * pointRecordLength;
      const buffer = new ArrayBuffer(fileSize);
      const view = new DataView(buffer);

      // Write LAS 1.2 header
      let offset = 0;
      // File signature "LASF"
      view.setUint8(offset++, 76); view.setUint8(offset++, 65);
      view.setUint8(offset++, 83); view.setUint8(offset++, 70);
      // File source ID
      view.setUint16(offset, 0, true); offset += 2;
      // Global encoding
      view.setUint16(offset, 0, true); offset += 2;
      // Project ID (GUID) - 16 bytes zeros
      for (let i = 0; i < 16; i++) view.setUint8(offset++, 0);
      // Version major/minor (1.2)
      view.setUint8(offset++, 1);
      view.setUint8(offset++, 2);
      // System identifier (32 bytes)
      const sysId = 'Phytograph';
      for (let i = 0; i < 32; i++) view.setUint8(offset++, i < sysId.length ? sysId.charCodeAt(i) : 0);
      // Generating software (32 bytes)
      const genSw = 'Phytograph Desktop';
      for (let i = 0; i < 32; i++) view.setUint8(offset++, i < genSw.length ? genSw.charCodeAt(i) : 0);
      // Creation day of year
      const now = new Date();
      const start = new Date(now.getFullYear(), 0, 0);
      const dayOfYear = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      view.setUint16(offset, dayOfYear, true); offset += 2;
      // Creation year
      view.setUint16(offset, now.getFullYear(), true); offset += 2;
      // Header size
      view.setUint16(offset, headerSize, true); offset += 2;
      // Offset to point data
      view.setUint32(offset, pointDataOffset, true); offset += 4;
      // Number of variable length records
      view.setUint32(offset, 0, true); offset += 4;
      // Point data format
      view.setUint8(offset++, pointFormat);
      // Point data record length
      view.setUint16(offset, pointRecordLength, true); offset += 2;
      // Number of point records
      view.setUint32(offset, data.pointCount, true); offset += 4;
      // Number of points by return (5 * 4 bytes)
      view.setUint32(offset, data.pointCount, true); offset += 4;
      for (let i = 0; i < 4; i++) { view.setUint32(offset, 0, true); offset += 4; }
      // Scale factors
      view.setFloat64(offset, scale, true); offset += 8;
      view.setFloat64(offset, scale, true); offset += 8;
      view.setFloat64(offset, scale, true); offset += 8;
      // Offsets
      view.setFloat64(offset, offsetX, true); offset += 8;
      view.setFloat64(offset, offsetY, true); offset += 8;
      view.setFloat64(offset, offsetZ, true); offset += 8;
      // Max/Min XYZ
      view.setFloat64(offset, maxX, true); offset += 8;
      view.setFloat64(offset, minX, true); offset += 8;
      view.setFloat64(offset, maxY, true); offset += 8;
      view.setFloat64(offset, minY, true); offset += 8;
      view.setFloat64(offset, maxZ, true); offset += 8;
      view.setFloat64(offset, minZ, true); offset += 8;

      // Write point data
      offset = pointDataOffset;
      for (let i = 0; i < data.pointCount; i++) {
        const x = data.positions[i * 3];
        const y = data.positions[i * 3 + 1];
        const z = data.positions[i * 3 + 2];
        // Scaled coordinates as int32
        view.setInt32(offset, Math.round((x - offsetX) / scale), true); offset += 4;
        view.setInt32(offset, Math.round((y - offsetY) / scale), true); offset += 4;
        view.setInt32(offset, Math.round((z - offsetZ) / scale), true); offset += 4;
        // Intensity (2 bytes)
        const intensity = data.intensities ? Math.round(data.intensities[i] * 65535) : 0;
        view.setUint16(offset, intensity, true); offset += 2;
        // Return info (1 byte)
        view.setUint8(offset++, 0);
        // Classification (1 byte)
        view.setUint8(offset++, 0);
        // Scan angle (1 byte)
        view.setInt8(offset++, 0);
        // User data (1 byte)
        view.setUint8(offset++, 0);
        // Point source ID (2 bytes)
        view.setUint16(offset, 0, true); offset += 2;
        // RGB (if format 2)
        if (hasColors) {
          const r = Math.round(data.colors![i * 3] * 65535);
          const g = Math.round(data.colors![i * 3 + 1] * 65535);
          const b = Math.round(data.colors![i * 3 + 2] * 65535);
          view.setUint16(offset, r, true); offset += 2;
          view.setUint16(offset, g, true); offset += 2;
          view.setUint16(offset, b, true); offset += 2;
        }
      }

      // Download binary file
      const blob = new Blob([buffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}.las`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    setShowExportPanel(false);
  }, [selectedIds, clouds, getDisplayData, downloadFile]);

  // Export mesh in various formats
  const exportMesh = useCallback((meshId: string, format: 'obj' | 'ply' | 'stl') => {
    const mesh = meshes.find(m => m.id === meshId);
    if (!mesh) return;

    const sourceCloud = clouds.find(c => c.id === mesh.sourceCloudId);
    // Use plant name if it's a plant, otherwise use source cloud filename
    const baseName = mesh.isPlant
      ? `${mesh.plantType}_plant_age${mesh.plantAge}`
      : (sourceCloud?.data.fileName?.replace(/\.[^.]+$/, '') || 'mesh');
    const { vertices, indices, normals } = mesh.data;

    if (format === 'obj') {
      const lines: string[] = [`# Mesh exported from Phytograph`, `# ${mesh.data.vertexCount} vertices, ${mesh.data.triangleCount} triangles`];
      if (mesh.isPlant) {
        lines.push(`# Helios Plant: ${mesh.plantType}, Age: ${mesh.plantAge} days`);
      }
      for (let i = 0; i < mesh.data.vertexCount; i++) {
        lines.push(`v ${vertices[i * 3].toFixed(6)} ${vertices[i * 3 + 1].toFixed(6)} ${vertices[i * 3 + 2].toFixed(6)}`);
      }
      if (normals) {
        for (let i = 0; i < mesh.data.vertexCount; i++) {
          lines.push(`vn ${normals[i * 3].toFixed(6)} ${normals[i * 3 + 1].toFixed(6)} ${normals[i * 3 + 2].toFixed(6)}`);
        }
      }
      for (let i = 0; i < mesh.data.triangleCount; i++) {
        const i0 = indices[i * 3] + 1;
        const i1 = indices[i * 3 + 1] + 1;
        const i2 = indices[i * 3 + 2] + 1;
        if (normals) {
          lines.push(`f ${i0}//${i0} ${i1}//${i1} ${i2}//${i2}`);
        } else {
          lines.push(`f ${i0} ${i1} ${i2}`);
        }
      }
      downloadFile(lines.join('\n'), `${baseName}_mesh.obj`);
    } else if (format === 'ply') {
      const lines: string[] = [
        'ply',
        'format ascii 1.0',
        `comment Mesh exported from Phytograph`,
        ...(mesh.isPlant ? [`comment Helios Plant: ${mesh.plantType}, Age: ${mesh.plantAge} days`] : []),
        `element vertex ${mesh.data.vertexCount}`,
        'property float x',
        'property float y',
        'property float z',
        `element face ${mesh.data.triangleCount}`,
        'property list uchar int vertex_indices',
        'end_header',
      ];
      for (let i = 0; i < mesh.data.vertexCount; i++) {
        lines.push(`${vertices[i * 3].toFixed(6)} ${vertices[i * 3 + 1].toFixed(6)} ${vertices[i * 3 + 2].toFixed(6)}`);
      }
      for (let i = 0; i < mesh.data.triangleCount; i++) {
        lines.push(`3 ${indices[i * 3]} ${indices[i * 3 + 1]} ${indices[i * 3 + 2]}`);
      }
      downloadFile(lines.join('\n'), `${baseName}_mesh.ply`);
    } else if (format === 'stl') {
      const lines: string[] = [`solid mesh`];
      for (let i = 0; i < mesh.data.triangleCount; i++) {
        const i0 = indices[i * 3], i1 = indices[i * 3 + 1], i2 = indices[i * 3 + 2];
        const v0 = [vertices[i0 * 3], vertices[i0 * 3 + 1], vertices[i0 * 3 + 2]];
        const v1 = [vertices[i1 * 3], vertices[i1 * 3 + 1], vertices[i1 * 3 + 2]];
        const v2 = [vertices[i2 * 3], vertices[i2 * 3 + 1], vertices[i2 * 3 + 2]];
        // Calculate normal
        const u = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
        const v = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
        const n = [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]];
        const len = Math.sqrt(n[0]*n[0] + n[1]*n[1] + n[2]*n[2]) || 1;
        lines.push(`  facet normal ${(n[0]/len).toFixed(6)} ${(n[1]/len).toFixed(6)} ${(n[2]/len).toFixed(6)}`);
        lines.push(`    outer loop`);
        lines.push(`      vertex ${v0[0].toFixed(6)} ${v0[1].toFixed(6)} ${v0[2].toFixed(6)}`);
        lines.push(`      vertex ${v1[0].toFixed(6)} ${v1[1].toFixed(6)} ${v1[2].toFixed(6)}`);
        lines.push(`      vertex ${v2[0].toFixed(6)} ${v2[1].toFixed(6)} ${v2[2].toFixed(6)}`);
        lines.push(`    endloop`);
        lines.push(`  endfacet`);
      }
      lines.push(`endsolid mesh`);
      downloadFile(lines.join('\n'), `${baseName}_mesh.stl`);
    }

    // For Helios plants, also export the plant structure XML
    if (mesh.isPlant && mesh.heliosXml) {
      // Small delay to ensure browser can handle multiple downloads
      setTimeout(() => {
        downloadFile(mesh.heliosXml!, `${baseName}_helios.xml`);
        showToast({ title: `Exported ${format.toUpperCase()} mesh and Helios XML`, type: 'success' });
      }, 100);
    }

    setShowExportPanel(false);
  }, [meshes, clouds, downloadFile]);

  // Sample mesh to point cloud (Discrete Sample)
  const handleSampleMesh = useCallback(async (meshId: string, density: number) => {
    const mesh = meshes.find(m => m.id === meshId);
    if (!mesh) return;

    setIsSamplingMesh(true);
    setShowSamplingPopup(false);

    try {
      const sourceCloud = clouds.find(c => c.id === mesh.sourceCloudId);
      const baseName = mesh.isPlant
        ? `${mesh.plantType}_plant_sampled`
        : (sourceCloud?.data.fileName?.replace(/\.[^.]+$/, '') || 'mesh') + '_sampled';

      // Get mesh transforms (default to identity if not set)
      const meshPos = meshPositions.get(meshId) || { x: 0, y: 0, z: 0 };
      const meshScale = meshScales.get(meshId) || { x: 1, y: 1, z: 1 };
      const meshRot = meshRotations.get(meshId) || { x: 0, y: 0, z: 0 };

      // Convert rotation from degrees to radians
      const rotX = meshRot.x * Math.PI / 180;
      const rotY = meshRot.y * Math.PI / 180;
      const rotZ = meshRot.z * Math.PI / 180;

      // Precompute rotation matrix components (Euler XYZ order)
      const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);

      // Convert mesh data to format expected by API, applying full transform (scale -> rotate -> translate)
      const vertices: number[][] = [];
      for (let i = 0; i < mesh.data.vertexCount; i++) {
        // Apply scale first
        let x = mesh.data.vertices[i * 3] * meshScale.x;
        let y = mesh.data.vertices[i * 3 + 1] * meshScale.y;
        let z = mesh.data.vertices[i * 3 + 2] * meshScale.z;

        // Apply rotation (Euler XYZ)
        // Rotate around X
        let y1 = y * cosX - z * sinX;
        let z1 = y * sinX + z * cosX;
        // Rotate around Y
        let x2 = x * cosY + z1 * sinY;
        let z2 = -x * sinY + z1 * cosY;
        // Rotate around Z
        let x3 = x2 * cosZ - y1 * sinZ;
        let y3 = x2 * sinZ + y1 * cosZ;

        // Apply translation
        vertices.push([
          x3 + meshPos.x,
          y3 + meshPos.y,
          z2 + meshPos.z,
        ]);
      }

      const triangles: number[][] = [];
      for (let i = 0; i < mesh.data.triangleCount; i++) {
        triangles.push([
          mesh.data.indices[i * 3],
          mesh.data.indices[i * 3 + 1],
          mesh.data.indices[i * 3 + 2],
        ]);
      }

      // Convert vertex colors if present
      let vertexColors: number[][] | undefined;
      if (mesh.data.vertexColors && mesh.data.vertexColors.length > 0) {
        vertexColors = [];
        for (let i = 0; i < mesh.data.vertexCount; i++) {
          vertexColors.push([
            mesh.data.vertexColors[i * 3],
            mesh.data.vertexColors[i * 3 + 1],
            mesh.data.vertexColors[i * 3 + 2],
          ]);
        }
      }

      const response = await sampleMeshSurface({
        vertices,
        triangles,
        vertex_colors: vertexColors,
        density: density,
      });

      if (!response.success || response.points.length === 0) {
        showToast({ title: response.error || 'Sampling returned no points', type: 'error' });
        return;
      }

      // Create point cloud data from response
      const positions = new Float32Array(response.num_points * 3);
      for (let i = 0; i < response.num_points; i++) {
        positions[i * 3] = response.points[i][0];
        positions[i * 3 + 1] = response.points[i][1];
        positions[i * 3 + 2] = response.points[i][2];
      }

      let colors: Float32Array | undefined;
      if (response.colors && response.colors.length > 0) {
        colors = new Float32Array(response.num_points * 3);
        for (let i = 0; i < response.num_points; i++) {
          colors[i * 3] = response.colors[i][0];
          colors[i * 3 + 1] = response.colors[i][1];
          colors[i * 3 + 2] = response.colors[i][2];
        }
      }

      // Calculate bounds
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < response.num_points; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }

      const newCloud: PointCloudEntry = {
        id: `sampled-${Date.now()}`,
        data: {
          positions,
          colors,
          pointCount: response.num_points,
          bounds: {
            min: new THREE.Vector3(minX, minY, minZ),
            max: new THREE.Vector3(maxX, maxY, maxZ),
            center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
            size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ),
          },
          fileName: baseName,
        },
        visible: true,
        color: '#22c55e', // Green for sampled points
      };

      // Add to point clouds
      if (onAddCloud) {
        onAddCloud(newCloud);
        showToast({ title: `Sampled ${response.num_points.toLocaleString()} points from mesh (area: ${response.surface_area.toFixed(4)} m²)`, type: 'success' });
      } else {
        showToast({ title: 'Cannot add point cloud: onAddCloud callback not provided', type: 'error' });
      }

    } catch (error) {
      console.error('Mesh sampling failed:', error);
      showToast({ title: `Sampling failed: ${error instanceof Error ? error.message : 'Unknown error'}`, type: 'error' });
    } finally {
      setIsSamplingMesh(false);
    }
  }, [meshes, clouds, onAddCloud, meshScales, meshPositions, meshRotations]);

  // Export skeleton in various formats
  const exportSkeleton = useCallback((skeletonId: string, format: 'obj' | 'ply' | 'json') => {
    const skeleton = skeletons.find(s => s.id === skeletonId);
    if (!skeleton) return;

    const sourceCloud = clouds.find(c => c.id === skeleton.sourceCloudId);
    const baseName = sourceCloud?.data.fileName?.replace(/\.[^.]+$/, '') || 'skeleton';
    const { points, edges, branchOrders, pointCount, totalLength, diameters } = skeleton.data;

    if (format === 'obj') {
      // Export as cylinder mesh when showAsCylinders is enabled
      if (skeletonShowAsCylinders && edges && edges.length > 0) {
        const lines: string[] = [
          `# Skeleton mesh exported from Phytograph`,
          `# ${pointCount} nodes, ${edges.length} edges`,
          `# Total length: ${totalLength.toFixed(4)}m`,
          `# Exported as cylinder mesh`,
        ];

        const radialSegments = 6;
        let vertexCount = 0;

        // Generate cylinder geometry for each edge
        for (const edge of edges) {
          const [fromIdx, toIdx] = edge;
          if (fromIdx >= pointCount || toIdx >= pointCount) continue;

          const start = {
            x: points[fromIdx * 3],
            y: points[fromIdx * 3 + 1],
            z: points[fromIdx * 3 + 2]
          };
          const end = {
            x: points[toIdx * 3],
            y: points[toIdx * 3 + 1],
            z: points[toIdx * 3 + 2]
          };

          // Direction vector
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const dz = end.z - start.z;
          const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

          if (length < 0.0001) continue;

          // Normalize direction
          const dirX = dx / length;
          const dirY = dy / length;
          const dirZ = dz / length;

          // Find perpendicular vectors
          let upX = 0, upY = 1, upZ = 0;
          if (Math.abs(dirY) >= 0.99) {
            upX = 1; upY = 0; upZ = 0;
          }

          // perp1 = dir x up
          let p1x = dirY * upZ - dirZ * upY;
          let p1y = dirZ * upX - dirX * upZ;
          let p1z = dirX * upY - dirY * upX;
          const p1len = Math.sqrt(p1x * p1x + p1y * p1y + p1z * p1z);
          p1x /= p1len; p1y /= p1len; p1z /= p1len;

          // perp2 = dir x perp1
          const p2x = dirY * p1z - dirZ * p1y;
          const p2y = dirZ * p1x - dirX * p1z;
          const p2z = dirX * p1y - dirY * p1x;

          // Radius
          const radius = diameters
            ? (diameters[fromIdx] + diameters[toIdx]) / 4
            : skeletonTubeRadius;

          // Generate vertices for start and end circles
          for (let ring = 0; ring <= 1; ring++) {
            const center = ring === 0 ? start : end;
            for (let j = 0; j < radialSegments; j++) {
              const angle = (j / radialSegments) * Math.PI * 2;
              const cos = Math.cos(angle);
              const sin = Math.sin(angle);

              const px = center.x + radius * (cos * p1x + sin * p2x);
              const py = center.y + radius * (cos * p1y + sin * p2y);
              const pz = center.z + radius * (cos * p1z + sin * p2z);
              lines.push(`v ${px.toFixed(6)} ${py.toFixed(6)} ${pz.toFixed(6)}`);
            }
          }

          // Generate faces for cylinder
          const startIdx = vertexCount + 1; // OBJ indices are 1-based
          for (let j = 0; j < radialSegments; j++) {
            const j1 = (j + 1) % radialSegments;
            const a = startIdx + j;
            const b = startIdx + j1;
            const c = startIdx + radialSegments + j;
            const d = startIdx + radialSegments + j1;
            // Two triangles per quad
            lines.push(`f ${a} ${c} ${b}`);
            lines.push(`f ${b} ${c} ${d}`);
          }

          vertexCount += radialSegments * 2;
        }

        downloadFile(lines.join('\n'), `${baseName}_skeleton_mesh.obj`);
      } else {
        // Export as points and lines (original behavior)
        const lines: string[] = [
          `# Skeleton exported from Phytograph`,
          `# ${pointCount} nodes, ${edges?.length || 0} edges`,
          `# Total length: ${totalLength.toFixed(4)}m`,
        ];
        for (let i = 0; i < pointCount; i++) {
          lines.push(`v ${points[i * 3].toFixed(6)} ${points[i * 3 + 1].toFixed(6)} ${points[i * 3 + 2].toFixed(6)}`);
        }
        if (edges) {
          for (const [from, to] of edges) {
            lines.push(`l ${from + 1} ${to + 1}`);
          }
        }
        downloadFile(lines.join('\n'), `${baseName}_skeleton.obj`);
      }
    } else if (format === 'ply') {
      const lines: string[] = [
        'ply',
        'format ascii 1.0',
        `element vertex ${pointCount}`,
        'property float x',
        'property float y',
        'property float z',
        ...(branchOrders ? ['property int branch_order'] : []),
        `element edge ${edges?.length || 0}`,
        'property int vertex1',
        'property int vertex2',
        'end_header',
      ];
      for (let i = 0; i < pointCount; i++) {
        let line = `${points[i * 3].toFixed(6)} ${points[i * 3 + 1].toFixed(6)} ${points[i * 3 + 2].toFixed(6)}`;
        if (branchOrders) line += ` ${branchOrders[i] || 1}`;
        lines.push(line);
      }
      if (edges) {
        for (const [from, to] of edges) {
          lines.push(`${from} ${to}`);
        }
      }
      downloadFile(lines.join('\n'), `${baseName}_skeleton.ply`);
    } else if (format === 'json') {
      const data = {
        nodes: Array.from({ length: pointCount }, (_, i) => ({
          x: points[i * 3],
          y: points[i * 3 + 1],
          z: points[i * 3 + 2],
          branchOrder: branchOrders?.[i] || 1,
        })),
        edges: edges || [],
        metadata: {
          totalLength,
          nodeCount: pointCount,
          edgeCount: edges?.length || 0,
          maxBranchOrder: skeleton.data.maxBranchOrder,
        },
      };
      downloadFile(JSON.stringify(data, null, 2), `${baseName}_skeleton.json`);
    }
    setShowExportPanel(false);
  }, [skeletons, clouds, downloadFile, skeletonShowAsCylinders, skeletonTubeRadius]);

  // Triangulate selected point cloud
  const handleTriangulate = useCallback(async () => {
    if (selectedIds.size !== 1) return;
    const id = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === id);
    if (!cloud) return;

    setTriangulationInProgress(true);
    setTriangulationError(null);

    try {
      // Get the display data (with any edits applied)
      const displayData = getDisplayData(cloud);

      // Convert positions to array of [x, y, z] points
      const points: number[][] = [];
      for (let i = 0; i < displayData.pointCount; i++) {
        points.push([
          displayData.positions[i * 3],
          displayData.positions[i * 3 + 1],
          displayData.positions[i * 3 + 2],
        ]);
      }

      // Build triangulation request
      const request: Parameters<typeof triangulatePointCloud>[0] = {
        points,
        method: triangulationMethod,
        estimate_normals: true,
        normal_radius: 0.1,
        normal_max_nn: 30,
      };

      // Add method-specific parameters
      if (triangulationMethod === 'poisson') {
        request.depth = poissonDepth;
      } else if (triangulationMethod === 'alpha_shape' && alphaValue !== null) {
        request.alpha = alphaValue;
      }

      const response = await triangulatePointCloud(request);
      console.log('Triangulation response:', response);

      if (!response.success) {
        throw new Error(response.error || 'Triangulation failed');
      }

      console.log('Converting response data...');
      console.log('Vertices count:', response.vertices?.length, 'sample:', response.vertices?.[0]);
      console.log('Triangles count:', response.triangles?.length, 'sample:', response.triangles?.[0]);

      // Convert response to MeshData
      const vertices = new Float32Array(response.vertices.flat());
      const indices = new Uint32Array(response.triangles.flat());
      const normals = response.normals ? new Float32Array(response.normals.flat()) : undefined;

      console.log('Converted - vertices:', vertices.length, 'indices:', indices.length);

      const meshData: MeshData = {
        vertices,
        indices,
        normals,
        vertexCount: response.num_vertices,
        triangleCount: response.num_triangles,
        surfaceArea: response.surface_area,
      };

      // Create mesh entry
      const meshEntry: MeshEntry = {
        id: crypto.randomUUID(),
        sourceCloudId: cloud.id,
        data: meshData,
        visible: true,
        color: cloud.color,
        method: triangulationMethod,
      };

      // Add to meshes
      console.log('Creating mesh entry:', meshEntry);
      setMeshes(prev => [...prev, meshEntry]);
      setShowTriangulationPanel(false);
      console.log('Triangulation completed successfully!');
      showToast({
        type: 'success',
        title: 'Triangulation Complete',
        message: `Created mesh with ${meshData.triangleCount.toLocaleString()} triangles`,
      });
    } catch (error) {
      console.error('Triangulation error:', error);
      console.error('Error stack:', error instanceof Error ? error.stack : 'No stack');
      const errorMessage = error instanceof Error ? error.message : 'Triangulation failed';
      setTriangulationError(errorMessage);
      showToast({
        type: 'error',
        title: 'Triangulation Failed',
        message: errorMessage,
      });
    } finally {
      setTriangulationInProgress(false);
    }
  }, [selectedIds, clouds, getDisplayData, triangulationMethod, poissonDepth, alphaValue]);

  // Compute Alignment distance statistics
  const handleAlignmentCompute = useCallback(async () => {
    // Need exactly 1 point cloud and 1 mesh selected
    if (selectedIds.size !== 1 || !selectedMeshId) {
      showToast({ type: 'error', title: 'Selection Required', message: 'Select exactly 1 point cloud and 1 mesh for alignment comparison' });
      return;
    }

    const cloudId = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === cloudId);
    const mesh = meshes.find(m => m.id === selectedMeshId);

    if (!cloud || !mesh) {
      showToast({ type: 'error', title: 'Not Found', message: 'Could not find selected point cloud or mesh' });
      return;
    }

    setIsComputingAlignment(true);
    setAlignmentResults(null);

    try {
      // Get the display data for the cloud (with edits applied)
      const displayData = getDisplayData(cloud);

      // Prepare point cloud positions as flat array
      const points: number[] = Array.from(displayData.positions);

      // Get mesh vertices and indices as flat arrays
      const meshVertices: number[] = Array.from(mesh.data.vertices);
      const meshIndices: number[] = Array.from(mesh.data.indices);

      console.log('Alignment computation - points:', points.length / 3, 'vertices:', meshVertices.length / 3, 'triangles:', meshIndices.length / 3);

      const response = await computeAlignmentDistance({
        points,
        mesh_vertices: meshVertices,
        mesh_indices: meshIndices,
      });

      if (!response.success) {
        throw new Error(response.error || 'Alignment computation failed');
      }

      setAlignmentResults(response);
      setShowAlignmentPanel(true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showToast({ type: 'error', title: 'Alignment Failed', message: errorMessage });
      console.error('Alignment computation error:', error);
    } finally {
      setIsComputingAlignment(false);
    }
  }, [selectedIds, selectedMeshId, clouds, meshes, getDisplayData]);

  // ICP (Iterative Closest Point) snap-to-fit - align mesh to point cloud
  const handleICPSnapToFit = useCallback(async () => {
    // Need exactly 1 point cloud and 1 mesh selected
    if (selectedIds.size !== 1 || !selectedMeshId) {
      showToast({ type: 'error', title: 'Selection Required', message: 'Select exactly 1 point cloud and 1 mesh for ICP alignment' });
      return;
    }

    const cloudId = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === cloudId);
    const mesh = meshes.find(m => m.id === selectedMeshId);

    if (!cloud || !mesh) {
      showToast({ type: 'error', title: 'Not Found', message: 'Could not find selected point cloud or mesh' });
      return;
    }

    setIsRunningICP(true);

    try {
      // Get the display data for the cloud (with edits applied)
      const displayData = getDisplayData(cloud);

      // Prepare point cloud positions as flat array (TARGET - stays fixed)
      const points: number[] = Array.from(displayData.positions);

      // Get current mesh position
      const currentPos = meshPositions.get(selectedMeshId) || { x: 0, y: 0, z: 0 };

      // Get mesh vertices and apply current position offset (SOURCE - to be moved)
      const meshVertices: number[] = [];
      for (let i = 0; i < mesh.data.vertexCount; i++) {
        meshVertices.push(mesh.data.vertices[i * 3] + currentPos.x);
        meshVertices.push(mesh.data.vertices[i * 3 + 1] + currentPos.y);
        meshVertices.push(mesh.data.vertices[i * 3 + 2] + currentPos.z);
      }
      const meshIndices: number[] = Array.from(mesh.data.indices);

      console.log('ICP registration - points:', points.length / 3, 'vertices:', meshVertices.length / 3);

      const response = await icpRegisterMeshToCloud({
        points,
        mesh_vertices: meshVertices,
        mesh_indices: meshIndices,
      });

      if (!response.success) {
        throw new Error(response.error || 'ICP registration failed');
      }

      if (response.transformation_matrix && response.transformation_matrix.length === 16) {
        // Apply the full transformation matrix (rotation + translation)
        const m = response.transformation_matrix;

        // Create THREE.Matrix4 from the flat array
        // NumPy flatten() gives row-major data, THREE.Matrix4.set() takes row-major input
        // So they match directly - NO transpose needed
        const matrix = new THREE.Matrix4();
        matrix.set(
          m[0], m[1], m[2], m[3],
          m[4], m[5], m[6], m[7],
          m[8], m[9], m[10], m[11],
          m[12], m[13], m[14], m[15]
        );

        // Extract rotation and translation
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        matrix.decompose(position, quaternion, scale);

        // Convert quaternion to euler angles
        const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');

        // The ICP transformation: T * (v + currentPos) = R*v + R*currentPos + t
        // In rendering: R * v + newPos
        // So: newPos = R * currentPos + t
        const currentPosVec = new THREE.Vector3(currentPos.x, currentPos.y, currentPos.z);
        currentPosVec.applyQuaternion(quaternion);  // R * currentPos

        const newPos = {
          x: currentPosVec.x + position.x,  // R*currentPos + t
          y: currentPosVec.y + position.y,
          z: currentPosVec.z + position.z,
        };

        // Convert radians to degrees since meshRotations stores degrees
        const newRot = {
          x: euler.x * 180 / Math.PI,
          y: euler.y * 180 / Math.PI,
          z: euler.z * 180 / Math.PI,
        };

        meshPositionsRef.current.set(selectedMeshId, newPos);
        setMeshPositions(prev => new Map(prev).set(selectedMeshId, newPos));
        meshRotationsRef.current.set(selectedMeshId, newRot);
        setMeshRotations(prev => new Map(prev).set(selectedMeshId, newRot));

        console.log(`ICP result - position: [${newPos.x.toFixed(4)}, ${newPos.y.toFixed(4)}, ${newPos.z.toFixed(4)}], rotation: [${newRot.x.toFixed(2)}°, ${newRot.y.toFixed(2)}°, ${newRot.z.toFixed(2)}°], fitness: ${response.fitness?.toFixed(4)}, rmse: ${response.rmse?.toFixed(6)}`);

        showToast({
          type: 'success',
          title: 'Snap to Fit Complete',
          message: `Fitness: ${((response.fitness || 0) * 100).toFixed(1)}%, RMSE: ${response.rmse?.toFixed(4) || 'N/A'}`,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showToast({ type: 'error', title: 'ICP Failed', message: errorMessage });
      console.error('ICP registration error:', error);
    } finally {
      setIsRunningICP(false);
    }
  }, [selectedIds, selectedMeshId, clouds, meshes, getDisplayData, meshPositions, setMeshPositions, setMeshRotations]);

  // Handle Cloud-to-Cloud ICP alignment
  const handleCloudToCloudICP = useCallback(async () => {
    // Need exactly 2 point clouds selected
    if (selectedIds.size !== 2) {
      showToast({ type: 'error', title: 'Selection Required', message: 'Select exactly 2 point clouds for cloud-to-cloud alignment' });
      return;
    }

    const cloudIds = Array.from(selectedIds);
    const targetCloud = clouds.find(c => c.id === cloudIds[0]);
    const sourceCloud = clouds.find(c => c.id === cloudIds[1]);

    if (!targetCloud || !sourceCloud) {
      showToast({ type: 'error', title: 'Not Found', message: 'Could not find selected point clouds' });
      return;
    }

    setIsRunningICP(true);

    try {
      // Get display data for both clouds (with edits applied)
      const targetDisplayData = getDisplayData(targetCloud);
      const sourceDisplayData = getDisplayData(sourceCloud);

      // Target cloud positions (stays fixed)
      const targetPoints: number[] = Array.from(targetDisplayData.positions);

      // Get source cloud's current translation
      const sourceState = getEditState(sourceCloud.id);
      const currentTranslation = sourceState.translation;

      // Source cloud positions (already includes translation from getDisplayData)
      const sourcePoints: number[] = Array.from(sourceDisplayData.positions);

      console.log('Cloud-to-cloud ICP - target points:', targetPoints.length / 3, 'source points:', sourcePoints.length / 3);

      const response = await icpRegisterCloudToCloud({
        target_points: targetPoints,
        source_points: sourcePoints,
      });

      if (!response.success) {
        throw new Error(response.error || 'Cloud-to-cloud ICP registration failed');
      }

      if (response.transformation_matrix && response.transformation_matrix.length === 16) {
        // Apply the full transformation matrix (rotation + translation)
        // For point clouds, we bake the transformation into the points by updating the base data
        const m = response.transformation_matrix;

        // Create THREE.Matrix4 from the flat array
        // NumPy flatten() gives row-major data, THREE.Matrix4.set() takes row-major input
        // So they match directly - NO transpose needed
        const matrix = new THREE.Matrix4();
        matrix.set(
          m[0], m[1], m[2], m[3],
          m[4], m[5], m[6], m[7],
          m[8], m[9], m[10], m[11],
          m[12], m[13], m[14], m[15]
        );

        // Extract rotation and translation for logging
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        matrix.decompose(position, quaternion, scale);
        const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');

        // Transform all source cloud positions using the full matrix
        // The source cloud's positions were sent with current translation already baked in
        // So we need to apply the transform to the original positions + current translation
        const sourceState = getEditState(sourceCloud.id);
        const newPositions = new Float32Array(sourceCloud.data.positions.length);
        const point = new THREE.Vector3();

        for (let i = 0; i < sourceCloud.data.positions.length; i += 3) {
          // Get original position + current translation (to match what was sent to ICP)
          point.set(
            sourceCloud.data.positions[i] + sourceState.translation.x,
            sourceCloud.data.positions[i + 1] + sourceState.translation.y,
            sourceCloud.data.positions[i + 2] + sourceState.translation.z
          );
          // Apply the ICP transformation
          point.applyMatrix4(matrix);
          // Store as new absolute position (translation will be reset to 0)
          newPositions[i] = point.x;
          newPositions[i + 1] = point.y;
          newPositions[i + 2] = point.z;
        }

        // Recompute bounds for the transformed positions
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < newPositions.length; i += 3) {
          minX = Math.min(minX, newPositions[i]);
          minY = Math.min(minY, newPositions[i + 1]);
          minZ = Math.min(minZ, newPositions[i + 2]);
          maxX = Math.max(maxX, newPositions[i]);
          maxY = Math.max(maxY, newPositions[i + 1]);
          maxZ = Math.max(maxZ, newPositions[i + 2]);
        }

        // Update the cloud with transformed positions using onUpdateCloud
        const newBounds = {
          min: new THREE.Vector3(minX, minY, minZ),
          max: new THREE.Vector3(maxX, maxY, maxZ),
          center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
          size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ),
        };

        onUpdateCloud(sourceCloud.id, {
          ...sourceCloud.data,
          positions: newPositions,
          bounds: newBounds,
        });

        // Reset translation since positions are now absolute
        setEditStates(prev => {
          const next = new Map(prev);
          const state = next.get(sourceCloud.id) || getEditState(sourceCloud.id);
          next.set(sourceCloud.id, { ...state, translation: { x: 0, y: 0, z: 0 } });
          return next;
        });

        console.log(`Cloud-to-cloud ICP result - position: [${position.x.toFixed(4)}, ${position.y.toFixed(4)}, ${position.z.toFixed(4)}], rotation: [${(euler.x * 180/Math.PI).toFixed(2)}°, ${(euler.y * 180/Math.PI).toFixed(2)}°, ${(euler.z * 180/Math.PI).toFixed(2)}°], fitness: ${response.fitness?.toFixed(4)}, rmse: ${response.rmse?.toFixed(6)}`);

        showToast({
          type: 'success',
          title: 'Cloud Alignment Complete',
          message: `Aligned "${sourceCloud.data.fileName || 'Cloud'}" to "${targetCloud.data.fileName || 'Cloud'}". Fitness: ${((response.fitness || 0) * 100).toFixed(1)}%`,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showToast({ type: 'error', title: 'Cloud-to-Cloud ICP Failed', message: errorMessage });
      console.error('Cloud-to-cloud ICP error:', error);
    } finally {
      setIsRunningICP(false);
    }
  }, [selectedIds, clouds, onUpdateCloud, getDisplayData, getEditState, setEditStates]);

  // Mesh-to-mesh ICP alignment
  const handleMeshToMeshICP = useCallback(async () => {
    // Need exactly 2 meshes selected
    if (selectedMeshIds.size !== 2) {
      showToast({ type: 'error', title: 'Selection Required', message: 'Select exactly 2 meshes for mesh-to-mesh alignment' });
      return;
    }

    const meshIdArray = Array.from(selectedMeshIds);
    const targetMesh = meshes.find(m => m.id === meshIdArray[0]);
    const sourceMesh = meshes.find(m => m.id === meshIdArray[1]);

    if (!targetMesh || !sourceMesh) {
      showToast({ type: 'error', title: 'Not Found', message: 'Could not find selected meshes' });
      return;
    }

    setIsRunningICP(true);

    try {
      // Get current positions for both meshes
      const targetPos = meshPositions.get(targetMesh.id) || { x: 0, y: 0, z: 0 };
      const sourcePos = meshPositions.get(sourceMesh.id) || { x: 0, y: 0, z: 0 };

      // Apply positions to vertices for ICP
      const targetVertices: number[] = [];
      const sourceVertices: number[] = [];

      for (let i = 0; i < targetMesh.data.vertices.length; i += 3) {
        targetVertices.push(
          targetMesh.data.vertices[i] + targetPos.x,
          targetMesh.data.vertices[i + 1] + targetPos.y,
          targetMesh.data.vertices[i + 2] + targetPos.z
        );
      }

      for (let i = 0; i < sourceMesh.data.vertices.length; i += 3) {
        sourceVertices.push(
          sourceMesh.data.vertices[i] + sourcePos.x,
          sourceMesh.data.vertices[i + 1] + sourcePos.y,
          sourceMesh.data.vertices[i + 2] + sourcePos.z
        );
      }

      console.log('Mesh-to-mesh ICP - target vertices:', targetVertices.length / 3, 'source vertices:', sourceVertices.length / 3);

      const response = await icpRegisterMeshToMesh({
        target_vertices: targetVertices,
        target_indices: Array.from(targetMesh.data.indices),
        source_vertices: sourceVertices,
        source_indices: Array.from(sourceMesh.data.indices),
      });

      if (!response.success) {
        throw new Error(response.error || 'Mesh-to-mesh ICP registration failed');
      }

      if (response.transformation_matrix && response.transformation_matrix.length === 16) {
        // Apply the full transformation matrix (rotation + translation)
        const m = response.transformation_matrix;

        // Create THREE.Matrix4 from the flat array
        // NumPy flatten() gives row-major data, THREE.Matrix4.set() takes row-major input
        // So they match directly - NO transpose needed
        const matrix = new THREE.Matrix4();
        matrix.set(
          m[0], m[1], m[2], m[3],
          m[4], m[5], m[6], m[7],
          m[8], m[9], m[10], m[11],
          m[12], m[13], m[14], m[15]
        );

        // Extract rotation and translation
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        matrix.decompose(position, quaternion, scale);

        // Convert quaternion to euler angles
        const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');

        // The ICP transformation: T * (v + sourcePos) = R*v + R*sourcePos + t
        // In rendering: R * v + newPos
        // So: newPos = R * sourcePos + t
        const sourcePosVec = new THREE.Vector3(sourcePos.x, sourcePos.y, sourcePos.z);
        sourcePosVec.applyQuaternion(quaternion);  // R * sourcePos

        const newPos = {
          x: sourcePosVec.x + position.x,  // R*sourcePos + t
          y: sourcePosVec.y + position.y,
          z: sourcePosVec.z + position.z,
        };

        // Convert radians to degrees since meshRotations stores degrees
        const newRot = {
          x: euler.x * 180 / Math.PI,
          y: euler.y * 180 / Math.PI,
          z: euler.z * 180 / Math.PI,
        };

        meshPositionsRef.current.set(sourceMesh.id, newPos);
        setMeshPositions(prev => new Map(prev).set(sourceMesh.id, newPos));
        meshRotationsRef.current.set(sourceMesh.id, newRot);
        setMeshRotations(prev => new Map(prev).set(sourceMesh.id, newRot));

        console.log(`Mesh-to-mesh ICP result - position: [${newPos.x.toFixed(4)}, ${newPos.y.toFixed(4)}, ${newPos.z.toFixed(4)}], rotation: [${newRot.x.toFixed(2)}°, ${newRot.y.toFixed(2)}°, ${newRot.z.toFixed(2)}°], fitness: ${response.fitness?.toFixed(4)}, rmse: ${response.rmse?.toFixed(6)}`);

        // Get display names for meshes
        const targetName = targetMesh.isPlant ? `${targetMesh.plantType} (${targetMesh.plantAge}d)` : 'Mesh 1';
        const sourceName = sourceMesh.isPlant ? `${sourceMesh.plantType} (${sourceMesh.plantAge}d)` : 'Mesh 2';

        showToast({
          type: 'success',
          title: 'Mesh Alignment Complete',
          message: `Aligned "${sourceName}" to "${targetName}". Fitness: ${((response.fitness || 0) * 100).toFixed(1)}%`,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showToast({ type: 'error', title: 'Mesh-to-Mesh ICP Failed', message: errorMessage });
      console.error('Mesh-to-mesh ICP error:', error);
    } finally {
      setIsRunningICP(false);
    }
  }, [selectedMeshIds, meshes, meshPositions, setMeshPositions]);

  // Remove a mesh
  const handleRemoveMesh = useCallback((meshId: string) => {
    setMeshes(prev => prev.filter(m => m.id !== meshId));
  }, []);

  // Toggle mesh visibility
  const handleToggleMeshVisibility = useCallback((meshId: string) => {
    setMeshes(prev => prev.map(m => m.id === meshId ? { ...m, visible: !m.visible } : m));
  }, []);

  // Extract skeleton from selected point cloud
  const handleExtractSkeleton = useCallback(async () => {
    if (selectedIds.size !== 1) return;
    const id = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === id);
    if (!cloud) return;

    setSkeletonInProgress(true);
    setSkeletonError(null);

    try {
      // Get the display data (with any edits applied)
      const displayData = getDisplayData(cloud);

      // Convert positions to array of [x, y, z] points
      // Downsample if too many points (skeleton extraction doesn't need 100K+ points)
      const MAX_SKELETON_POINTS = 20000;
      const totalPoints = displayData.pointCount;
      const skipRate = totalPoints > MAX_SKELETON_POINTS
        ? Math.ceil(totalPoints / MAX_SKELETON_POINTS)
        : 1;

      const points: number[][] = [];
      for (let i = 0; i < totalPoints; i += skipRate) {
        points.push([
          displayData.positions[i * 3],
          displayData.positions[i * 3 + 1],
          displayData.positions[i * 3 + 2],
        ]);
      }

      if (skipRate > 1) {
        console.log(`Downsampled from ${totalPoints} to ${points.length} points (skip rate: ${skipRate})`);
      }

      // Auto-calculate search_radius based on point density if set to 0
      let effectiveSearchRadius = skeletonSearchRadius;
      if (effectiveSearchRadius === 0 || effectiveSearchRadius < 0.001) {
        // Sample points to estimate average nearest neighbor distance
        const sampleSize = Math.min(500, points.length);
        const sampleIndices: number[] = [];
        for (let i = 0; i < sampleSize; i++) {
          sampleIndices.push(Math.floor(Math.random() * points.length));
        }

        let totalMinDist = 0;
        let validSamples = 0;

        for (const idx of sampleIndices) {
          const p = points[idx];
          let minDist = Infinity;

          // Find nearest neighbor (brute force on sample)
          for (let j = 0; j < points.length; j++) {
            if (j === idx) continue;
            const q = points[j];
            const dist = Math.sqrt(
              (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
            );
            if (dist < minDist && dist > 0) {
              minDist = dist;
            }
          }

          if (minDist < Infinity) {
            totalMinDist += minDist;
            validSamples++;
          }
        }

        const avgNNDist = validSamples > 0 ? totalMinDist / validSamples : 0.05;
        // Use 2.5x average NN distance for good graph connectivity
        effectiveSearchRadius = avgNNDist * 2.5;
        console.log(`Auto-calculated search_radius: ${effectiveSearchRadius.toFixed(4)} (avg NN dist: ${avgNNDist.toFixed(4)})`);
      }

      const response = await extractSkeleton({
        points,
        // Pre-processing
        remove_outliers: skeletonRemoveOutliers,
        // Graph building (BFS algorithm)
        search_radius: effectiveSearchRadius,
        root_threshold: skeletonRootThreshold,
        // Quantization
        quantization_levels: skeletonQuantizationLevels,
        use_nonlinear_quantization: skeletonUseNonlinearQuant,
        // Filtering
        threshold_filter: skeletonThresholdFilter,
        use_proportion_filter: skeletonUseProportionFilter,
        proportion_threshold: skeletonProportionThreshold,
        // Smoothing
        smooth_skeleton: skeletonSmooth,
        smoothing_iterations: skeletonSmoothIterations,
      });

      if (!response.success) {
        throw new Error(response.error || 'Skeleton extraction failed');
      }

      // Convert response to SkeletonData
      const skeletonPoints = new Float32Array(response.skeleton_points.flat());

      const skeletonData: SkeletonData = {
        points: skeletonPoints,
        edges: response.skeleton_edges || null,  // BFS algorithm returns edges for branching structure
        branchOrders: response.branch_orders || null,  // Strahler branch order for each node
        maxBranchOrder: response.max_branch_order || 1,
        diameters: null,  // BFS algorithm doesn't compute diameters
        pointCount: response.num_nodes,
        totalLength: response.total_length || 0,
      };

      // Create skeleton entry
      const skeletonEntry: SkeletonEntry = {
        id: crypto.randomUUID(),
        sourceCloudId: cloud.id,
        data: skeletonData,
        visible: true,
        color: '#f59e0b',  // Amber color for skeleton
      };

      setSkeletons(prev => [...prev, skeletonEntry]);
      setShowSkeletonPanel(false);
      showToast({
        type: 'success',
        title: 'Skeleton Extracted',
        message: `Length: ${skeletonData.totalLength.toFixed(2)}m, ${skeletonData.pointCount} points`,
      });
    } catch (error) {
      console.error('Skeleton extraction error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Skeleton extraction failed';
      setSkeletonError(errorMessage);
      showToast({
        type: 'error',
        title: 'Skeleton Extraction Failed',
        message: errorMessage,
      });
    } finally {
      setSkeletonInProgress(false);
    }
  }, [selectedIds, clouds, getDisplayData, skeletonRemoveOutliers, skeletonSearchRadius, skeletonRootThreshold, skeletonQuantizationLevels, skeletonUseNonlinearQuant, skeletonThresholdFilter, skeletonUseProportionFilter, skeletonProportionThreshold, skeletonSmooth, skeletonSmoothIterations]);

  // Remove a skeleton
  const handleRemoveSkeleton = useCallback((skeletonId: string) => {
    setSkeletons(prev => prev.filter(s => s.id !== skeletonId));
  }, []);

  // Confirm and execute deletion
  const handleConfirmDelete = useCallback(() => {
    if (!deleteConfirm) return;

    if (deleteConfirm.type === 'mesh') {
      handleRemoveMesh(deleteConfirm.id);
      if (selectedMeshIds.has(deleteConfirm.id)) {
        setSelectedMeshIds(prev => {
          const newSet = new Set(prev);
          newSet.delete(deleteConfirm.id);
          return newSet;
        });
      }
    } else if (deleteConfirm.type === 'skeleton') {
      handleRemoveSkeleton(deleteConfirm.id);
      if (selectedSkeletonId === deleteConfirm.id) {
        setSelectedSkeletonId(null);
      }
    } else if (deleteConfirm.type === 'cloud') {
      onRemoveCloud(deleteConfirm.id);
    }

    setDeleteConfirm(null);
  }, [deleteConfirm, handleRemoveMesh, handleRemoveSkeleton, onRemoveCloud, selectedMeshId, selectedSkeletonId]);

  // Toggle skeleton visibility
  const handleToggleSkeletonVisibility = useCallback((skeletonId: string) => {
    setSkeletons(prev => prev.map(s => s.id === skeletonId ? { ...s, visible: !s.visible } : s));
  }, []);

  // Select a mesh (shift-click for multi-select, clears skeleton selection)
  const handleSelectMesh = useCallback((meshId: string) => {
    setSelectedMeshIds(prev => {
      const newSet = new Set(prev);
      if (isShiftHeldRef.current) {
        // Shift held: toggle mesh in selection (multi-select)
        if (newSet.has(meshId)) {
          newSet.delete(meshId);
        } else {
          newSet.add(meshId);
        }
      } else {
        // No shift: single select (toggle or replace)
        if (newSet.size === 1 && newSet.has(meshId)) {
          // Clicking same mesh deselects it
          newSet.clear();
        } else {
          // Select only this mesh
          newSet.clear();
          newSet.add(meshId);
        }
        // Only clear cloud selection when not holding shift
        onDeselectAll();
      }
      return newSet;
    });
    setSelectedSkeletonId(null);
  }, [onDeselectAll]);

  // Select a skeleton (clears point cloud and mesh selection)
  const handleSelectSkeleton = useCallback((skeletonId: string) => {
    setSelectedSkeletonId(prev => prev === skeletonId ? null : skeletonId);
    setSelectedMeshIds(new Set());
    onDeselectAll(); // Clear point cloud selection
  }, [onDeselectAll]);

  // Clear mesh/skeleton selection when point cloud is selected (unless shift held for mixed selection)
  useEffect(() => {
    if (selectedIds.size > 0 && !isShiftHeldRef.current) {
      setSelectedMeshIds(new Set());
      setSelectedSkeletonId(null);
    }
  }, [selectedIds]);

  // Get selected mesh and skeleton objects
  // For single mesh selection, get the first (or only) selected mesh
  const selectedMesh = useMemo(() => {
    if (selectedMeshIds.size === 0) return null;
    const firstId = Array.from(selectedMeshIds)[0];
    return meshes.find(m => m.id === firstId) || null;
  }, [meshes, selectedMeshIds]);

  const selectedSkeleton = useMemo(() => {
    return skeletons.find(s => s.id === selectedSkeletonId) || null;
  }, [skeletons, selectedSkeletonId]);

  // Determine what type of object is selected
  const selectionType = useMemo((): 'cloud' | 'multiCloud' | 'mesh' | 'multiMesh' | 'skeleton' | 'mixed' | 'none' => {
    const hasCloud = selectedIds.size > 0;
    const hasMultipleClouds = selectedIds.size >= 2;
    const hasMesh = selectedMeshIds.size > 0;
    const hasMultipleMeshes = selectedMeshIds.size >= 2;
    const hasSkeleton = !!selectedSkeletonId;

    // Mixed selection (cloud + mesh) for alignment comparison
    if (hasCloud && hasMesh) return 'mixed';
    // Multiple clouds selected for cloud-to-cloud alignment
    if (hasMultipleClouds) return 'multiCloud';
    // Multiple meshes selected for mesh-to-mesh alignment
    if (hasMultipleMeshes) return 'multiMesh';
    if (hasCloud) return 'cloud';
    if (hasMesh) return 'mesh';
    if (hasSkeleton) return 'skeleton';
    return 'none';
  }, [selectedIds, selectedMeshIds, selectedSkeletonId]);

  // Live alignment computation - automatically compute when mesh moves in mixed mode
  useEffect(() => {
    // Only run in mixed selection mode with live alignment enabled
    if (selectionType !== 'mixed' || !liveAlignmentEnabled || selectedIds.size !== 1 || !selectedMeshId) {
      return;
    }

    const cloudId = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === cloudId);
    const mesh = meshes.find(m => m.id === selectedMeshId);

    if (!cloud || !mesh) return;

    // Get current mesh position
    const meshPos = meshPositions.get(selectedMeshId) || { x: 0, y: 0, z: 0 };
    const posKey = `${meshPos.x.toFixed(3)},${meshPos.y.toFixed(3)},${meshPos.z.toFixed(3)}`;

    // Skip if position hasn't changed
    if (posKey === lastMeshPositionRef.current) return;
    lastMeshPositionRef.current = posKey;

    // Clear previous timer
    if (alignmentDebounceTimerRef.current) {
      clearTimeout(alignmentDebounceTimerRef.current);
    }

    // Debounce the alignment computation (300ms delay)
    alignmentDebounceTimerRef.current = setTimeout(async () => {
      // Don't start if already computing
      if (isComputingAlignment) return;

      setIsComputingAlignment(true);
      try {
        // Get the display data for the cloud (with edits applied)
        const displayData = getDisplayData(cloud);

        // Prepare point cloud positions as flat array
        const points: number[] = Array.from(displayData.positions);

        // Get mesh vertices and apply current position offset
        const meshVertices: number[] = [];
        for (let i = 0; i < mesh.data.vertexCount; i++) {
          meshVertices.push(mesh.data.vertices[i * 3] + meshPos.x);
          meshVertices.push(mesh.data.vertices[i * 3 + 1] + meshPos.y);
          meshVertices.push(mesh.data.vertices[i * 3 + 2] + meshPos.z);
        }
        const meshIndices: number[] = Array.from(mesh.data.indices);

        const response = await computeAlignmentDistance({
          points,
          mesh_vertices: meshVertices,
          mesh_indices: meshIndices,
        });

        if (response.success) {
          setAlignmentResults(response);
        }
      } catch (error) {
        console.error('Live alignment computation error:', error);
      } finally {
        setIsComputingAlignment(false);
      }
    }, 300);

    // Cleanup timer on unmount
    return () => {
      if (alignmentDebounceTimerRef.current) {
        clearTimeout(alignmentDebounceTimerRef.current);
      }
    };
  }, [selectionType, liveAlignmentEnabled, selectedIds, selectedMeshId, meshPositions, clouds, meshes, getDisplayData, isComputingAlignment]);

  // Compute selected object's center coordinates for the info panel
  const selectedObjectCenter = useMemo(() => {
    // Mesh selected
    if (selectedMeshId) {
      const mesh = meshes.find(m => m.id === selectedMeshId);
      if (mesh) {
        const pos = meshPositions.get(selectedMeshId) || { x: 0, y: 0, z: 0 };
        const { vertices, vertexCount } = mesh.data;
        if (vertexCount > 0) {
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (let i = 0; i < vertexCount; i++) {
            const x = vertices[i * 3] + pos.x;
            const y = vertices[i * 3 + 1] + pos.y;
            const z = vertices[i * 3 + 2] + pos.z;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          }
          return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
        }
      }
    }

    // Skeleton selected
    if (selectedSkeletonId) {
      const skeleton = skeletons.find(s => s.id === selectedSkeletonId);
      if (skeleton) {
        const pos = skeletonPositions.get(selectedSkeletonId) || { x: 0, y: 0, z: 0 };
        const { points, pointCount } = skeleton.data;
        if (pointCount > 0) {
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (let i = 0; i < pointCount; i++) {
            const x = points[i * 3] + pos.x;
            const y = points[i * 3 + 1] + pos.y;
            const z = points[i * 3 + 2] + pos.z;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          }
          return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
        }
      }
    }

    // Point cloud(s) selected
    if (selectedIds.size > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let hasData = false;
      for (const id of selectedIds) {
        const cloud = clouds.find(c => c.id === id);
        if (cloud) {
          const editState = getEditState(id);
          const trans = editState.translation;
          const bounds = cloud.data.bounds;
          minX = Math.min(minX, bounds.min.x + trans.x);
          minY = Math.min(minY, bounds.min.y + trans.y);
          minZ = Math.min(minZ, bounds.min.z + trans.z);
          maxX = Math.max(maxX, bounds.max.x + trans.x);
          maxY = Math.max(maxY, bounds.max.y + trans.y);
          maxZ = Math.max(maxZ, bounds.max.z + trans.z);
          hasData = true;
        }
      }
      if (hasData) {
        return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
      }
    }

    return null;
  }, [selectedMeshId, selectedSkeletonId, selectedIds, meshes, skeletons, clouds, meshPositions, skeletonPositions, getEditState]);

  // Compute selected mesh info (type, dimensions) for the info panel
  // Smart number formatting - fewer decimals for larger numbers
  const smartFormat = (n: number): string => {
    const abs = Math.abs(n);
    if (abs >= 100) return n.toFixed(1);
    if (abs >= 10) return n.toFixed(2);
    if (abs >= 1) return n.toFixed(2);
    if (abs >= 0.1) return n.toFixed(3);
    return n.toFixed(4);
  };

  const selectedMeshInfo = useMemo(() => {
    if (!selectedMeshId) return null;

    const mesh = meshes.find(m => m.id === selectedMeshId);
    if (!mesh) return null;

    const pos = meshPositions.get(selectedMeshId) || { x: 0, y: 0, z: 0 };
    const scale = meshScales.get(selectedMeshId) || { x: 1, y: 1, z: 1 };
    const { vertices, vertexCount } = mesh.data;

    // Calculate bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      const x = vertices[i * 3] * scale.x + pos.x;
      const y = vertices[i * 3 + 1] * scale.y + pos.y;
      const z = vertices[i * 3 + 2] * scale.z + pos.z;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }

    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;

    // Determine type and shape-specific dimensions
    let type = 'Mesh';
    let dimensions = '';

    if (mesh.isPlant) {
      type = mesh.plantType ? mesh.plantType.charAt(0).toUpperCase() + mesh.plantType.slice(1) : 'Plant';
      dimensions = `${mesh.plantAge}d (${smartFormat(Math.max(sizeX, sizeY))}×${smartFormat(sizeZ)})`;
    } else if (mesh.sourceCloudId.startsWith('shape-')) {
      const shapeMatch = mesh.sourceCloudId.match(/shape-(\w+)-/);
      const shapeType = shapeMatch ? shapeMatch[1] : 'unknown';

      switch (shapeType) {
        case 'cone':
          type = 'Cone';
          const coneRadius = Math.max(sizeX, sizeY) / 2;
          dimensions = `(r,h): (${smartFormat(coneRadius)},${smartFormat(sizeZ)})`;
          break;
        case 'cylinder':
          type = 'Cylinder';
          const cylRadius = Math.max(sizeX, sizeY) / 2;
          dimensions = `(r,h): (${smartFormat(cylRadius)},${smartFormat(sizeZ)})`;
          break;
        case 'sphere':
          type = 'Sphere';
          const sphereRadius = Math.max(sizeX, sizeY, sizeZ) / 2;
          dimensions = `(r): ${smartFormat(sphereRadius)}`;
          break;
        case 'voxel':
          type = 'Voxel';
          dimensions = `(w,d,h): (${smartFormat(sizeX)},${smartFormat(sizeY)},${smartFormat(sizeZ)})`;
          break;
        default:
          type = shapeType.charAt(0).toUpperCase() + shapeType.slice(1);
          dimensions = `(w,d,h): (${smartFormat(sizeX)},${smartFormat(sizeY)},${smartFormat(sizeZ)})`;
      }
    } else {
      // Regular mesh from triangulation
      dimensions = `(w,d,h): (${smartFormat(sizeX)},${smartFormat(sizeY)},${smartFormat(sizeZ)})`;
    }

    return { type, dimensions };
  }, [selectedMeshId, meshes, meshPositions, meshScales]);

  // Generate mesh data from shape type with default unit size
  const generateShapeMesh = useCallback((shapeType: ShapeType): MeshData => {
    let geometry: THREE.BufferGeometry;
    const segments = 32;

    switch (shapeType) {
      case 'voxel':
        // Unit cube
        geometry = new THREE.BoxGeometry(1, 1, 1);
        break;
      case 'sphere':
        // Unit sphere (radius 0.5, diameter 1)
        geometry = new THREE.SphereGeometry(0.5, segments, segments / 2);
        break;
      case 'cylinder':
        // Unit cylinder (radius 0.5, height 1), rotated so flat side is down (Z-up)
        geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, segments, 1);
        geometry.rotateX(-Math.PI / 2);
        break;
      case 'cone':
        // Unit cone (base radius 0.5, height 1), rotated so flat side is down (Z-up)
        geometry = new THREE.CylinderGeometry(0, 0.5, 1, segments, 1);
        geometry.rotateX(-Math.PI / 2);
        break;
      default:
        geometry = new THREE.BoxGeometry(1, 1, 1);
    }

    // Ensure geometry has non-indexed buffer
    const nonIndexedGeometry = geometry.toNonIndexed ? geometry.toNonIndexed() : geometry;
    nonIndexedGeometry.computeVertexNormals();

    // Extract vertices and create indices
    const positionAttr = nonIndexedGeometry.getAttribute('position') as THREE.BufferAttribute;
    const normalAttr = nonIndexedGeometry.getAttribute('normal') as THREE.BufferAttribute;

    const vertexCount = positionAttr.count;
    const vertices = new Float32Array(positionAttr.array);
    const normals = normalAttr ? new Float32Array(normalAttr.array) : undefined;

    // Create triangle indices (for non-indexed geometry, just sequential)
    const triangleCount = Math.floor(vertexCount / 3);
    const indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      indices[i] = i;
    }

    geometry.dispose();
    nonIndexedGeometry.dispose();

    return {
      vertices,
      indices,
      normals,
      vertexCount,
      triangleCount,
    };
  }, []);

  // Handle creating a new shape - takes type, auto-selects, shows resize panel
  const handleCreateShape = useCallback((shapeType: ShapeType) => {
    const meshData = generateShapeMesh(shapeType);

    const shapeColors: Record<ShapeType, string> = {
      voxel: '#60a5fa', // blue
      cylinder: '#4ade80', // green
      sphere: '#f472b6', // pink
      cone: '#fbbf24', // amber
    };

    const newMeshId = crypto.randomUUID();
    const newMesh: MeshEntry = {
      id: newMeshId,
      sourceCloudId: `shape-${shapeType}-${shapeCounter}`, // Use a synthetic ID
      data: meshData,
      visible: true,
      color: shapeColors[shapeType],
      method: 'delaunay', // Just a placeholder since shapes aren't from triangulation
    };

    setMeshes(prev => [...prev, newMesh]);
    setShapeCounter(prev => prev + 1);

    // Initialize scale for this mesh
    // Initialize transforms for this mesh
    setMeshScales(prev => {
      const next = new Map(prev);
      next.set(newMeshId, { x: 1, y: 1, z: 1 });
      return next;
    });
    setMeshPositions(prev => {
      const next = new Map(prev);
      next.set(newMeshId, { x: 0, y: 0, z: 0 });
      return next;
    });
    setMeshRotations(prev => {
      const next = new Map(prev);
      next.set(newMeshId, { x: 0, y: 0, z: 0 });
      return next;
    });

    // Auto-select the new mesh and show resize panel
    setSelectedMeshIds(new Set([newMeshId]));
    setSelectedSkeletonId(null);
    onDeselectAll(); // Clear point cloud selection
    setShowResizePanel(true);

    // Reset camera to fit new bounds after state updates
    setTimeout(() => {
      (window as any).__resetPointCloudCamera?.();
    }, 50);
  }, [shapeCounter, generateShapeMesh, onDeselectAll]);

  // Handle Helios triangulation as a background task with cancel support
  const handleHeliosTriangulate = useCallback(async (request: HeliosTriangulationRequest) => {
    if (isHeliosRunning) return;

    const abort = new AbortController();
    heliosAbortRef.current = abort;
    setIsHeliosRunning(true);

    try {
      const response = await heliosTriangulate(request, abort.signal);

      if (abort.signal.aborted) return;

      if (!response.success) {
        showToast({ type: 'error', title: 'Helios Triangulation Failed', message: response.error || 'Unknown error' });
        return;
      }

      // Process result into mesh
      const vertices = new Float32Array(response.vertices.flat());
      const indices = new Uint32Array(response.triangles.flat());
      const vertexColors = response.colors ? new Float32Array(response.colors.flat()) : undefined;

      // Compute per-vertex normals from indexed mesh geometry
      let normals: Float32Array | undefined;
      if (response.normals && response.normals.length === response.num_vertices) {
        normals = new Float32Array(response.normals.flat());
      } else {
        normals = new Float32Array(response.num_vertices * 3);
        for (let t = 0; t < response.num_triangles; t++) {
          const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
          const ax = vertices[i1 * 3] - vertices[i0 * 3];
          const ay = vertices[i1 * 3 + 1] - vertices[i0 * 3 + 1];
          const az = vertices[i1 * 3 + 2] - vertices[i0 * 3 + 2];
          const bx = vertices[i2 * 3] - vertices[i0 * 3];
          const by = vertices[i2 * 3 + 1] - vertices[i0 * 3 + 1];
          const bz = vertices[i2 * 3 + 2] - vertices[i0 * 3 + 2];
          const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
          for (const vi of [i0, i1, i2]) {
            normals[vi * 3] += nx;
            normals[vi * 3 + 1] += ny;
            normals[vi * 3 + 2] += nz;
          }
        }
        for (let i = 0; i < response.num_vertices; i++) {
          const vi = i * 3;
          const len = Math.sqrt(normals[vi] ** 2 + normals[vi + 1] ** 2 + normals[vi + 2] ** 2);
          if (len > 1e-10) { normals[vi] /= len; normals[vi + 1] /= len; normals[vi + 2] /= len; }
        }
      }

      const meshData: MeshData = {
        vertices,
        indices,
        normals,
        vertexColors,
        vertexCount: response.num_vertices,
        triangleCount: response.num_triangles,
        surfaceArea: response.surface_area,
      };

      const meshEntry: MeshEntry = {
        id: crypto.randomUUID(),
        sourceCloudId: 'helios',
        data: meshData,
        visible: true,
        color: '#22c55e',
        method: 'helios',
      };

      setMeshes(prev => [...prev, meshEntry]);
      setShowTriangulationPanel(false);
      showToast({
        type: 'success',
        title: 'Helios Triangulation Complete',
        message: `Created mesh with ${meshData.triangleCount.toLocaleString()} triangles`,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      showToast({
        type: 'error',
        title: 'Helios Triangulation Failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsHeliosRunning(false);
      heliosAbortRef.current = null;
    }
  }, [isHeliosRunning]);

  const cancelHeliosTriangulation = useCallback(() => {
    heliosAbortRef.current?.abort();
    setIsHeliosRunning(false);
    heliosAbortRef.current = null;
  }, []);

  // Handle creating a plant model from pyhelios PlantArchitecture
  // Uses session-based approach to enable consistent plants across age steps
  const handleCreatePlant = useCallback(async (request: PlantGenerationRequest) => {
    if (isGeneratingPlant) return;

    setIsGeneratingPlant(true);
    setShowPlantPopup(false); // Close popup when generation starts

    try {
      // Create a plant session for consistent age stepping
      const sessionResponse = await createPlantSession({
        plant_type: request.plant_type,
        initial_age: request.age,
        position_x: request.position_x ?? 0,
        position_y: request.position_y ?? 0,
        position_z: request.position_z ?? 0,
      });

      let sessionId: string | undefined;
      let response;

      if (sessionResponse.success && sessionResponse.session_id) {
        sessionId = sessionResponse.session_id;
        console.log(`[Plant] Created session ${sessionId} for consistent age stepping`);

        // Get geometry by advancing 0 days
        const advanceResponse = await advancePlantSession(sessionId, 0);
        if (advanceResponse.success) {
          // Convert session response format to plant generation response format
          response = {
            success: true,
            vertices: advanceResponse.vertices,
            indices: advanceResponse.indices,
            colors: advanceResponse.colors,
            vertex_count: advanceResponse.vertex_count,
            triangle_count: advanceResponse.triangle_count,
            plant_type: request.plant_type,
            age: advanceResponse.current_age,
            height: advanceResponse.height,
            // Session doesn't return these - leave undefined
            normals: undefined as number[][] | undefined,
            uv_coordinates: undefined as number[][] | undefined,
            materials: undefined,
            material_groups: undefined,
            textures: undefined,
            helios_xml: sessionResponse.helios_xml,
          };
        } else {
          console.warn('[Plant] Session advance failed, falling back to stateless:', advanceResponse.error);
          sessionId = undefined;
          response = await generatePlantModel(request);
        }
      } else {
        console.warn('[Plant] Session creation failed, falling back to stateless:', sessionResponse.error);
        response = await generatePlantModel(request);
      }

      if (!response.success) {
        showToast({ title: response.error || 'Plant generation failed', type: 'error' });
        return;
      }

      // Debug: Log response data
      console.log('[Plant] Response received:', {
        vertex_count: response.vertex_count,
        triangle_count: response.triangle_count,
        has_colors: response.colors?.length || 0,
        has_uvs: response.uv_coordinates?.length || 0,
        materials: response.materials?.length || 0,
        textures: Object.keys(response.textures || {}).length,
      });

      // Convert response data to MeshData format
      // Flatten vertices array and create Float32Array
      const vertices = new Float32Array(response.vertex_count * 3);
      for (let i = 0; i < response.vertex_count; i++) {
        vertices[i * 3] = response.vertices[i][0];
        vertices[i * 3 + 1] = response.vertices[i][1];
        vertices[i * 3 + 2] = response.vertices[i][2];
      }

      // Flatten indices array and create Uint32Array
      const indices = new Uint32Array(response.triangle_count * 3);
      for (let i = 0; i < response.triangle_count; i++) {
        indices[i * 3] = response.indices[i][0];
        indices[i * 3 + 1] = response.indices[i][1];
        indices[i * 3 + 2] = response.indices[i][2];
      }

      // Flatten normals if available
      let normals: Float32Array | undefined;
      if (response.normals && response.normals.length > 0) {
        normals = new Float32Array(response.normals.length * 3);
        for (let i = 0; i < response.normals.length; i++) {
          normals[i * 3] = response.normals[i][0];
          normals[i * 3 + 1] = response.normals[i][1];
          normals[i * 3 + 2] = response.normals[i][2];
        }
      }

      // Flatten vertex colors if available (from Helios organ coloring)
      let vertexColors: Float32Array | undefined;
      if (response.colors && response.colors.length > 0) {
        vertexColors = new Float32Array(response.colors.length * 3);
        for (let i = 0; i < response.colors.length; i++) {
          vertexColors[i * 3] = response.colors[i][0];
          vertexColors[i * 3 + 1] = response.colors[i][1];
          vertexColors[i * 3 + 2] = response.colors[i][2];
        }
      }

      // Flatten UV coordinates if available (for textures)
      let uvCoordinates: Float32Array | undefined;
      if (response.uv_coordinates && response.uv_coordinates.length > 0) {
        uvCoordinates = new Float32Array(response.uv_coordinates.length * 2);
        for (let i = 0; i < response.uv_coordinates.length; i++) {
          uvCoordinates[i * 2] = response.uv_coordinates[i][0];
          uvCoordinates[i * 2 + 1] = response.uv_coordinates[i][1];
        }
      }

      // Process materials and textures
      let plantMaterials: PlantMaterialDef[] | undefined;
      if (response.materials && response.material_groups) {
        plantMaterials = response.materials.map((mat) => {
          // Find the material group for this material
          const group = response.material_groups?.find(g => g.material_name === mat.name);
          const triangleIndices = group?.triangle_indices || [];

          // Get texture data if material has a texture
          const textureData = mat.texture_name && response.textures
            ? response.textures[mat.texture_name]
            : undefined;

          return {
            name: mat.name,
            color: mat.color as [number, number, number] | undefined,
            textureData,
            hasAlpha: mat.has_alpha,
            triangleIndices,
          };
        });
        console.log(`[Plant] Processed ${plantMaterials.length} materials, ${plantMaterials.filter(m => m.textureData).length} with textures`);
      }

      const meshData: MeshData = {
        vertices,
        indices,
        normals,
        vertexColors,
        uvCoordinates,
        vertexCount: response.vertex_count,
        triangleCount: response.triangle_count,
      };

      const newMeshId = crypto.randomUUID();
      // Generate a random seed if not provided, for reproducible regeneration
      const seed = request.random_seed ?? Math.floor(Math.random() * 1000000);
      const newMesh: MeshEntry = {
        id: newMeshId,
        sourceCloudId: `plant-${response.plant_type}-${shapeCounter}`,
        data: meshData,
        visible: true,
        color: '#22c55e', // green color for plants
        method: 'delaunay', // Placeholder
        // Plant-specific metadata for Helios export
        isPlant: true,
        plantType: response.plant_type,
        plantAge: response.age,
        plantPosition: { x: request.position_x ?? 0, y: request.position_y ?? 0, z: request.position_z ?? 0 },
        plantSeed: seed,
        plantSessionId: sessionId, // Session ID for consistent age stepping
        regenerationKey: 0, // Counter for forcing React remount on age change
        heliosXml: response.helios_xml,
        plantMaterials,
      };

      // Debug: Log mesh data before adding
      console.log('[Plant] MeshData created:', {
        vertices: meshData.vertices.length,
        indices: meshData.indices.length,
        vertexColors: meshData.vertexColors?.length || 0,
        uvCoordinates: meshData.uvCoordinates?.length || 0,
        vertexCount: meshData.vertexCount,
        triangleCount: meshData.triangleCount,
        plantMaterials: plantMaterials?.length || 0,
        sampleVertex: [meshData.vertices[0], meshData.vertices[1], meshData.vertices[2]],
        sampleIndex: [meshData.indices[0], meshData.indices[1], meshData.indices[2]],
      });

      setMeshes(prev => [...prev, newMesh]);
      setShapeCounter(prev => prev + 1);
      console.log('[Plant] Mesh added to state');

      // Initialize transforms for this mesh
      setMeshScales(prev => {
        const next = new Map(prev);
        next.set(newMeshId, { x: 1, y: 1, z: 1 });
        return next;
      });
      setMeshPositions(prev => {
        const next = new Map(prev);
        next.set(newMeshId, { x: 0, y: 0, z: 0 });
        return next;
      });
      setMeshRotations(prev => {
        const next = new Map(prev);
        next.set(newMeshId, { x: 0, y: 0, z: 0 });
        return next;
      });

      // Auto-select the new mesh
      setSelectedMeshIds(new Set([newMeshId]));
      setSelectedSkeletonId(null);
      onDeselectAll();

      // Reset camera to fit the new plant mesh
      setTimeout(() => {
        (window as any).__resetPointCloudCamera?.();
      }, 50);

      console.log(`[Plant] Created plant mesh ${newMeshId} with seed ${seed}${sessionId ? `, session ${sessionId}` : ' (no session)'}`);
      if (sessionId) {
        console.log('[Plant] Session-based age stepping is enabled for this plant');
      }

    } catch (error) {
      console.error('Plant generation failed:', error);
      showToast({ title: `Plant generation failed: ${error}`, type: 'error' });
    } finally {
      setIsGeneratingPlant(false);
    }
  }, [isGeneratingPlant, shapeCounter, onDeselectAll]);

  // Handle morphing a plant with modified parameters
  const handleMorphPlant = useCallback(async (request: PlantMorphRequest) => {
    // Find the selected plant mesh
    const selectedMeshId = Array.from(selectedMeshIds)[0];
    const mesh = meshes.find(m => m.id === selectedMeshId);
    if (!mesh || !mesh.isPlant) {
      showToast({ title: 'No plant mesh selected', type: 'error' });
      return;
    }

    setIsMorphing(true);

    try {
      // Delete old session if it exists
      if (mesh.plantSessionId) {
        try {
          await deletePlantSession(mesh.plantSessionId);
          console.log(`[Morph] Deleted old session ${mesh.plantSessionId}`);
        } catch (e) {
          console.warn('[Morph] Failed to delete old session:', e);
        }
      }

      const response = await morphPlant(request);

      if (!response.success) {
        showToast({ title: `Morph failed: ${response.error}`, type: 'error' });
        return;
      }

      // Convert response arrays to typed arrays
      const vertices = new Float32Array(response.vertex_count * 3);
      for (let i = 0; i < response.vertex_count; i++) {
        vertices[i * 3] = response.vertices[i][0];
        vertices[i * 3 + 1] = response.vertices[i][1];
        vertices[i * 3 + 2] = response.vertices[i][2];
      }

      const indices = new Uint32Array(response.triangle_count * 3);
      for (let i = 0; i < response.triangle_count; i++) {
        indices[i * 3] = response.indices[i][0];
        indices[i * 3 + 1] = response.indices[i][1];
        indices[i * 3 + 2] = response.indices[i][2];
      }

      let vertexColors: Float32Array | undefined;
      if (response.colors && response.colors.length > 0) {
        vertexColors = new Float32Array(response.colors.length * 3);
        for (let i = 0; i < response.colors.length; i++) {
          vertexColors[i * 3] = response.colors[i][0];
          vertexColors[i * 3 + 1] = response.colors[i][1];
          vertexColors[i * 3 + 2] = response.colors[i][2];
        }
      }

      // Replace mesh in-place with new geometry
      setMeshes(prev => prev.map(m => {
        if (m.id === selectedMeshId) {
          return {
            ...m,
            data: {
              vertices,
              indices,
              normals: undefined,
              vertexColors,
              vertexCount: response.vertex_count,
              triangleCount: response.triangle_count,
            },
            plantAge: response.current_age,
            plantSessionId: response.session_id,
            heliosXml: response.helios_xml ?? m.heliosXml,
            regenerationKey: (m.regenerationKey ?? 0) + 1,
          };
        }
        return m;
      }));

      console.log(`[Morph] Plant morphed: ${response.vertex_count} vertices, session ${response.session_id}`);
      showToast({ title: `Plant morphed successfully (${response.vertex_count} vertices)`, type: 'success' });

    } catch (error) {
      console.error('Plant morph failed:', error);
      showToast({ title: `Plant morph failed: ${error}`, type: 'error' });
    } finally {
      setIsMorphing(false);
    }
  }, [meshes, selectedMeshIds]);

  // Handle advancing plant age using session-based approach for consistent plants
  const handleAdvancePlantAge = useCallback(async (meshId: string, dt: number) => {
    // Find the mesh to get its plant parameters
    const mesh = meshes.find(m => m.id === meshId);
    if (!mesh || !mesh.isPlant || !mesh.plantType) {
      console.error('Plant mesh not found or missing plant metadata');
      return;
    }

    if (isAdvancingAge) return;

    const currentAge = mesh.plantAge ?? 0;
    const newAge = currentAge + dt;

    // Don't allow negative ages
    if (newAge < 0) {
      console.warn('Cannot set negative plant age');
      return;
    }

    setIsAdvancingAge(true);

    try {
      // Session-based approach: Use advanceTime for forward growth (keeps plant consistent)
      // Note: Going backward in time requires regeneration (creates a new plant)
      if (dt > 0 && mesh.plantSessionId) {
        // Use existing session to advance time
        console.log(`[Plant] Advancing session ${mesh.plantSessionId} by ${dt} days`);

        const response = await advancePlantSession(mesh.plantSessionId, dt);

        if (!response.success) {
          console.error('Plant session advance failed:', response.error);
          // Fall back to stateless regeneration
          console.log('[Plant] Falling back to stateless regeneration...');
        } else {
          // Convert response data to MeshData format
          const vertices = new Float32Array(response.vertex_count * 3);
          for (let i = 0; i < response.vertex_count; i++) {
            vertices[i * 3] = response.vertices[i][0];
            vertices[i * 3 + 1] = response.vertices[i][1];
            vertices[i * 3 + 2] = response.vertices[i][2];
          }

          const indices = new Uint32Array(response.triangle_count * 3);
          for (let i = 0; i < response.triangle_count; i++) {
            indices[i * 3] = response.indices[i][0];
            indices[i * 3 + 1] = response.indices[i][1];
            indices[i * 3 + 2] = response.indices[i][2];
          }

          let vertexColors: Float32Array | undefined;
          if (response.colors && response.colors.length > 0) {
            vertexColors = new Float32Array(response.colors.length * 3);
            for (let i = 0; i < response.colors.length; i++) {
              vertexColors[i * 3] = response.colors[i][0];
              vertexColors[i * 3 + 1] = response.colors[i][1];
              vertexColors[i * 3 + 2] = response.colors[i][2];
            }
          }

          // Update the mesh with new geometry from session
          setMeshes(prev => prev.map(m => {
            if (m.id === meshId) {
              return {
                ...m,
                data: {
                  vertices,
                  indices,
                  normals: undefined,
                  vertexColors,
                  vertexCount: response.vertex_count,
                  triangleCount: response.triangle_count,
                },
                plantAge: response.current_age,
                regenerationKey: (m.regenerationKey ?? 0) + 1,
              };
            }
            return m;
          }));

          console.log(`[Plant] Session advanced: age ${response.previous_age} -> ${response.current_age}, ${response.vertex_count} vertices`);
          setIsAdvancingAge(false);
          return;
        }
      }

      // For backward time travel (dt < 0), no existing session, or session advance failed:
      // Create a new session at the target age
      console.log(`[Plant] Creating new session at age ${newAge}`);

      const sessionResponse = await createPlantSession({
        plant_type: mesh.plantType,
        initial_age: newAge,
        position_x: mesh.plantPosition?.x ?? 0,
        position_y: mesh.plantPosition?.y ?? 0,
        position_z: mesh.plantPosition?.z ?? 0,
      });

      if (!sessionResponse.success || !sessionResponse.session_id) {
        console.error('Failed to create plant session:', sessionResponse.error);
        // Fall back to stateless generation as last resort
        const response = await generatePlantModel({
          plant_type: mesh.plantType,
          age: newAge,
          position_x: mesh.plantPosition?.x ?? 0,
          position_y: mesh.plantPosition?.y ?? 0,
          position_z: mesh.plantPosition?.z ?? 0,
          random_seed: mesh.plantSeed,
        });

        if (!response.success) {
          console.error('Plant regeneration failed:', response.error);
          return;
        }

        // Convert and update (stateless fallback)
        const vertices = new Float32Array(response.vertex_count * 3);
        for (let i = 0; i < response.vertex_count; i++) {
          vertices[i * 3] = response.vertices[i][0];
          vertices[i * 3 + 1] = response.vertices[i][1];
          vertices[i * 3 + 2] = response.vertices[i][2];
        }
        const indices = new Uint32Array(response.triangle_count * 3);
        for (let i = 0; i < response.triangle_count; i++) {
          indices[i * 3] = response.indices[i][0];
          indices[i * 3 + 1] = response.indices[i][1];
          indices[i * 3 + 2] = response.indices[i][2];
        }
        let vertexColors: Float32Array | undefined;
        if (response.colors && response.colors.length > 0) {
          vertexColors = new Float32Array(response.colors.length * 3);
          for (let i = 0; i < response.colors.length; i++) {
            vertexColors[i * 3] = response.colors[i][0];
            vertexColors[i * 3 + 1] = response.colors[i][1];
            vertexColors[i * 3 + 2] = response.colors[i][2];
          }
        }

        setMeshes(prev => prev.map(m => {
          if (m.id === meshId) {
            return {
              ...m,
              data: { vertices, indices, normals: undefined, vertexColors, vertexCount: response.vertex_count, triangleCount: response.triangle_count },
              plantAge: newAge,
              regenerationKey: (m.regenerationKey ?? 0) + 1,
              heliosXml: response.helios_xml,
              plantSessionId: undefined, // No session available
            };
          }
          return m;
        }));
        console.log(`[Plant] Stateless regeneration at age ${newAge}: ${response.vertex_count} vertices`);
        return;
      }

      // Session created - now get geometry by advancing 0 days
      const advanceResponse = await advancePlantSession(sessionResponse.session_id, 0);

      if (!advanceResponse.success) {
        console.error('Failed to get geometry from new session:', advanceResponse.error);
        return;
      }

      // Convert response data to MeshData format
      const vertices = new Float32Array(advanceResponse.vertex_count * 3);
      for (let i = 0; i < advanceResponse.vertex_count; i++) {
        vertices[i * 3] = advanceResponse.vertices[i][0];
        vertices[i * 3 + 1] = advanceResponse.vertices[i][1];
        vertices[i * 3 + 2] = advanceResponse.vertices[i][2];
      }

      const indices = new Uint32Array(advanceResponse.triangle_count * 3);
      for (let i = 0; i < advanceResponse.triangle_count; i++) {
        indices[i * 3] = advanceResponse.indices[i][0];
        indices[i * 3 + 1] = advanceResponse.indices[i][1];
        indices[i * 3 + 2] = advanceResponse.indices[i][2];
      }

      let vertexColors: Float32Array | undefined;
      if (advanceResponse.colors && advanceResponse.colors.length > 0) {
        vertexColors = new Float32Array(advanceResponse.colors.length * 3);
        for (let i = 0; i < advanceResponse.colors.length; i++) {
          vertexColors[i * 3] = advanceResponse.colors[i][0];
          vertexColors[i * 3 + 1] = advanceResponse.colors[i][1];
          vertexColors[i * 3 + 2] = advanceResponse.colors[i][2];
        }
      }

      // Update the mesh with new session
      setMeshes(prev => prev.map(m => {
        if (m.id === meshId) {
          return {
            ...m,
            data: {
              vertices,
              indices,
              normals: undefined,
              vertexColors,
              vertexCount: advanceResponse.vertex_count,
              triangleCount: advanceResponse.triangle_count,
            },
            plantAge: advanceResponse.current_age,
            plantSessionId: sessionResponse.session_id,
            regenerationKey: (m.regenerationKey ?? 0) + 1,
          };
        }
        return m;
      }));

      console.log(`[Plant] Created new session ${sessionResponse.session_id} at age ${advanceResponse.current_age}: ${advanceResponse.vertex_count} vertices`);

    } catch (error) {
      console.error('Plant age advancement failed:', error);
    } finally {
      setIsAdvancingAge(false);
    }
  }, [meshes, isAdvancingAge]);

  // Handle growth animation - steps from start age to end age
  const handleStartGrowthAnimation = useCallback(async (meshId: string) => {
    const mesh = meshes.find(m => m.id === meshId);
    if (!mesh || !mesh.isPlant || !mesh.plantType) {
      console.error('Plant mesh not found or missing plant metadata');
      return;
    }

    const startAge = parseInt(animationStartAge);
    const endAge = parseInt(animationEndAge);

    if (isNaN(startAge) || isNaN(endAge) || startAge < 0 || endAge < 0) {
      showToast({ title: 'Invalid age values', type: 'error' });
      return;
    }

    if (startAge >= endAge) {
      showToast({ title: 'End age must be greater than start age', type: 'error' });
      return;
    }

    // Reset abort flag and start animation
    animationAbortRef.current = false;
    setIsAnimating(true);
    setAnimationProgress(startAge);

    console.log(`[Plant Animation] Starting growth from age ${startAge} to ${endAge}`);

    try {
      // First, create a new session at the start age
      // Use the same seed as the original plant to ensure identical geometry
      const sessionResponse = await createPlantSession({
        plant_type: mesh.plantType,
        initial_age: startAge,
        position_x: mesh.plantPosition?.x ?? 0,
        position_y: mesh.plantPosition?.y ?? 0,
        position_z: mesh.plantPosition?.z ?? 0,
        random_seed: mesh.plantSeed,
      });

      if (!sessionResponse.success || !sessionResponse.session_id) {
        showToast({ title: 'Failed to create plant session', type: 'error' });
        setIsAnimating(false);
        setAnimationProgress(null);
        return;
      }

      const sessionId = sessionResponse.session_id;
      console.log(`[Plant Animation] Created session ${sessionId} at age ${startAge}`);

      // Get initial geometry
      let advanceResponse = await advancePlantSession(sessionId, 0);
      if (!advanceResponse.success) {
        showToast({ title: 'Failed to get initial geometry', type: 'error' });
        setIsAnimating(false);
        setAnimationProgress(null);
        return;
      }

      // Update mesh with starting geometry and session
      const updateMeshGeometry = (response: typeof advanceResponse) => {
        const vertices = new Float32Array(response.vertex_count * 3);
        for (let i = 0; i < response.vertex_count; i++) {
          vertices[i * 3] = response.vertices[i][0];
          vertices[i * 3 + 1] = response.vertices[i][1];
          vertices[i * 3 + 2] = response.vertices[i][2];
        }
        const indices = new Uint32Array(response.triangle_count * 3);
        for (let i = 0; i < response.triangle_count; i++) {
          indices[i * 3] = response.indices[i][0];
          indices[i * 3 + 1] = response.indices[i][1];
          indices[i * 3 + 2] = response.indices[i][2];
        }
        let vertexColors: Float32Array | undefined;
        if (response.colors && response.colors.length > 0) {
          vertexColors = new Float32Array(response.colors.length * 3);
          for (let i = 0; i < response.colors.length; i++) {
            vertexColors[i * 3] = response.colors[i][0];
            vertexColors[i * 3 + 1] = response.colors[i][1];
            vertexColors[i * 3 + 2] = response.colors[i][2];
          }
        }

        setMeshes(prev => prev.map(m => {
          if (m.id === meshId) {
            return {
              ...m,
              data: {
                vertices,
                indices,
                normals: undefined,
                vertexColors,
                vertexCount: response.vertex_count,
                triangleCount: response.triangle_count,
              },
              plantAge: response.current_age,
              plantSessionId: sessionId,
              regenerationKey: (m.regenerationKey ?? 0) + 1,
            };
          }
          return m;
        }));
      };

      // Update with initial geometry
      updateMeshGeometry(advanceResponse);

      // Now step through each day from start to end
      let currentAge = startAge;
      while (currentAge < endAge) {
        // Check if animation was aborted
        if (animationAbortRef.current) {
          console.log('[Plant Animation] Animation aborted by user');
          break;
        }

        // Advance by 1 day
        advanceResponse = await advancePlantSession(sessionId, 1);
        if (!advanceResponse.success) {
          console.error('[Plant Animation] Failed to advance:', advanceResponse.error);
          break;
        }

        currentAge = advanceResponse.current_age;
        setAnimationProgress(currentAge);

        // Update mesh geometry
        updateMeshGeometry(advanceResponse);

        // Small delay to make the animation visible
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`[Plant Animation] Completed at age ${currentAge}`);

    } catch (error) {
      console.error('[Plant Animation] Error:', error);
      showToast({ title: `Animation failed: ${error}`, type: 'error' });
    } finally {
      setIsAnimating(false);
      setAnimationProgress(null);
    }
  }, [meshes, animationStartAge, animationEndAge]);

  // Stop growth animation
  const handleStopGrowthAnimation = useCallback(() => {
    animationAbortRef.current = true;
  }, []);

  // Stop GIF generation
  const handleStopMakeGIF = useCallback(() => {
    gifAbortRef.current = true;
  }, []);

  // Make GIF of plant growth using offscreen renderer
  const handleMakeGIF = useCallback(async (meshId: string) => {
    const mesh = meshes.find(m => m.id === meshId);
    if (!mesh || !mesh.isPlant || !mesh.plantType) {
      console.error('[GIF] Plant mesh not found or missing plant metadata');
      return;
    }

    const startAge = parseInt(animationStartAge);
    const endAge = parseInt(animationEndAge);

    if (isNaN(startAge) || isNaN(endAge) || startAge < 0 || endAge < 0) {
      showToast({ title: 'Invalid age values', type: 'error' });
      return;
    }

    if (startAge >= endAge) {
      showToast({ title: 'End age must be greater than start age', type: 'error' });
      return;
    }

    // Get camera from the main scene
    const mainCamera = mainCameraRef.current;
    if (!mainCamera) {
      showToast({ title: 'Camera not ready', type: 'error' });
      return;
    }

    // Reset abort flag and start GIF generation
    gifAbortRef.current = false;
    setIsGeneratingGif(true);
    setGifProgress({ current: 0, total: endAge - startAge + 1, phase: 'frames' });

    console.log(`[GIF] Starting GIF generation from age ${startAge} to ${endAge}`);

    try {
      // For "current" view, match the main camera's aspect ratio for identical framing
      // For preset views, use square 512x512
      let width = 512;
      let height = 512;

      if (gifCameraView === 'current' && mainCamera) {
        const mainAspect = (mainCamera as THREE.PerspectiveCamera).aspect || 1;
        if (mainAspect > 1) {
          // Wider than tall - keep width at 512, adjust height
          height = Math.round(512 / mainAspect);
        } else {
          // Taller than wide - keep height at 512, adjust width
          width = Math.round(512 * mainAspect);
        }
      }

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: gifBackground === 'transparent',
        preserveDrawingBuffer: true,
      });
      renderer.setSize(width, height);
      renderer.setPixelRatio(1);

      // Set background color
      if (gifBackground === 'transparent') {
        renderer.setClearColor(0x000000, 0);
      } else if (gifBackground === 'black') {
        renderer.setClearColor(0x000000, 1);
      } else {
        renderer.setClearColor(0xffffff, 1);
      }

      // Create offscreen scene
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.5));
      const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
      dirLight.position.set(10, 10, 10);
      scene.add(dirLight);

      // Set up camera based on view selection
      // NOTE: This scene uses Z-up coordinate system (like Helios/main viewer)
      // - X: left/right
      // - Y: front/back
      // - Z: up/down (plant grows along Z axis)
      const camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 10000);
      const cameraDistance = 2; // Distance from plant center

      // Plant world position - mesh vertices include this offset from backend
      const plantWorldPos = new THREE.Vector3(
        mesh.plantPosition?.x ?? 0,
        mesh.plantPosition?.y ?? 0,
        mesh.plantPosition?.z ?? 0
      );

      if (gifCameraView === 'current' && mainCamera) {
        // For "current" view: copy the main camera's transform exactly
        // The quaternion encodes the exact viewing direction (including OrbitControls target)
        camera.position.copy(mainCamera.position);
        camera.quaternion.copy(mainCamera.quaternion);
        camera.up.copy(mainCamera.up);
        camera.fov = (mainCamera as THREE.PerspectiveCamera).fov || 60;
        camera.near = (mainCamera as THREE.PerspectiveCamera).near || 0.01;
        camera.far = (mainCamera as THREE.PerspectiveCamera).far || 10000;
        camera.updateProjectionMatrix();
      } else {
        // Use preset camera positions matching the main viewer's snapToView logic
        // Z-up coordinate system, positioned relative to plant world position
        const px = plantWorldPos.x;
        const py = plantWorldPos.y;
        const pz = plantWorldPos.z;

        switch (gifCameraView) {
          case 'front':
            // Front view: camera in front (negative Y), looking at plant
            camera.position.set(px, py - cameraDistance, pz + 0.5);
            camera.up.set(0, 0, 1); // Z is up
            break;
          case 'side':
            // Side view: camera to the right (positive X), looking at plant
            camera.position.set(px + cameraDistance, py, pz + 0.5);
            camera.up.set(0, 0, 1); // Z is up
            break;
          case 'top':
            // Top view: camera above (positive Z), looking down
            camera.position.set(px, py, pz + cameraDistance + 0.5);
            camera.up.set(0, 1, 0); // Y is up for top-down view
            break;
          case 'iso':
          default:
            // Isometric view - diagonal from front-right-above (matching main viewer)
            camera.position.set(
              px + cameraDistance * 0.6,   // X: slightly right
              py - cameraDistance * 0.6,   // Y: in front (negative)
              pz + cameraDistance * 0.5 + 0.5  // Z: above
            );
            camera.up.set(0, 0, 1); // Z is up
            break;
        }
        camera.lookAt(plantWorldPos);
      }
      camera.updateProjectionMatrix();

      // Create GIF encoder
      const gif = new GIF({
        workers: 2,
        quality: 10,
        width: width,
        height: height,
        workerScript: '/gif.worker.js',
        transparent: gifBackground === 'transparent' ? '#000000' : null,
      });

      // First, create a new session at the start age
      // Use the same seed as the original plant to ensure identical geometry
      const sessionResponse = await createPlantSession({
        plant_type: mesh.plantType,
        initial_age: startAge,
        position_x: mesh.plantPosition?.x ?? 0,
        position_y: mesh.plantPosition?.y ?? 0,
        position_z: mesh.plantPosition?.z ?? 0,
        random_seed: mesh.plantSeed,
      });

      if (!sessionResponse.success || !sessionResponse.session_id) {
        showToast({ title: 'Failed to create plant session', type: 'error' });
        setIsGeneratingGif(false);
        setGifProgress(null);
        renderer.dispose();
        return;
      }

      const sessionId = sessionResponse.session_id;
      console.log(`[GIF] Created session ${sessionId} at age ${startAge}`);

      // Helper to create mesh from response
      const createMeshFromResponse = (response: Awaited<ReturnType<typeof advancePlantSession>>) => {
        const geometry = new THREE.BufferGeometry();

        // Create vertices
        const vertices = new Float32Array(response.vertex_count * 3);
        for (let i = 0; i < response.vertex_count; i++) {
          vertices[i * 3] = response.vertices[i][0];
          vertices[i * 3 + 1] = response.vertices[i][1];
          vertices[i * 3 + 2] = response.vertices[i][2];
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

        // Create indices
        const indices = new Uint32Array(response.triangle_count * 3);
        for (let i = 0; i < response.triangle_count; i++) {
          indices[i * 3] = response.indices[i][0];
          indices[i * 3 + 1] = response.indices[i][1];
          indices[i * 3 + 2] = response.indices[i][2];
        }
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

        // Create vertex colors
        if (response.colors && response.colors.length > 0) {
          const colors = new Float32Array(response.colors.length * 3);
          for (let i = 0; i < response.colors.length; i++) {
            colors[i * 3] = response.colors[i][0];
            colors[i * 3 + 1] = response.colors[i][1];
            colors[i * 3 + 2] = response.colors[i][2];
          }
          geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }

        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
        });

        return new THREE.Mesh(geometry, material);
      };

      // Get initial geometry
      let advanceResponse = await advancePlantSession(sessionId, 0);
      if (!advanceResponse.success) {
        showToast({ title: 'Failed to get initial geometry', type: 'error' });
        setIsGeneratingGif(false);
        setGifProgress(null);
        renderer.dispose();
        return;
      }

      // Frame collection loop
      let currentAge = startAge;
      let frameCount = 0;
      const totalFrames = endAge - startAge + 1;

      // Process first frame
      let plantMesh = createMeshFromResponse(advanceResponse);
      scene.add(plantMesh);
      renderer.render(scene, camera);

      // Capture frame
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(renderer.domElement, 0, 0);
      gif.addFrame(ctx, { copy: true, delay: 100 });
      frameCount++;
      setGifProgress({ current: frameCount, total: totalFrames, phase: 'frames' });

      // Step through each day
      while (currentAge < endAge) {
        // Check if aborted
        if (gifAbortRef.current) {
          console.log('[GIF] Generation aborted by user');
          renderer.dispose();
          setIsGeneratingGif(false);
          setGifProgress(null);
          return;
        }

        // Advance by 1 day
        advanceResponse = await advancePlantSession(sessionId, 1);
        if (!advanceResponse.success) {
          console.error('[GIF] Failed to advance:', advanceResponse.error);
          break;
        }

        currentAge = advanceResponse.current_age;

        // Remove old mesh, add new one
        scene.remove(plantMesh);
        plantMesh.geometry.dispose();
        (plantMesh.material as THREE.Material).dispose();

        plantMesh = createMeshFromResponse(advanceResponse);
        scene.add(plantMesh);

        // Render and capture frame
        renderer.render(scene, camera);
        ctx.drawImage(renderer.domElement, 0, 0);
        gif.addFrame(ctx, { copy: true, delay: 100 });

        frameCount++;
        setGifProgress({ current: frameCount, total: totalFrames, phase: 'frames' });
      }

      // Clean up mesh
      scene.remove(plantMesh);
      plantMesh.geometry.dispose();
      (plantMesh.material as THREE.Material).dispose();

      console.log(`[GIF] Captured ${frameCount} frames, encoding...`);
      setGifProgress({ current: frameCount, total: totalFrames, phase: 'encoding' });

      // Encode GIF
      gif.on('finished', (blob: Blob) => {
        // Download the GIF
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${mesh.plantType}_growth_${startAge}-${endAge}.gif`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('[GIF] Download started');
        showToast({ title: 'GIF downloaded successfully!', type: 'success' });

        renderer.dispose();
        setIsGeneratingGif(false);
        setGifProgress(null);
      });

      gif.render();

    } catch (error) {
      console.error('[GIF] Error:', error);
      showToast({ title: `GIF generation failed: ${error}`, type: 'error' });
      setIsGeneratingGif(false);
      setGifProgress(null);
    }
  }, [meshes, animationStartAge, animationEndAge, gifBackground, gifCameraView]);

  // Get first selected cloud for gizmo positioning
  const firstSelectedCloud = useMemo(() => {
    const id = Array.from(selectedIds)[0];
    return clouds.find(c => c.id === id);
  }, [selectedIds, clouds]);

  return (
    <div className={`relative bg-neutral-900 ${className}`}>
      {/* 3D Canvas */}
      <Canvas
        camera={{ fov: 60, near: 0.01, far: 10000, position: [0, 0, 10] }}
        gl={{ antialias: true, alpha: false }}
        onCreated={({ gl }) => { gl.setClearColor('#171717'); }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 10, 10]} intensity={0.5} />

        {/* Scene background */}
        <SceneBackground color={bgColor} style={bgStyle} />

        {/* Camera capture for GIF generation */}
        <CameraCapture cameraRef={mainCameraRef} />

        {/* Render all visible clouds */}
        {clouds.map(cloud => {
          if (!cloud.visible) return null;
          const editState = getEditState(cloud.id);
          const isSelected = selectedIds.has(cloud.id);
          // Show crop preview when this cloud is selected and in crop mode
          const showCropPreview = isSelected && editMode === 'crop';
          // Check if there's a resample preview for this cloud
          const hasResamplePreview = resamplePreview?.cloudId === cloud.id;
          // Always call getDisplayData to handle erasing, pass showCropPreview for crop filtering
          // Use resample preview data if available
          const displayData = hasResamplePreview
            ? resamplePreview.previewData
            : (showCropPreview || editState.erasedIndices.size > 0)
              ? getDisplayData(cloud, showCropPreview)
              : cloud.data;

          // Skip rendering if the display data has no points (all erased)
          if (!displayData || displayData.pointCount === 0) {
            return null;
          }

          // When getDisplayData is called, it bakes translation into positions, so group position should be [0,0,0]
          // getDisplayData is called when: showCropPreview || erasedIndices.size > 0
          const usesDisplayData = showCropPreview || editState.erasedIndices.size > 0;
          return (
            <group
              key={cloud.id}
              position={usesDisplayData ? [0, 0, 0] : [editState.translation.x, editState.translation.y, editState.translation.z]}
            >
              <PointCloud data={displayData} pointSize={pointSize} colorMode={colorMode} selectedScalarField={selectedScalarField} filters={cloudFilters.get(cloud.id)} />
            </group>
          );
        })}

        {/* Render all visible meshes */}
        {meshes.map(mesh => {
          if (!mesh.visible) return null;
          // Get transforms from state (position, rotation, scale)
          const meshPos = meshPositions.get(mesh.id) || { x: 0, y: 0, z: 0 };
          const meshRot = meshRotations.get(mesh.id) || { x: 0, y: 0, z: 0 };
          const meshScale = meshScales.get(mesh.id) || { x: 1, y: 1, z: 1 };

          // For non-shape meshes, also apply source cloud translation
          const sourceCloud = clouds.find(c => c.id === mesh.sourceCloudId);
          const editState = sourceCloud ? getEditState(sourceCloud.id) : null;
          const cloudOffset = editState
            ? { x: editState.translation.x, y: editState.translation.y, z: editState.translation.z }
            : { x: 0, y: 0, z: 0 };

          return (
            <group
              key={mesh.id}
              position={[meshPos.x + cloudOffset.x, meshPos.y + cloudOffset.y, meshPos.z + cloudOffset.z]}
              rotation={[meshRot.x * Math.PI / 180, meshRot.y * Math.PI / 180, meshRot.z * Math.PI / 180]}
              scale={[meshScale.x, meshScale.y, meshScale.z]}
            >
              {/* Render mesh with vertex colors (texture rendering disabled - UV computation doesn't match Helios texture layout) */}
              {/* Key includes regenerationKey to force remount when plant is regenerated */}
              <TriangleMesh
                key={`mesh-${mesh.id}-${mesh.regenerationKey ?? 0}`}
                data={mesh.data}
                color={mesh.color}
                opacity={meshOpacity}
                wireframe={meshWireframe}
                useVertexColors={mesh.data.vertexColors !== undefined && mesh.data.vertexColors.length > 0}
              />
            </group>
          );
        })}

        {/* Render all visible skeletons */}
        {skeletons.map(skeleton => {
          if (!skeleton.visible) return null;
          // Apply skeleton's own position only - skeletons move independently from source clouds
          const skelPos = skeletonPositions.get(skeleton.id) || { x: 0, y: 0, z: 0 };

          return (
            <group
              key={skeleton.id}
              position={[skelPos.x, skelPos.y, skelPos.z]}
            >
              {skeletonShowAsCylinders ? (
                <Skeleton3D
                  data={skeleton.data}
                  color={skeleton.color}
                  tubeRadius={skeletonTubeRadius}
                  showDiameters={false}
                  colorByBranchOrder={skeletonColorByBranchOrder}
                />
              ) : (
                <SkeletonPoints
                  data={skeleton.data}
                  color={skeleton.color}
                  pointSize={8}
                  colorByBranchOrder={skeletonColorByBranchOrder}
                />
              )}
            </group>
          );
        })}

        <CameraController bounds={combinedBounds} enabled={!gizmoDragging} />

        {/* Translation Gizmo for selected clouds */}
        {editMode === 'translate' && firstSelectedCloud && (
          <TranslationGizmo
            center={new THREE.Vector3(
              firstSelectedCloud.data.bounds.center.x + getEditState(firstSelectedCloud.id).translation.x,
              firstSelectedCloud.data.bounds.center.y + getEditState(firstSelectedCloud.id).translation.y,
              firstSelectedCloud.data.bounds.center.z + getEditState(firstSelectedCloud.id).translation.z
            )}
            size={firstSelectedCloud.data.bounds.size.length() / 3}
            onTranslate={handleGizmoTranslate}
            onDragStart={() => setGizmoDragging(true)}
            onDragEnd={() => { setGizmoDragging(false); saveToHistory(); }}
          />
        )}

        {/* Translation Gizmo for selected mesh */}
        {editMode === 'translate' && selectedMesh && (() => {
          const meshPos = meshPositions.get(selectedMesh.id) || { x: 0, y: 0, z: 0 };
          const meshScale = meshScales.get(selectedMesh.id) || { x: 1, y: 1, z: 1 };
          return (
            <TranslationGizmo
              center={new THREE.Vector3(meshPos.x, meshPos.y, meshPos.z)}
              size={Math.max(meshScale.x, meshScale.y, meshScale.z)}
              onTranslate={handleMeshTranslate}
              onDragStart={() => { startHistoryEntry('mesh', selectedMesh.id); setGizmoDragging(true); }}
              onDragEnd={() => { commitHistoryEntry(); setGizmoDragging(false); }}
            />
          );
        })()}

        {/* Translation Gizmo for selected skeleton */}
        {editMode === 'translate' && selectedSkeleton && selectedSkeleton.data.pointCount > 0 && (() => {
          const skelPos = skeletonPositions.get(selectedSkeleton.id) || { x: 0, y: 0, z: 0 };
          // Calculate skeleton bounds for gizmo size
          const skelData = selectedSkeleton.data;
          let minX = skelData.points[0], maxX = skelData.points[0];
          let minY = skelData.points[1], maxY = skelData.points[1];
          let minZ = skelData.points[2], maxZ = skelData.points[2];
          for (let i = 1; i < skelData.pointCount; i++) {
            const x = skelData.points[i * 3];
            const y = skelData.points[i * 3 + 1];
            const z = skelData.points[i * 3 + 2];
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          }
          const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
          const center = new THREE.Vector3(
            skelPos.x + (minX + maxX) / 2,
            skelPos.y + (minY + maxY) / 2,
            skelPos.z + (minZ + maxZ) / 2
          );
          return (
            <TranslationGizmo
              center={center}
              size={size}
              onTranslate={handleSkeletonTranslate}
              onDragStart={() => { startHistoryEntry('skeleton', selectedSkeleton.id); setGizmoDragging(true); }}
              onDragEnd={() => { commitHistoryEntry(); setGizmoDragging(false); }}
            />
          );
        })()}

        {/* Crop Box for selected cloud */}
        {editMode === 'crop' && firstSelectedCloud && (() => {
          const editState = getEditState(firstSelectedCloud.id);
          if (!editState.cropMin || !editState.cropMax) return null;
          const trans = editState.translation;
          // Crop bounds stored in local coords, add translation for display
          const displayMin = {
            x: editState.cropMin.x + trans.x,
            y: editState.cropMin.y + trans.y,
            z: editState.cropMin.z + trans.z
          };
          const displayMax = {
            x: editState.cropMax.x + trans.x,
            y: editState.cropMax.y + trans.y,
            z: editState.cropMax.z + trans.z
          };
          return (
            <CropBox
              min={displayMin}
              max={displayMax}
              onMinChange={(min) => {
                // Subtract translation to store in local coords
                const localMin = { x: min.x - trans.x, y: min.y - trans.y, z: min.z - trans.z };
                updateSelectedEditStates(s => ({ ...s, cropMin: localMin }));
              }}
              onMaxChange={(max) => {
                // Subtract translation to store in local coords
                const localMax = { x: max.x - trans.x, y: max.y - trans.y, z: max.z - trans.z };
                updateSelectedEditStates(s => ({ ...s, cropMax: localMax }));
              }}
              onDragStart={() => setGizmoDragging(true)}
              onDragEnd={() => { setGizmoDragging(false); saveToHistory(); }}
              keepInside={!editState.cropInvert}
            />
          );
        })()}

        {/* Erase Brush - for erasing points from point cloud */}
        {editMode === 'erase' && firstSelectedCloud && (() => {
          const editState = getEditState(firstSelectedCloud.id);
          return (
            <EraseBrush
              brushSize={eraseBrushSize}
              brushPosition={eraseBrushPosition}
              isErasing={isErasing}
              cloudData={firstSelectedCloud.data}
              cloudTranslation={editState.translation}
              alreadyErasedIndices={editState.erasedIndices}
              onErase={(indicesToErase) => {
                setEditStates(prev => {
                  const next = new Map(prev);
                  const state = next.get(firstSelectedCloud.id);
                  if (state) {
                    const newErased = new Set(state.erasedIndices);
                    indicesToErase.forEach(i => newErased.add(i));
                    next.set(firstSelectedCloud.id, { ...state, erasedIndices: newErased });

                    // Check if all points are now erased - trigger delete confirmation
                    const remainingPoints = firstSelectedCloud.data.pointCount - newErased.size;
                    if (remainingPoints <= 0) {
                      // Use setTimeout to avoid state update during render
                      setTimeout(() => {
                        // Reset erasing state before showing delete dialog
                        setIsErasing(false);
                        setGizmoDragging(false);
                        setDeleteConfirm({
                          type: 'cloud',
                          id: firstSelectedCloud.id,
                          name: firstSelectedCloud.data.fileName || 'Unnamed'
                        });
                        setEditMode('none');
                      }, 0);
                    }
                  }
                  return next;
                });
              }}
              onBrushPositionChange={setEraseBrushPosition}
              onEraseStart={() => {
                startHistoryEntry('cloud', firstSelectedCloud.id);
                setGizmoDragging(true);
              }}
              onEraseEnd={() => {
                // Use setTimeout to ensure state updates are processed before committing history
                // This prevents race conditions that can cause rendering issues
                setTimeout(() => {
                  setGizmoDragging(false);
                  commitHistoryEntry();
                }, 0);
              }}
              setIsErasing={setIsErasing}
            />
          );
        })()}

        {/* Grid - uses staticBounds so it stays fixed when objects are moved */}
        {showGrid && (
          <Grid
            args={[100, 100]}
            cellSize={staticBounds.size.length() / 20}
            cellThickness={0.5}
            cellColor="#404040"
            sectionSize={staticBounds.size.length() / 4}
            sectionThickness={1}
            sectionColor="#525252"
            position={
              gridPlane === 'z-up'
                ? [staticBounds.center.x, staticBounds.center.y, staticBounds.min.z]
                : [staticBounds.center.x, staticBounds.min.y, staticBounds.center.z]
            }
            rotation={gridPlane === 'z-up' ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}
            fadeDistance={staticBounds.size.length() * 5}
            infiniteGrid
            side={THREE.DoubleSide}
          />
        )}

        {showAxes && <AxesDisplay size={staticBounds.size.length() / 3} />}
      </Canvas>

      {/* Helios triangulation status indicator */}
      {isHeliosRunning && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-neutral-800/80 backdrop-blur-sm rounded-full border border-neutral-700/50 z-20">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="text-[11px] text-neutral-300">Helios triangulating...</span>
          <button
            onClick={cancelHeliosTriangulation}
            className="ml-1 p-0.5 rounded hover:bg-neutral-600/60 transition-colors"
            title="Cancel triangulation"
          >
            <X className="w-3 h-3 text-neutral-400 hover:text-neutral-200" />
          </button>
        </div>
      )}

      {/* Right Side Panels Container */}
      <div className="absolute top-4 right-4 flex flex-col gap-2 max-h-[calc(100vh-100px)]">
        {/* Cloud List Panel */}
        <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-64 max-h-[40vh] flex flex-col">
          <div className="p-2 border-b border-neutral-700 flex items-center gap-2">
            <Layers className="w-4 h-4 text-neutral-400" />
            <span className="text-xs font-medium text-neutral-300 flex-1">Point Clouds</span>
            <button onClick={onSelectAll} className="p-1 hover:bg-neutral-700 rounded" title="Select All">
              <CheckSquare className="w-3 h-3 text-neutral-400" />
            </button>
            <button onClick={onDeselectAll} className="p-1 hover:bg-neutral-700 rounded" title="Deselect All">
              <XSquare className="w-3 h-3 text-neutral-400" />
            </button>
          </div>
          <div className="overflow-y-auto flex-1 p-1">
            {clouds.map(cloud => {
              const isSelected = selectedIds.has(cloud.id);
              const editState = getEditState(cloud.id);
              const hasCloudEdits = editState.translation.x !== 0 || editState.translation.y !== 0 || editState.translation.z !== 0 || editState.erasedIndices.size > 0;
              const effectivePointCount = cloud.data.pointCount - editState.erasedIndices.size;

              return (
                <div
                  key={cloud.id}
                  data-testid="cloud-row"
                  data-cloud-name={cloud.data.fileName || 'Unnamed'}
                  data-point-count={effectivePointCount}
                  data-selected={isSelected ? 'true' : 'false'}
                  onClick={(e) => onToggleSelection(cloud.id, e.shiftKey || e.ctrlKey || e.metaKey)}
                  className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                    isSelected ? 'bg-blue-600/30 border border-blue-500/50' : 'hover:bg-neutral-700/50'
                  }`}
                >
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: cloud.color }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-neutral-200 truncate" data-testid="cloud-row-name">{cloud.data.fileName || 'Unnamed'}</div>
                    <div className="text-[10px] text-neutral-500" data-testid="cloud-row-count">
                      {effectivePointCount.toLocaleString()} pts
                      {hasCloudEdits && <span className="ml-1 text-amber-400">*</span>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleVisibility(cloud.id); }}
                    className="p-1 hover:bg-neutral-600 rounded"
                    title={cloud.visible ? 'Hide' : 'Show'}
                  >
                    {cloud.visible ? (
                      <Eye className="w-3 h-3 text-neutral-400" />
                    ) : (
                      <EyeOff className="w-3 h-3 text-neutral-600" />
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (colorDropdownCloudId === cloud.id) {
                        setColorDropdownCloudId(null);
                      } else {
                        setColorDropdownCloudId(cloud.id);
                      }
                    }}
                    className="p-1 hover:bg-neutral-600 rounded"
                    title="Color By"
                    id={`color-btn-${cloud.id}`}
                  >
                    <Palette className="w-3 h-3 text-neutral-400" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ type: 'cloud', id: cloud.id, name: cloud.data.fileName || 'Point Cloud' }); }}
                    className="p-1 hover:bg-red-600/30 rounded"
                    title="Remove"
                  >
                    <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Meshes Panel */}
        {meshes.length > 0 && (
          <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-64 max-h-[40vh] flex flex-col">
            <div className="p-2 border-b border-neutral-700 flex items-center gap-2">
              <Box className="w-4 h-4 text-neutral-400" />
              <span className="text-xs font-medium text-neutral-300 flex-1">Meshes</span>
            </div>
            <div className="overflow-y-auto flex-1 p-1">
              {meshes.map(mesh => {
                const sourceCloud = clouds.find(c => c.id === mesh.sourceCloudId);
                const isSelected = selectedMeshIds.has(mesh.id);
                // Display name: for plants show type/age, otherwise show filename
                const displayName = mesh.isPlant
                  ? `${mesh.plantType} (${mesh.plantAge}d)`
                  : (sourceCloud?.data.fileName || 'Mesh');
                return (
                  <div
                    key={mesh.id}
                    data-testid="mesh-row"
                    data-mesh-name={displayName}
                    data-triangle-count={mesh.data.triangleCount}
                    data-is-plant={mesh.isPlant ? 'true' : 'false'}
                    data-selected={isSelected ? 'true' : 'false'}
                    onClick={() => handleSelectMesh(mesh.id)}
                    className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                      isSelected ? 'bg-green-600/30 border border-green-500/50' : 'hover:bg-neutral-700/50'
                    }`}
                  >
                    {mesh.isPlant ? (
                      <Leaf className="w-3 h-3 flex-shrink-0 text-green-400" />
                    ) : (
                      <div className="w-3 h-3 rounded flex-shrink-0" style={{ backgroundColor: mesh.color }} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-neutral-200 truncate" data-testid="mesh-row-name">
                        {displayName}
                      </div>
                      <div className="text-[10px] text-neutral-500" data-testid="mesh-row-count">
                        {mesh.data.triangleCount.toLocaleString()} triangles
                        {mesh.data.surfaceArea && ` · ${mesh.data.surfaceArea.toFixed(2)} m²`}
                        {mesh.isPlant && ' · Helios Plant'}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggleMeshVisibility(mesh.id); }}
                      className="p-1 hover:bg-neutral-600 rounded"
                      title={mesh.visible ? 'Hide' : 'Show'}
                    >
                      {mesh.visible ? (
                        <Eye className="w-3 h-3 text-neutral-400" />
                      ) : (
                        <EyeOff className="w-3 h-3 text-neutral-600" />
                      )}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const sourceName = sourceCloud?.data.fileName || 'Mesh';
                        setDeleteConfirm({ type: 'mesh', id: mesh.id, name: sourceName });
                      }}
                      className="p-1 hover:bg-red-600/30 rounded"
                      title="Remove"
                    >
                      <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
                    </button>
                  </div>
                );
              })}
            </div>
            {/* Mesh Settings */}
            <div className="p-2 border-t border-neutral-700">
              <div className="mb-2">
                <label className="text-[10px] text-neutral-400 block mb-1">Opacity: {(meshOpacity * 100).toFixed(0)}%</label>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.1"
                  value={meshOpacity}
                  onChange={(e) => setMeshOpacity(parseFloat(e.target.value))}
                  className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
                />
              </div>
              <label className="flex items-center gap-2 text-neutral-300 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={meshWireframe}
                  onChange={(e) => setMeshWireframe(e.target.checked)}
                  className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
                />
                Wireframe
              </label>
            </div>
          </div>
        )}

        {/* Skeletons Panel */}
        {skeletons.length > 0 && (
          <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-64 max-h-[40vh] flex flex-col">
            <div className="p-2 border-b border-neutral-700 flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-neutral-400" />
              <span className="text-xs font-medium text-neutral-300 flex-1">Skeletons</span>
            </div>
            <div className="overflow-y-auto flex-1 p-1">
              {skeletons.map(skeleton => {
                const sourceCloud = clouds.find(c => c.id === skeleton.sourceCloudId);
                const isSelected = selectedSkeletonId === skeleton.id;
                return (
                  <div
                    key={skeleton.id}
                    data-testid="skeleton-row"
                    data-skeleton-name={sourceCloud?.data.fileName || 'Skeleton'}
                    data-total-length={skeleton.data.totalLength}
                    data-point-count={skeleton.data.pointCount}
                    data-selected={isSelected ? 'true' : 'false'}
                    onClick={() => handleSelectSkeleton(skeleton.id)}
                    className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                      isSelected ? 'bg-amber-600/30 border border-amber-500/50' : 'hover:bg-neutral-700/50'
                    }`}
                  >
                    <div className="w-3 h-3 rounded flex-shrink-0" style={{ backgroundColor: skeleton.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-neutral-200 truncate" data-testid="skeleton-row-name">
                        {sourceCloud?.data.fileName || 'Skeleton'}
                      </div>
                      <div className="text-[10px] text-neutral-500" data-testid="skeleton-row-stats">
                        {skeleton.data.totalLength.toFixed(2)}m · {skeleton.data.pointCount} pts
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggleSkeletonVisibility(skeleton.id); }}
                      className="p-1 hover:bg-neutral-600 rounded"
                      title={skeleton.visible ? 'Hide' : 'Show'}
                    >
                      {skeleton.visible ? (
                        <Eye className="w-3 h-3 text-neutral-400" />
                      ) : (
                        <EyeOff className="w-3 h-3 text-neutral-600" />
                      )}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const sourceName = sourceCloud?.data.fileName || 'Skeleton';
                        setDeleteConfirm({ type: 'skeleton', id: skeleton.id, name: sourceName });
                      }}
                      className="p-1 hover:bg-red-600/30 rounded"
                      title="Remove"
                    >
                      <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
                    </button>
                  </div>
                );
              })}
            </div>
            {/* Skeleton Settings */}
            <div className="p-2 border-t border-neutral-700">
              <label className="flex items-center gap-2 text-[10px] text-neutral-400 cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={skeletonShowAsCylinders}
                  onChange={(e) => setSkeletonShowAsCylinders(e.target.checked)}
                  className="rounded bg-neutral-700 border-neutral-600 w-3 h-3 accent-neutral-500"
                />
                Show as cylinders
              </label>
              {skeletonShowAsCylinders && (
                <div className="mb-2">
                  <label className="text-[10px] text-neutral-400 block mb-1">Tube Radius: {skeletonTubeRadius.toFixed(3)}</label>
                  <input
                    type="range"
                    min="0.005"
                    max="0.1"
                    step="0.005"
                    value={skeletonTubeRadius}
                    onChange={(e) => setSkeletonTubeRadius(parseFloat(e.target.value))}
                    className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
                  />
                </div>
              )}
              <label className="flex items-center gap-2 text-[10px] text-neutral-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skeletonColorByBranchOrder}
                  onChange={(e) => setSkeletonColorByBranchOrder(e.target.checked)}
                  className="rounded bg-neutral-700 border-neutral-600 w-3 h-3 accent-neutral-500"
                />
                Color by branch order
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Left Control Panel */}
      <div className="absolute top-4 left-4 flex flex-col gap-2">
        {/* View Controls */}
        <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg p-2 shadow-lg flex gap-1">
          <button onClick={() => (window as any).__resetPointCloudCamera?.()} className="p-2 hover:bg-neutral-700 rounded transition-colors flex items-center justify-center" title="Reset View">
            <Home className="w-4 h-4 text-neutral-300" />
          </button>
          <button onClick={() => { setShowCommandPalette(true); setCommandSearch(''); setCommandSelectedIndex(0); }} className="p-2 hover:bg-neutral-700 rounded transition-colors flex items-center justify-center" title="Search Commands (Cmd+K)">
            <Search className="w-4 h-4 text-neutral-300" />
          </button>
        </div>

        {/* Snap to View */}
        <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg p-2 shadow-lg">
          <div className="text-[10px] text-neutral-500 mb-1.5 text-center">Snap View</div>
          <div className="grid grid-cols-3 gap-0.5">
            <div />
            <button onClick={() => (window as any).__snapToView?.('back', getSnapViewTarget())} className="p-1.5 hover:bg-neutral-700 rounded" title="Back View"><ArrowUp className="w-3 h-3 text-neutral-300" /></button>
            <div />
            <button onClick={() => (window as any).__snapToView?.('left', getSnapViewTarget())} className="p-1.5 hover:bg-neutral-700 rounded" title="Left View"><ArrowLeft className="w-3 h-3 text-neutral-300" /></button>
            <button onClick={() => (window as any).__snapToView?.('top', getSnapViewTarget())} className="p-1.5 hover:bg-neutral-700 rounded" title="Top View"><Circle className="w-3 h-3 text-neutral-300" /></button>
            <button onClick={() => (window as any).__snapToView?.('right', getSnapViewTarget())} className="p-1.5 hover:bg-neutral-700 rounded" title="Right View"><ArrowRight className="w-3 h-3 text-neutral-300" /></button>
            <button onClick={() => (window as any).__snapToView?.('iso', getSnapViewTarget())} className="p-1.5 hover:bg-neutral-700 rounded" title="Isometric"><Square className="w-3 h-3 text-neutral-300 rotate-45" /></button>
            <button onClick={() => (window as any).__snapToView?.('front', getSnapViewTarget())} className="p-1.5 hover:bg-neutral-700 rounded" title="Front View"><ArrowDown className="w-3 h-3 text-neutral-300" /></button>
            <button onClick={() => (window as any).__snapToView?.('bottom', getSnapViewTarget())} className="p-1.5 hover:bg-neutral-700 rounded" title="Bottom View"><Circle className="w-2.5 h-2.5 text-neutral-500" /></button>
          </div>
        </div>

        {/* Create Shapes - always visible */}
        <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg p-2 shadow-lg">
          <div className="text-[10px] text-neutral-500 mb-1.5 text-center">Create</div>
          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={() => handleCreateShape('voxel')}
              className="p-2 rounded transition-colors hover:bg-cyan-600 hover:text-white bg-neutral-700"
              title="Create Voxel (Cube)"
            >
              <Box className="w-4 h-4 text-neutral-300" />
            </button>
            <button
              onClick={() => handleCreateShape('cylinder')}
              className="p-2 rounded transition-colors hover:bg-cyan-600 hover:text-white bg-neutral-700"
              title="Create Cylinder"
            >
              <svg className="w-4 h-4 text-neutral-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <ellipse cx="12" cy="5" rx="8" ry="3" />
                <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
              </svg>
            </button>
            <button
              onClick={() => handleCreateShape('sphere')}
              className="p-2 rounded transition-colors hover:bg-cyan-600 hover:text-white bg-neutral-700"
              title="Create Sphere"
            >
              <Circle className="w-4 h-4 text-neutral-300" />
            </button>
            <button
              onClick={() => handleCreateShape('cone')}
              className="p-2 rounded transition-colors hover:bg-cyan-600 hover:text-white bg-neutral-700"
              title="Create Cone"
            >
              <Triangle className="w-4 h-4 text-neutral-300" />
            </button>
            <button
              data-testid="tool-plant-generate"
              onClick={() => setShowPlantPopup(true)}
              disabled={isGeneratingPlant}
              className={`p-2 rounded transition-colors ${isGeneratingPlant ? 'bg-neutral-600 cursor-wait' : 'hover:bg-neutral-600 bg-neutral-700'}`}
              title="Generate Plant Model"
            >
              {isGeneratingPlant ? (
                <Loader2 className="w-4 h-4 text-neutral-400 animate-spin" />
              ) : (
                <Sprout className="w-4 h-4 text-neutral-300" />
              )}
            </button>
          </div>
        </div>

        {/* Tools - show for any selection type */}
        {selectionType !== 'none' && (
          <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg p-2 shadow-lg">
            <div className="text-[10px] text-neutral-500 mb-1.5 text-center">Tools</div>
            <div className="grid grid-cols-2 gap-1">
              {/* Mixed Selection Tools - Only Move to Origin and Alignment */}
              {selectionType === 'mixed' && (
                <>
                  {/* Move to Origin */}
                  <button
                    onClick={handleMoveToOrigin}
                    className="p-2 rounded transition-colors hover:bg-neutral-700"
                    title="Move to Origin"
                  >
                    <CircleDot className="w-4 h-4 text-neutral-300" />
                  </button>
                  {/* Alignment */}
                  <button
                    onClick={() => showAlignmentPanel ? setShowAlignmentPanel(false) : handleAlignmentCompute()}
                    className={`p-2 rounded transition-colors ${showAlignmentPanel ? 'bg-cyan-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Alignment"
                    disabled={isComputingAlignment}
                  >
                    {isComputingAlignment ? (
                      <Loader2 className="w-4 h-4 text-neutral-300 animate-spin" />
                    ) : (
                      <Globe className={`w-4 h-4 ${showAlignmentPanel ? 'text-white' : 'text-neutral-300'}`} />
                    )}
                  </button>
                </>
              )}
              {/* Multi-Cloud Selection Tools - Move to Origin and Alignment (Cloud-to-Cloud ICP) */}
              {selectionType === 'multiCloud' && (
                <>
                  {/* Move to Origin */}
                  <button
                    onClick={handleMoveToOrigin}
                    className="p-2 rounded transition-colors hover:bg-neutral-700"
                    title="Move to Origin"
                  >
                    <CircleDot className="w-4 h-4 text-neutral-300" />
                  </button>
                  {/* Alignment (Cloud-to-Cloud ICP) */}
                  <button
                    onClick={handleCloudToCloudICP}
                    className={`p-2 rounded transition-colors ${isRunningICP ? 'bg-cyan-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Alignment - Align second cloud to first cloud (ICP)"
                    disabled={isRunningICP || selectedIds.size !== 2}
                  >
                    {isRunningICP ? (
                      <Loader2 className="w-4 h-4 text-neutral-300 animate-spin" />
                    ) : (
                      <Globe className={`w-4 h-4 ${selectedIds.size === 2 ? 'text-neutral-300' : 'text-neutral-500'}`} />
                    )}
                  </button>
                  {/* Triangulate (Helios - multi-scan) - open popup directly */}
                  <button
                    onClick={() => {
                      closeAllToolPanels();
                      setShowHeliosPopup(true);
                    }}
                    className={`p-2 rounded transition-colors ${showHeliosPopup ? 'bg-green-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Triangulate (Helios)"
                  >
                    <Triangle className={`w-4 h-4 ${showHeliosPopup ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                </>
              )}
              {/* Multi-Mesh Tools (2+ meshes selected) */}
              {selectionType === 'multiMesh' && (
                <>
                  {/* Move to Origin */}
                  <button
                    onClick={handleMoveToOrigin}
                    className="p-2 rounded transition-colors hover:bg-neutral-700"
                    title="Move to Origin"
                  >
                    <CircleDot className="w-4 h-4 text-neutral-300" />
                  </button>
                  {/* Alignment (Mesh-to-Mesh ICP) */}
                  <button
                    onClick={handleMeshToMeshICP}
                    className={`p-2 rounded transition-colors ${isRunningICP ? 'bg-cyan-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Alignment - Align second mesh to first mesh (ICP)"
                    disabled={isRunningICP || selectedMeshIds.size !== 2}
                  >
                    {isRunningICP ? (
                      <Loader2 className="w-4 h-4 text-neutral-300 animate-spin" />
                    ) : (
                      <Globe className={`w-4 h-4 ${selectedMeshIds.size === 2 ? 'text-neutral-300' : 'text-neutral-500'}`} />
                    )}
                  </button>
                </>
              )}
              {/* Point Cloud Tools - Order: Move to Origin, Translate, Crop, Filter, Erase, Stitch, Triangulate, Extract Skeleton, Export, Delete */}
              {selectionType === 'cloud' && (
                <>
                  {/* 1. Move to Origin */}
                  <button
                    onClick={handleMoveToOrigin}
                    className="p-2 rounded transition-colors hover:bg-neutral-700"
                    title="Move to Origin"
                  >
                    <CircleDot className="w-4 h-4 text-neutral-300" />
                  </button>
                  {/* 2. Translate */}
                  <button
                    onClick={() => {
                      if (editMode === 'translate') {
                        setEditMode('none');
                      } else {
                        closeAllToolPanels('editMode');
                        setEditMode('translate');
                      }
                    }}
                    className={`p-2 rounded transition-colors ${editMode === 'translate' ? 'bg-blue-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Translate"
                  >
                    <Move className={`w-4 h-4 ${editMode === 'translate' ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                  {/* 3. Crop */}
                  <button
                    onClick={() => {
                      if (editMode === 'crop') {
                        setEditMode('none');
                      } else {
                        closeAllToolPanels('editMode');
                        // When entering crop mode, reset bounds to effective data bounds (accounting for erasure)
                        // Crop bounds are in LOCAL coordinates (before translation)
                        for (const cloudId of selectedIds) {
                          const cloud = clouds.find(c => c.id === cloudId);
                          if (cloud) {
                            const state = getEditState(cloudId);
                            // Get effective bounds (with erasure applied, but no crop preview)
                            // getDisplayData returns bounds WITH translation applied,
                            // but crop bounds need LOCAL coordinates (without translation)
                            const effectiveData = getDisplayData(cloud, false);
                            const tx = state.translation.x;
                            const ty = state.translation.y;
                            const tz = state.translation.z;
                            setEditStates(prev => {
                              const next = new Map(prev);
                              const currentState = next.get(cloudId) || state;
                              next.set(cloudId, {
                                ...currentState,
                                cropMin: {
                                  x: effectiveData.bounds.min.x - tx,
                                  y: effectiveData.bounds.min.y - ty,
                                  z: effectiveData.bounds.min.z - tz
                                },
                                cropMax: {
                                  x: effectiveData.bounds.max.x - tx,
                                  y: effectiveData.bounds.max.y - ty,
                                  z: effectiveData.bounds.max.z - tz
                                },
                              });
                              return next;
                            });
                          }
                        }
                        setEditMode('crop');
                      }
                    }}
                    className={`p-2 rounded transition-colors ${editMode === 'crop' ? 'bg-blue-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Crop"
                  >
                    <Crop className={`w-4 h-4 ${editMode === 'crop' ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                  {/* 4. Filter (single cloud only) */}
                  {selectedIds.size === 1 && (
                    <button
                      onClick={() => {
                        if (showFilterPanel) {
                          setShowFilterPanel(false);
                        } else {
                          closeAllToolPanels('filter');
                          setShowFilterPanel(true);
                        }
                      }}
                      className={`p-2 rounded transition-colors ${showFilterPanel ? 'bg-cyan-600 text-white' : 'hover:bg-neutral-700'}`}
                      title="Filter Points"
                    >
                      <Filter className={`w-4 h-4 ${showFilterPanel ? 'text-white' : 'text-neutral-300'}`} />
                    </button>
                  )}
                  {/* 4b. Resample (single cloud only) */}
                  {selectedIds.size === 1 && (
                    <button
                      onClick={() => {
                        if (showResamplePanel) {
                          setShowResamplePanel(false);
                          setResamplePreview(null); // Clear preview when closing
                        } else {
                          closeAllToolPanels('resample');
                          setShowResamplePanel(true);
                        }
                      }}
                      className={`p-2 rounded transition-colors ${showResamplePanel ? 'bg-cyan-600 text-white' : 'hover:bg-neutral-700'}`}
                      title="Resample"
                    >
                      <ChartScatter className={`w-4 h-4 ${showResamplePanel ? 'text-white' : 'text-neutral-300'}`} />
                    </button>
                  )}
                  {/* 5. Erase (single cloud only) */}
                  {selectedIds.size === 1 && (
                    <button
                      onClick={() => {
                        if (editMode === 'erase') {
                          setEditMode('none');
                        } else {
                          closeAllToolPanels('editMode');
                          setEditMode('erase');
                        }
                      }}
                      className={`p-2 rounded transition-colors ${editMode === 'erase' ? 'bg-red-600 text-white' : 'hover:bg-neutral-700'}`}
                      title="Erase Brush"
                    >
                      <Eraser className={`w-4 h-4 ${editMode === 'erase' ? 'text-white' : 'text-neutral-300'}`} />
                    </button>
                  )}
                  {/* 5b. Alignment (greyed out - use from mixed selection toolbar) */}
                  <button
                    className="p-2 rounded transition-colors opacity-40 cursor-not-allowed"
                    title="Align Selected Objects"
                    disabled={true}
                  >
                    <Globe className="w-4 h-4 text-neutral-500" />
                  </button>
                  {/* 6. Stitch (requires 2+ clouds) */}
                  <button
                    onClick={() => onStitchClouds?.(Array.from(selectedIds))}
                    className={`p-2 rounded transition-colors ${selectedIds.size >= 2 ? 'hover:bg-neutral-700' : 'opacity-40 cursor-not-allowed'}`}
                    title="Stitch Selected Clouds"
                    disabled={selectedIds.size < 2 || !onStitchClouds}
                  >
                    <Merge className={`w-4 h-4 ${selectedIds.size >= 2 ? 'text-neutral-300' : 'text-neutral-500'}`} />
                  </button>
                  {/* 7. Triangulate */}
                  <button
                    data-testid="tool-triangulate"
                    onClick={() => {
                      if (showTriangulationPanel) {
                        setShowTriangulationPanel(false);
                      } else {
                        closeAllToolPanels('triangulation');
                        setShowTriangulationPanel(true);
                      }
                    }}
                    className={`p-2 rounded transition-colors ${showTriangulationPanel ? 'bg-green-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Triangulate"
                  >
                    <Triangle className={`w-4 h-4 ${showTriangulationPanel ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                  {/* 8. Extract Skeleton (single cloud only) */}
                  <button
                    data-testid="tool-skeleton"
                    onClick={() => {
                      if (showSkeletonPanel) {
                        setShowSkeletonPanel(false);
                      } else {
                        closeAllToolPanels('skeleton');
                        setShowSkeletonPanel(true);
                      }
                    }}
                    className={`p-2 rounded transition-colors ${showSkeletonPanel ? 'bg-amber-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Extract Skeleton"
                    disabled={selectedIds.size !== 1}
                  >
                    <GitBranch className={`w-4 h-4 ${showSkeletonPanel ? 'text-white' : selectedIds.size !== 1 ? 'text-neutral-500' : 'text-neutral-300'}`} />
                  </button>
                  {/* 9. Export */}
                  <button
                    data-testid="tool-export-cloud"
                    onClick={() => {
                      if (showExportPanel) {
                        setShowExportPanel(false);
                      } else {
                        closeAllToolPanels('export');
                        setShowExportPanel(true);
                      }
                    }}
                    className={`p-2 rounded transition-colors ${showExportPanel ? 'bg-purple-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Export"
                  >
                    <Download className={`w-4 h-4 ${showExportPanel ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                  {/* 11. Delete (single cloud only) */}
                  {selectedIds.size === 1 && (
                    <button
                      onClick={() => {
                        const cloudId = Array.from(selectedIds)[0];
                        const cloud = clouds.find(c => c.id === cloudId);
                        if (cloud) {
                          setDeleteConfirm({ type: 'cloud', id: cloudId, name: cloud.data.fileName || 'Point Cloud' });
                        }
                      }}
                      className="p-2 rounded transition-colors hover:bg-red-600/30"
                      title="Delete Point Cloud"
                    >
                      <Trash2 className="w-4 h-4 text-neutral-300 hover:text-red-400" />
                    </button>
                  )}
                </>
              )}

              {/* Mesh Tools */}
              {selectionType === 'mesh' && selectedMesh && (
                <>
                  {/* 1. Move to Origin */}
                  <button
                    onClick={handleMoveToOrigin}
                    className="p-2 rounded transition-colors hover:bg-neutral-700"
                    title="Move to Origin"
                  >
                    <CircleDot className="w-4 h-4 text-neutral-300" />
                  </button>
                  {/* 2. Translate */}
                  <button
                    onClick={() => setEditMode(editMode === 'translate' ? 'none' : 'translate')}
                    className={`p-2 rounded transition-colors ${editMode === 'translate' ? 'bg-blue-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Translate"
                  >
                    <Move className={`w-4 h-4 ${editMode === 'translate' ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                  {/* 3. Resize */}
                  <button
                    onClick={() => setShowResizePanel(!showResizePanel)}
                    className={`p-2 rounded transition-colors ${showResizePanel ? 'bg-blue-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Resize"
                  >
                    <Maximize2 className={`w-4 h-4 ${showResizePanel ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                  {/* 4. Rotate */}
                  <button
                    onClick={() => setEditMode(editMode === 'rotate' ? 'none' : 'rotate')}
                    className={`p-2 rounded transition-colors ${editMode === 'rotate' ? 'bg-blue-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Rotate"
                  >
                    <RotateCcw className={`w-4 h-4 ${editMode === 'rotate' ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                  {/* 5. Sample to Point Cloud */}
                  <button
                    onClick={() => setShowSamplingPopup(true)}
                    disabled={isSamplingMesh}
                    className="p-2 rounded transition-colors hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Sample to Point Cloud"
                  >
                    {isSamplingMesh ? (
                      <Loader2 className="w-4 h-4 text-neutral-300 animate-spin" />
                    ) : (
                      <ChartScatter className="w-4 h-4 text-neutral-300" />
                    )}
                  </button>
                  {/* 6. Plant Growth (if plant) */}
                  {selectedMesh.isPlant && (
                    <button
                      onClick={() => setShowPlantGrowthPanel(!showPlantGrowthPanel)}
                      className={`p-2 rounded transition-colors ${showPlantGrowthPanel ? 'bg-neutral-600 text-white' : 'hover:bg-neutral-700'}`}
                      title="Plant Growth"
                    >
                      <ClockPlus className={`w-4 h-4 ${showPlantGrowthPanel ? 'text-white' : 'text-neutral-300'}`} />
                    </button>
                  )}
                  {/* 6b. Morph Plant (if plant) */}
                  {selectedMesh.isPlant && (
                    <button
                      onClick={() => setShowMorphPopup(!showMorphPopup)}
                      className={`p-2 rounded transition-colors ${showMorphPopup ? 'bg-amber-600 text-white' : 'hover:bg-neutral-700'}`}
                      title="Morph Plant Parameters"
                      disabled={isMorphing}
                    >
                      {isMorphing ? (
                        <Loader2 className="w-4 h-4 text-amber-300 animate-spin" />
                      ) : (
                        <Dna className={`w-4 h-4 ${showMorphPopup ? 'text-white' : 'text-neutral-300'}`} />
                      )}
                    </button>
                  )}
                  {/* 7. Export */}
                  <button
                    data-testid="tool-export-mesh"
                    onClick={() => {
                      if (showExportPanel) {
                        setShowExportPanel(false);
                      } else {
                        closeAllToolPanels('export');
                        setShowExportPanel(true);
                      }
                    }}
                    className={`p-2 rounded transition-colors ${showExportPanel ? 'bg-purple-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Export"
                  >
                    <Download className={`w-4 h-4 ${showExportPanel ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                </>
              )}

              {/* Skeleton Tools */}
              {selectionType === 'skeleton' && selectedSkeleton && (
                <>
                  <button
                    onClick={handleMoveToOrigin}
                    className="p-2 rounded transition-colors hover:bg-neutral-700"
                    title="Move to Origin"
                  >
                    <CircleDot className="w-4 h-4 text-neutral-300" />
                  </button>
                  <button
                    onClick={() => setEditMode(editMode === 'translate' ? 'none' : 'translate')}
                    className={`p-2 rounded transition-colors ${editMode === 'translate' ? 'bg-blue-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Translate"
                  >
                    <Move className={`w-4 h-4 ${editMode === 'translate' ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                  <button
                    data-testid="tool-export-skeleton"
                    onClick={() => {
                      if (showExportPanel) {
                        setShowExportPanel(false);
                      } else {
                        closeAllToolPanels('export');
                        setShowExportPanel(true);
                      }
                    }}
                    className={`p-2 rounded transition-colors ${showExportPanel ? 'bg-purple-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Export"
                  >
                    <Download className={`w-4 h-4 ${showExportPanel ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                </>
              )}

              {/* Delete - available for meshes and skeletons */}
              {selectionType === 'mesh' && selectedMesh && (
                <button
                  onClick={() => {
                    const sourceName = clouds.find(c => c.id === selectedMesh.sourceCloudId)?.data.fileName || 'Mesh';
                    setDeleteConfirm({ type: 'mesh', id: selectedMesh.id, name: sourceName });
                  }}
                  className="p-2 rounded transition-colors hover:bg-red-600/30"
                  title="Delete Mesh"
                >
                  <Trash2 className="w-4 h-4 text-neutral-300 hover:text-red-400" />
                </button>
              )}
              {selectionType === 'skeleton' && selectedSkeleton && (
                <button
                  onClick={() => {
                    const sourceName = clouds.find(c => c.id === selectedSkeleton.sourceCloudId)?.data.fileName || 'Skeleton';
                    setDeleteConfirm({ type: 'skeleton', id: selectedSkeleton.id, name: sourceName });
                  }}
                  className="p-2 rounded transition-colors hover:bg-red-600/30"
                  title="Delete Skeleton"
                >
                  <Trash2 className="w-4 h-4 text-neutral-300 hover:text-red-400" />
                </button>
              )}

              {/* Undo/Redo - available for all selection types */}
              <div className="col-span-2 border-t border-neutral-700 my-1" />
              <button onClick={handleUndo} disabled={historyIndex < 0 && !canUndoStitch?.()} className={`p-2 rounded ${historyIndex >= 0 || canUndoStitch?.() ? 'hover:bg-neutral-700' : 'opacity-40'}`} title="Undo (Ctrl+Z)">
                <Undo2 className="w-4 h-4 text-neutral-300" />
              </button>
              <button onClick={handleRedo} disabled={historyIndex >= history.length - 1} className={`p-2 rounded ${historyIndex < history.length - 1 ? 'hover:bg-neutral-700' : 'opacity-40'}`} title="Redo (Ctrl+Y)">
                <Redo2 className="w-4 h-4 text-neutral-300" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Crop Panel */}
      {editMode === 'crop' && firstSelectedCloud && (() => {
        const editState = getEditState(firstSelectedCloud.id);
        if (!editState.cropMin || !editState.cropMax) return null;

        return (
          <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56">
            <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center gap-2">
              <Crop className="w-3 h-3" />
              Crop Region
            </div>
            <div className="mb-3 p-2 bg-neutral-900/50 rounded">
              <div className="text-[10px] text-neutral-400 mb-2">Mode</div>
              <div className="flex gap-1">
                <button
                  onClick={() => { updateSelectedEditStates(s => ({ ...s, cropInvert: false })); setTimeout(saveToHistory, 0); }}
                  className={`flex-1 px-2 py-1.5 text-xs rounded ${!editState.cropInvert ? 'bg-green-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                >
                  Keep Inside
                </button>
                <button
                  onClick={() => { updateSelectedEditStates(s => ({ ...s, cropInvert: true })); setTimeout(saveToHistory, 0); }}
                  className={`flex-1 px-2 py-1.5 text-xs rounded ${editState.cropInvert ? 'bg-red-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                >
                  Keep Outside
                </button>
              </div>
            </div>
            {/* Crop Box Dimensions */}
            <div className="mb-3 p-2 bg-neutral-900/50 rounded">
              <div className="text-[10px] text-neutral-400 mb-2">Dimensions</div>
              <div className="grid grid-cols-3 gap-1">
                {['X', 'Y', 'Z'].map((axis) => {
                  const axisKey = axis.toLowerCase() as 'x' | 'y' | 'z';
                  const size = editState.cropMax && editState.cropMin
                    ? (editState.cropMax[axisKey] - editState.cropMin[axisKey]).toFixed(2)
                    : '0';
                  return (
                    <div key={axis} className="flex flex-col">
                      <label className="text-[9px] text-neutral-500 mb-0.5">{axis}</label>
                      <input
                        type="number"
                        step="0.1"
                        value={size}
                        onChange={(e) => {
                          const newSize = parseFloat(e.target.value) || 0;
                          if (editState.cropMin && editState.cropMax) {
                            const center = (editState.cropMin[axisKey] + editState.cropMax[axisKey]) / 2;
                            updateSelectedEditStates(s => ({
                              ...s,
                              cropMin: { ...s.cropMin!, [axisKey]: center - newSize / 2 },
                              cropMax: { ...s.cropMax!, [axisKey]: center + newSize / 2 },
                            }));
                          }
                        }}
                        className="w-full px-1 py-0.5 text-[10px] bg-neutral-700 border border-neutral-600 rounded text-white text-center"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Crop Box Center Location */}
            <div className="mb-3 p-2 bg-neutral-900/50 rounded">
              <div className="text-[10px] text-neutral-400 mb-2">Center Position</div>
              <div className="grid grid-cols-3 gap-1">
                {['X', 'Y', 'Z'].map((axis) => {
                  const axisKey = axis.toLowerCase() as 'x' | 'y' | 'z';
                  const center = editState.cropMax && editState.cropMin
                    ? ((editState.cropMax[axisKey] + editState.cropMin[axisKey]) / 2).toFixed(2)
                    : '0';
                  return (
                    <div key={axis} className="flex flex-col">
                      <label className="text-[9px] text-neutral-500 mb-0.5">{axis}</label>
                      <input
                        type="number"
                        step="0.1"
                        value={center}
                        onChange={(e) => {
                          const newCenter = parseFloat(e.target.value) || 0;
                          if (editState.cropMin && editState.cropMax) {
                            const halfSize = (editState.cropMax[axisKey] - editState.cropMin[axisKey]) / 2;
                            updateSelectedEditStates(s => ({
                              ...s,
                              cropMin: { ...s.cropMin!, [axisKey]: newCenter - halfSize },
                              cropMax: { ...s.cropMax!, [axisKey]: newCenter + halfSize },
                            }));
                          }
                        }}
                        className="w-full px-1 py-0.5 text-[10px] bg-neutral-700 border border-neutral-600 rounded text-white text-center"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Hint about applying */}
            <div className="text-[10px] text-neutral-400 text-center mb-2 py-1">
              Press <span className="text-green-400 font-medium">Enter</span> to apply crop
            </div>
            <button
              onClick={() => {
                // Reset crop box to current cloud bounds
                updateSelectedEditStates(s => ({
                  ...s,
                  cropMin: { x: firstSelectedCloud.data.bounds.min.x, y: firstSelectedCloud.data.bounds.min.y, z: firstSelectedCloud.data.bounds.min.z },
                  cropMax: { x: firstSelectedCloud.data.bounds.max.x, y: firstSelectedCloud.data.bounds.max.y, z: firstSelectedCloud.data.bounds.max.z },
                  cropInvert: false,
                }));
              }}
              className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
            >
              Reset Crop Box
            </button>
          </div>
        );
      })()}

      {/* Erase Brush Panel */}
      {editMode === 'erase' && firstSelectedCloud && (() => {
        const editState = getEditState(firstSelectedCloud.id);
        const erasedCount = editState.erasedIndices?.size || 0;

        return (
          <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56">
            <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center gap-2">
              <Eraser className="w-3 h-3" />
              Erase Brush
            </div>
            <div className="mb-3">
              <label className="text-[10px] text-neutral-400 block mb-1">
                Brush Size: {eraseBrushSize.toFixed(2)}
              </label>
              <input
                type="range"
                min="0.01"
                max="1"
                step="0.01"
                value={eraseBrushSize}
                onChange={(e) => setEraseBrushSize(parseFloat(e.target.value))}
                className="w-full h-1 bg-neutral-600 rounded appearance-none cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-neutral-500 mt-1">
                <span>Small</span>
                <span>Large</span>
              </div>
            </div>
            <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
              {erasedCount > 0 ? (
                <span>{erasedCount.toLocaleString()} points erased</span>
              ) : (
                <span>Hold 'E' and move cursor to erase</span>
              )}
            </div>
            {erasedCount > 0 && (
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleApplyErase}
                  className="w-full px-2 py-1.5 text-xs bg-red-600 hover:bg-red-500 rounded text-white font-medium"
                >
                  Apply Erase ({erasedCount.toLocaleString()} points)
                </button>
                <button
                  onClick={() => {
                    saveToHistory();
                    updateSelectedEditStates(s => ({ ...s, erasedIndices: new Set<number>() }));
                    setTimeout(saveToHistory, 0);
                  }}
                  className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
                >
                  Restore All Points
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {/* Filter Panel */}
      {showFilterPanel && firstSelectedCloud && (() => {
        const cloud = firstSelectedCloud;
        const data = cloud.data;
        const currentFilters = cloudFilters.get(cloud.id);

        // Get or create default filters based on cloud data
        const getDefaultFilters = (): CloudFilters => ({
          x: { min: data.bounds.min.x, max: data.bounds.max.x, enabled: false },
          y: { min: data.bounds.min.y, max: data.bounds.max.y, enabled: false },
          z: { min: data.bounds.min.z, max: data.bounds.max.z, enabled: false },
          intensity: data.intensities ? { min: 0, max: 1, enabled: false } : undefined,
          scalarFields: Object.fromEntries(
            Object.entries(data.scalarFields || {}).map(([name, field]) => [
              name,
              { min: field.min, max: field.max, enabled: false }
            ])
          )
        });

        const filters = currentFilters || getDefaultFilters();

        // Build list of available fields for dropdown
        const availableFields: { value: string; label: string; bounds: { min: number; max: number } }[] = [
          { value: 'x', label: 'X', bounds: { min: data.bounds.min.x, max: data.bounds.max.x } },
          { value: 'y', label: 'Y', bounds: { min: data.bounds.min.y, max: data.bounds.max.y } },
          { value: 'z', label: 'Z', bounds: { min: data.bounds.min.z, max: data.bounds.max.z } },
        ];
        if (data.intensities) {
          availableFields.push({ value: 'intensity', label: 'Intensity', bounds: { min: 0, max: 1 } });
        }
        Object.entries(data.scalarFields || {}).forEach(([name, field]) => {
          availableFields.push({ value: `scalar:${name}`, label: name, bounds: { min: field.min, max: field.max } });
        });

        // Get current filter values for selected field
        const getFieldFilter = (fieldValue: string): FilterRange | undefined => {
          if (fieldValue === 'x') return filters.x;
          if (fieldValue === 'y') return filters.y;
          if (fieldValue === 'z') return filters.z;
          if (fieldValue === 'intensity') return filters.intensity;
          if (fieldValue.startsWith('scalar:')) {
            const name = fieldValue.substring(7);
            return filters.scalarFields[name];
          }
          return undefined;
        };

        // Apply filter for the selected field
        const applyFilter = () => {
          if (!selectedFilterField) return;
          const min = parseFloat(pendingFilterMin);
          const max = parseFloat(pendingFilterMax);
          if (isNaN(min) || isNaN(max)) return;

          const newFilters = { ...filters };
          if (selectedFilterField === 'x') {
            newFilters.x = { min, max, enabled: true };
          } else if (selectedFilterField === 'y') {
            newFilters.y = { min, max, enabled: true };
          } else if (selectedFilterField === 'z') {
            newFilters.z = { min, max, enabled: true };
          } else if (selectedFilterField === 'intensity' && newFilters.intensity) {
            newFilters.intensity = { min, max, enabled: true };
          } else if (selectedFilterField.startsWith('scalar:')) {
            const name = selectedFilterField.substring(7);
            newFilters.scalarFields = {
              ...newFilters.scalarFields,
              [name]: { min, max, enabled: true }
            };
          }
          setCloudFilters(new Map(cloudFilters).set(cloud.id, newFilters));
        };

        // Remove filter for the selected field
        const removeFilter = () => {
          if (!selectedFilterField) return;
          const field = availableFields.find(f => f.value === selectedFilterField);
          if (!field) return;

          const newFilters = { ...filters };
          if (selectedFilterField === 'x') {
            newFilters.x = { min: field.bounds.min, max: field.bounds.max, enabled: false };
          } else if (selectedFilterField === 'y') {
            newFilters.y = { min: field.bounds.min, max: field.bounds.max, enabled: false };
          } else if (selectedFilterField === 'z') {
            newFilters.z = { min: field.bounds.min, max: field.bounds.max, enabled: false };
          } else if (selectedFilterField === 'intensity' && newFilters.intensity) {
            newFilters.intensity = { min: field.bounds.min, max: field.bounds.max, enabled: false };
          } else if (selectedFilterField.startsWith('scalar:')) {
            const name = selectedFilterField.substring(7);
            newFilters.scalarFields = {
              ...newFilters.scalarFields,
              [name]: { min: field.bounds.min, max: field.bounds.max, enabled: false }
            };
          }
          setCloudFilters(new Map(cloudFilters).set(cloud.id, newFilters));
          setPendingFilterMin(field.bounds.min.toFixed(4));
          setPendingFilterMax(field.bounds.max.toFixed(4));
        };

        const hasAnyFilter = filters.x.enabled || filters.y.enabled || filters.z.enabled ||
          filters.intensity?.enabled ||
          Object.values(filters.scalarFields).some(f => f.enabled);

        const clearAllFilters = () => {
          setCloudFilters(new Map(cloudFilters).set(cloud.id, getDefaultFilters()));
          if (selectedFilterField) {
            const field = availableFields.find(f => f.value === selectedFilterField);
            if (field) {
              setPendingFilterMin(field.bounds.min.toFixed(4));
              setPendingFilterMax(field.bounds.max.toFixed(4));
            }
          }
        };

        // Handle field selection change
        const handleFieldChange = (fieldValue: string) => {
          setSelectedFilterField(fieldValue);
          const field = availableFields.find(f => f.value === fieldValue);
          const currentFilter = getFieldFilter(fieldValue);
          if (currentFilter) {
            setPendingFilterMin(currentFilter.min.toFixed(4));
            setPendingFilterMax(currentFilter.max.toFixed(4));
          } else if (field) {
            setPendingFilterMin(field.bounds.min.toFixed(4));
            setPendingFilterMax(field.bounds.max.toFixed(4));
          }
        };

        // Get active filters list
        const activeFilters = availableFields.filter(f => {
          const filter = getFieldFilter(f.value);
          return filter?.enabled;
        });

        // Get bounds for selected field
        const selectedField = availableFields.find(f => f.value === selectedFilterField);
        const currentFilter = selectedFilterField ? getFieldFilter(selectedFilterField) : undefined;

        return (
          <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
                <Filter className="w-3 h-3" />
                Filter Points
              </div>
              <button
                onClick={() => setShowFilterPanel(false)}
                className="p-1 hover:bg-neutral-700 rounded"
              >
                <X className="w-3 h-3 text-neutral-400" />
              </button>
            </div>

            {/* Field Dropdown */}
            <div className="mb-3">
              <label className="text-[10px] text-neutral-400 block mb-1">Field</label>
              <select
                value={selectedFilterField || ''}
                onChange={(e) => handleFieldChange(e.target.value)}
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
              >
                <option value="">Select a field...</option>
                {availableFields.map(f => (
                  <option key={f.value} value={f.value}>
                    {f.label} {getFieldFilter(f.value)?.enabled ? '(active)' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Min/Max Inputs - only show when field is selected */}
            {selectedFilterField && selectedField && (
              <div className="mb-3">
                <div className="text-[10px] text-neutral-500 mb-1">
                  Range: {selectedField.bounds.min.toFixed(2)} to {selectedField.bounds.max.toFixed(2)}
                </div>
                <div className="flex gap-2 mb-2">
                  <div className="flex-1">
                    <label className="text-[10px] text-neutral-400 block mb-1">Min</label>
                    <input
                      type="number"
                      value={pendingFilterMin}
                      onChange={(e) => setPendingFilterMin(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && applyFilter()}
                      step="any"
                      className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] text-neutral-400 block mb-1">Max</label>
                    <input
                      type="number"
                      value={pendingFilterMax}
                      onChange={(e) => setPendingFilterMax(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && applyFilter()}
                      step="any"
                      className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={applyFilter}
                    className="flex-1 px-2 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 rounded text-white"
                  >
                    Apply
                  </button>
                  {currentFilter?.enabled && (
                    <button
                      onClick={removeFilter}
                      className="px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <div className="text-[9px] text-neutral-500 mt-1">Press Enter to apply</div>
              </div>
            )}

            {/* Active Filters List */}
            {activeFilters.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] text-neutral-500 mb-1 font-medium">Active Filters</div>
                <div className="space-y-1">
                  {activeFilters.map(f => {
                    const filter = getFieldFilter(f.value);
                    return (
                      <div key={f.value} className="text-[10px] text-neutral-300 bg-neutral-900/50 rounded px-2 py-1 flex justify-between items-center">
                        <span>{f.label}: {filter?.min.toFixed(2)} - {filter?.max.toFixed(2)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Clear All button */}
            {hasAnyFilter && (
              <button
                onClick={clearAllFilters}
                className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded mb-2"
              >
                Clear All Filters
              </button>
            )}

            {/* Permanently apply filter */}
            {hasAnyFilter && (
              <button
                onClick={handleApplyFilterPermanently}
                className="w-full px-2 py-1.5 text-xs bg-red-600 hover:bg-red-500 rounded text-white"
              >
                Permanently Filter Point Cloud
              </button>
            )}
          </div>
        );
      })()}

      {/* Resample Panel */}
      {showResamplePanel && firstSelectedCloud && (() => {
        const cloud = firstSelectedCloud;
        const originalCount = resamplePreview?.cloudId === cloud.id
          ? resamplePreview.originalPointCount
          : cloud.data.pointCount;
        const isPreviewActive = resamplePreview?.cloudId === cloud.id;
        const previewCount = isPreviewActive ? resamplePreview.previewData.pointCount : null;

        // Helper to compute resampled data
        const computeResampledData = () => {
          const data = cloud.data;
          const sourceCount = data.pointCount;
          const targetCount = Math.max(1, Math.round(originalCount * resampleFraction));

          // Generate random indices to keep
          const indices: number[] = [];
          for (let i = 0; i < sourceCount; i++) {
            indices.push(i);
          }
          // Fisher-Yates shuffle and take first targetCount
          for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
          }
          const keptIndices = indices.slice(0, targetCount).sort((a, b) => a - b);

          // Build new arrays
          const newPositions = new Float32Array(targetCount * 3);
          const newColors = data.colors ? new Float32Array(targetCount * 3) : undefined;
          const newIntensities = data.intensities ? new Float32Array(targetCount) : undefined;
          const newScalarFields: Record<string, { values: Float32Array; min: number; max: number }> = {};

          // Initialize scalar fields
          Object.keys(data.scalarFields || {}).forEach(name => {
            newScalarFields[name] = {
              values: new Float32Array(targetCount),
              min: Infinity,
              max: -Infinity,
            };
          });

          // Copy data at kept indices
          for (let i = 0; i < targetCount; i++) {
            const srcIdx = keptIndices[i];
            newPositions[i * 3] = data.positions[srcIdx * 3];
            newPositions[i * 3 + 1] = data.positions[srcIdx * 3 + 1];
            newPositions[i * 3 + 2] = data.positions[srcIdx * 3 + 2];

            if (newColors && data.colors) {
              newColors[i * 3] = data.colors[srcIdx * 3];
              newColors[i * 3 + 1] = data.colors[srcIdx * 3 + 1];
              newColors[i * 3 + 2] = data.colors[srcIdx * 3 + 2];
            }
            if (newIntensities && data.intensities) {
              newIntensities[i] = data.intensities[srcIdx];
            }
            Object.entries(data.scalarFields || {}).forEach(([name, field]) => {
              const val = field.values[srcIdx];
              newScalarFields[name].values[i] = val;
              newScalarFields[name].min = Math.min(newScalarFields[name].min, val);
              newScalarFields[name].max = Math.max(newScalarFields[name].max, val);
            });
          }

          // Recompute bounds
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (let i = 0; i < targetCount; i++) {
            const x = newPositions[i * 3];
            const y = newPositions[i * 3 + 1];
            const z = newPositions[i * 3 + 2];
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          }

          return {
            ...data,
            positions: newPositions,
            colors: newColors,
            intensities: newIntensities,
            scalarFields: newScalarFields,
            pointCount: targetCount,
            bounds: {
              min: new THREE.Vector3(minX, minY, minZ),
              max: new THREE.Vector3(maxX, maxY, maxZ),
              center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
              size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ),
            },
          } as PointCloudData;
        };

        return (
          <div
            className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setResamplePreview(null);
                setShowResamplePanel(false);
              }
            }}
            ref={(el) => el?.focus()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
                <ChartScatter className="w-3 h-3" />
                Resample
              </div>
              <button
                onClick={() => {
                  setResamplePreview(null);
                  setShowResamplePanel(false);
                }}
                className="p-1 hover:bg-neutral-700 rounded"
              >
                <X className="w-3 h-3 text-neutral-400" />
              </button>
            </div>

            {/* Point count info */}
            <div className="mb-3 text-[10px] text-neutral-400">
              Original: {originalCount.toLocaleString()} points
              {isPreviewActive && (
                <span className="text-cyan-400 ml-2">(Preview: {previewCount?.toLocaleString()})</span>
              )}
            </div>

            {/* Fraction Input */}
            <div className="mb-3">
              <label className="text-[10px] text-neutral-400 block mb-1">Keep fraction (0.001 - 1.0)</label>
              <input
                type="number"
                min={0.001}
                max={1.0}
                step={0.01}
                value={resampleFraction}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) {
                    setResampleFraction(Math.min(1.0, Math.max(0.001, val)));
                    setResamplePreview(null); // Clear preview when fraction changes
                  }
                }}
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
              />
              {/* Quick presets */}
              <div className="flex gap-1 mt-1.5 flex-wrap">
                {[1.0, 0.5, 0.25, 0.1, 0.05, 0.01].map(preset => (
                  <button
                    key={preset}
                    onClick={() => {
                      setResampleFraction(preset);
                      setResamplePreview(null);
                    }}
                    className={`px-1.5 py-0.5 text-[10px] rounded ${
                      resampleFraction === preset
                        ? 'bg-cyan-600 text-white'
                        : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                    }`}
                  >
                    {preset * 100}%
                  </button>
                ))}
              </div>
            </div>

            {/* Result Preview */}
            <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
              Result: ~{Math.round(originalCount * resampleFraction).toLocaleString()} points
            </div>

            {/* Preview Button */}
            <button
              onClick={() => {
                if (resampleFraction >= 1.0) return;
                const previewData = computeResampledData();
                setResamplePreview({
                  cloudId: cloud.id,
                  previewData,
                  originalPointCount: originalCount,
                });
                showToast({
                  type: 'info',
                  title: 'Preview Active',
                  message: `Showing ${previewData.pointCount.toLocaleString()} points (temporary)`,
                });
              }}
              disabled={resampleFraction >= 1.0}
              className={`w-full px-2 py-1.5 text-xs rounded text-white mb-2 ${resampleFraction >= 1.0 ? 'bg-neutral-600 cursor-not-allowed' : 'bg-cyan-600 hover:bg-cyan-500'}`}
            >
              {isPreviewActive ? 'Refresh Preview' : 'Preview'}
            </button>

            {/* Permanently Resample Button */}
            <button
              onClick={() => {
                if (resampleFraction >= 1.0) return;

                // Use preview data if available, otherwise compute fresh
                const finalData = isPreviewActive ? resamplePreview.previewData : computeResampledData();

                // Update cloud data permanently
                onUpdateCloud(cloud.id, finalData);

                showToast({
                  type: 'success',
                  title: 'Resampled',
                  message: `Reduced from ${originalCount.toLocaleString()} to ${finalData.pointCount.toLocaleString()} points`,
                });
                setResamplePreview(null);
                setShowResamplePanel(false);
              }}
              disabled={resampleFraction >= 1.0}
              className={`w-full px-2 py-1.5 text-xs rounded text-white ${resampleFraction >= 1.0 ? 'bg-neutral-600 cursor-not-allowed' : 'bg-red-600 hover:bg-red-500'}`}
            >
              Permanently Resample Point Cloud
            </button>

            {/* Cancel Preview Button (only when preview is active) */}
            {isPreviewActive && (
              <button
                onClick={() => setResamplePreview(null)}
                className="w-full px-2 py-1.5 text-xs rounded text-neutral-300 bg-neutral-700 hover:bg-neutral-600 mt-2"
              >
                Cancel Preview
              </button>
            )}
          </div>
        );
      })()}

      {/* Triangulation Panel */}
      {showTriangulationPanel && selectedIds.size === 1 && (
        <div data-testid="triangulation-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <Triangle className="w-3 h-3" />
              Triangulation
            </div>
            <button
              onClick={() => setShowTriangulationPanel(false)}
              className="p-1 hover:bg-neutral-700 rounded"
            >
              <X className="w-3 h-3 text-neutral-400" />
            </button>
          </div>

          {/* Method Selection */}
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">Method</label>
            <select
              data-testid="triangulation-method"
              value={triangulationMethod}
              onChange={(e) => setTriangulationMethod(e.target.value as TriangulationMethod)}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
              disabled={triangulationInProgress}
            >
              <option value="ball_pivoting">Ball Pivoting</option>
              <option value="poisson">Poisson</option>
              <option value="alpha_shape">Alpha Shape</option>
              <option value="delaunay">Delaunay (2D)</option>
              <option value="helios">Helios</option>
            </select>
          </div>

          {/* Method Description */}
          <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
            {triangulationMethod === 'ball_pivoting' && 'Good for clean, uniformly sampled point clouds'}
            {triangulationMethod === 'poisson' && 'Creates watertight meshes, good for noisy data'}
            {triangulationMethod === 'alpha_shape' && 'Good for concave shapes'}
            {triangulationMethod === 'delaunay' && 'Fast 2D projection, best for roughly planar surfaces'}
            {triangulationMethod === 'helios' && 'Spherical Delaunay triangulation for multi-scan LiDAR data'}
          </div>

          {/* Method-specific Parameters */}
          {triangulationMethod === 'poisson' && (
            <div className="mb-3">
              <label className="text-[10px] text-neutral-400 block mb-1">
                Octree Depth: {poissonDepth}
              </label>
              <input
                data-testid="triangulation-poisson-depth"
                type="range"
                min="4"
                max="12"
                value={poissonDepth}
                onChange={(e) => setPoissonDepth(parseInt(e.target.value))}
                className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
                disabled={triangulationInProgress}
              />
              <div className="flex justify-between text-[9px] text-neutral-500 mt-0.5">
                <span>Coarse</span>
                <span>Fine</span>
              </div>
            </div>
          )}

          {triangulationMethod === 'alpha_shape' && (
            <div className="mb-3">
              <label className="flex items-center gap-2 text-[10px] text-neutral-400 mb-1">
                <input
                  type="checkbox"
                  checked={alphaValue === null}
                  onChange={(e) => setAlphaValue(e.target.checked ? null : 0.1)}
                  className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
                  disabled={triangulationInProgress}
                />
                Auto Alpha
              </label>
              {alphaValue !== null && (
                <input
                  type="number"
                  value={alphaValue}
                  onChange={(e) => setAlphaValue(parseFloat(e.target.value) || 0.1)}
                  className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600 mt-1"
                  step="0.01"
                  min="0.001"
                  disabled={triangulationInProgress}
                />
              )}
            </div>
          )}

          {/* Error Message */}
          {triangulationError && (
            <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
              {triangulationError}
            </div>
          )}

          {/* Triangulate / Setup Button */}
          {(triangulationMethod === 'helios' || selectedIds.size > 1) ? (
            <button
              data-testid="triangulation-setup-button"
              onClick={() => setShowHeliosPopup(true)}
              className="w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white"
            >
              <Triangle className="w-3 h-3" />
              Setup
            </button>
          ) : (
            <button
              data-testid="triangulation-run-button"
              onClick={handleTriangulate}
              disabled={triangulationInProgress}
              className={`w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 ${
                triangulationInProgress
                  ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                  : 'bg-green-600 hover:bg-green-500 text-white'
              }`}
            >
              {triangulationInProgress ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Triangulating...
                </>
              ) : (
                <>
                  <Triangle className="w-3 h-3" />
                  Triangulate
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Skeleton Extraction Panel */}
      {showSkeletonPanel && selectedIds.size === 1 && (
        <div data-testid="skeleton-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-72 max-h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <GitBranch className="w-3 h-3" />
              Skeleton Extraction (BFS Graph)
            </div>
            <button
              onClick={() => setShowSkeletonPanel(false)}
              className="p-1 hover:bg-neutral-700 rounded"
            >
              <X className="w-3 h-3 text-neutral-400" />
            </button>
          </div>

          {/* Description */}
          <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
            BFS graph-based algorithm for tree skeleton extraction. Follows branch connectivity from root to tips.
          </div>

          {/* Main Parameters */}
          <div className="mb-3 space-y-2">
            <label className="flex items-center gap-2 text-[10px] text-neutral-300 cursor-pointer">
              <input
                type="checkbox"
                checked={skeletonRemoveOutliers}
                onChange={(e) => setSkeletonRemoveOutliers(e.target.checked)}
                className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
                disabled={skeletonInProgress}
              />
              Remove outlier points
            </label>
            <label className="flex items-center gap-2 text-[10px] text-neutral-300 cursor-pointer">
              <input
                type="checkbox"
                checked={skeletonSmooth}
                onChange={(e) => setSkeletonSmooth(e.target.checked)}
                className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
                disabled={skeletonInProgress}
              />
              Smooth skeleton (Laplace)
            </label>
          </div>

          {/* Search Radius */}
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">
              Search Radius: {skeletonSearchRadius < 0.001 ? 'Auto (based on density)' : `${skeletonSearchRadius.toFixed(3)}m`}
            </label>
            <input
              data-testid="skeleton-search-radius"
              type="range"
              min="0"
              max="0.2"
              step="0.005"
              value={skeletonSearchRadius}
              onChange={(e) => setSkeletonSearchRadius(parseFloat(e.target.value))}
              className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer"
              disabled={skeletonInProgress}
            />
            <div className="text-[9px] text-neutral-500 mt-1">
              Neighbor connection distance. Set to 0 for auto-calculation from point density.
            </div>
          </div>

          {/* Threshold Filter */}
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">
              Min Points/Block: {skeletonThresholdFilter}
            </label>
            <input
              data-testid="skeleton-min-points"
              type="range"
              min="1"
              max="50"
              step="1"
              value={skeletonThresholdFilter}
              onChange={(e) => setSkeletonThresholdFilter(parseInt(e.target.value))}
              className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer"
              disabled={skeletonInProgress}
            />
            <div className="text-[9px] text-neutral-500 mt-1">
              Filter noise/small branches. Lower for more detail.
            </div>
          </div>

          {/* Advanced Options Toggle */}
          <button
            onClick={() => setSkeletonShowAdvanced(!skeletonShowAdvanced)}
            className="w-full text-left text-[10px] text-neutral-400 hover:text-neutral-300 mb-2 flex items-center gap-1"
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${skeletonShowAdvanced ? 'rotate-90' : ''}`} />
            Advanced Options
          </button>

          {/* Advanced Options */}
          {skeletonShowAdvanced && (
            <div className="mb-3 pl-2 border-l border-neutral-700 space-y-3">
              {/* Root Threshold */}
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Root Threshold: {skeletonRootThreshold.toFixed(3)}m
                </label>
                <input
                  type="range"
                  min="0.005"
                  max="0.1"
                  step="0.005"
                  value={skeletonRootThreshold}
                  onChange={(e) => setSkeletonRootThreshold(parseFloat(e.target.value))}
                  className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer"
                  disabled={skeletonInProgress}
                />
              </div>

              {/* Quantization Levels */}
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Quantization Levels: {skeletonQuantizationLevels}
                </label>
                <input
                  type="range"
                  min="20"
                  max="120"
                  step="10"
                  value={skeletonQuantizationLevels}
                  onChange={(e) => setSkeletonQuantizationLevels(parseInt(e.target.value))}
                  className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer"
                  disabled={skeletonInProgress}
                />
              </div>

              <label className="flex items-center gap-2 text-[10px] text-neutral-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skeletonUseNonlinearQuant}
                  onChange={(e) => setSkeletonUseNonlinearQuant(e.target.checked)}
                  className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
                  disabled={skeletonInProgress}
                />
                Nonlinear quantization (sqrt scaling)
              </label>

              <label className="flex items-center gap-2 text-[10px] text-neutral-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skeletonUseProportionFilter}
                  onChange={(e) => setSkeletonUseProportionFilter(e.target.checked)}
                  className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
                  disabled={skeletonInProgress}
                />
                Proportion filter (parent/child ratio)
              </label>

              {/* Smoothing Iterations */}
              {skeletonSmooth && (
                <div>
                  <label className="text-[10px] text-neutral-400 block mb-1">
                    Smoothing Iterations: {skeletonSmoothIterations}
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    step="1"
                    value={skeletonSmoothIterations}
                    onChange={(e) => setSkeletonSmoothIterations(parseInt(e.target.value))}
                    className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer"
                    disabled={skeletonInProgress}
                  />
                </div>
              )}

              <div className="text-[9px] text-neutral-500">
                Nonlinear quantization preserves branch detail. Proportion filter removes small disconnected clusters.
              </div>
            </div>
          )}

          {/* Error Message */}
          {skeletonError && (
            <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
              {skeletonError}
            </div>
          )}

          {/* Extract Button */}
          <button
            data-testid="skeleton-extract-button"
            onClick={handleExtractSkeleton}
            disabled={skeletonInProgress}
            className={`w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 ${
              skeletonInProgress
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-amber-600 hover:bg-amber-500 text-white'
            }`}
          >
            {skeletonInProgress ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Extracting...
              </>
            ) : (
              <>
                <GitBranch className="w-3 h-3" />
                Extract Skeleton
              </>
            )}
          </button>
        </div>
      )}

      {/* Resize Panel - shows when mesh is selected and resize mode is active */}
      {showResizePanel && selectedMesh && (() => {
        const scale = meshScales.get(selectedMesh.id) || { x: 1, y: 1, z: 1 };
        const isShape = selectedMesh.sourceCloudId.startsWith('shape-');
        const isCylinder = selectedMesh.sourceCloudId.includes('cylinder');
        const isCone = selectedMesh.sourceCloudId.includes('cone');
        return (
          <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56">
            <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Maximize2 className="w-3 h-3" />
                Resize {isShape ? 'Shape' : 'Mesh'}
              </span>
              <button
                onClick={() => setShowResizePanel(false)}
                className="text-neutral-500 hover:text-neutral-300"
              >
                ×
              </button>
            </div>

            {/* Uniform Scale */}
            <div className="mb-3">
              <label className="text-[10px] text-neutral-400 block mb-1">
                Uniform Scale: {scale.x.toFixed(2)}
              </label>
              <input
                type="range"
                min="0.1"
                max="10"
                step="0.1"
                value={scale.x}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setMeshScales(prev => {
                    const next = new Map(prev);
                    next.set(selectedMesh.id, { x: v, y: v, z: v });
                    return next;
                  });
                }}
                className="w-full h-2 bg-neutral-700 rounded appearance-none cursor-pointer"
              />
            </div>

            {/* Cylinder/Cone-specific: Radius (XY) and Height (Z) */}
            {(isCylinder || isCone) && (
              <div className="mb-3 p-2 bg-neutral-900/50 rounded space-y-2">
                <div className="text-[10px] text-neutral-400 mb-1">{isCone ? 'Cone' : 'Cylinder'} Controls</div>
                <div>
                  <label className="text-[9px] text-neutral-500 block">Radius: {scale.x.toFixed(2)}</label>
                  <input
                    type="range"
                    min="0.1"
                    max="10"
                    step="0.1"
                    value={scale.x}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setMeshScales(prev => {
                        const next = new Map(prev);
                        next.set(selectedMesh.id, { x: v, y: v, z: scale.z });
                        return next;
                      });
                    }}
                    className="w-full h-1.5 bg-neutral-700 rounded appearance-none cursor-pointer"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-neutral-500 block">Height: {scale.z.toFixed(2)}</label>
                  <input
                    type="range"
                    min="0.1"
                    max="10"
                    step="0.1"
                    value={scale.z}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setMeshScales(prev => {
                        const next = new Map(prev);
                        next.set(selectedMesh.id, { ...scale, z: v });
                        return next;
                      });
                    }}
                    className="w-full h-1.5 bg-neutral-700 rounded appearance-none cursor-pointer"
                  />
                </div>
              </div>
            )}

            {/* Individual Axis Scales */}
            <div className="p-2 bg-neutral-900/50 rounded space-y-2">
              <div className="text-[10px] text-neutral-400 mb-1">Per-Axis Scale</div>
              <div>
                <label className="text-[9px] text-neutral-500 block">X: {scale.x.toFixed(2)}</label>
                <input
                  type="range"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={scale.x}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setMeshScales(prev => {
                      const next = new Map(prev);
                      next.set(selectedMesh.id, { ...scale, x: v });
                      return next;
                    });
                  }}
                  className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
                />
              </div>
              <div>
                <label className="text-[9px] text-neutral-500 block">Y: {scale.y.toFixed(2)}</label>
                <input
                  type="range"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={scale.y}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setMeshScales(prev => {
                      const next = new Map(prev);
                      next.set(selectedMesh.id, { ...scale, y: v });
                      return next;
                    });
                  }}
                  className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
                />
              </div>
              <div>
                <label className="text-[9px] text-neutral-500 block">Z: {scale.z.toFixed(2)}</label>
                <input
                  type="range"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={scale.z}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setMeshScales(prev => {
                      const next = new Map(prev);
                      next.set(selectedMesh.id, { ...scale, z: v });
                      return next;
                    });
                  }}
                  className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
                />
              </div>
            </div>

            {/* Reset button */}
            <button
              onClick={() => {
                setMeshScales(prev => {
                  const next = new Map(prev);
                  next.set(selectedMesh.id, { x: 1, y: 1, z: 1 });
                  return next;
                });
              }}
              className="w-full mt-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs"
            >
              Reset Scale
            </button>
          </div>
        );
      })()}

      {/* Translate Coordinates Panel - shows when translate mode is active and something is selected */}
      {editMode === 'translate' && (selectedMesh || selectedSkeletonId || selectedIds.size > 0) && (() => {
        // Get current position based on selection type
        let currentPos = { x: 0, y: 0, z: 0 };
        let objectName = '';

        if (selectedMesh) {
          currentPos = meshPositions.get(selectedMesh.id) || { x: 0, y: 0, z: 0 };
          objectName = selectedMesh.isPlant ? `${selectedMesh.plantType} Plant` : 'Mesh';
        } else if (selectedSkeletonId) {
          currentPos = skeletonPositions.get(selectedSkeletonId) || { x: 0, y: 0, z: 0 };
          const skeleton = skeletons.find(s => s.id === selectedSkeletonId);
          objectName = skeleton ? `Skeleton ${skeleton.id.slice(0, 8)}` : 'Skeleton';
        } else if (selectedIds.size > 0) {
          const firstCloudId = Array.from(selectedIds)[0];
          const editState = getEditState(firstCloudId);
          currentPos = editState ? { x: editState.translation.x, y: editState.translation.y, z: editState.translation.z } : { x: 0, y: 0, z: 0 };
          const cloud = clouds.find(c => c.id === firstCloudId);
          objectName = cloud?.data.fileName || 'Point Cloud';
        }

        const handleCoordChange = (axis: 'x' | 'y' | 'z', value: string) => {
          const numValue = parseFloat(value);
          if (isNaN(numValue)) return;

          if (selectedMesh) {
            setMeshPositions(prev => {
              const next = new Map(prev);
              const pos = next.get(selectedMesh.id) || { x: 0, y: 0, z: 0 };
              next.set(selectedMesh.id, { ...pos, [axis]: numValue });
              return next;
            });
          } else if (selectedSkeletonId) {
            setSkeletonPositions(prev => {
              const next = new Map(prev);
              const pos = next.get(selectedSkeletonId) || { x: 0, y: 0, z: 0 };
              next.set(selectedSkeletonId, { ...pos, [axis]: numValue });
              return next;
            });
          } else if (selectedIds.size > 0) {
            // For point clouds, update edit states
            setEditStates(prev => {
              const next = new Map(prev);
              for (const cloudId of selectedIds) {
                const state = next.get(cloudId) || { translation: { x: 0, y: 0, z: 0 }, cropEnabled: false, cropInvert: false, cropMin: null, cropMax: null, erasedIndices: new Set<number>() };
                next.set(cloudId, {
                  ...state,
                  translation: { ...state.translation, [axis]: numValue }
                });
              }
              return next;
            });
          }
        };

        return (
          <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56">
            <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Move className="w-3 h-3" />
                Position
              </span>
              <span className="text-[9px] text-neutral-500 truncate max-w-[100px]" title={objectName}>
                {objectName}
              </span>
            </div>

            <div className="space-y-2">
              {(['x', 'y', 'z'] as const).map((axis) => (
                <div key={axis} className="flex items-center gap-2">
                  <label className="text-[10px] text-neutral-400 w-3 uppercase font-medium">
                    {axis}
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={currentPos[axis].toFixed(3)}
                    onChange={(e) => handleCoordChange(axis, e.target.value)}
                    className="flex-1 bg-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              ))}
            </div>

            <button
              onClick={() => {
                if (selectedMesh) {
                  setMeshPositions(prev => {
                    const next = new Map(prev);
                    next.set(selectedMesh.id, { x: 0, y: 0, z: 0 });
                    return next;
                  });
                } else if (selectedSkeletonId) {
                  setSkeletonPositions(prev => {
                    const next = new Map(prev);
                    next.set(selectedSkeletonId, { x: 0, y: 0, z: 0 });
                    return next;
                  });
                } else if (selectedIds.size > 0) {
                  setEditStates(prev => {
                    const next = new Map(prev);
                    for (const cloudId of selectedIds) {
                      const state = next.get(cloudId);
                      if (state) {
                        next.set(cloudId, { ...state, translation: { x: 0, y: 0, z: 0 } });
                      }
                    }
                    return next;
                  });
                }
              }}
              className="w-full mt-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs"
            >
              Reset Position
            </button>
          </div>
        );
      })()}

      {/* Plant Growth Panel - shows when plant mesh is selected and growth panel is open */}
      {/* Positioned to the left of the main right panel to avoid overlap */}
      {showPlantGrowthPanel && selectedMesh?.isPlant && (() => {
        const currentAge = selectedMesh.plantAge ?? 0;
        const handleGoToAge = () => {
          const target = parseFloat(targetAge);
          if (!isNaN(target) && target >= 0) {
            const delta = target - currentAge;
            if (delta !== 0) {
              handleAdvancePlantAge(selectedMesh.id, delta);
            }
          }
        };
        return (
          <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56">
            <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <ClockPlus className="w-3 h-3 text-neutral-400" />
                Plant Growth
              </span>
              <button
                onClick={() => setShowPlantGrowthPanel(false)}
                className="text-neutral-500 hover:text-neutral-300"
              >
                ×
              </button>
            </div>

            <div className="space-y-3">
              {/* Current Age Display */}
              <div className="text-[10px] text-neutral-400">
                Current Age: <span className="text-white font-medium">{currentAge.toFixed(0)} days</span>
              </div>

              {/* Quick Increment Buttons */}
              <div>
                <div className="text-[9px] text-neutral-500 mb-1">Quick Adjust</div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleAdvancePlantAge(selectedMesh.id, -1)}
                    disabled={isAdvancingAge || currentAge <= 0}
                    className="flex-1 px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors"
                  >
                    -1
                  </button>
                  <button
                    onClick={() => handleAdvancePlantAge(selectedMesh.id, 1)}
                    disabled={isAdvancingAge}
                    className="flex-1 px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors"
                  >
                    +1
                  </button>
                </div>
              </div>

              {/* Custom Step Section */}
              <div>
                <div className="text-[9px] text-neutral-500 mb-1">Custom Step</div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleAdvancePlantAge(selectedMesh.id, -ageStep)}
                    disabled={isAdvancingAge || currentAge - ageStep < 0}
                    className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    value={ageStep}
                    onChange={(e) => setAgeStep(Math.max(1, parseInt(e.target.value) || 1))}
                    min={1}
                    className="flex-1 w-12 px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white text-center focus:outline-none focus:ring-1 focus:ring-neutral-500"
                    disabled={isAdvancingAge}
                  />
                  <button
                    onClick={() => handleAdvancePlantAge(selectedMesh.id, ageStep)}
                    disabled={isAdvancingAge}
                    className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Go To Age Section */}
              <div>
                <div className="text-[9px] text-neutral-500 mb-1">Go to Age</div>
                <div className="flex gap-1">
                  <input
                    type="number"
                    value={targetAge}
                    onChange={(e) => setTargetAge(e.target.value)}
                    placeholder={currentAge.toFixed(0)}
                    min={0}
                    className="flex-1 px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-neutral-500"
                    disabled={isAdvancingAge}
                    onKeyDown={(e) => e.key === 'Enter' && handleGoToAge()}
                  />
                  <button
                    onClick={handleGoToAge}
                    disabled={isAdvancingAge || !targetAge || parseFloat(targetAge) === currentAge}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors"
                  >
                    Go
                  </button>
                </div>
              </div>

              {/* Growth Animation Section */}
              <div className="border-t border-neutral-700 pt-3 mt-1">
                <div className="text-[9px] text-neutral-500 mb-1">Growth Animation</div>
                <div className="flex gap-1 mb-2">
                  <div className="flex-1">
                    <label className="text-[8px] text-neutral-500 block mb-0.5">Start</label>
                    <input
                      type="number"
                      value={animationStartAge}
                      onChange={(e) => setAnimationStartAge(e.target.value)}
                      min={0}
                      className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-neutral-500"
                      disabled={isAnimating || isAdvancingAge}
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[8px] text-neutral-500 block mb-0.5">End</label>
                    <input
                      type="number"
                      value={animationEndAge}
                      onChange={(e) => setAnimationEndAge(e.target.value)}
                      min={0}
                      className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-neutral-500"
                      disabled={isAnimating || isAdvancingAge}
                    />
                  </div>
                </div>
                {/* GIF Settings Row */}
                <div className="flex gap-2 mb-2">
                  <div className="flex-1">
                    <label className="text-[8px] text-neutral-500 block mb-0.5">Background</label>
                    <select
                      value={gifBackground}
                      onChange={(e) => setGifBackground(e.target.value as 'transparent' | 'black' | 'white')}
                      className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-neutral-500"
                      disabled={isAnimating || isGeneratingGif || isAdvancingAge}
                    >
                      <option value="black">Black</option>
                      <option value="white">White</option>
                      <option value="transparent">Transparent</option>
                    </select>
                  </div>
                </div>
                {/* GIF Camera View */}
                <div className="mb-2">
                  <label className="text-[8px] text-neutral-500 block mb-1">Camera View</label>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setGifCameraView('current')}
                      disabled={isAnimating || isGeneratingGif || isAdvancingAge}
                      className={`flex-1 px-2 py-1 rounded text-[9px] transition-colors ${
                        gifCameraView === 'current'
                          ? 'bg-purple-600 text-white'
                          : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                      } disabled:opacity-50`}
                      title="Use current camera angle"
                    >
                      Current
                    </button>
                    <button
                      onClick={() => setGifCameraView('front')}
                      disabled={isAnimating || isGeneratingGif || isAdvancingAge}
                      className={`flex-1 px-2 py-1 rounded text-[9px] transition-colors ${
                        gifCameraView === 'front'
                          ? 'bg-purple-600 text-white'
                          : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                      } disabled:opacity-50`}
                      title="Front view"
                    >
                      Front
                    </button>
                    <button
                      onClick={() => setGifCameraView('side')}
                      disabled={isAnimating || isGeneratingGif || isAdvancingAge}
                      className={`flex-1 px-2 py-1 rounded text-[9px] transition-colors ${
                        gifCameraView === 'side'
                          ? 'bg-purple-600 text-white'
                          : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                      } disabled:opacity-50`}
                      title="Side view"
                    >
                      Side
                    </button>
                    <button
                      onClick={() => setGifCameraView('top')}
                      disabled={isAnimating || isGeneratingGif || isAdvancingAge}
                      className={`flex-1 px-2 py-1 rounded text-[9px] transition-colors ${
                        gifCameraView === 'top'
                          ? 'bg-purple-600 text-white'
                          : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                      } disabled:opacity-50`}
                      title="Top view"
                    >
                      Top
                    </button>
                    <button
                      onClick={() => setGifCameraView('iso')}
                      disabled={isAnimating || isGeneratingGif || isAdvancingAge}
                      className={`flex-1 px-2 py-1 rounded text-[9px] transition-colors ${
                        gifCameraView === 'iso'
                          ? 'bg-purple-600 text-white'
                          : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                      } disabled:opacity-50`}
                      title="Isometric view"
                    >
                      Iso
                    </button>
                  </div>
                </div>
                <div className="flex gap-1">
                  {!isAnimating && !isGeneratingGif ? (
                    <>
                      <button
                        onClick={() => handleStartGrowthAnimation(selectedMesh.id)}
                        disabled={isAdvancingAge || parseInt(animationStartAge) >= parseInt(animationEndAge)}
                        className="flex-1 px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors flex items-center justify-center gap-1"
                      >
                        <Play className="w-3 h-3" />
                        Start
                      </button>
                      <button
                        onClick={() => handleMakeGIF(selectedMesh.id)}
                        disabled={isAdvancingAge || parseInt(animationStartAge) >= parseInt(animationEndAge)}
                        className="flex-1 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors flex items-center justify-center gap-1"
                      >
                        <Film className="w-3 h-3" />
                        Make GIF
                      </button>
                    </>
                  ) : isAnimating ? (
                    <button
                      onClick={handleStopGrowthAnimation}
                      className="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded text-[10px] text-white font-medium transition-colors flex items-center justify-center gap-1"
                    >
                      <StopCircle className="w-3 h-3" />
                      Stop
                    </button>
                  ) : (
                    <button
                      onClick={handleStopMakeGIF}
                      className="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded text-[10px] text-white font-medium transition-colors flex items-center justify-center gap-1"
                    >
                      <StopCircle className="w-3 h-3" />
                      Cancel GIF
                    </button>
                  )}
                </div>
                {/* Animation Progress */}
                {isAnimating && animationProgress !== null && (
                  <div className="mt-2">
                    <div className="flex items-center justify-between text-[9px] text-neutral-400 mb-1">
                      <span>Progress</span>
                      <span>{animationProgress} / {animationEndAge} days</span>
                    </div>
                    <div className="w-full bg-neutral-700 rounded-full h-1.5">
                      <div
                        className="bg-green-500 h-1.5 rounded-full transition-all duration-100"
                        style={{
                          width: `${((animationProgress - parseInt(animationStartAge)) / (parseInt(animationEndAge) - parseInt(animationStartAge))) * 100}%`
                        }}
                      />
                    </div>
                  </div>
                )}
                {/* GIF Progress */}
                {isGeneratingGif && gifProgress && (
                  <div className="mt-2">
                    <div className="flex items-center justify-between text-[9px] text-neutral-400 mb-1">
                      <span>{gifProgress.phase === 'frames' ? 'Capturing frames' : 'Encoding GIF...'}</span>
                      <span>{gifProgress.current} / {gifProgress.total}</span>
                    </div>
                    <div className="w-full bg-neutral-700 rounded-full h-1.5">
                      <div
                        className="bg-purple-500 h-1.5 rounded-full transition-all duration-100"
                        style={{
                          width: `${(gifProgress.current / gifProgress.total) * 100}%`
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Loading Indicator */}
              {isAdvancingAge && (
                <div className="flex items-center gap-2 text-[9px] text-neutral-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Regenerating plant...
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Rotation Panel - shows when mesh is selected and rotate mode is active */}
      {editMode === 'rotate' && selectedMesh && (() => {
        const rotation = meshRotations.get(selectedMesh.id) || { x: 0, y: 0, z: 0 };
        const isShape = selectedMesh.sourceCloudId.startsWith('shape-');
        return (
          <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56">
            <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <RotateCcw className="w-3 h-3" />
                Rotate {isShape ? 'Shape' : 'Mesh'}
              </span>
              <button
                onClick={() => setEditMode('none')}
                className="text-neutral-500 hover:text-neutral-300"
              >
                ×
              </button>
            </div>

            {/* Rotation axes */}
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  X Rotation: {rotation.x.toFixed(0)}°
                </label>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  step="5"
                  value={rotation.x}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setMeshRotations(prev => {
                      const next = new Map(prev);
                      next.set(selectedMesh.id, { ...rotation, x: v });
                      return next;
                    });
                  }}
                  className="w-full h-2 bg-neutral-700 rounded appearance-none cursor-pointer"
                />
              </div>
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Y Rotation: {rotation.y.toFixed(0)}°
                </label>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  step="5"
                  value={rotation.y}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setMeshRotations(prev => {
                      const next = new Map(prev);
                      next.set(selectedMesh.id, { ...rotation, y: v });
                      return next;
                    });
                  }}
                  className="w-full h-2 bg-neutral-700 rounded appearance-none cursor-pointer"
                />
              </div>
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Z Rotation: {rotation.z.toFixed(0)}°
                </label>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  step="5"
                  value={rotation.z}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setMeshRotations(prev => {
                      const next = new Map(prev);
                      next.set(selectedMesh.id, { ...rotation, z: v });
                      return next;
                    });
                  }}
                  className="w-full h-2 bg-neutral-700 rounded appearance-none cursor-pointer"
                />
              </div>
            </div>

            {/* Reset button */}
            <button
              onClick={() => {
                setMeshRotations(prev => {
                  const next = new Map(prev);
                  next.set(selectedMesh.id, { x: 0, y: 0, z: 0 });
                  return next;
                });
              }}
              className="w-full mt-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-xs"
            >
              Reset Rotation
            </button>
          </div>
        );
      })()}

      {/* Alignment Results Panel */}
      {showAlignmentPanel && alignmentResults && (
        <div
          className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-72 max-h-[80vh] overflow-y-auto"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setShowAlignmentPanel(false); }}
          ref={(el) => el?.focus()}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <Globe className="w-3 h-3" />
              Alignment
            </div>
            <button
              onClick={() => setShowAlignmentPanel(false)}
              className="p-1 hover:bg-neutral-700 rounded"
            >
              <X className="w-3 h-3 text-neutral-400" />
            </button>
          </div>

          <div className="space-y-3">
            {/* Key Statistics */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-neutral-700/50 rounded p-2">
                <div className="text-[10px] text-neutral-400">Mean Distance</div>
                <div className="text-sm font-medium text-cyan-400">
                  {alignmentResults.mean_distance !== undefined ? `${(alignmentResults.mean_distance * 1000).toFixed(2)} mm` : 'N/A'}
                </div>
              </div>
              <div className="bg-neutral-700/50 rounded p-2">
                <div className="text-[10px] text-neutral-400">RMSE</div>
                <div className="text-sm font-medium text-cyan-400">
                  {alignmentResults.rmse !== undefined ? `${(alignmentResults.rmse * 1000).toFixed(2)} mm` : 'N/A'}
                </div>
              </div>
              <div className="bg-neutral-700/50 rounded p-2">
                <div className="text-[10px] text-neutral-400">Std Deviation</div>
                <div className="text-sm font-medium text-neutral-200">
                  {alignmentResults.std_deviation !== undefined ? `${(alignmentResults.std_deviation * 1000).toFixed(2)} mm` : 'N/A'}
                </div>
              </div>
              <div className="bg-neutral-700/50 rounded p-2">
                <div className="text-[10px] text-neutral-400">Median</div>
                <div className="text-sm font-medium text-neutral-200">
                  {alignmentResults.median_distance !== undefined ? `${(alignmentResults.median_distance * 1000).toFixed(2)} mm` : 'N/A'}
                </div>
              </div>
            </div>

            {/* Range */}
            <div className="bg-neutral-700/50 rounded p-2">
              <div className="text-[10px] text-neutral-400 mb-1">Distance Range</div>
              <div className="flex justify-between text-xs">
                <span className="text-green-400">Min: {alignmentResults.min_distance !== undefined ? `${(alignmentResults.min_distance * 1000).toFixed(2)} mm` : 'N/A'}</span>
                <span className="text-red-400">Max: {alignmentResults.max_distance !== undefined ? `${(alignmentResults.max_distance * 1000).toFixed(2)} mm` : 'N/A'}</span>
              </div>
            </div>

            {/* Percentiles */}
            <div className="bg-neutral-700/50 rounded p-2">
              <div className="text-[10px] text-neutral-400 mb-1">Percentiles</div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-neutral-400">90th:</span>
                  <span className="text-neutral-200">{alignmentResults.percentile_90 !== undefined ? `${(alignmentResults.percentile_90 * 1000).toFixed(2)} mm` : 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-400">95th:</span>
                  <span className="text-neutral-200">{alignmentResults.percentile_95 !== undefined ? `${(alignmentResults.percentile_95 * 1000).toFixed(2)} mm` : 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-400">99th:</span>
                  <span className="text-neutral-200">{alignmentResults.percentile_99 !== undefined ? `${(alignmentResults.percentile_99 * 1000).toFixed(2)} mm` : 'N/A'}</span>
                </div>
              </div>
            </div>

            {/* Coverage Statistics */}
            <div className="bg-neutral-700/50 rounded p-2">
              <div className="text-[10px] text-neutral-400 mb-1">Coverage (points within distance)</div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-neutral-400">&lt; 1mm:</span>
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-1.5 bg-neutral-600 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500"
                        style={{ width: `${alignmentResults.points_within_1mm || 0}%` }}
                      />
                    </div>
                    <span className="text-neutral-200 w-12 text-right">{alignmentResults.points_within_1mm?.toFixed(1)}%</span>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-neutral-400">&lt; 5mm:</span>
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-1.5 bg-neutral-600 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-yellow-500"
                        style={{ width: `${alignmentResults.points_within_5mm || 0}%` }}
                      />
                    </div>
                    <span className="text-neutral-200 w-12 text-right">{alignmentResults.points_within_5mm?.toFixed(1)}%</span>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-neutral-400">&lt; 10mm:</span>
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-1.5 bg-neutral-600 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-orange-500"
                        style={{ width: `${alignmentResults.points_within_10mm || 0}%` }}
                      />
                    </div>
                    <span className="text-neutral-200 w-12 text-right">{alignmentResults.points_within_10mm?.toFixed(1)}%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Snap to Fit Button */}
            <button
              onClick={handleICPSnapToFit}
              disabled={isRunningICP || selectionType !== 'mixed'}
              className={`w-full px-3 py-2 rounded text-xs font-medium transition-colors flex items-center justify-center gap-2 ${
                isRunningICP || selectionType !== 'mixed'
                  ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                  : 'bg-cyan-600 hover:bg-cyan-500 text-white'
              }`}
              title="Use ICP registration to automatically align the mesh to the point cloud"
            >
              {isRunningICP ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Aligning...
                </>
              ) : (
                <>
                  <Maximize2 className="w-3 h-3" />
                  Snap to Fit (ICP)
                </>
              )}
            </button>

            {/* Point Count */}
            <div className="text-[10px] text-neutral-500 text-center">
              Computed from {alignmentResults.point_count?.toLocaleString()} points
            </div>
          </div>
        </div>
      )}

      {/* Export Panel - context-sensitive based on selection */}
      {showExportPanel && (
        <div data-testid="export-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 max-h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <Download className="w-3 h-3" />
              Export {selectionType === 'cloud' ? 'Point Cloud' : selectionType === 'mesh' ? 'Mesh' : selectionType === 'skeleton' ? 'Skeleton' : ''}
            </div>
            <button
              onClick={() => setShowExportPanel(false)}
              className="p-1 hover:bg-neutral-700 rounded"
            >
              <X className="w-3 h-3 text-neutral-400" />
            </button>
          </div>

          {/* Point Cloud Export */}
          {selectionType === 'cloud' && selectedIds.size === 1 && (
            <div className="mb-4">
              <div className="text-[10px] font-medium text-neutral-400 mb-2">
                {clouds.find(c => c.id === Array.from(selectedIds)[0])?.data.fileName || 'Point Cloud'}
              </div>
              <div className="grid grid-cols-3 gap-1">
                <button
                  data-testid="export-cloud-las"
                  onClick={() => exportPointCloud('las')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  LAS
                </button>
                <button
                  data-testid="export-cloud-laz"
                  onClick={() => exportPointCloud('laz')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                  title="Compressed LAS (requires backend)"
                >
                  LAZ
                </button>
                <button
                  data-testid="export-cloud-ply"
                  onClick={() => exportPointCloud('ply')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  PLY
                </button>
                <button
                  data-testid="export-cloud-xyz"
                  onClick={() => exportPointCloud('xyz')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  XYZ
                </button>
                <button
                  data-testid="export-cloud-csv"
                  onClick={() => exportPointCloud('csv')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  CSV
                </button>
                <button
                  data-testid="export-cloud-txt"
                  onClick={() => exportPointCloud('txt')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                  title="Space-delimited with header and scalar fields"
                >
                  TXT
                </button>
                <button
                  data-testid="export-cloud-obj"
                  onClick={() => exportPointCloud('obj')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  OBJ
                </button>
              </div>
            </div>
          )}

          {/* Selected Mesh Export */}
          {selectionType === 'mesh' && selectedMesh && (
            <div className="mb-4">
              <div className="text-[10px] font-medium text-neutral-400 mb-2">
                {clouds.find(c => c.id === selectedMesh.sourceCloudId)?.data.fileName || 'Mesh'}
              </div>
              <div className="text-[10px] text-neutral-500 mb-2">
                {selectedMesh.data.triangleCount.toLocaleString()} triangles
              </div>
              <div className="grid grid-cols-3 gap-1">
                <button
                  data-testid="export-mesh-obj"
                  onClick={() => exportMesh(selectedMesh.id, 'obj')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  OBJ
                </button>
                <button
                  data-testid="export-mesh-ply"
                  onClick={() => exportMesh(selectedMesh.id, 'ply')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  PLY
                </button>
                <button
                  data-testid="export-mesh-stl"
                  onClick={() => exportMesh(selectedMesh.id, 'stl')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  STL
                </button>
              </div>
              {/* Sample to Points button */}
              <button
                onClick={() => setShowSamplingPopup(true)}
                disabled={isSamplingMesh}
                className="mt-2 w-full px-2 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:cursor-not-allowed rounded text-xs text-white flex items-center justify-center gap-1.5"
              >
                {isSamplingMesh ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Sampling...
                  </>
                ) : (
                  <>
                    <Grid3x3 className="w-3 h-3" />
                    Sample to Points
                  </>
                )}
              </button>
            </div>
          )}

          {/* Selected Skeleton Export */}
          {selectionType === 'skeleton' && selectedSkeleton && (
            <div className="mb-4">
              <div className="text-[10px] font-medium text-neutral-400 mb-2">
                {clouds.find(c => c.id === selectedSkeleton.sourceCloudId)?.data.fileName || 'Skeleton'}
              </div>
              <div className="text-[10px] text-neutral-500 mb-2">
                {selectedSkeleton.data.pointCount} nodes · {selectedSkeleton.data.totalLength.toFixed(2)}m
              </div>
              <div className="grid grid-cols-3 gap-1">
                <button
                  onClick={() => exportSkeleton(selectedSkeleton.id, 'obj')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  OBJ
                </button>
                <button
                  onClick={() => exportSkeleton(selectedSkeleton.id, 'ply')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  PLY
                </button>
                <button
                  onClick={() => exportSkeleton(selectedSkeleton.id, 'json')}
                  className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
                >
                  JSON
                </button>
              </div>
            </div>
          )}

          {/* No selection message */}
          {selectionType === 'none' && (
            <div className="text-[10px] text-neutral-500 text-center py-2">
              Select an object to export
            </div>
          )}
        </div>
      )}

      {/* Display Settings Panel */}
      <div className="absolute bottom-4 right-4 bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-48 overflow-hidden">
        {/* Collapsible Header */}
        <button
          onClick={() => setDisplayPanelCollapsed(!displayPanelCollapsed)}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-neutral-700/50 transition-colors"
        >
          <span className="text-xs font-medium text-neutral-300">Display</span>
          <ChevronDown className={`w-3 h-3 text-neutral-400 transition-transform duration-200 ${displayPanelCollapsed ? '-rotate-90' : ''}`} />
        </button>

        {/* Collapsible Content */}
        {!displayPanelCollapsed && (
          <div className="px-3 pb-3 space-y-2">
            {/* Background */}
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">Background</label>
              <div className="flex gap-1">
                <select value={bgColor} onChange={(e) => setBgColor(e.target.value as 'black' | 'white')} className="flex-1 bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600">
                  <option value="black">Dark</option>
                  <option value="white">Light</option>
                </select>
                <select value={bgStyle} onChange={(e) => setBgStyle(e.target.value as 'solid' | 'gradient')} className="flex-1 bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600">
                  <option value="solid">Solid</option>
                  <option value="gradient">Gradient</option>
                </select>
              </div>
            </div>

            {/* Point Size with +/- buttons */}
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">Point Size: {pointSize.toFixed(1)}px</label>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPointSize(prev => Math.max(prev - 0.5, 0.5))}
                  className="p-1 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
                  title="Decrease Point Size"
                >
                  <Minus className="w-3 h-3 text-neutral-300" />
                </button>
                <input type="range" min="0.5" max="5" step="0.5" value={pointSize} onChange={(e) => setPointSize(parseFloat(e.target.value))} className="flex-1 h-1 bg-neutral-700 rounded appearance-none cursor-pointer" />
                <button
                  onClick={() => setPointSize(prev => Math.min(prev + 0.5, 5))}
                  className="p-1 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
                  title="Increase Point Size"
                >
                  <Plus className="w-3 h-3 text-neutral-300" />
                </button>
              </div>
            </div>

            {/* Grid and Axes toggles */}
            <div className="space-y-1 text-xs">
              <label className="flex items-center gap-2 text-neutral-300 cursor-pointer">
                <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500" />
                Grid
              </label>
              {showGrid && (
                <div className="ml-5 flex gap-1">
                  <button onClick={() => setGridPlane('z-up')} className={`px-2 py-0.5 text-[10px] rounded ${gridPlane === 'z-up' ? 'bg-neutral-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}>Z-up</button>
                  <button onClick={() => setGridPlane('y-up')} className={`px-2 py-0.5 text-[10px] rounded ${gridPlane === 'y-up' ? 'bg-neutral-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}>Y-up</button>
                </div>
              )}
              <label className="flex items-center gap-2 text-neutral-300 cursor-pointer">
                <input type="checkbox" checked={showAxes} onChange={(e) => setShowAxes(e.target.checked)} className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500" />
                Axes
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-neutral-800 rounded-lg p-4 shadow-xl max-w-sm mx-4">
            <div className="text-sm font-medium text-neutral-200 mb-2">Delete {deleteConfirm.type}?</div>
            <div className="text-xs text-neutral-400 mb-4">
              Are you sure you want to delete "{deleteConfirm.name}"? This action cannot be undone.
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  // Reset all drag/erasing states to ensure camera controls work
                  setGizmoDragging(false);
                  setIsErasing(false);
                  setDeleteConfirm(null);
                }}
                className="px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Command Palette Modal */}
      {showCommandPalette && (
        <>
          {/* Invisible click-catcher to close palette when clicking outside */}
          <div
            className="absolute inset-0 z-40"
            onClick={() => setShowCommandPalette(false)}
          />
          {/* Command palette positioned below the search button */}
          <div
            className="absolute top-16 left-4 bg-neutral-800 rounded-lg shadow-2xl w-80 overflow-hidden border border-neutral-700 z-50"
          >
            {/* Search Input */}
            <div className="p-3 border-b border-neutral-700">
              <div className="flex items-center gap-2 bg-neutral-900 rounded-md px-3 py-2">
                <Search className="w-4 h-4 text-neutral-500 flex-shrink-0" />
                <input
                  type="text"
                  value={commandSearch}
                  onChange={(e) => { setCommandSearch(e.target.value); setCommandSelectedIndex(0); }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setCommandSelectedIndex(prev => Math.min(prev + 1, filteredCommands.length - 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setCommandSelectedIndex(prev => Math.max(prev - 1, 0));
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      const cmd = filteredCommands[commandSelectedIndex];
                      if (cmd && cmd.available) {
                        cmd.action();
                        setShowCommandPalette(false);
                      }
                    } else if (e.key === 'Escape') {
                      setShowCommandPalette(false);
                    }
                  }}
                  placeholder="Search commands..."
                  className="flex-1 bg-transparent text-sm text-neutral-200 placeholder-neutral-500 outline-none"
                  autoFocus
                />
                <span className="text-[10px] text-neutral-500 bg-neutral-700 px-1.5 py-0.5 rounded">
                  {navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl+K'}
                </span>
              </div>
            </div>

            {/* Results List */}
            <div className="max-h-80 overflow-y-auto">
              {filteredCommands.length === 0 ? (
                <div className="p-4 text-center text-sm text-neutral-500">No matching commands</div>
              ) : (
                <div className="py-1">
                  {filteredCommands.map((cmd, index) => (
                    <button
                      key={cmd.id}
                      onClick={() => {
                        if (cmd.available) {
                          cmd.action();
                          setShowCommandPalette(false);
                        }
                      }}
                      onMouseEnter={() => setCommandSelectedIndex(index)}
                      className={`w-full px-3 py-2 flex items-center justify-between text-left transition-colors ${
                        index === commandSelectedIndex ? 'bg-neutral-700' : 'hover:bg-neutral-700/50'
                      } ${!cmd.available ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`text-sm ${cmd.available ? 'text-neutral-200' : 'text-neutral-500'}`}>
                          {cmd.name}
                        </span>
                        {!cmd.available && cmd.requires && (
                          <span className="text-[10px] text-neutral-500 italic">
                            Select {cmd.requires === 'multiple-clouds' ? 'multiple point clouds' :
                                   cmd.requires === 'multiple-meshes' ? 'multiple meshes' :
                                   cmd.requires === 'plant' ? 'a plant' : `a ${cmd.requires}`} to {cmd.name.toLowerCase()}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-neutral-500 bg-neutral-700/50 px-1.5 py-0.5 rounded">
                        {cmd.category}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-3 py-2 border-t border-neutral-700 flex items-center gap-4 text-[10px] text-neutral-500">
              <span><kbd className="bg-neutral-700 px-1 rounded">↑↓</kbd> Navigate</span>
              <span><kbd className="bg-neutral-700 px-1 rounded">Enter</kbd> Select</span>
              <span><kbd className="bg-neutral-700 px-1 rounded">Esc</kbd> Close</span>
            </div>
          </div>
        </>
      )}

      {/* Navigation Help */}
      <div className="absolute bottom-4 left-4 bg-neutral-800/80 backdrop-blur-sm rounded-lg px-3 py-2 text-xs text-neutral-400">
        <span className="text-neutral-300">Left:</span> Rotate · <span className="text-neutral-300">Right:</span> Pan · <span className="text-neutral-300">Scroll:</span> Zoom
      </div>

      {/* Selection Info Panel - shows center coordinates and mesh info */}
      {selectedObjectCenter && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-neutral-800/90 backdrop-blur-sm rounded-lg px-3 py-1.5 text-xs border border-neutral-700">
          <div className="flex items-center gap-2">
            {selectedMeshInfo && (
              <>
                <span className="text-neutral-200 font-medium">{selectedMeshInfo.type}</span>
                <span className="text-neutral-300 font-mono">{selectedMeshInfo.dimensions}</span>
                <span className="text-neutral-600">|</span>
              </>
            )}
            <span className="text-neutral-300 font-mono">
              <span className="text-neutral-500">Center</span> ({smartFormat(selectedObjectCenter.x)},{smartFormat(selectedObjectCenter.y)},{smartFormat(selectedObjectCenter.z)})
            </span>
            <button
              onClick={() => {
                const coords = `${smartFormat(selectedObjectCenter.x)},${smartFormat(selectedObjectCenter.y)},${smartFormat(selectedObjectCenter.z)}`;
                navigator.clipboard.writeText(coords);
                setCoordsCopied(true);
                setTimeout(() => setCoordsCopied(false), 600);
              }}
              className={`p-1 rounded transition-colors ${coordsCopied ? 'bg-green-600' : 'hover:bg-neutral-700'}`}
              title="Copy coordinates"
            >
              <svg className={`w-3.5 h-3.5 transition-colors ${coordsCopied ? 'text-white' : 'text-neutral-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {coordsCopied ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                )}
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Plant Generation Popup */}
      <PlantGenerationPopup
        isOpen={showPlantPopup}
        onClose={() => setShowPlantPopup(false)}
        onGenerate={handleCreatePlant}
        isGenerating={isGeneratingPlant}
      />

      {/* Helios Triangulation Popup */}
      <HeliosTriangulationPopup
        isOpen={showHeliosPopup}
        onClose={() => setShowHeliosPopup(false)}
        clouds={clouds}
        onStartTriangulate={handleHeliosTriangulate}
        initialSelectedIds={selectedIds}
      />

      {/* Morph Plant Popup */}
      {selectedMesh?.isPlant && (
        <MorphPopup
          isOpen={showMorphPopup}
          onClose={() => setShowMorphPopup(false)}
          onMorph={handleMorphPlant}
          isMorphing={isMorphing}
          plantType={selectedMesh.plantType || ''}
          plantAge={selectedMesh.plantAge || 0}
          heliosXml={selectedMesh.heliosXml || ''}
        />
      )}

      {/* Mesh Sampling Popup */}
      {showSamplingPopup && selectedMesh && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowSamplingPopup(false)}
          />

          {/* Modal */}
          <div className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-sm mx-4 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
              <div className="flex items-center gap-2">
                <Grid3x3 className="w-5 h-5 text-neutral-400" />
                <h2 className="text-lg font-semibold text-white">Sample Mesh to Points</h2>
              </div>
              <button
                onClick={() => setShowSamplingPopup(false)}
                className="p-1 rounded hover:bg-neutral-700 transition-colors"
              >
                <X className="w-5 h-5 text-neutral-400" />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              <div className="text-sm text-neutral-300">
                Convert mesh to point cloud by sampling {selectedMesh.data.triangleCount.toLocaleString()} triangles.
              </div>

              {/* Density Input */}
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">
                  Point Density (points/m²)
                </label>
                <input
                  type="number"
                  value={samplingDensity}
                  onChange={(e) => setSamplingDensity(Math.max(100, parseInt(e.target.value) || 100))}
                  min={100}
                  step={1000}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                />
                <p className="text-xs text-neutral-500 mt-1">
                  Higher values create denser point clouds
                </p>
              </div>

              {/* Preset Buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => setSamplingDensity(1000)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs ${samplingDensity === 1000 ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'}`}
                >
                  Sparse (1k)
                </button>
                <button
                  onClick={() => setSamplingDensity(10000)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs ${samplingDensity === 10000 ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'}`}
                >
                  Medium (10k)
                </button>
                <button
                  onClick={() => setSamplingDensity(50000)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs ${samplingDensity === 50000 ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'}`}
                >
                  Dense (50k)
                </button>
              </div>

              {/* Submit Button */}
              <button
                onClick={() => handleSampleMesh(selectedMesh.id, samplingDensity)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-white font-medium transition-colors"
              >
                <Grid3x3 className="w-4 h-4" />
                Sample Mesh
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Color By Dropdown Overlay - rendered at root level for proper z-indexing */}
      {colorDropdownCloudId && (() => {
        const cloud = clouds.find(c => c.id === colorDropdownCloudId);
        if (!cloud) return null;
        const btn = document.getElementById(`color-btn-${colorDropdownCloudId}`);
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return (
          <>
            {/* Click-outside backdrop */}
            <div
              className="fixed inset-0 z-[9998]"
              onClick={() => setColorDropdownCloudId(null)}
            />
            {/* Dropdown menu */}
            <div
              className="fixed bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl z-[9999] min-w-[160px] py-1 max-h-[400px] overflow-y-auto"
              style={{
                top: rect.bottom + 4,
                left: Math.max(8, rect.right - 160),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-1.5 text-[10px] text-neutral-500 font-medium uppercase tracking-wide border-b border-neutral-700">
                Color By
              </div>
              {[
                { value: 'x', label: 'X Axis' },
                { value: 'y', label: 'Y Axis' },
                { value: 'height', label: 'Z Axis (Height)' },
                { value: 'intensity', label: 'Intensity' },
                { value: 'rgb', label: 'RGB' },
                { value: 'single', label: 'Solid Color' },
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    setColorMode(option.value as ColorMode);
                    setColorDropdownCloudId(null);
                  }}
                  className={`w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-700 transition-colors ${
                    colorMode === option.value ? 'text-blue-400 bg-neutral-700/50' : 'text-neutral-300'
                  }`}
                >
                  {option.label}
                </button>
              ))}
              {/* Scalar fields section */}
              {cloud.data.scalarFields && Object.keys(cloud.data.scalarFields).length > 0 && (
                <div className="border-t border-neutral-700 mt-1 pt-1">
                  <div className="px-3 py-1 text-[10px] text-neutral-500 font-medium">
                    Scalar Fields
                  </div>
                  {Object.keys(cloud.data.scalarFields).sort().map((fieldName) => (
                    <button
                      key={fieldName}
                      onClick={() => {
                        setColorMode('scalar');
                        setSelectedScalarField(fieldName);
                        setColorDropdownCloudId(null);
                      }}
                      className={`w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-700 transition-colors ${
                        colorMode === 'scalar' && selectedScalarField === fieldName
                          ? 'text-blue-400 bg-neutral-700/50'
                          : 'text-neutral-300'
                      }`}
                    >
                      {fieldName}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}
