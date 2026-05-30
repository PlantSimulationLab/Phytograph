import { useRef, useMemo, useState, useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { Canvas } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';
import { Eye, EyeOff, Maximize2, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Circle, Square, Move, Crop, RotateCcw, Undo2, Redo2, Trash2, Layers, CheckSquare, XSquare, Triangle, Loader2, Box, Merge, GitBranch, ChevronRight, ChevronDown, Download, Plus, Home, Leaf, Sprout, ClockPlus, CircleDot, Minus, Grid3x3, X, ChartScatter, Eraser, Film, Play, StopCircle, Filter, Globe, Search, Dna, Radio, Pencil, FileUp, Settings } from 'lucide-react';
import GIF from 'gif.js';
import { triangulatePointCloud, TriangulationMethod, extractSkeleton, generatePlantModel, generatePlantStreaming, sampleMeshSurface, exportPointCloudLasLaz, createPlantSession, advancePlantSession, computeAlignmentDistance, AlignmentDistanceResponse, icpRegisterMeshToCloud, icpRegisterCloudToCloud, icpRegisterMeshToMesh, HeliosTriangulationRequest, heliosTriangulate, morphPlant, PlantMorphRequest, deletePlantSession, cropPointCloudByPath, cropOctree, segmentGround, segmentGroundApply, segmentTrees, segmentTreesApply, type CropOctreeRegion, type CropOctreeResult, type BackendPointSource } from '../utils/backendApi';
import { showToast } from './Toast';
import { getSettings, updateSettings } from '../lib/store';
import {
  ColormapName,
  COLORMAP_NAMES,
  COLORMAP_LABELS,
} from '../lib/colormaps';
import { PlantGenerationPopup, type PlantGenerationPayload } from './PlantGenerationPopup';
import { HeliosTriangulationPopup } from './HeliosTriangulationPopup';
import { MorphPopup } from './MorphPopup';
import { ScanParametersPopup } from './ScanParametersPopup';
import { ScannerMarker } from './ScannerMarker';
import { DebouncedNumberInput } from './DebouncedNumberInput';
import { BulkImportProgress, type BulkImportProgressState } from './BulkImportProgress';
import { type ScanParameters } from '../lib/scanParameters';
import { type Scan, hasData, hasParams, scanDisplayName } from '../lib/scan';
import { parsePointCloudFromPath, buildPointCloudFromBackend, buildPointCloudFromOctree } from '../lib/pointCloudParsers';
import { resolveAttachedScanFile } from '../lib/scanFileResolver';
import { dirname } from '../lib/pathUtils';
import {
  pointInPolygon,
  projectWorldToCanvasPixel,
  worldBoundsUnion,
  polygonRegionFromCamera,
} from '../lib/cropGeometry';
import {
  computeBoundsFromPositions,
  fuzzyMatch,
  generateShapeMesh,
  octreeScalarFieldOptions,
} from '../lib/pointCloudHelpers';
import { Colorbar } from './viewer/Colorbar';
import { ClassLegend } from './viewer/ClassLegend';
import { categoricalSchemeForRange, GROUND_CLASS_ATTRIBUTE, TREE_INSTANCE_ATTRIBUTE } from '../lib/classification';
import { mergeTrees, splitTreeByGaps } from '../lib/treeEdit';
import { OctreePointCloud } from './viewer/renderers/OctreePointCloud';
import { PointCloud } from './viewer/renderers/PointCloud';
import { TriangleMesh } from './viewer/renderers/TriangleMesh';
import { VoxelGridOverlay } from './viewer/renderers/VoxelGridOverlay';
import { TexturedPlantMesh } from './viewer/renderers/TexturedPlantMesh';
export { TexturedPlantMesh } from './viewer/renderers/TexturedPlantMesh';
import { Skeleton3D } from './viewer/renderers/Skeleton3D';
import { SkeletonPoints } from './viewer/renderers/SkeletonPoints';
import { CameraController } from './viewer/scene/CameraController';
import { ViewportAxesGizmo } from './viewer/scene/ViewportAxesGizmo';
import { SceneBackground } from './viewer/scene/SceneBackground';
import { CameraCapture } from './viewer/scene/CameraCapture';
import { TranslationGizmo } from './viewer/gizmos/TranslationGizmo';
import { CropBox } from './viewer/gizmos/CropBox';
import { BoxDrawRaycaster } from './viewer/gizmos/BoxDrawRaycaster';
import { PolygonCameraSnapshotter } from './viewer/gizmos/PolygonCameraSnapshotter';
import { OrthoProjectionOverride } from './viewer/gizmos/OrthoProjectionOverride';
import { EraseBrush } from './viewer/gizmos/EraseBrush';

// Shared viewer types now live in lib/pointCloudTypes.ts so the extracted leaf
// components (components/viewer/**) and the lib parsers can import them without
// a components → lib cycle. Re-exported below so existing consumers that import
// these types FROM this module (App.tsx, lib/scan.ts, lib/pointCloudParsers.ts)
// keep working unchanged.
import type {
  ScalarField,
  PointSourcePayload,
  PointCloudData,
  PointCloudEntry,
  CloudEditState,
  HistoryEntry,
  MeshData,
  MeshEntry,
  SkeletonData,
  SkeletonEntry,
  ColorMode,
  ShapeType,
  FilterRange,
  CloudFilters,
} from '../lib/pointCloudTypes';
export type {
  ScalarField,
  OctreeRef,
  PointSourcePayload,
  PointCloudData,
  PointCloudEntry,
  MeshData,
  PlantMaterialDef,
  MeshEntry,
  SkeletonData,
  SkeletonEntry,
} from '../lib/pointCloudTypes';
import { plantResponseToMeshData } from '../lib/plantMeshData';

// Grid plane options
type GridPlane = 'z-up' | 'y-up';
type EditMode = 'none' | 'translate' | 'crop' | 'rotate' | 'erase';


// Import function refs for mesh/skeleton
export interface ImportRefs {
  importMesh: (mesh: Omit<MeshEntry, 'id'>) => void;
  importSkeleton: (skeleton: Omit<SkeletonEntry, 'id'>) => void;
}

interface PointCloudViewerProps {
  scans: Scan[];
  selectedScanIds: Set<string>;
  onToggleVisibility: (id: string) => void;
  onToggleSelection: (id: string, multiSelect: boolean) => void;
  onRemoveScan: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onUpdateScanData: (id: string, data: PointCloudData) => void;
  onUpdateScanParams: (id: string, params: ScanParameters | undefined) => void;
  onUpdateScanLabel?: (id: string, label: string) => void;
  onSave: (data: PointCloudData, fileName: string) => void;
  onAddScan?: (scan: Scan) => void;
  onAddScans?: (scans: Scan[]) => void;
  onStitchScans?: (ids: string[]) => void;
  onUndoStitch?: () => boolean;
  canUndoStitch?: () => boolean;
  className?: string;
  importRefsCallback?: (refs: ImportRefs) => void;
  // Fired when the set of viewer-owned content (meshes, skeletons) changes
  // between empty and non-empty. App uses this to dismiss the empty-state hint
  // when content arrives that isn't a scan — e.g. a generated Helios plant,
  // which is a mesh, not a scan.
  onViewerContentChange?: (hasContent: boolean) => void;
}

export default function PointCloudViewer({
  scans,
  selectedScanIds,
  onToggleVisibility,
  onToggleSelection,
  onRemoveScan,
  onSelectAll,
  onDeselectAll,
  onUpdateScanData,
  onUpdateScanParams,
  onUpdateScanLabel,
  onSave: _onSave,
  onAddScan,
  onAddScans,
  onStitchScans,
  onUndoStitch,
  canUndoStitch,
  className = '',
  importRefsCallback,
  onViewerContentChange
}: PointCloudViewerProps) {
  // Legacy internal aliases. The bulk of this file was written against
  // `clouds` / `selectedIds` / `onUpdateCloud` etc., and assumes every entry
  // has a `data` payload. We adapt the unified Scan list at the boundary so
  // existing callsites keep working while the right-pane UI and the marker
  // rendering use the full scan (including params-only entries).
  const clouds: PointCloudEntry[] = useMemo(
    () => scans.filter(hasData).map(s => ({
      id: s.id,
      data: s.data,
      visible: s.visible,
      color: s.color,
      sourcePath: s.sourcePath,
      asciiFormat: s.asciiFormat,
    })),
    [scans],
  );
  // Selection set is shared between data-bearing and params-only scans — the
  // existing tool-panel logic only ever asks "is this cloud id selected", and
  // those ids never collide with params-only scan ids.
  const selectedIds = selectedScanIds;
  const onRemoveCloud = onRemoveScan;

  const onUpdateCloud = onUpdateScanData;
  const onAddCloud = useMemo(() => {
    if (!onAddScan) return undefined;
    return (cloud: PointCloudEntry) => {
      onAddScan({
        id: cloud.id,
        label: cloud.data.fileName ?? 'Scan',
        visible: cloud.visible,
        color: cloud.color,
        data: cloud.data,
      });
    };
  }, [onAddScan]);
  const onStitchClouds = onStitchScans;
  const [pointSize, setPointSize] = useState(1);
  const [colorMode, setColorMode] = useState<ColorMode>('per-scan');
  const [selectedScalarField, setSelectedScalarField] = useState<string | undefined>(undefined);
  const [colormap, setColormap] = useState<ColormapName>('viridis');
  // One-shot remount generation per octree cacheId. An OctreePointCloud that
  // MOUNTS directly into a gradient mode (height/scalar) — e.g. a freshly
  // imported cloud while the global colorMode is already 'height' — compiles
  // its colour shader before any tiles exist, so the first tiles render with a
  // stale (grayscale) program until something forces a recompile. The
  // colorMode/field remount key only fires on a *change*, not on mount-into.
  // We bump this generation once, shortly after the cloud appears, to force a
  // single fresh-material remount with tiles present (the same cure as a manual
  // mode toggle). Keyed by cacheId and guarded so it fires at most once per
  // octree — no remount loop.
  const [octreePaintGen, setOctreePaintGen] = useState<Record<string, number>>({});
  const octreePaintedRef = useRef<Set<string>>(new Set());
  // Fired (via OctreePointCloud.onFirstTilesReady) the first time an octree's
  // tiles paint. Forces a single fresh-material remount so a cloud that mounted
  // directly into a gradient/scalar mode recompiles its shader with geometry
  // present. rgb / per-scan / single render correctly on first paint, so they
  // don't need it — and a later switch INTO a gradient mode is a colorMode
  // change, which already remounts via the key. Guarded → fires once per
  // cacheId, never loops.
  const handleOctreeFirstTiles = useCallback((cacheId: string) => {
    const needsRefresh =
      colorMode === 'height' || colorMode === 'intensity' ||
      colorMode === 'scalar' || colorMode === 'x' || colorMode === 'y';
    if (!needsRefresh) return;
    if (octreePaintedRef.current.has(cacheId)) return;
    octreePaintedRef.current.add(cacheId);
    setOctreePaintGen(prev => ({ ...prev, [cacheId]: (prev[cacheId] ?? 0) + 1 }));
  }, [colorMode]);
  // Custom min/max overrides keyed by `${colorMode}:${field?}`. Undefined entries
  // mean "use the data-derived range."
  const [colorRanges, setColorRanges] = useState<Record<string, { min?: number; max?: number }>>({});
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

  // Ground segmentation state (Cloth Simulation Filter)
  const [showGroundSegmentPanel, setShowGroundSegmentPanel] = useState(false);
  const [groundSegmentInProgress, setGroundSegmentInProgress] = useState(false);
  const [groundSegmentError, setGroundSegmentError] = useState<string | null>(null);
  const [groundClothResolution, setGroundClothResolution] = useState(0.05);
  const [groundClassThreshold, setGroundClassThreshold] = useState(0.02);
  const [groundRigidness, setGroundRigidness] = useState(3);
  const [groundSplitClouds, setGroundSplitClouds] = useState(false);
  // Tree (individual-tree) segmentation via TreeIso.
  const [showTreeSegmentPanel, setShowTreeSegmentPanel] = useState(false);
  const [treeSegmentInProgress, setTreeSegmentInProgress] = useState(false);
  const [treeSegmentError, setTreeSegmentError] = useState<string | null>(null);
  const [treeRegStrength1, setTreeRegStrength1] = useState(1.0);
  const [treeRegStrength2, setTreeRegStrength2] = useState(15.0);
  const [treeMaxGap, setTreeMaxGap] = useState(2.0);
  const [treeSplitClouds, setTreeSplitClouds] = useState(false);
  // Human-in-the-loop trunk seeding: when seeding, clicks drop a seed marker.
  const [treeSeedMode, setTreeSeedMode] = useState(false);
  const [treeSeedPoints, setTreeSeedPoints] = useState<Array<[number, number, number]>>([]);
  // Refine controls (post-segmentation merge/split of the tree_instance field).
  const [treeMergeA, setTreeMergeA] = useState(1);
  const [treeMergeB, setTreeMergeB] = useState(2);
  const [treeSplitId, setTreeSplitId] = useState(1);

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
  const [skeletonProportionThreshold] = useState(0.1);

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

  // Report whether the viewer holds any non-scan content (meshes or skeletons)
  // so App can dismiss the empty-state hint when e.g. a plant is generated.
  useEffect(() => {
    onViewerContentChange?.(meshes.length > 0 || skeletons.length > 0);
  }, [onViewerContentChange, meshes.length, skeletons.length]);

  // Export panel state
  const [showExportPanel, setShowExportPanel] = useState(false);

  // Global app settings (persisted via electron-store). Currently just the
  // triangulate point cap for octree clouds; loaded once on mount.
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [triangulateMaxPoints, setTriangulateMaxPoints] = useState(5_000_000);
  useEffect(() => {
    getSettings().then(s => setTriangulateMaxPoints(s.triangulateMaxPoints)).catch(() => {});
  }, []);
  const commitTriangulateMaxPoints = useCallback((value: number) => {
    const v = Math.max(1000, Math.floor(value) || 5_000_000);
    setTriangulateMaxPoints(v);
    updateSettings({ triangulateMaxPoints: v }).catch(() => {});
  }, []);

  // Alignment comparison state
  const [showAlignmentPanel, setShowAlignmentPanel] = useState(false);
  const [alignmentResults, setAlignmentResults] = useState<AlignmentDistanceResponse | null>(null);
  const [isComputingAlignment, setIsComputingAlignment] = useState(false);
  // Live alignment mode - automatically computes alignment when mesh is moved
  const [liveAlignmentEnabled] = useState(true); // Auto-enabled by default in mixed mode
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
  // Live build progress (0-1) + phase message, shown in the popup's progress bar.
  const [plantProgress, setPlantProgress] = useState<number | null>(null);
  const [plantProgressMsg, setPlantProgressMsg] = useState('');
  // Abort controller for an in-flight streaming build (Cancel button).
  const plantAbortRef = useRef<AbortController | null>(null);
  // Helios triangulation popup + background task state
  const [showHeliosPopup, setShowHeliosPopup] = useState(false);
  const [isHeliosRunning, setIsHeliosRunning] = useState(false);
  const heliosAbortRef = useRef<AbortController | null>(null);
  // True while handleApplyCrop's backend round-trip is in flight. Keeps the
  // crop preview (hidden to-be-cropped points) alive after editMode flips to
  // 'none' and drives the "Cropping…" badge.
  const [isApplyingCrop, setIsApplyingCrop] = useState(false);
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
  // Lock per-axis scale so edits apply uniformly to X/Y/Z
  const [scaleLocked, setScaleLocked] = useState(false);
  const [showPlantGrowthPanel, setShowPlantGrowthPanel] = useState(false);
  const [showMorphPopup, setShowMorphPopup] = useState(false);
  const [isMorphing, setIsMorphing] = useState(false);

  // Scan rows derived from the parent's unified Scan list. `scansWithParams`
  // backs the scanner-marker rendering and the right-pane "Scans" panel for
  // entries that carry scan parameters; `scansAll` is used for the panel
  // listing (which shows every scan regardless of whether it has data).
  const scansAll = scans;
  const scansWithParams = useMemo(() => scans.filter(hasParams), [scans]);
  const [selectedMarkerScanId, setSelectedMarkerScanId] = useState<string | null>(null);
  const [scanPopupState, setScanPopupState] = useState<
    | { kind: 'closed' }
    | { kind: 'add' }
    | { kind: 'edit'; id: string }
    | { kind: 'add-params-to'; id: string }
  >({ kind: 'closed' });
  // Defaults handed to the popup when adding a new scan (label, origin).
  // openAddScanPopup is declared lower, after combinedBounds is in scope.
  const [scanDefaults, setScanDefaults] = useState<{ label?: string; params?: Partial<ScanParameters> }>({});
  // Progress for a Helios XML bulk import in flight. The launching popup
  // closes immediately so the user sees this modal instead of an idle popup.
  const [bulkImportProgress, setBulkImportProgress] = useState<BulkImportProgressState | null>(null);
  // Per-row expansion state for the scans panel. Held in-memory only; resets
  // on app reload.
  const [expandedScanIds, setExpandedScanIds] = useState<Set<string>>(new Set());

  // Edit mode and per-cloud edit states
  const [editMode, setEditMode] = useState<EditMode>('none');
  const [editStates, setEditStates] = useState<Map<string, CloudEditState>>(new Map());

  // Crop state lives at the viewer level (not per-cloud) so a single
  // region applies uniformly across every selected scan. See cropGeometry.ts
  // for the region types.
  type CropMode = 'box' | 'rect' | 'polygon';
  type CropDrawState =
    | 'idle'
    | 'awaiting-box-corner-1'
    | 'awaiting-box-corner-2'
    | 'drawing-polygon'
    | 'drawing-rect';
  const [cropMode, setCropMode] = useState<CropMode>('box');
  // World-space AABB. Null when crop mode hasn't been entered yet.
  const [cropBox, setCropBox] = useState<{
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  } | null>(null);
  // Closed screen-space polygon (camera-frozen at draw time).
  const [cropPolygon, setCropPolygon] = useState<{
    points: { x: number; y: number }[];
    projection: number[];
    view: number[];
    canvasSize: { width: number; height: number };
  } | null>(null);
  const [cropInvert, setCropInvert] = useState(false);
  // When true, Apply partitions each cloud in two: the original keeps the
  // in-region points (normal crop) and the cropped-out (inverse) points
  // become a brand-new cloud added to the scene — no points are discarded.
  const [cropSegment, setCropSegment] = useState(false);
  const [cropDrawState, setCropDrawState] = useState<CropDrawState>('idle');
  // In-progress polygon vertices while the user is clicking. Promoted to
  // cropPolygon when they press Enter.
  const [polygonInProgress, setPolygonInProgress] = useState<
    { x: number; y: number }[]
  >([]);
  // First-corner stash while a two-click ground-plane box draw is in
  // progress.
  const boxDrawFirstCornerRef = useRef<{ x: number; y: number } | null>(null);
  // Live world-XY cursor position on the ground plane while placing box
  // corners, used to render the corner-1 marker and the live preview box
  // that follows the cursor before corner 2 is clicked. On a ref (plus a
  // tick to force re-render) so the panel doesn't re-render per mousemove.
  const boxDrawCursorRef = useRef<{ x: number; y: number } | null>(null);
  const [boxDrawCursorTick, setBoxDrawCursorTick] = useState(0);
  // Live snapshots of the rendering camera and canvas size, kept in sync
  // by a tiny in-Canvas component (PolygonCameraSnapshotter). Read when
  // the user presses Enter to close a polygon so the in/out test stays
  // stable even if they orbit afterwards.
  const polygonCameraRef = useRef<THREE.Camera | null>(null);
  const polygonCanvasSizeRef = useRef<{ width: number; height: number } | null>(null);
  // Live canvas-pixel position of the mouse while drawing a polygon —
  // used to render the "next segment" preview line from the last vertex
  // to the cursor. Stored on a ref since it updates on every mousemove
  // and we don't want to re-render the panel for it.
  const polygonCursorRef = useRef<{ x: number; y: number } | null>(null);
  const [polygonCursorTick, setPolygonCursorTick] = useState(0);
  // Rect-drag state (canvas-pixel space). A rectangle crop is a screen-space
  // drag that works from any view; on mouse-up its 4 corners are frozen into
  // cropPolygon, so it reuses the entire polygon project-and-test pipeline.
  // `rectDragStart` is the mousedown corner (non-null ⇒ a drag is in
  // progress); the live opposite corner lives on a ref + tick so dragging
  // doesn't re-render the panel.
  const [rectDragStart, setRectDragStart] = useState<{ x: number; y: number } | null>(null);
  const rectDragCurrentRef = useRef<{ x: number; y: number } | null>(null);
  const [rectDragTick, setRectDragTick] = useState(0);

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

  // Blender-style modal transform state: T (translate), S (scale) with X/Y/Z axis lock
  // and Shift+X/Y/Z plane lock (Shift+X = constrain to YZ plane, etc.).
  type TransformAxis = 'free' | 'x' | 'y' | 'z' | 'yz' | 'xz' | 'xy';
  interface TransformModalState {
    op: 'translate' | 'scale';
    axis: TransformAxis;
    startScreen: { x: number; y: number };
    pivot: { x: number; y: number; z: number };
    target: 'mesh' | 'skeleton' | 'cloud';
    meshId?: string;
    skeletonId?: string;
    cloudIds?: string[];
    originalMeshPos?: { x: number; y: number; z: number };
    originalMeshScale?: { x: number; y: number; z: number };
    originalSkeletonPos?: { x: number; y: number; z: number };
    originalCloudTranslations?: Map<string, { x: number; y: number; z: number }>;
    // Numeric input buffer (Blender-style). When parseable, overrides mouse-driven value.
    numericBuffer: string;
  }
  const transformModalRef = useRef<TransformModalState | null>(null);
  const [transformModal, setTransformModal] = useState<TransformModalState | null>(null);

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
    if (except !== 'ground-segment') setShowGroundSegmentPanel(false);
    if (except !== 'tree-segment') { setShowTreeSegmentPanel(false); setTreeSeedMode(false); }
    if (except !== 'skeleton') setShowSkeletonPanel(false);
    if (except !== 'export') setShowExportPanel(false);
    if (except !== 'morph') setShowMorphPopup(false);
  }, []);

  // Get edit state for a cloud
  const getEditState = useCallback((id: string): CloudEditState => {
    return editStates.get(id) || {
      translation: { x: 0, y: 0, z: 0 },
      erasedIndices: new Set<number>(),
    };
  }, [editStates]);

  // Toggle the crop tool. Called from both the single-cloud toolbar and
  // the multi-cloud toolbar so the same Crop button is available to N≥1
  // selected scans. On entry the world-space cropBox is initialized to
  // the union of every selected scan's translated bounds.
  const toggleCropMode = useCallback(() => {
    if (editMode === 'crop') {
      setEditMode('none');
      setCropDrawState('idle');
      setPolygonInProgress([]);
      return;
    }
    closeAllToolPanels('editMode');
    const initial = worldBoundsUnion(
      Array.from(selectedIds)
        .map(id => clouds.find(c => c.id === id))
        .filter((c): c is PointCloudEntry => !!c)
        .map(c => ({
          bounds: {
            min: { x: c.data.bounds.min.x, y: c.data.bounds.min.y, z: c.data.bounds.min.z },
            max: { x: c.data.bounds.max.x, y: c.data.bounds.max.y, z: c.data.bounds.max.z },
          },
          translation: getEditState(c.id).translation,
        })),
    );
    if (initial) setCropBox(initial);
    setCropPolygon(null);
    setPolygonInProgress([]);
    setRectDragStart(null);
    rectDragCurrentRef.current = null;
    setCropDrawState('idle');
    setCropMode('box');
    setCropInvert(false);
    setCropSegment(false);
    setEditMode('crop');
  }, [editMode, selectedIds, clouds, getEditState, closeAllToolPanels]);

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

  // Expose viewer-scoped actions on window so the application menu (wired in
  // src/main/menu.ts) can dispatch to them via App.tsx without prop-drilling.
  // Matches the existing __resetPointCloudCamera / __snapToView pattern in
  // CameraController above.
  useEffect(() => {
    (window as any).__handleUndo = handleUndo;
    (window as any).__handleRedo = handleRedo;
    (window as any).__openExportPanel = () => {
      closeAllToolPanels('export');
      setShowExportPanel(true);
    };
    return () => {
      delete (window as any).__handleUndo;
      delete (window as any).__handleRedo;
      delete (window as any).__openExportPanel;
    };
  }, [handleUndo, handleRedo, closeAllToolPanels]);

  // Build a world-space inclusion predicate for the active crop region.
  // Returns null when there's no usable region (mode mismatch / nothing
  // drawn yet). Callers pass world-space coords. Box mode is a simple
  // AABB test; polygon mode projects to canvas pixels using the frozen
  // camera matrices and runs a ray-casting point-in-polygon.
  const buildCropPredicate = useCallback((): ((wx: number, wy: number, wz: number) => boolean) | null => {
    if (cropMode === 'box') {
      if (!cropBox) return null;
      const { min, max } = cropBox;
      return (wx, wy, wz) =>
        wx >= min.x && wx <= max.x &&
        wy >= min.y && wy <= max.y &&
        wz >= min.z && wz <= max.z;
    }
    // Rect and Polygon both produce a frozen screen-space polygon
    // (rect = 4 corners), so they share the project-then-point-in-polygon
    // predicate and the backend `polygon` region payload.
    if (cropMode === 'polygon' || cropMode === 'rect') {
      if (!cropPolygon || cropPolygon.points.length < 3) return null;
      const { points, projection, view, canvasSize } = cropPolygon;
      return (wx, wy, wz) => {
        const pixel = projectWorldToCanvasPixel(
          { x: wx, y: wy, z: wz },
          projection,
          view,
          canvasSize,
        );
        if (!pixel) return false;
        return pointInPolygon(pixel, points);
      };
    }
    return null;
  }, [cropMode, cropBox, cropPolygon]);

  // Apply the active crop region to every selected scan. Multi-scan crop
  // produces N cropped scans — one per input — preserving per-scan
  // identity (id, fileName, scan params live elsewhere). Translation is
  // baked into the new positions, matching the existing erase/filter
  // semantics so downstream code stays uniform.
  //
  // CRITICAL: clouds are processed one-per-task with setTimeout yields
  // between them, reading the LATEST scans through `cloudsRef` rather
  // than capturing the array in the useCallback closure. This is what
  // keeps multi-cloud apply within V8's 4 GB heap limit on large scans.
  //
  // The synchronous-loop approach holds every old cloud.data buffer
  // alive for the full duration of the callback (the closure pins the
  // `clouds` array), so during the loop we transiently have:
  //   (every old cloud.data) + (this iteration's new typed arrays)
  // For two ~28M-point scans with RGB + intensity that's ~1.57 GB old +
  // ~784 MB new + position GPU buffers + live preview indices ≈ 3 GB
  // external — combined with React/three.js overhead it tips over the
  // 4 GB ceiling.
  //
  // Sequential processing means each iteration's old cloud.data becomes
  // unreachable after onUpdateCloud commits and React processes the
  // resulting setScans, freeing it before the next iteration's
  // allocation. Peak is now ~one cloud's old + new ≈ 1.2 GB transient,
  // well under the ceiling.
  const cloudsRef = useRef(clouds);
  cloudsRef.current = clouds;
  const editStatesRef = useRef(editStates);
  editStatesRef.current = editStates;

  const handleApplyCrop = useCallback(() => {
    if (editMode !== 'crop' || selectedIds.size === 0) return;
    if (isApplyingCrop) return;
    const predicate = buildCropPredicate();
    if (!predicate) return;

    // Capture the inputs the apply needs BEFORE we tear down the crop UI.
    // After flushSync(setEditMode('none')) below, cropBox/cropInvert in
    // closure are still the values we want (closures don't re-bind on
    // re-render).
    //
    // isApplyingCrop is set first so the crop preview survives the editMode
    // flip: the octree clipBox and the flat-cloud index filter are gated on
    // (editMode === 'crop' || isApplyingCrop), so flipping editMode to 'none'
    // here hides the draggable box handles + the crop panel while the
    // to-be-cropped points stay HIDDEN until the new cropped data is live.
    // That's the whole point — the backend round-trip can take 15-20 s
    // (octree re-conversion), and flashing the cropped points back into
    // view during that window made users think the crop had failed.
    //
    // Memory tradeoff: keeping the preview alive re-couples the flat-cloud
    // index buffer with the apply's new typed arrays (the original teardown
    // dropped the index buffer first to stay under V8's 4 GB old-space
    // ceiling). This only matters for the in-renderer fallback path
    // (stitched / erased / polygon clouds) on very large flat scans — the
    // common slow case is octree clouds, whose preview is a GPU clip box
    // with no large JS buffer, so keeping it alive is free. The flat
    // backend path (cropPointCloudByPath) allocates in Python, not V8. If a
    // large in-renderer crop is ever observed to OOM, release that cloud's
    // preview right before its two-pass allocation below.
    setIsApplyingCrop(true);
    flushSync(() => {
      setEditMode('none');
    });

    const cloudIdsToProcess = Array.from(selectedIds);
    const emptied: { id: string; name: string }[] = [];
    const touchedCloudIds: string[] = [];
    // Sum of kept point counts across all clouds touched in this apply.
    // Used by finishUp to surface a "Cropped to N points" toast.
    const keptCounts: number[] = [];
    // Segment mode: keep the cropped-out (inverse) points as a new cloud
    // rather than discarding them. Captured here so the value is stable for
    // the whole apply even though the panel is torn down mid-run.
    const segment = cropSegment;
    // Number of new "(segment)" clouds added this apply — drives the toast.
    let segmentedCount = 0;
    // Distinct color for the new segment cloud so it's separable from the
    // source in the scene (mustard, matching the brand highlight palette).
    const SEGMENT_COLOR = '#f59e0b';

    const finishUp = () => {
      if (touchedCloudIds.length > 0) {
        setEditStates(prev => {
          const next = new Map(prev);
          for (const id of touchedCloudIds) {
            next.set(id, {
              translation: { x: 0, y: 0, z: 0 },
              erasedIndices: new Set<number>(),
            });
          }
          return next;
        });
        setHistory(prev => prev.filter(entry => !touchedCloudIds.includes(entry.id)));
        setHistoryIndex(prev => Math.max(-1, prev - touchedCloudIds.length));

        // Post-apply confirmation toast. Mirrors the "Loaded N points"
        // toast from import — gives the user a concrete signal that the
        // apply finished and which cloud(s) the new point count refers
        // to. Surfaced for octree and flat apply paths alike.
        const total = keptCounts.reduce((s, n) => s + n, 0);
        if (total > 0) {
          const cloudWord = touchedCloudIds.length === 1 ? 'cloud' : 'clouds';
          showToast({
            title: `Cropped ${touchedCloudIds.length} ${cloudWord} to ${total.toLocaleString()} points`,
            type: 'success',
          });
        }
      }

      // Segment-mode confirmation. Fires independently of the crop toast
      // above (the source cloud may have been fully cropped away yet the
      // inverse still produced a new cloud).
      if (segmentedCount > 0) {
        const segWord = segmentedCount === 1 ? 'cloud' : 'clouds';
        showToast({
          title: `Segmented ${segmentedCount} new ${segWord} from cropped-out points`,
          type: 'success',
        });
      }

      if (emptied.length > 0) {
        setDeleteConfirm({ type: 'cloud', id: emptied[0].id, name: emptied[0].name });
      }

      // Clear the apply flag together with the crop region: the preview
      // (hidden points) stays alive right up until this point — after the new
      // cropped cloud data has already been swapped in via onUpdateCloud — so
      // the points never flash back into view.
      setIsApplyingCrop(false);
      setCropBox(null);
      setCropPolygon(null);
      setPolygonInProgress([]);
      setRectDragStart(null);
      rectDragCurrentRef.current = null;
      setCropDrawState('idle');
      setCropSegment(false);
      setEditMode('none');
    };

    // Per-cloud work. Box-mode + sourcePath + no-erased clouds delegate
    // the filter to the backend (Python/NumPy can iterate a 28M-point
    // typed array without hitting V8's 4 GB old-space ceiling). The
    // in-renderer two-pass remains the fallback for stitched clouds (no
    // sourcePath), clouds with erased indices the backend doesn't know
    // about, and polygon-mode crop (camera-frozen predicate the backend
    // can't evaluate). Returns a Promise so the outer loop awaits the
    // HTTP round-trip between clouds — keeping the cross-iteration GC
    // window the in-JS path relied on for memory headroom.
    const processOne = async (cloudId: string): Promise<void> => {
      // IMPORTANT: read from the ref, not from the closure-captured
      // `clouds`. After the previous iteration's setScans commits, the
      // ref points at the new scans array (without the old cloud.data
      // we just replaced), so the old data is GC-eligible.
      const cloud = cloudsRef.current.find(c => c.id === cloudId);
      if (!cloud) return;
      const state = editStatesRef.current.get(cloudId) ?? {
        translation: { x: 0, y: 0, z: 0 },
        erasedIndices: new Set<number>(),
      };

      const src = cloud.data;
      const erased = state.erasedIndices;
      const tx = state.translation.x;
      const ty = state.translation.y;
      const tz = state.translation.z;

      // No-op short-circuit: when the box-mode crop fully encloses this
      // cloud's translated bounds and there's nothing else to bake in,
      // the apply would produce a byte-identical copy of cloud.data.
      // Skip the allocation entirely.
      if (
        cropMode === 'box' && cropBox && !cropInvert &&
        erased.size === 0 && tx === 0 && ty === 0 && tz === 0 &&
        src.bounds.min.x >= cropBox.min.x && src.bounds.max.x <= cropBox.max.x &&
        src.bounds.min.y >= cropBox.min.y && src.bounds.max.y <= cropBox.max.y &&
        src.bounds.min.z >= cropBox.min.z && src.bounds.max.z <= cropBox.max.z
      ) {
        return;
      }

      // Octree-backed clouds: route through /api/pointcloud/crop_octree.
      // The backend re-runs PotreeConverter on a filtered XYZ source and
      // returns a new cache id; the renderer hot-swaps to it (the
      // OctreePointCloud component depends on data.octree.cacheId, so
      // changing it triggers dispose + reload of the underlying
      // PointCloudOctree without remounting the React node).
      //
      // Both box and polygon regions go backend-side. Erased indices from
      // the in-renderer brush are unreachable here because octree clouds
      // don't expose flat positions to the brush in the first place —
      // erase regions are handled by handleApplyErase via the same
      // crop_octree endpoint.
      if (cloud.data.octree && cloud.data.octree.sourceXyzPath) {
        const octreeInfo = cloud.data.octree;
        let region: CropOctreeRegion | null = null;
        if (cropMode === 'box' && cropBox) {
          region = {
            kind: 'box',
            min: [cropBox.min.x, cropBox.min.y, cropBox.min.z],
            max: [cropBox.max.x, cropBox.max.y, cropBox.max.z],
            invert: cropInvert,
          };
        } else if ((cropMode === 'polygon' || cropMode === 'rect') && cropPolygon && cropPolygon.points.length >= 3) {
          region = {
            kind: 'polygon',
            points: cropPolygon.points.map(p => [p.x, p.y] as [number, number]),
            projection: cropPolygon.projection,
            view: cropPolygon.view,
            canvas: {
              width: cropPolygon.canvasSize.width,
              height: cropPolygon.canvasSize.height,
            },
            invert: cropInvert,
          };
        }

        if (region) {
          try {
            const result = await cropOctree(octreeInfo.sourceXyzPath, {
              asciiFormat: octreeInfo.asciiFormat ?? null,
              region,
              translation: (tx !== 0 || ty !== 0 || tz !== 0)
                ? [tx, ty, tz]
                : null,
            });
            if (result.point_count === 0 || !result.cache_id) {
              emptied.push({ id: cloud.id, name: src.fileName || 'Unnamed' });
              return;
            }
            // buildPointCloudFromOctree builds the new PointCloudData
            // (empty positions, tight_bounds for the new extent, new
            // cacheId). React passes it to OctreePointCloud which
            // observes the cacheId change and re-loads the streamed tiles.
            const newData = buildPointCloudFromOctree(
              {
                cache_id: result.cache_id,
                cache_dir: result.cache_dir ?? '',
                cached: result.cached,
                version: result.version,
                point_count: result.point_count,
                spacing: result.spacing,
                scale: result.scale,
                offset: result.offset,
                bounds: result.bounds,
                tight_bounds: result.tight_bounds,
                attributes: result.attributes,
              },
              octreeInfo.sourceXyzPath,
              src.fileName ?? cloud.id,
              octreeInfo.asciiFormat ?? null,
            );
            onUpdateCloud(cloud.id, newData);
            touchedCloudIds.push(cloud.id);
            keptCounts.push(result.point_count);

            // Segment mode: re-run the crop with the region inverted and add
            // the cropped-out points as a new cloud. Same backend endpoint,
            // just invert flipped. An empty inverse (region enclosed the whole
            // cloud) is silently skipped — nothing to segment off.
            if (segment && onAddCloud) {
              try {
                const invResult = await cropOctree(octreeInfo.sourceXyzPath, {
                  asciiFormat: octreeInfo.asciiFormat ?? null,
                  region: { ...region, invert: !cropInvert },
                  translation: (tx !== 0 || ty !== 0 || tz !== 0)
                    ? [tx, ty, tz]
                    : null,
                });
                if (invResult.point_count > 0 && invResult.cache_id) {
                  onAddCloud({
                    id: crypto.randomUUID(),
                    data: buildPointCloudFromOctree(
                      {
                        cache_id: invResult.cache_id,
                        cache_dir: invResult.cache_dir ?? '',
                        cached: invResult.cached,
                        version: invResult.version,
                        point_count: invResult.point_count,
                        spacing: invResult.spacing,
                        scale: invResult.scale,
                        offset: invResult.offset,
                        bounds: invResult.bounds,
                        tight_bounds: invResult.tight_bounds,
                        attributes: invResult.attributes,
                      },
                      octreeInfo.sourceXyzPath,
                      `${src.fileName ?? cloud.id} (segment)`,
                      octreeInfo.asciiFormat ?? null,
                    ),
                    visible: true,
                    color: SEGMENT_COLOR,
                  });
                  segmentedCount++;
                }
              } catch (err) {
                console.error('[handleApplyCrop] segment (octree inverse) failed:', err);
                showToast({
                  title: `Segment failed for ${src.fileName || 'cloud'}`,
                  type: 'error',
                });
              }
            }
            return;
          } catch (err) {
            console.error('[handleApplyCrop] crop_octree failed:', err);
            // No fallback for octree clouds — the in-renderer path below
            // iterates data.positions which is empty for octrees. Surface
            // the failure via a toast and skip the cloud.
            showToast({
              title: `Crop failed for ${src.fileName || 'cloud'}`,
              type: 'error',
            });
            return;
          }
        }
      }

      // Backend-delegated path. Box mode with a known sourcePath and no
      // erased points is the common case on freshly-imported scans —
      // exactly the situation that OOM'd in JS. The backend re-reads the
      // file, applies the AABB filter with NumPy, and streams the kept
      // points back; the renderer just decodes one Float32Array per
      // channel from the response and hands it to onUpdateCloud. No
      // multi-GB intermediates in V8.
      if (
        cropMode === 'box' && cropBox &&
        cloud.sourcePath && erased.size === 0
      ) {
        try {
          const response = await cropPointCloudByPath(cloud.sourcePath, {
            asciiFormat: cloud.asciiFormat ?? null,
            cropMin: cropBox.min,
            cropMax: cropBox.max,
            cropInvert,
            translation: (tx !== 0 || ty !== 0 || tz !== 0)
              ? { x: tx, y: ty, z: tz }
              : null,
          });
          if (response.pointCount === 0) {
            emptied.push({ id: cloud.id, name: src.fileName || 'Unnamed' });
            return;
          }
          const newData = buildPointCloudFromBackend(response, src.fileName ?? cloud.id);
          onUpdateCloud(cloud.id, newData);
          touchedCloudIds.push(cloud.id);
          keptCounts.push(response.pointCount);

          // Segment mode: re-read the file with the crop inverted and add the
          // cropped-out points as a new cloud. Wrapped in its own try/catch so
          // a failure here doesn't trigger the in-renderer fallback below (the
          // kept set is already committed).
          if (segment && onAddCloud) {
            try {
              const invResponse = await cropPointCloudByPath(cloud.sourcePath, {
                asciiFormat: cloud.asciiFormat ?? null,
                cropMin: cropBox.min,
                cropMax: cropBox.max,
                cropInvert: !cropInvert,
                translation: (tx !== 0 || ty !== 0 || tz !== 0)
                  ? { x: tx, y: ty, z: tz }
                  : null,
              });
              if (invResponse.pointCount > 0) {
                onAddCloud({
                  id: crypto.randomUUID(),
                  data: buildPointCloudFromBackend(
                    invResponse,
                    `${src.fileName ?? cloud.id} (segment)`,
                  ),
                  visible: true,
                  color: SEGMENT_COLOR,
                });
                segmentedCount++;
              }
            } catch (err) {
              console.error('[handleApplyCrop] segment (flat inverse) failed:', err);
              showToast({
                title: `Segment failed for ${src.fileName || 'cloud'}`,
                type: 'error',
              });
            }
          }
          return;
        } catch (err) {
          // Fall through to the in-renderer path. We log so a 5xx from
          // the backend (or a renamed/moved source file) surfaces in
          // dev, but otherwise transparently take the slower path —
          // it'll still work for small clouds.
          console.warn('[handleApplyCrop] backend crop failed, falling back to in-renderer:', err);
        }
      }

      // In-renderer fallback. Two-pass over typed arrays (count, then
      // fill). Used for stitched clouds (no sourcePath), clouds with
      // erased indices, polygon-mode crop, and any case where the
      // backend call raised above.
      //
      // buildSubset emits one partition of the cloud: with keepWhenInside
      // true it keeps points the predicate accepts, with false it keeps the
      // complement. Returns null when the partition is empty. The kept set
      // (keepWhenInside = !cropInvert) preserves the prior behavior; segment
      // mode also builds the inverse (keepWhenInside = cropInvert) as a new
      // cloud. Colors/intensities follow the points; scalarFields are dropped
      // here as they were before — only the octree path carries them.
      const buildSubset = (keepWhenInside: boolean): PointCloudData | null => {
        let pointCount = 0;
        for (let i = 0; i < src.pointCount; i++) {
          if (erased.has(i)) continue;
          const wx = src.positions[i * 3] + tx;
          const wy = src.positions[i * 3 + 1] + ty;
          const wz = src.positions[i * 3 + 2] + tz;
          const inside = predicate(wx, wy, wz);
          if (keepWhenInside ? inside : !inside) pointCount++;
        }

        if (pointCount === 0) return null;

        const newPositions = new Float32Array(pointCount * 3);
        const newColors = src.colors ? new Float32Array(pointCount * 3) : null;
        const newIntensities = src.intensities ? new Float32Array(pointCount) : null;

        const min = new THREE.Vector3(Infinity, Infinity, Infinity);
        const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

        let w = 0;
        for (let i = 0; i < src.pointCount; i++) {
          if (erased.has(i)) continue;
          const wx = src.positions[i * 3] + tx;
          const wy = src.positions[i * 3 + 1] + ty;
          const wz = src.positions[i * 3 + 2] + tz;
          const inside = predicate(wx, wy, wz);
          if (!(keepWhenInside ? inside : !inside)) continue;
          newPositions[w * 3] = wx;
          newPositions[w * 3 + 1] = wy;
          newPositions[w * 3 + 2] = wz;
          if (wx < min.x) min.x = wx; if (wx > max.x) max.x = wx;
          if (wy < min.y) min.y = wy; if (wy > max.y) max.y = wy;
          if (wz < min.z) min.z = wz; if (wz > max.z) max.z = wz;
          if (newColors && src.colors) {
            newColors[w * 3] = src.colors[i * 3];
            newColors[w * 3 + 1] = src.colors[i * 3 + 1];
            newColors[w * 3 + 2] = src.colors[i * 3 + 2];
          }
          if (newIntensities && src.intensities) {
            newIntensities[w] = src.intensities[i];
          }
          w++;
        }

        const center = new THREE.Vector3(
          (min.x + max.x) / 2,
          (min.y + max.y) / 2,
          (min.z + max.z) / 2,
        );
        const size = new THREE.Vector3(
          max.x - min.x,
          max.y - min.y,
          max.z - min.z,
        );

        return {
          positions: newPositions,
          colors: newColors ?? undefined,
          intensities: newIntensities ?? undefined,
          pointCount,
          bounds: { min, max, center, size },
          fileName: src.fileName,
        };
      };

      // Segment mode builds the inverse first, so if the kept set turns out
      // empty (and we delete the source) the segment cloud still carries the
      // points. onAddCloud is undefined when the host didn't wire onAddScan.
      if (segment && onAddCloud) {
        const inverseData = buildSubset(cropInvert);
        if (inverseData) {
          onAddCloud({
            id: crypto.randomUUID(),
            data: { ...inverseData, fileName: `${src.fileName ?? cloud.id} (segment)` },
            visible: true,
            color: SEGMENT_COLOR,
          });
          segmentedCount++;
        }
      }

      const keptData = buildSubset(!cropInvert);
      if (!keptData) {
        emptied.push({ id: cloud.id, name: src.fileName || 'Unnamed' });
        return;
      }
      onUpdateCloud(cloud.id, keptData);
      touchedCloudIds.push(cloud.id);
      keptCounts.push(keptData.pointCount);
    };

    let i = 0;
    const next = async (): Promise<void> => {
      if (i >= cloudIdsToProcess.length) {
        finishUp();
        return;
      }
      const cloudId = cloudIdsToProcess[i];
      i++;
      // Await processOne — backend round-trips need to complete before
      // the next iteration starts, otherwise we'd fire all crop requests
      // in parallel and lose the cross-iteration GC headroom.
      await processOne(cloudId);
      // Yield via setTimeout so React commits the setScans triggered by
      // onUpdateCloud, cloudsRef gets refreshed by our render-body
      // assignment, and GC has a chance to reclaim the previous
      // iteration's old cloud.data buffers before we allocate again.
      setTimeout(next, 0);
    };
    void next();
  }, [editMode, selectedIds, isApplyingCrop, onUpdateCloud, buildCropPredicate, cropInvert, cropMode, cropBox, cropPolygon]);

  // Apply erased points permanently - removes erased points and bakes in translation
  const handleApplyErase = useCallback(() => {
    if (editMode !== 'erase' || selectedIds.size !== 1) return;

    const cloudId = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === cloudId);
    const state = editStates.get(cloudId);

    if (!cloud || !state || state.erasedIndices.size === 0) return;

    // Octree clouds: the free-form brush accumulates point indices into
    // erasedIndices, but octree-backed data.positions is an empty
    // Float32Array — those indices don't refer to anything. The M3 erase
    // story for octrees is "use Crop with invert=true to remove a
    // region", which handleApplyCrop already wires through crop_octree.
    // Tell the user explicitly rather than silently doing nothing.
    if (cloud.data.octree) {
      showToast({
        title: 'Brush erase is not available for octree clouds — use Crop with invert',
        type: 'info',
      });
      setEditMode('none');
      return;
    }

    // Filter out erased points and apply translation. Two-pass over typed
    // arrays to avoid the multi-GB JS `number[]` intermediate that the
    // earlier push-based version produced on large clouds.
    const erased = state.erasedIndices;
    const src = cloud.data;
    const tx = state.translation.x;
    const ty = state.translation.y;
    const tz = state.translation.z;

    const pointCount = src.pointCount - erased.size;
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

    const newPositions = new Float32Array(pointCount * 3);
    const newColors = src.colors ? new Float32Array(pointCount * 3) : null;
    const newIntensities = src.intensities ? new Float32Array(pointCount) : null;

    // Allocate scalar-field typed arrays up front too; we'll track min/max
    // while filling.
    const scalarOut: Record<string, { arr: Float32Array; src: Float32Array; min: number; max: number }> = {};
    if (src.scalarFields) {
      for (const [name, field] of Object.entries(src.scalarFields)) {
        scalarOut[name] = {
          arr: new Float32Array(pointCount),
          src: field.values,
          min: Infinity,
          max: -Infinity,
        };
      }
    }

    // Single pass: fill typed arrays and compute bounds simultaneously.
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    let w = 0;
    for (let i = 0; i < src.pointCount; i++) {
      if (erased.has(i)) continue;
      const wx = src.positions[i * 3] + tx;
      const wy = src.positions[i * 3 + 1] + ty;
      const wz = src.positions[i * 3 + 2] + tz;
      newPositions[w * 3] = wx;
      newPositions[w * 3 + 1] = wy;
      newPositions[w * 3 + 2] = wz;
      if (wx < min.x) min.x = wx; if (wx > max.x) max.x = wx;
      if (wy < min.y) min.y = wy; if (wy > max.y) max.y = wy;
      if (wz < min.z) min.z = wz; if (wz > max.z) max.z = wz;

      if (newColors && src.colors) {
        newColors[w * 3] = src.colors[i * 3];
        newColors[w * 3 + 1] = src.colors[i * 3 + 1];
        newColors[w * 3 + 2] = src.colors[i * 3 + 2];
      }
      if (newIntensities && src.intensities) {
        newIntensities[w] = src.intensities[i];
      }
      for (const name in scalarOut) {
        const out = scalarOut[name];
        const v = out.src[i];
        out.arr[w] = v;
        if (v < out.min) out.min = v;
        if (v > out.max) out.max = v;
      }
      w++;
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

    const finalScalarFields: Record<string, ScalarField> | undefined = src.scalarFields
      ? Object.fromEntries(
          Object.entries(scalarOut).map(([name, out]) => [name, { values: out.arr, min: out.min, max: out.max }])
        )
      : undefined;

    // Create new point cloud data
    const newData: PointCloudData = {
      positions: newPositions,
      colors: newColors ?? undefined,
      intensities: newIntensities ?? undefined,
      scalarFields: finalScalarFields,
      pointCount,
      bounds: { min, max, center, size },
      fileName: cloud.data.fileName,
    };

    // Update the cloud permanently
    onUpdateCloud(cloud.id, newData);

    // Reset edit state for this cloud (no translation, no erased)
    setEditStates(prev => {
      const next = new Map(prev);
      next.set(cloud.id, {
        translation: { x: 0, y: 0, z: 0 },
        erasedIndices: new Set<number>(),
      });
      return next;
    });

    // Clear history entries for this cloud since data changed
    setHistory(prev => prev.filter(entry => entry.id !== cloud.id));
    setHistoryIndex(prev => Math.max(-1, prev - 1));

    setEditMode('none');
  }, [editMode, selectedIds, clouds, editStates, onUpdateCloud]);

  // Build the crop_octree args (region + scalarFilters + translation) for an
  // octree-backed cloud from its active filters. X/Y/Z range filters become a
  // box region (full extent on any disabled axis); enabled scalar filters
  // become scalar_filters AND-combined with it. Shared by Filter and Segment.
  const buildOctreeFilterArgs = useCallback((cloud: PointCloudEntry, filters: CloudFilters) => {
    const editState = editStates.get(cloud.id);
    const otx = editState?.translation.x ?? 0;
    const oty = editState?.translation.y ?? 0;
    const otz = editState?.translation.z ?? 0;

    const scalarFilters = Object.entries(filters.scalarFields)
      .filter(([, f]) => f.enabled)
      .map(([slug, f]) => ({ slug, min: f.min, max: f.max }));

    let region: CropOctreeRegion | null = null;
    if (filters.x.enabled || filters.y.enabled || filters.z.enabled) {
      const b = cloud.data.bounds;
      region = {
        kind: 'box',
        min: [
          filters.x.enabled ? filters.x.min : b.min.x,
          filters.y.enabled ? filters.y.min : b.min.y,
          filters.z.enabled ? filters.z.min : b.min.z,
        ],
        max: [
          filters.x.enabled ? filters.x.max : b.max.x,
          filters.y.enabled ? filters.y.max : b.max.y,
          filters.z.enabled ? filters.z.max : b.max.z,
        ],
        invert: false,
      };
    }

    return {
      region,
      scalarFilters: scalarFilters.length > 0 ? scalarFilters : null,
      translation: (otx !== 0 || oty !== 0 || otz !== 0)
        ? [otx, oty, otz] as [number, number, number]
        : null,
    };
  }, [editStates]);

  // Convert a crop_octree result into PointCloudData (or null when empty).
  const octreeResultToData = useCallback((
    result: CropOctreeResult,
    sourceXyzPath: string,
    fileName: string,
    asciiFormat: string | null,
  ): PointCloudData | null => {
    if (result.point_count === 0 || !result.cache_id) return null;
    return buildPointCloudFromOctree(
      {
        cache_id: result.cache_id,
        cache_dir: result.cache_dir ?? '',
        cached: result.cached,
        version: result.version,
        point_count: result.point_count,
        spacing: result.spacing,
        scale: result.scale,
        offset: result.offset,
        bounds: result.bounds,
        tight_bounds: result.tight_bounds,
        attributes: result.attributes,
      },
      sourceXyzPath,
      fileName,
      asciiFormat,
    );
  }, []);

  // Clear edit state, filters, and history for a cloud after a filter commit,
  // then close the panel. Shared by Filter and Segment.
  const clearFilterStateForCloud = useCallback((cloudId: string) => {
    setEditStates(prev => {
      const next = new Map(prev);
      next.set(cloudId, { translation: { x: 0, y: 0, z: 0 }, erasedIndices: new Set<number>() });
      return next;
    });
    setCloudFilters(prev => {
      const next = new Map(prev);
      next.delete(cloudId);
      return next;
    });
    setHistory(prev => prev.filter(entry => entry.id !== cloudId));
    setHistoryIndex(prev => Math.max(-1, prev - 1));
    setShowFilterPanel(false);
  }, []);

  // Rebuild a flat cloud's PointCloudData from the points satisfying `keepFn`
  // (carrying colors / intensities / scalarFields, recomputing bounds). Returns
  // null when no point matches. Used for both the kept set (keep) and the
  // leftover set (!keep) in Segment, and the kept set in Filter.
  const rebuildFlatCloudData = useCallback((
    cloud: PointCloudEntry,
    keepFn: (i: number) => boolean,
    translation: { x: number; y: number; z: number },
  ): PointCloudData | null => {
    const src = cloud.data;
    const { x: tx, y: ty, z: tz } = translation;

    let pointCount = 0;
    for (let i = 0; i < src.pointCount; i++) {
      if (keepFn(i)) pointCount++;
    }
    if (pointCount === 0) return null;

    const newPositions = new Float32Array(pointCount * 3);
    const newColors = src.colors ? new Float32Array(pointCount * 3) : null;
    const newIntensities = src.intensities ? new Float32Array(pointCount) : null;
    const scalarOut: Record<string, { arr: Float32Array; src: Float32Array; min: number; max: number }> = {};
    if (src.scalarFields) {
      for (const [name, field] of Object.entries(src.scalarFields)) {
        scalarOut[name] = { arr: new Float32Array(pointCount), src: field.values, min: Infinity, max: -Infinity };
      }
    }

    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    let w = 0;
    for (let i = 0; i < src.pointCount; i++) {
      if (!keepFn(i)) continue;
      const wx = src.positions[i * 3] + tx;
      const wy = src.positions[i * 3 + 1] + ty;
      const wz = src.positions[i * 3 + 2] + tz;
      newPositions[w * 3] = wx;
      newPositions[w * 3 + 1] = wy;
      newPositions[w * 3 + 2] = wz;
      if (wx < min.x) min.x = wx; if (wx > max.x) max.x = wx;
      if (wy < min.y) min.y = wy; if (wy > max.y) max.y = wy;
      if (wz < min.z) min.z = wz; if (wz > max.z) max.z = wz;
      if (newColors && src.colors) {
        newColors[w * 3] = src.colors[i * 3];
        newColors[w * 3 + 1] = src.colors[i * 3 + 1];
        newColors[w * 3 + 2] = src.colors[i * 3 + 2];
      }
      if (newIntensities && src.intensities) {
        newIntensities[w] = src.intensities[i];
      }
      for (const name in scalarOut) {
        const out = scalarOut[name];
        const v = out.src[i];
        out.arr[w] = v;
        if (v < out.min) out.min = v;
        if (v > out.max) out.max = v;
      }
      w++;
    }

    const center = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    const size = new THREE.Vector3(max.x - min.x, max.y - min.y, max.z - min.z);

    const newScalarFieldsData: Record<string, { values: Float32Array; min: number; max: number }> = {};
    for (const name in scalarOut) {
      const out = scalarOut[name];
      newScalarFieldsData[name] = { values: out.arr, min: out.min, max: out.max };
    }

    return {
      positions: newPositions,
      colors: newColors ?? undefined,
      intensities: newIntensities ?? undefined,
      scalarFields: Object.keys(newScalarFieldsData).length > 0 ? newScalarFieldsData : undefined,
      pointCount,
      bounds: { min, max, center, size },
      fileName: cloud.data.fileName,
    };
  }, []);

  // Build the keep-predicate for a flat cloud from its active filters.
  const buildFlatKeepPredicate = useCallback((cloud: PointCloudEntry, filters: CloudFilters, erased: Set<number>) => {
    const src = cloud.data;
    return (i: number): boolean => {
      if (erased.has(i)) return false;
      const x = src.positions[i * 3];
      const y = src.positions[i * 3 + 1];
      const z = src.positions[i * 3 + 2];
      if (filters.x.enabled && (x < filters.x.min || x > filters.x.max)) return false;
      if (filters.y.enabled && (y < filters.y.min || y > filters.y.max)) return false;
      if (filters.z.enabled && (z < filters.z.min || z > filters.z.max)) return false;
      if (filters.intensity?.enabled && src.intensities) {
        const v = src.intensities[i];
        if (v < filters.intensity.min || v > filters.intensity.max) return false;
      }
      for (const name in filters.scalarFields) {
        const sf = filters.scalarFields[name];
        if (sf.enabled && src.scalarFields?.[name]) {
          const v = src.scalarFields[name].values[i];
          if (v < sf.min || v > sf.max) return false;
        }
      }
      return true;
    };
  }, []);

  // Apply filter permanently - removes filtered out points from the point cloud
  const handleApplyFilterPermanently = useCallback(async () => {
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

    // Octree-backed clouds hold no flat positions to iterate; apply the filter
    // via backend re-conversion (crop_octree). No live preview — applies
    // directly, like crop on large clouds.
    if (cloud.data.octree?.sourceXyzPath) {
      const octreeInfo = cloud.data.octree;
      const args = buildOctreeFilterArgs(cloud, filters);
      try {
        const result = await cropOctree(octreeInfo.sourceXyzPath, {
          asciiFormat: octreeInfo.asciiFormat ?? null,
          ...args,
        });
        const newData = octreeResultToData(
          result, octreeInfo.sourceXyzPath, cloud.data.fileName ?? cloud.id, octreeInfo.asciiFormat ?? null,
        );
        if (!newData) {
          // Filter excluded everything — offer to delete the cloud.
          setDeleteConfirm({ type: 'cloud', id: cloud.id, name: cloud.data.fileName || 'Unnamed' });
          return;
        }
        onUpdateCloud(cloud.id, newData);
      } catch (err) {
        console.error('[handleApplyFilterPermanently] crop_octree failed:', err);
        showToast({ title: `Filter failed for ${cloud.data.fileName || 'cloud'}`, type: 'error' });
        return;
      }
      clearFilterStateForCloud(cloud.id);
      return;
    }

    // Flat clouds: rebuild in-memory from the points that pass the filter.
    const state = editStates.get(cloudId) || {
      translation: { x: 0, y: 0, z: 0 },
      erasedIndices: new Set<number>(),
    };
    const keep = buildFlatKeepPredicate(cloud, filters, state.erasedIndices);
    const newData = rebuildFlatCloudData(cloud, keep, state.translation);
    if (!newData) {
      // All points would be removed - trigger delete confirmation.
      setDeleteConfirm({ type: 'cloud', id: cloud.id, name: cloud.data.fileName || 'Unnamed' });
      return;
    }
    onUpdateCloud(cloud.id, newData);
    clearFilterStateForCloud(cloud.id);
  }, [selectedIds, clouds, cloudFilters, editStates, onUpdateCloud, buildOctreeFilterArgs, octreeResultToData, clearFilterStateForCloud, buildFlatKeepPredicate, rebuildFlatCloudData]);

  // Segment by filter: keep the in-range points on the original cloud AND add
  // the out-of-range points as a second cloud. Nothing is discarded — kept +
  // leftover == the original. Mirrors the ground-segment "split into clouds".
  const handleSegmentFilter = useCallback(async () => {
    if (selectedIds.size !== 1) return;
    const cloudId = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === cloudId);
    const filters = cloudFilters.get(cloudId);
    if (!cloud || !filters) return;

    const hasAnyFilter = filters.x.enabled || filters.y.enabled || filters.z.enabled ||
      filters.intensity?.enabled ||
      Object.values(filters.scalarFields).some(f => f.enabled);
    if (!hasAnyFilter) return;

    if (!onAddCloud) {
      showToast({ title: 'Cannot segment: add-cloud not available', type: 'error' });
      return;
    }

    const leftoverName = `${cloud.data.fileName ?? 'cloud'} (filtered out)`;

    // Octree: two backend calls — kept (as-is) and leftover (invert_all). The
    // leftover is the exact complement, so the two never overlap or drop a point.
    if (cloud.data.octree?.sourceXyzPath) {
      const octreeInfo = cloud.data.octree;
      const args = buildOctreeFilterArgs(cloud, filters);
      try {
        const [keptResult, leftoverResult] = await Promise.all([
          cropOctree(octreeInfo.sourceXyzPath, { asciiFormat: octreeInfo.asciiFormat ?? null, ...args }),
          cropOctree(octreeInfo.sourceXyzPath, { asciiFormat: octreeInfo.asciiFormat ?? null, ...args, invertAll: true }),
        ]);
        const keptData = octreeResultToData(keptResult, octreeInfo.sourceXyzPath, cloud.data.fileName ?? cloud.id, octreeInfo.asciiFormat ?? null);
        const leftoverData = octreeResultToData(leftoverResult, octreeInfo.sourceXyzPath, leftoverName, octreeInfo.asciiFormat ?? null);
        if (!keptData) {
          // Nothing in range — offer to delete rather than blank the cloud.
          setDeleteConfirm({ type: 'cloud', id: cloud.id, name: cloud.data.fileName || 'Unnamed' });
          return;
        }
        onUpdateCloud(cloud.id, keptData);
        if (leftoverData) {
          onAddCloud({ id: crypto.randomUUID(), data: leftoverData, visible: true, color: cloud.color });
        }
      } catch (err) {
        console.error('[handleSegmentFilter] crop_octree failed:', err);
        showToast({ title: `Segment failed for ${cloud.data.fileName || 'cloud'}`, type: 'error' });
        return;
      }
      clearFilterStateForCloud(cloud.id);
      return;
    }

    // Flat: rebuild both halves in-memory from keep / !keep.
    const state = editStates.get(cloudId) || { translation: { x: 0, y: 0, z: 0 }, erasedIndices: new Set<number>() };
    const keep = buildFlatKeepPredicate(cloud, filters, state.erasedIndices);
    const keptData = rebuildFlatCloudData(cloud, keep, state.translation);
    if (!keptData) {
      setDeleteConfirm({ type: 'cloud', id: cloud.id, name: cloud.data.fileName || 'Unnamed' });
      return;
    }
    // Leftover excludes erased points too (they're gone either way), so the
    // leftover predicate is "not erased and not kept".
    const leftover = (i: number) => !state.erasedIndices.has(i) && !keep(i);
    const leftoverData = rebuildFlatCloudData(cloud, leftover, state.translation);
    onUpdateCloud(cloud.id, keptData);
    if (leftoverData) {
      leftoverData.fileName = leftoverName;
      onAddCloud({ id: crypto.randomUUID(), data: leftoverData, visible: true, color: cloud.color });
    }
    clearFilterStateForCloud(cloud.id);
  }, [selectedIds, clouds, cloudFilters, editStates, onUpdateCloud, onAddCloud, buildOctreeFilterArgs, octreeResultToData, clearFilterStateForCloud, buildFlatKeepPredicate, rebuildFlatCloudData]);

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
      // Enter: while mid-polygon, close the polygon. Otherwise (in crop
      // mode) Enter is a no-op — apply is bound exclusively to the
      // explicit "Apply" button in the crop panel so the user can't
      // accidentally trigger a multi-GB filter pass by hitting Enter
      // after typing a coordinate. In other edit modes (translate,
      // erase…) Enter still exits the mode.
      if (e.key === 'Enter' && editMode !== 'none') {
        if (editMode === 'crop') {
          if (cropDrawState === 'drawing-polygon') {
            e.preventDefault();
            if (polygonInProgress.length >= 3 && polygonCameraRef.current && polygonCanvasSizeRef.current) {
              const region = polygonRegionFromCamera(
                polygonInProgress,
                polygonCameraRef.current,
                polygonCanvasSizeRef.current,
                false,
              );
              setCropPolygon({
                points: region.points,
                projection: region.projection,
                view: region.view,
                canvasSize: region.canvasSize,
              });
              setPolygonInProgress([]);
              setCropDrawState('idle');
            }
            return;
          }
          // Crop mode + not drawing a polygon: don't preventDefault here
          // (we don't want to interfere with form-level handling) and
          // don't apply. The Apply button is the only entry point.
        } else {
          e.preventDefault();
          setEditMode('none');
        }
      }
      // Escape: cancel polygon-in-progress, or exit edit mode.
      if (e.key === 'Escape' && editMode !== 'none') {
        e.preventDefault();
        if (editMode === 'crop' && cropDrawState === 'drawing-polygon') {
          setPolygonInProgress([]);
          setCropDrawState('idle');
          return;
        }
        if (editMode === 'crop' && cropDrawState === 'drawing-rect') {
          setRectDragStart(null);
          rectDragCurrentRef.current = null;
          setCropDrawState('idle');
          return;
        }
        if (editMode === 'crop' && (cropDrawState === 'awaiting-box-corner-1' || cropDrawState === 'awaiting-box-corner-2')) {
          boxDrawFirstCornerRef.current = null;
          boxDrawCursorRef.current = null;
          setCropDrawState('idle');
          return;
        }
        setEditMode('none');
      }
      // Backspace: pop the last polygon vertex while drawing.
      if (e.key === 'Backspace' && editMode === 'crop' && cropDrawState === 'drawing-polygon') {
        e.preventDefault();
        setPolygonInProgress(prev => prev.slice(0, -1));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, editMode, cropDrawState, polygonInProgress]);

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

  // Open the add-scan popup with sensible defaults: next label and current
  // scene center as origin. Shared by the toolbar Radio button (Create
  // section) and the "+" inside the right-hand Scans panel.
  const openAddScanPopup = useCallback(() => {
    const center = combinedBounds.center;
    setScanDefaults({
      label: `Scan ${scansAll.length + 1}`,
      params: { origin: { x: center.x, y: center.y, z: center.z } },
    });
    setScanPopupState({ kind: 'add' });
  }, [combinedBounds, scansAll.length]);

  // Open the params popup pre-filled to attach scan params to an existing
  // data-only scan. The origin defaults to the scan's bounds center.
  const openAddParamsPopupFor = useCallback((scan: Scan) => {
    const origin = scan.data?.bounds.center
      ? { x: scan.data.bounds.center.x, y: scan.data.bounds.center.y, z: scan.data.bounds.center.z }
      : combinedBounds.center
        ? { x: combinedBounds.center.x, y: combinedBounds.center.y, z: combinedBounds.center.z }
        : undefined;
    setScanDefaults({ label: scan.label, params: { origin } });
    setScanPopupState({ kind: 'add-params-to', id: scan.id });
  }, [combinedBounds]);

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
      { id: 'create-voxel', name: 'Create Voxel', keywords: ['cube', 'box', 'shape', 'grid'], action: () => handleCreateShape('voxel'), category: 'Create', requires: null },
      { id: 'create-plant', name: 'Generate Plant', keywords: ['helios', 'leaf', 'vegetation'], action: () => setShowPlantPopup(true), category: 'Create', requires: null },

      // Point cloud tools
      { id: 'cloud-translate', name: 'Translate Point Cloud', keywords: ['move', 'position'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'translate' ? 'none' : 'translate'); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-crop', name: 'Crop Point Cloud', keywords: ['cut', 'trim', 'box'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'crop' ? 'none' : 'crop'); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-filter', name: 'Filter Points', keywords: ['range', 'intensity'], action: () => { closeAllToolPanels('filter'); setShowFilterPanel(!showFilterPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-resample', name: 'Resample Point Cloud', keywords: ['downsample', 'reduce', 'decimate'], action: () => { closeAllToolPanels('resample'); setShowResamplePanel(!showResamplePanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-erase', name: 'Erase Brush', keywords: ['delete', 'remove', 'paint'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'erase' ? 'none' : 'erase'); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-triangulate', name: 'Triangulate', keywords: ['mesh', 'surface', 'reconstruct'], action: () => { closeAllToolPanels('triangulation'); setShowTriangulationPanel(!showTriangulationPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-ground-segment', name: 'Segment Ground', keywords: ['ground', 'classify', 'classification', 'plant', 'csf', 'cloth', 'lidar'], action: () => { closeAllToolPanels('ground-segment'); setShowGroundSegmentPanel(!showGroundSegmentPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-segment-trees', name: 'Segment Trees', keywords: ['tree', 'trees', 'instance', 'treeiso', 'individual', 'forest', 'isolate', 'crown', 'trunk'], action: () => { closeAllToolPanels('tree-segment'); setShowTreeSegmentPanel(!showTreeSegmentPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-skeleton', name: 'Extract Skeleton', keywords: ['branch', 'structure'], action: () => { closeAllToolPanels('skeleton'); setShowSkeletonPanel(!showSkeletonPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-export', name: 'Export Point Cloud', keywords: ['save', 'las', 'laz', 'xyz'], action: () => { closeAllToolPanels('export'); setShowExportPanel(!showExportPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'cloud-stitch', name: 'Stitch Clouds', keywords: ['merge', 'combine', 'join'], action: () => { if (selectedIds.size >= 2 && onStitchClouds) onStitchClouds(Array.from(selectedIds)); }, category: 'Point Cloud', requires: 'multiple-clouds' },

      // Mesh tools
      { id: 'mesh-transform', name: 'Transform Mesh', keywords: ['translate', 'move', 'position', 'rotate', 'turn', 'spin', 'resize', 'scale', 'size'], action: () => setShowResizePanel(!showResizePanel), category: 'Mesh', requires: 'mesh' },
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

      // Global settings (always available)
      { id: 'settings', name: 'Settings', keywords: ['options', 'preferences', 'triangulate', 'max points', 'cap'], action: () => setShowSettingsPanel(v => !v), category: 'App', requires: null },
    ];

    return cmds;
  }, [editMode, showFilterPanel, showResamplePanel, showTriangulationPanel, showGroundSegmentPanel, showTreeSegmentPanel, showSkeletonPanel, showExportPanel, showResizePanel, showPlantGrowthPanel, closeAllToolPanels, onSelectAll, onDeselectAll, onStitchClouds, selectedIds, handleUndo, handleRedo]);

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
  }, [commands, commandSearch, hasCloudSelected, hasMeshSelected, hasSkeletonSelected, hasPlantMeshSelected, selectedIds.size, selectedMeshIds.size]);

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

  // Apply erased points permanently - returns new PointCloudData with
  // points removed and bounds recalculated. Two-pass typed-array fill so
  // we don't build a multi-GB JS `number[]` intermediate on large clouds.
  const applyErasedPoints = useCallback((data: PointCloudData, erasedIndices: Set<number>): PointCloudData => {
    if (erasedIndices.size === 0) return data;

    const pointCount = data.pointCount - erasedIndices.size;
    const newPositions = new Float32Array(pointCount * 3);
    const newColors = data.colors ? new Float32Array(pointCount * 3) : null;
    const newIntensities = data.intensities ? new Float32Array(pointCount) : null;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    let w = 0;
    for (let i = 0; i < data.pointCount; i++) {
      if (erasedIndices.has(i)) continue;
      const i3 = i * 3;
      const x = data.positions[i3];
      const y = data.positions[i3 + 1];
      const z = data.positions[i3 + 2];
      newPositions[w * 3] = x;
      newPositions[w * 3 + 1] = y;
      newPositions[w * 3 + 2] = z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      if (newColors && data.colors) {
        newColors[w * 3] = data.colors[i3];
        newColors[w * 3 + 1] = data.colors[i3 + 1];
        newColors[w * 3 + 2] = data.colors[i3 + 2];
      }
      if (newIntensities && data.intensities) {
        newIntensities[w] = data.intensities[i];
      }
      w++;
    }

    // Handle empty point cloud
    if (pointCount === 0) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 0;
    }

    return {
      ...data,
      positions: newPositions,
      colors: newColors ?? undefined,
      intensities: newIntensities ?? undefined,
      pointCount,
      bounds: {
        min: new THREE.Vector3(minX, minY, minZ),
        max: new THREE.Vector3(maxX, maxY, maxZ),
        center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
        size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ),
      },
    };
  }, []);
  void applyErasedPoints; // kept for upcoming permanent-erase feature

  // Get display data for a cloud (with edits applied)
  // showCropPreview: when true, apply crop filtering for preview (used in crop mode)
  const getDisplayData = useCallback((cloud: PointCloudEntry, showCropPreview: boolean = false): PointCloudData => {
    const editState = getEditState(cloud.id);
    const data = cloud.data;

    // Fast path: if there's nothing to do, return the input data unchanged.
    // Critical: returning the SAME object reference is what keeps
    // PointCloud's geometry useMemo from re-executing (and reallocating
    // its own ~hundreds of MB of Float32Arrays) on every parent render.
    //
    // Conditions for the fast path:
    //   - no erased points
    //   - no translation
    //   - and the crop preview, if active, fully encloses this cloud
    //     under an axis-aligned box (the default state of crop mode for
    //     N≥1 selected clouds, since the initial region is the union of
    //     every selected cloud's bounds).
    const erased = editState.erasedIndices;
    const tx = editState.translation.x;
    const ty = editState.translation.y;
    const tz = editState.translation.z;
    const hasErase = erased && erased.size > 0;
    const hasTranslation = tx !== 0 || ty !== 0 || tz !== 0;
    const cropIsNoOp =
      !showCropPreview ||
      (cropMode === 'box' && cropBox && !cropInvert &&
        data.bounds.min.x + tx >= cropBox.min.x && data.bounds.max.x + tx <= cropBox.max.x &&
        data.bounds.min.y + ty >= cropBox.min.y && data.bounds.max.y + ty <= cropBox.max.y &&
        data.bounds.min.z + tz >= cropBox.min.z && data.bounds.max.z + tz <= cropBox.max.z);

    if (!hasErase && !hasTranslation && cropIsNoOp) {
      return data;
    }

    let positions = data.positions;
    let colors = data.colors;
    let intensities = data.intensities;
    let pointCount = data.pointCount;

    // Apply erasing first (uses original indices).
    //
    // Two-pass over typed arrays: count surviving points, allocate
    // Float32Arrays directly at the right size, then fill. The earlier
    // implementation pushed onto JS `number[]` arrays and then did
    // `new Float32Array(jsArr)`, which keeps both alive at once — V8 stores
    // them as PACKED_DOUBLE_ELEMENTS (8 bytes/entry), so on a 50M-point
    // cloud the JS arrays alone exceed 3 GB and OOM'd the renderer.
    if (editState.erasedIndices && editState.erasedIndices.size > 0) {
      const erased = editState.erasedIndices;
      const src = data;
      let kept = 0;
      for (let i = 0; i < src.pointCount; i++) {
        if (!erased.has(i)) kept++;
      }

      const newPositions = new Float32Array(kept * 3);
      const newColors = src.colors ? new Float32Array(kept * 3) : null;
      const newIntensities = src.intensities ? new Float32Array(kept) : null;

      let w = 0;
      for (let i = 0; i < src.pointCount; i++) {
        if (erased.has(i)) continue;
        newPositions[w * 3] = src.positions[i * 3];
        newPositions[w * 3 + 1] = src.positions[i * 3 + 1];
        newPositions[w * 3 + 2] = src.positions[i * 3 + 2];
        if (newColors && src.colors) {
          newColors[w * 3] = src.colors[i * 3];
          newColors[w * 3 + 1] = src.colors[i * 3 + 1];
          newColors[w * 3 + 2] = src.colors[i * 3 + 2];
        }
        if (newIntensities && src.intensities) {
          newIntensities[w] = src.intensities[i];
        }
        w++;
      }

      pointCount = kept;
      positions = newPositions;
      if (newColors) colors = newColors;
      if (newIntensities) intensities = newIntensities;
    }

    // Apply crop preview (when in crop mode). Two-pass for the same reason
    // as the erase branch above: a JS `number[]` of 3·N doubles for a 50M
    // cloud is multi-GB and OOMs the renderer the moment you click Crop.
    //
    // The crop region lives in WORLD coordinates (shared across all
    // selected scans). To test a point we add this cloud's translation to
    // get its world position, then run the predicate. We still write the
    // kept points back in local coordinates — the translate pass below
    // bakes translation into the rendered geometry.
    const cropPredicate = showCropPreview ? buildCropPredicate() : null;
    if (cropPredicate) {
      const tx = editState.translation.x;
      const ty = editState.translation.y;
      const tz = editState.translation.z;
      const invert = cropInvert;

      // Short-circuit: when the crop region is an AABB that fully encloses
      // this cloud's translated bounds and we're not inverting, every
      // point survives the filter — skip the per-render Float32Array copy
      // entirely. This is the state of the world the instant the user
      // clicks Crop with N≥1 clouds selected: the default region is the
      // union of every selected cloud's bounds, so each cloud is by
      // construction fully inside it. Without this short-circuit a
      // multi-cloud crop on two ~28M-point scans allocates ~700 MB of
      // throwaway typed-array copies per parent re-render, which combined
      // with the original buffers and PointCloud's own geometry useMemo
      // pushed V8's large-object space past the 4 GB ceiling.
      const fullyInside =
        cropMode === 'box' && cropBox && !invert &&
        data.bounds.min.x + tx >= cropBox.min.x && data.bounds.max.x + tx <= cropBox.max.x &&
        data.bounds.min.y + ty >= cropBox.min.y && data.bounds.max.y + ty <= cropBox.max.y &&
        data.bounds.min.z + tz >= cropBox.min.z && data.bounds.max.z + tz <= cropBox.max.z;

      if (!fullyInside) {
        let kept = 0;
        for (let i = 0; i < pointCount; i++) {
          const wx = positions[i * 3] + tx;
          const wy = positions[i * 3 + 1] + ty;
          const wz = positions[i * 3 + 2] + tz;
          const inside = cropPredicate(wx, wy, wz);
          if (invert ? !inside : inside) kept++;
        }

        const newPositions = new Float32Array(kept * 3);
        const newColors = colors ? new Float32Array(kept * 3) : null;
        const newIntensities = intensities ? new Float32Array(kept) : null;

        let w = 0;
        for (let i = 0; i < pointCount; i++) {
          const x = positions[i * 3];
          const y = positions[i * 3 + 1];
          const z = positions[i * 3 + 2];
          const inside = cropPredicate(x + tx, y + ty, z + tz);
          if (!(invert ? !inside : inside)) continue;
          newPositions[w * 3] = x;
          newPositions[w * 3 + 1] = y;
          newPositions[w * 3 + 2] = z;
          if (newColors && colors) {
            newColors[w * 3] = colors[i * 3];
            newColors[w * 3 + 1] = colors[i * 3 + 1];
            newColors[w * 3 + 2] = colors[i * 3 + 2];
          }
          if (newIntensities && intensities) {
            newIntensities[w] = intensities[i];
          }
          w++;
        }

        pointCount = kept;
        positions = newPositions;
        if (newColors) colors = newColors;
        if (newIntensities) intensities = newIntensities;
      }
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
  }, [getEditState, buildCropPredicate, cropInvert, cropMode, cropBox]);

  // Resolve a cloud to either its in-memory display data (flat clouds) or a
  // backend point-source descriptor (octree clouds, whose positions buffer is
  // empty). Downstream ops (skeleton, triangulate, c2m, icp, export) branch
  // once on `kind` instead of each re-deriving the octree case. For octree
  // clouds the only pending edit is translation (erase is disabled on them),
  // read from the same edit state the crop-apply path uses.
  const buildPointSource = useCallback((cloud: PointCloudEntry): PointSourcePayload => {
    const octree = cloud.data.octree;
    if (octree && octree.sourceXyzPath) {
      const t = getEditState(cloud.id).translation;
      const translation: [number, number, number] | null =
        (t.x !== 0 || t.y !== 0 || t.z !== 0) ? [t.x, t.y, t.z] : null;
      return {
        kind: 'source',
        source: {
          source_path: octree.sourceXyzPath,
          ascii_format: octree.asciiFormat ?? null,
          translation,
        },
      };
    }
    return { kind: 'inline', data: getDisplayData(cloud) };
  }, [getEditState, getDisplayData]);

  // Render-path companion to getDisplayData: returns ONLY a Uint32Array
  // of visible-point indices (or null when nothing is filtered). The JSX
  // renderer passes this to <PointCloud indices={...}> which uses it as
  // the geometry index attribute — three.js then draws just those points
  // against the cloud's original (shared) position/color buffers.
  //
  // No Float32Array allocation, regardless of crop region or cloud size.
  // Cost per call: one Uint32Array of size `kept` (~4 bytes per visible
  // point). The "fully inside" and "nothing filtered" fast paths return
  // null so three.js draws all points without an index attribute at all.
  //
  // Translation is NOT baked here — it's applied by the parent group's
  // `position` prop. Crop predicate consumes translated world coords.
  const getDisplayIndices = useCallback((cloud: PointCloudEntry, showCropPreview: boolean): Uint32Array | null => {
    const editState = getEditState(cloud.id);
    const data = cloud.data;
    const erased = editState.erasedIndices;
    const tx = editState.translation.x;
    const ty = editState.translation.y;
    const tz = editState.translation.z;

    const cropPredicate = showCropPreview ? buildCropPredicate() : null;

    // Fast path: nothing filters anything.
    if (!erased.size && !cropPredicate) return null;

    // Fast path: box crop fully encloses cloud's translated bounds, and
    // no erase / no inversion. Nothing is filtered out — let three.js
    // draw all of cloud.data.
    if (!erased.size && cropPredicate && cropMode === 'box' && cropBox && !cropInvert) {
      const fullyInside =
        data.bounds.min.x + tx >= cropBox.min.x && data.bounds.max.x + tx <= cropBox.max.x &&
        data.bounds.min.y + ty >= cropBox.min.y && data.bounds.max.y + ty <= cropBox.max.y &&
        data.bounds.min.z + tz >= cropBox.min.z && data.bounds.max.z + tz <= cropBox.max.z;
      if (fullyInside) return null;
    }

    // Two-pass: count survivors, allocate Uint32Array, fill.
    const keep = (i: number): boolean => {
      if (erased.has(i)) return false;
      if (cropPredicate) {
        const wx = data.positions[i * 3] + tx;
        const wy = data.positions[i * 3 + 1] + ty;
        const wz = data.positions[i * 3 + 2] + tz;
        const inside = cropPredicate(wx, wy, wz);
        return cropInvert ? !inside : inside;
      }
      return true;
    };

    let kept = 0;
    for (let i = 0; i < data.pointCount; i++) if (keep(i)) kept++;
    const out = new Uint32Array(kept);
    let w = 0;
    for (let i = 0; i < data.pointCount; i++) if (keep(i)) out[w++] = i;
    return out;
  }, [getEditState, buildCropPredicate, cropInvert, cropMode, cropBox]);

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

    const baseName = cloud.data.fileName?.replace(/\.[^.]+$/, '') || 'pointcloud';

    // Octree-backed cloud: it has no renderer positions to format, so every
    // format goes through the backend, which streams from the source file
    // (applying any pending translation) and returns base64 output.
    const ps = buildPointSource(cloud);
    if (ps.kind === 'source') {
      try {
        const response = await exportPointCloudLasLaz({
          source: { ...ps.source, want_colors: true },
          format,
          filename: `${baseName}.${format}`,
        });
        if (response.success && response.data) {
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
          showToast({ title: 'Export Failed', message: response.error || 'Unknown error', type: 'error' });
        }
      } catch (error) {
        showToast({ title: 'Export Failed', message: error instanceof Error ? error.message : 'Unknown error', type: 'error' });
      }
      setShowExportPanel(false);
      return;
    }

    const data = ps.data;

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
  }, [selectedIds, clouds, getDisplayData, buildPointSource, downloadFile]);

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
      const ps = buildPointSource(cloud);

      // Build triangulation request. Octree clouds send a source descriptor
      // capped at the global triangulateMaxPoints setting (open3d holds all
      // points in RAM); flat clouds send inline points.
      const request: Parameters<typeof triangulatePointCloud>[0] = {
        method: triangulationMethod,
        estimate_normals: true,
        normal_radius: 0.1,
        normal_max_nn: 30,
      };

      if (ps.kind === 'source') {
        request.source = { ...ps.source, max_points: triangulateMaxPoints };
      } else {
        const displayData = ps.data;
        const points: number[][] = [];
        for (let i = 0; i < displayData.pointCount; i++) {
          points.push([
            displayData.positions[i * 3],
            displayData.positions[i * 3 + 1],
            displayData.positions[i * 3 + 2],
          ]);
        }
        request.points = points;
      }

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

      // Warn when the global triangulate cap downsampled a streamed cloud.
      if (
        ps.kind === 'source' &&
        typeof response.points_used === 'number' &&
        response.points_used < cloud.data.pointCount
      ) {
        showToast({
          type: 'warning',
          title: 'Cloud downsampled for triangulation',
          message: `Triangulated ${response.points_used.toLocaleString()} of ${cloud.data.pointCount.toLocaleString()} points (Settings → Triangulate max points). Raise the cap for more detail.`,
        });
      }

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
  }, [selectedIds, clouds, buildPointSource, triangulationMethod, poissonDepth, alphaValue, triangulateMaxPoints]);

  // Segment ground vs plant points (Cloth Simulation Filter). Writes a
  // `ground_class` scalar attribute (1=ground, 2=plant) and colors by it.
  // Octree clouds re-convert through the backend (the apply endpoint bakes the
  // class into a new octree); flat clouds get the labels written into
  // scalarFields directly. Optionally also splits into ground/plant clouds
  // (flat clouds only — octree split would need a backend class filter).
  const handleGroundSegment = useCallback(async () => {
    if (selectedIds.size !== 1) return;
    const id = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === id);
    if (!cloud) return;

    setGroundSegmentInProgress(true);
    setGroundSegmentError(null);

    const csfParams = {
      cloth_resolution: groundClothResolution,
      rigidness: groundRigidness,
      class_threshold: groundClassThreshold,
    };

    try {
      const ps = buildPointSource(cloud);

      // --- Octree-backed cloud: re-convert with ground_class baked in. ---
      if (ps.kind === 'source') {
        const octreeInfo = cloud.data.octree;
        if (!octreeInfo?.sourceXyzPath) {
          throw new Error('Octree cloud is missing its source file path.');
        }
        const srcPath = octreeInfo.sourceXyzPath;
        const af = octreeInfo.asciiFormat ?? null;
        const baseName = cloud.data.fileName ?? id;

        // Classify in place: re-convert with ground_class baked in, swap the ref.
        const meta = await segmentGroundApply({
          source_path: srcPath,
          ascii_format: af,
          ...csfParams,
        });
        const newData = buildPointCloudFromOctree(meta, srcPath, baseName, af);
        onUpdateCloud(id, newData);
        setColorMode('scalar');
        setSelectedScalarField(GROUND_CLASS_ATTRIBUTE);
        setShowGroundSegmentPanel(false);

        // Optional split: re-convert once per class into ground/plant octrees.
        if (groundSplitClouds && onAddCloud) {
          const addSplit = async (keepClass: number, suffix: string, color: string) => {
            const sm = await segmentGroundApply({
              source_path: srcPath,
              ascii_format: af,
              ...csfParams,
              keep_class: keepClass,
            });
            onAddCloud({
              id: crypto.randomUUID(),
              data: buildPointCloudFromOctree(sm, srcPath, `${baseName} (${suffix})`, af),
              visible: true,
              color,
            });
          };
          await addSplit(1, 'ground', '#8c6643');
          await addSplit(2, 'non-ground', '#4caf50');
        }

        showToast({
          type: 'success',
          title: 'Ground Segmentation Complete',
          message: `Classified ${meta.point_count.toLocaleString()} points (ground vs plant).`,
        });
        return;
      }

      // --- Flat cloud: classify in memory, write scalarFields. ---
      const displayData = ps.data;
      const count = displayData.pointCount;
      const points: number[][] = new Array(count);
      for (let i = 0; i < count; i++) {
        points[i] = [
          displayData.positions[i * 3],
          displayData.positions[i * 3 + 1],
          displayData.positions[i * 3 + 2],
        ];
      }

      const response = await segmentGround({ points, ...csfParams });
      if (!response.success) {
        throw new Error(response.error || 'Ground segmentation failed');
      }

      const labels = Float32Array.from(response.labels);
      const newScalarFields = {
        ...(displayData.scalarFields ?? {}),
        [GROUND_CLASS_ATTRIBUTE]: { values: labels, min: 1, max: 2 },
      };
      onUpdateCloud(id, { ...displayData, scalarFields: newScalarFields });
      setColorMode('scalar');
      setSelectedScalarField(GROUND_CLASS_ATTRIBUTE);
      setShowGroundSegmentPanel(false);

      // Optional split into ground / plant child clouds.
      if (groundSplitClouds && onAddCloud) {
        const makeChild = (classValue: number, suffix: string, color: string) => {
          const idxs: number[] = [];
          for (let i = 0; i < count; i++) {
            if (Math.round(response.labels[i]) === classValue) idxs.push(i);
          }
          if (idxs.length === 0) return;
          const pos = new Float32Array(idxs.length * 3);
          let col: Float32Array | undefined;
          if (displayData.colors && displayData.colors.length >= count * 3) {
            col = new Float32Array(idxs.length * 3);
          }
          idxs.forEach((srcIdx, k) => {
            pos[k * 3] = displayData.positions[srcIdx * 3];
            pos[k * 3 + 1] = displayData.positions[srcIdx * 3 + 1];
            pos[k * 3 + 2] = displayData.positions[srcIdx * 3 + 2];
            if (col && displayData.colors) {
              col[k * 3] = displayData.colors[srcIdx * 3];
              col[k * 3 + 1] = displayData.colors[srcIdx * 3 + 1];
              col[k * 3 + 2] = displayData.colors[srcIdx * 3 + 2];
            }
          });
          const baseName = displayData.fileName ?? 'cloud';
          const bmin = new THREE.Vector3(Infinity, Infinity, Infinity);
          const bmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
          for (let k = 0; k < idxs.length; k++) {
            bmin.x = Math.min(bmin.x, pos[k * 3]); bmax.x = Math.max(bmax.x, pos[k * 3]);
            bmin.y = Math.min(bmin.y, pos[k * 3 + 1]); bmax.y = Math.max(bmax.y, pos[k * 3 + 1]);
            bmin.z = Math.min(bmin.z, pos[k * 3 + 2]); bmax.z = Math.max(bmax.z, pos[k * 3 + 2]);
          }
          const { center, size } = computeBoundsFromPositions(pos, idxs.length);
          onAddCloud({
            id: crypto.randomUUID(),
            data: {
              positions: pos,
              colors: col,
              pointCount: idxs.length,
              bounds: { min: bmin, max: bmax, center, size },
              fileName: `${baseName} (${suffix})`,
            },
            visible: true,
            color,
          });
        };
        makeChild(1, 'ground', '#8c6643');
        makeChild(2, 'non-ground', '#4caf50');
      }

      showToast({
        type: 'success',
        title: 'Ground Segmentation Complete',
        message: `${response.num_ground.toLocaleString()} ground, ${response.num_plant.toLocaleString()} plant`,
      });
    } catch (error) {
      console.error('Ground segmentation error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Ground segmentation failed';
      setGroundSegmentError(errorMessage);
      showToast({ type: 'error', title: 'Ground Segmentation Failed', message: errorMessage });
    } finally {
      setGroundSegmentInProgress(false);
    }
  }, [selectedIds, clouds, buildPointSource, onUpdateCloud, onAddCloud, groundClothResolution, groundRigidness, groundClassThreshold, groundSplitClouds]);

  // Segment individual trees (TreeIso cut-pursuit). Writes a `tree_instance`
  // scalar attribute (0=unassigned, 1..N=trees) and colors by it. Mirrors
  // handleGroundSegment: octree clouds re-convert through the backend apply
  // endpoint; flat clouds get labels written into scalarFields. Optional trunk
  // seeds (treeSeedPoints) drive human-in-the-loop seeding, and an optional
  // split extracts each tree into its own child cloud.
  const handleSegmentTrees = useCallback(async () => {
    if (selectedIds.size !== 1) return;
    const id = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === id);
    if (!cloud) return;

    setTreeSegmentInProgress(true);
    setTreeSegmentError(null);

    const tiParams = {
      reg_strength1: treeRegStrength1,
      reg_strength2: treeRegStrength2,
      max_gap: treeMaxGap,
    };
    const seeds = treeSeedPoints.length > 0 ? treeSeedPoints.map(p => [p[0], p[1], p[2]]) : undefined;

    try {
      const ps = buildPointSource(cloud);

      // --- Octree-backed cloud: re-convert with tree_instance baked in. ---
      if (ps.kind === 'source') {
        const octreeInfo = cloud.data.octree;
        if (!octreeInfo?.sourceXyzPath) {
          throw new Error('Octree cloud is missing its source file path.');
        }
        const srcPath = octreeInfo.sourceXyzPath;
        const af = octreeInfo.asciiFormat ?? null;
        const baseName = cloud.data.fileName ?? id;

        const meta = await segmentTreesApply({
          source_path: srcPath,
          ascii_format: af,
          seed_points: seeds,
          ...tiParams,
        });
        const newData = buildPointCloudFromOctree(meta, srcPath, baseName, af);
        onUpdateCloud(id, newData);
        setColorMode('scalar');
        setSelectedScalarField(TREE_INSTANCE_ATTRIBUTE);
        setShowTreeSegmentPanel(false);
        setTreeSeedMode(false);
        showToast({
          type: 'success',
          title: 'Tree Segmentation Complete',
          message: `Segmented ${meta.point_count.toLocaleString()} points into individual trees.`,
        });
        return;
      }

      // --- Flat cloud: segment in memory, write scalarFields. ---
      const displayData = ps.data;
      const count = displayData.pointCount;
      const points: number[][] = new Array(count);
      for (let i = 0; i < count; i++) {
        points[i] = [
          displayData.positions[i * 3],
          displayData.positions[i * 3 + 1],
          displayData.positions[i * 3 + 2],
        ];
      }

      const response = await segmentTrees({ points, seed_points: seeds, ...tiParams });
      if (!response.success) {
        throw new Error(response.error || 'Tree segmentation failed');
      }

      const labels = Float32Array.from(response.labels);
      const newScalarFields = {
        ...(displayData.scalarFields ?? {}),
        [TREE_INSTANCE_ATTRIBUTE]: { values: labels, min: 0, max: response.num_trees },
      };
      onUpdateCloud(id, { ...displayData, scalarFields: newScalarFields });
      setColorMode('scalar');
      setSelectedScalarField(TREE_INSTANCE_ATTRIBUTE);
      setShowTreeSegmentPanel(false);
      setTreeSeedMode(false);

      // Optional split: one child cloud per tree id (skip 0 = unassigned).
      if (treeSplitClouds && onAddCloud) {
        const byTree = new Map<number, number[]>();
        for (let i = 0; i < count; i++) {
          const t = Math.round(response.labels[i]);
          if (t <= 0) continue;
          (byTree.get(t) ?? byTree.set(t, []).get(t)!).push(i);
        }
        for (const [treeId, idxs] of Array.from(byTree.entries()).sort((a, b) => a[0] - b[0])) {
          const pos = new Float32Array(idxs.length * 3);
          let col: Float32Array | undefined;
          if (displayData.colors && displayData.colors.length >= count * 3) {
            col = new Float32Array(idxs.length * 3);
          }
          idxs.forEach((srcIdx, k) => {
            pos[k * 3] = displayData.positions[srcIdx * 3];
            pos[k * 3 + 1] = displayData.positions[srcIdx * 3 + 1];
            pos[k * 3 + 2] = displayData.positions[srcIdx * 3 + 2];
            if (col && displayData.colors) {
              col[k * 3] = displayData.colors[srcIdx * 3];
              col[k * 3 + 1] = displayData.colors[srcIdx * 3 + 1];
              col[k * 3 + 2] = displayData.colors[srcIdx * 3 + 2];
            }
          });
          const baseName = displayData.fileName ?? 'cloud';
          const bmin = new THREE.Vector3(Infinity, Infinity, Infinity);
          const bmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
          for (let k = 0; k < idxs.length; k++) {
            bmin.x = Math.min(bmin.x, pos[k * 3]); bmax.x = Math.max(bmax.x, pos[k * 3]);
            bmin.y = Math.min(bmin.y, pos[k * 3 + 1]); bmax.y = Math.max(bmax.y, pos[k * 3 + 1]);
            bmin.z = Math.min(bmin.z, pos[k * 3 + 2]); bmax.z = Math.max(bmax.z, pos[k * 3 + 2]);
          }
          const { center, size } = computeBoundsFromPositions(pos, idxs.length);
          onAddCloud({
            id: crypto.randomUUID(),
            data: {
              positions: pos,
              colors: col,
              pointCount: idxs.length,
              bounds: { min: bmin, max: bmax, center, size },
              fileName: `${baseName} (tree ${treeId})`,
            },
            visible: true,
            color: '#4caf50',
          });
        }
      }

      showToast({
        type: response.ground_warning ? 'error' : 'success',
        title: 'Tree Segmentation Complete',
        message: response.ground_warning
          ? `Found ${response.num_trees} trees, but ground looks present — run Ground Segmentation first for best results.`
          : `Segmented ${response.num_trees} trees.`,
      });
    } catch (error) {
      console.error('Tree segmentation error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Tree segmentation failed';
      setTreeSegmentError(errorMessage);
      showToast({ type: 'error', title: 'Tree Segmentation Failed', message: errorMessage });
    } finally {
      setTreeSegmentInProgress(false);
    }
  }, [selectedIds, clouds, buildPointSource, onUpdateCloud, onAddCloud, treeRegStrength1, treeRegStrength2, treeMaxGap, treeSplitClouds, treeSeedPoints]);

  // Refine the tree_instance field in place (flat clouds only — octree clouds
  // bake the attribute on disk and would need a backend re-run). Reads the
  // active cloud's labels, applies a pure merge/split, writes them back, and
  // keeps the scalar coloring active.
  const refineTreeLabels = useCallback((
    transform: (labels: Float32Array, positions: Float32Array) => Float32Array,
    actionLabel: string,
  ) => {
    if (selectedIds.size !== 1) return;
    const id = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === id);
    const field = cloud?.data.scalarFields?.[TREE_INSTANCE_ATTRIBUTE];
    if (!cloud || !field) {
      showToast({ type: 'error', title: 'No tree segmentation', message: 'Run Segment Trees first (flat clouds only).' });
      return;
    }
    try {
      const newLabels = transform(field.values, cloud.data.positions);
      let maxId = 0;
      for (let i = 0; i < newLabels.length; i++) maxId = Math.max(maxId, newLabels[i]);
      onUpdateCloud(id, {
        ...cloud.data,
        scalarFields: {
          ...cloud.data.scalarFields,
          [TREE_INSTANCE_ATTRIBUTE]: { values: newLabels, min: 0, max: maxId },
        },
      });
      setColorMode('scalar');
      setSelectedScalarField(TREE_INSTANCE_ATTRIBUTE);
      showToast({ type: 'success', title: actionLabel, message: `${maxId} trees now.` });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Refine failed';
      showToast({ type: 'error', title: 'Refine Failed', message: msg });
    }
  }, [selectedIds, clouds, onUpdateCloud]);

  const handleMergeTrees = useCallback(() => {
    refineTreeLabels((labels) => mergeTrees(labels, [treeMergeA, treeMergeB]), 'Trees Merged');
  }, [refineTreeLabels, treeMergeA, treeMergeB]);

  const handleSplitTree = useCallback(() => {
    refineTreeLabels((labels, positions) => splitTreeByGaps(positions, labels, treeSplitId, treeMaxGap), 'Tree Split');
  }, [refineTreeLabels, treeSplitId, treeMaxGap]);

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
      // Resolve the cloud to inline points (flat clouds) or a source descriptor
      // (octree clouds). Mesh vertices/indices are always inline.
      const ps = buildPointSource(cloud);
      const meshVertices: number[] = Array.from(mesh.data.vertices);
      const meshIndices: number[] = Array.from(mesh.data.indices);

      const response = await computeAlignmentDistance(
        ps.kind === 'source'
          ? { source: ps.source, mesh_vertices: meshVertices, mesh_indices: meshIndices }
          : { points: Array.from(ps.data.positions), mesh_vertices: meshVertices, mesh_indices: meshIndices },
      );

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
  }, [selectedIds, selectedMeshId, clouds, meshes, buildPointSource]);

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
      // Resolve the TARGET cloud to inline points (flat) or a source descriptor
      // (octree). The cloud stays fixed; the mesh (SOURCE) is always inline.
      const ps = buildPointSource(cloud);

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

      const response = await icpRegisterMeshToCloud(
        ps.kind === 'source'
          ? { source: ps.source, mesh_vertices: meshVertices, mesh_indices: meshIndices }
          : { points: Array.from(ps.data.positions), mesh_vertices: meshVertices, mesh_indices: meshIndices },
      );

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
  }, [selectedIds, selectedMeshId, clouds, meshes, buildPointSource, meshPositions, setMeshPositions, setMeshRotations]);

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

    // The ICP transform is baked into the SOURCE cloud's positions in the
    // renderer. Octree clouds keep no positions (geometry lives on disk), and a
    // rotation+translation can't be folded into a cached octree the way an AABB
    // crop can — so we can't move a streamed source cloud. The TARGET may be an
    // octree (it's only read). Block when the source is an octree.
    if (sourceCloud.data.octree) {
      showToast({
        type: 'error',
        title: 'Can’t align a streamed cloud',
        message: 'Cloud-to-cloud ICP moves the second-selected cloud, which isn’t supported for large (streamed) clouds. Select it first so it becomes the fixed target instead.',
      });
      return;
    }

    setIsRunningICP(true);

    try {
      // Resolve each cloud independently — the target can be flat (inline
      // points) or octree (source descriptor, read from disk); the source is
      // always flat (guarded above) so its transform can be baked locally.
      const targetPs = buildPointSource(targetCloud);
      const sourcePs = buildPointSource(sourceCloud);

      const response = await icpRegisterCloudToCloud({
        ...(targetPs.kind === 'source'
          ? { target_source: targetPs.source }
          : { target_points: Array.from(targetPs.data.positions) }),
        ...(sourcePs.kind === 'source'
          ? { source_source: sourcePs.source }
          : { source_points: Array.from(sourcePs.data.positions) }),
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
  }, [selectedIds, clouds, onUpdateCloud, buildPointSource, getEditState, setEditStates]);

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
      const MAX_SKELETON_POINTS = 20000;
      const ps = buildPointSource(cloud);

      // Resolve the points source and the effective search radius. Octree
      // clouds send a backend source descriptor (with the 20k cap) and let the
      // backend auto-calculate the radius from a KD-tree NN estimate; flat
      // clouds downsample + auto-estimate in JS as before.
      let points: number[][] | undefined;
      let source: BackendPointSource | undefined;
      let effectiveSearchRadius = skeletonSearchRadius;

      if (ps.kind === 'source') {
        source = { ...ps.source, max_points: MAX_SKELETON_POINTS };
        // search_radius left as-is — the backend computes it when < 0.001.
      } else {
        const displayData = ps.data;
        const totalPoints = displayData.pointCount;
        const skipRate = totalPoints > MAX_SKELETON_POINTS
          ? Math.ceil(totalPoints / MAX_SKELETON_POINTS)
          : 1;

        points = [];
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
      }

      const response = await extractSkeleton({
        points,
        source,
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
  }, [selectedIds, clouds, buildPointSource, skeletonRemoveOutliers, skeletonSearchRadius, skeletonRootThreshold, skeletonQuantizationLevels, skeletonUseNonlinearQuant, skeletonThresholdFilter, skeletonUseProportionFilter, skeletonProportionThreshold, skeletonSmooth, skeletonSmoothIterations]);

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

  // Blender-style modal transform shortcuts (T translate, S scale; X/Y/Z lock axis,
  // Shift+X/Y/Z lock to the perpendicular plane). Enter/click commits, Esc/right-click
  // cancels. Suppressed while an input is focused.
  useEffect(() => {
    const isInputFocused = (): boolean => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const lastMouse = { x: 0, y: 0, set: false };

    const getCanvas = (): HTMLCanvasElement | null =>
      (document.querySelector('canvas[data-engine]') as HTMLCanvasElement | null) ||
      (document.querySelector('canvas') as HTMLCanvasElement | null);

    const computePivot = (): { x: number; y: number; z: number } | null => {
      if (selectedMesh) {
        const pos = meshPositionsRef.current.get(selectedMesh.id) || { x: 0, y: 0, z: 0 };
        const scl = meshScalesRef.current.get(selectedMesh.id) || { x: 1, y: 1, z: 1 };
        const { vertices, vertexCount } = selectedMesh.data;
        if (vertexCount === 0) return pos;
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < vertexCount; i++) {
          cx += vertices[i * 3];
          cy += vertices[i * 3 + 1];
          cz += vertices[i * 3 + 2];
        }
        cx /= vertexCount; cy /= vertexCount; cz /= vertexCount;
        return { x: cx * scl.x + pos.x, y: cy * scl.y + pos.y, z: cz * scl.z + pos.z };
      }
      if (selectedSkeleton) {
        const pos = skeletonPositionsRef.current.get(selectedSkeleton.id) || { x: 0, y: 0, z: 0 };
        const { points, pointCount } = selectedSkeleton.data;
        if (pointCount === 0) return pos;
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < pointCount; i++) {
          cx += points[i * 3];
          cy += points[i * 3 + 1];
          cz += points[i * 3 + 2];
        }
        cx /= pointCount; cy /= pointCount; cz /= pointCount;
        return { x: cx + pos.x, y: cy + pos.y, z: cz + pos.z };
      }
      if (selectedIds.size > 0) {
        let cx = 0, cy = 0, cz = 0, n = 0;
        for (const id of selectedIds) {
          const cloud = clouds.find(c => c.id === id);
          if (!cloud) continue;
          const state = editStates.get(id);
          const tr = state?.translation ?? { x: 0, y: 0, z: 0 };
          cx += cloud.data.bounds.center.x + tr.x;
          cy += cloud.data.bounds.center.y + tr.y;
          cz += cloud.data.bounds.center.z + tr.z;
          n++;
        }
        if (n === 0) return null;
        return { x: cx / n, y: cy / n, z: cz / n };
      }
      return null;
    };

    const closestPointOnLineFromRay = (ray: THREE.Ray, P: THREE.Vector3, dir: THREE.Vector3): number => {
      // Returns parameter t such that P + t*dir is closest to the ray.
      const w0 = new THREE.Vector3().subVectors(ray.origin, P);
      const b = ray.direction.dot(dir);
      const d = ray.direction.dot(w0);
      const e = dir.dot(w0);
      const denom = 1 - b * b;
      if (Math.abs(denom) < 1e-6) return 0;
      return (e - b * d) / denom;
    };

    const computeTranslateDelta = (
      camera: THREE.Camera,
      canvas: HTMLCanvasElement,
      axis: TransformAxis,
      pivot: { x: number; y: number; z: number },
      startScreen: { x: number; y: number },
      currentScreen: { x: number; y: number },
    ): THREE.Vector3 => {
      const rect = canvas.getBoundingClientRect();
      const makeRay = (s: { x: number; y: number }) => {
        const ndc = new THREE.Vector2(
          ((s.x - rect.left) / rect.width) * 2 - 1,
          -(((s.y - rect.top) / rect.height) * 2 - 1),
        );
        const rc = new THREE.Raycaster();
        rc.setFromCamera(ndc, camera);
        return rc.ray.clone();
      };
      const rayA = makeRay(startScreen);
      const rayB = makeRay(currentScreen);
      const pivotVec = new THREE.Vector3(pivot.x, pivot.y, pivot.z);

      if (axis === 'free') {
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir.clone().negate(), pivotVec);
        const pA = new THREE.Vector3();
        const pB = new THREE.Vector3();
        if (!rayA.intersectPlane(plane, pA)) return new THREE.Vector3();
        if (!rayB.intersectPlane(plane, pB)) return new THREE.Vector3();
        return pB.sub(pA);
      }

      if (axis === 'yz' || axis === 'xz' || axis === 'xy') {
        const normal = new THREE.Vector3(
          axis === 'yz' ? 1 : 0,
          axis === 'xz' ? 1 : 0,
          axis === 'xy' ? 1 : 0,
        );
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pivotVec);
        const pA = new THREE.Vector3();
        const pB = new THREE.Vector3();
        if (!rayA.intersectPlane(plane, pA)) return new THREE.Vector3();
        if (!rayB.intersectPlane(plane, pB)) return new THREE.Vector3();
        return pB.sub(pA);
      }

      const axisDir = new THREE.Vector3(
        axis === 'x' ? 1 : 0,
        axis === 'y' ? 1 : 0,
        axis === 'z' ? 1 : 0,
      );
      const tA = closestPointOnLineFromRay(rayA, pivotVec, axisDir);
      const tB = closestPointOnLineFromRay(rayB, pivotVec, axisDir);
      return axisDir.clone().multiplyScalar(tB - tA);
    };

    const computeScaleFactor = (
      camera: THREE.Camera,
      canvas: HTMLCanvasElement,
      axis: TransformAxis,
      pivot: { x: number; y: number; z: number },
      startScreen: { x: number; y: number },
      currentScreen: { x: number; y: number },
    ): { x: number; y: number; z: number } => {
      const rect = canvas.getBoundingClientRect();
      const proj = new THREE.Vector3(pivot.x, pivot.y, pivot.z).project(camera);
      const pivotPx = {
        x: rect.left + ((proj.x + 1) / 2) * rect.width,
        y: rect.top + ((-proj.y + 1) / 2) * rect.height,
      };
      const dStart = Math.hypot(startScreen.x - pivotPx.x, startScreen.y - pivotPx.y);
      const dCur = Math.hypot(currentScreen.x - pivotPx.x, currentScreen.y - pivotPx.y);
      const factor = dStart > 1 ? dCur / dStart : 1;
      const fx = (axis === 'free' || axis === 'x' || axis === 'xy' || axis === 'xz') ? factor : 1;
      const fy = (axis === 'free' || axis === 'y' || axis === 'xy' || axis === 'yz') ? factor : 1;
      const fz = (axis === 'free' || axis === 'z' || axis === 'xz' || axis === 'yz') ? factor : 1;
      return { x: fx, y: fy, z: fz };
    };

    const applyTranslate = (modal: TransformModalState, delta: THREE.Vector3) => {
      if (modal.target === 'mesh' && modal.meshId && modal.originalMeshPos) {
        const orig = modal.originalMeshPos;
        const newPos = { x: orig.x + delta.x, y: orig.y + delta.y, z: orig.z + delta.z };
        meshPositionsRef.current.set(modal.meshId, newPos);
        setMeshPositions(prev => new Map(prev).set(modal.meshId!, newPos));
      } else if (modal.target === 'skeleton' && modal.skeletonId && modal.originalSkeletonPos) {
        const orig = modal.originalSkeletonPos;
        const newPos = { x: orig.x + delta.x, y: orig.y + delta.y, z: orig.z + delta.z };
        skeletonPositionsRef.current.set(modal.skeletonId, newPos);
        setSkeletonPositions(prev => new Map(prev).set(modal.skeletonId!, newPos));
      } else if (modal.target === 'cloud' && modal.cloudIds && modal.originalCloudTranslations) {
        setEditStates(prev => {
          const next = new Map(prev);
          for (const id of modal.cloudIds!) {
            const orig = modal.originalCloudTranslations!.get(id);
            if (!orig) continue;
            const state = next.get(id) || {
              translation: { x: 0, y: 0, z: 0 },
              erasedIndices: new Set<number>(),
            };
            next.set(id, {
              ...state,
              translation: { x: orig.x + delta.x, y: orig.y + delta.y, z: orig.z + delta.z },
            });
          }
          return next;
        });
      }
    };

    const applyScale = (modal: TransformModalState, factor: { x: number; y: number; z: number }) => {
      if (modal.target === 'mesh' && modal.meshId && modal.originalMeshScale) {
        const orig = modal.originalMeshScale;
        const newScale = {
          x: Math.max(0.001, orig.x * factor.x),
          y: Math.max(0.001, orig.y * factor.y),
          z: Math.max(0.001, orig.z * factor.z),
        };
        meshScalesRef.current.set(modal.meshId, newScale);
        setMeshScales(prev => new Map(prev).set(modal.meshId!, newScale));
      }
    };

    const parseNumeric = (s: string): number | null => {
      if (!s) return null;
      if (s === '-' || s === '.' || s === '-.') return null;
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    };

    const applyNumeric = (modal: TransformModalState, value: number) => {
      if (modal.op === 'translate') {
        let dx = 0, dy = 0, dz = 0;
        if (modal.axis === 'x' || modal.axis === 'free') dx = value;
        else if (modal.axis === 'y') dy = value;
        else if (modal.axis === 'z') dz = value;
        else if (modal.axis === 'xy') { dx = value; dy = value; }
        else if (modal.axis === 'xz') { dx = value; dz = value; }
        else if (modal.axis === 'yz') { dy = value; dz = value; }
        applyTranslate(modal, new THREE.Vector3(dx, dy, dz));
      } else {
        const f = { x: 1, y: 1, z: 1 };
        if (modal.axis === 'free') { f.x = value; f.y = value; f.z = value; }
        else if (modal.axis === 'x') f.x = value;
        else if (modal.axis === 'y') f.y = value;
        else if (modal.axis === 'z') f.z = value;
        else if (modal.axis === 'xy') { f.x = value; f.y = value; }
        else if (modal.axis === 'xz') { f.x = value; f.z = value; }
        else if (modal.axis === 'yz') { f.y = value; f.z = value; }
        applyScale(modal, f);
      }
    };

    const updateModal = (clientX: number, clientY: number) => {
      const modal = transformModalRef.current;
      if (!modal) return;
      const numeric = parseNumeric(modal.numericBuffer);
      if (numeric !== null) {
        applyNumeric(modal, numeric);
        return;
      }
      const camera = mainCameraRef.current;
      const canvas = getCanvas();
      if (!camera || !canvas) return;
      const cur = { x: clientX, y: clientY };
      if (modal.op === 'translate') {
        const delta = computeTranslateDelta(camera, canvas, modal.axis, modal.pivot, modal.startScreen, cur);
        applyTranslate(modal, delta);
      } else {
        const factor = computeScaleFactor(camera, canvas, modal.axis, modal.pivot, modal.startScreen, cur);
        applyScale(modal, factor);
      }
    };

    const cancelModal = () => {
      const modal = transformModalRef.current;
      if (!modal) return;
      if (modal.target === 'mesh' && modal.meshId) {
        if (modal.originalMeshPos) {
          const orig = modal.originalMeshPos;
          meshPositionsRef.current.set(modal.meshId, orig);
          setMeshPositions(prev => new Map(prev).set(modal.meshId!, orig));
        }
        if (modal.originalMeshScale) {
          const orig = modal.originalMeshScale;
          meshScalesRef.current.set(modal.meshId, orig);
          setMeshScales(prev => new Map(prev).set(modal.meshId!, orig));
        }
      } else if (modal.target === 'skeleton' && modal.skeletonId && modal.originalSkeletonPos) {
        const orig = modal.originalSkeletonPos;
        skeletonPositionsRef.current.set(modal.skeletonId, orig);
        setSkeletonPositions(prev => new Map(prev).set(modal.skeletonId!, orig));
      } else if (modal.target === 'cloud' && modal.cloudIds && modal.originalCloudTranslations) {
        setEditStates(prev => {
          const next = new Map(prev);
          for (const id of modal.cloudIds!) {
            const orig = modal.originalCloudTranslations!.get(id);
            if (!orig) continue;
            const state = next.get(id);
            if (state) next.set(id, { ...state, translation: orig });
          }
          return next;
        });
      }
      pendingHistoryRef.current = null;
      transformModalRef.current = null;
      setTransformModal(null);
      setGizmoDragging(false);
    };

    const commitModal = () => {
      if (!transformModalRef.current) return;
      commitHistoryEntry();
      transformModalRef.current = null;
      setTransformModal(null);
      setGizmoDragging(false);
    };

    const startModal = (op: 'translate' | 'scale') => {
      if (transformModalRef.current) return;
      if (!mainCameraRef.current) return;
      if (!lastMouse.set) return;
      const pivot = computePivot();
      if (!pivot) return;

      let state: TransformModalState | null = null;

      if (selectedMesh) {
        state = {
          op,
          axis: 'free',
          startScreen: { x: lastMouse.x, y: lastMouse.y },
          pivot,
          target: 'mesh',
          meshId: selectedMesh.id,
          originalMeshPos: { ...(meshPositionsRef.current.get(selectedMesh.id) || { x: 0, y: 0, z: 0 }) },
          originalMeshScale: { ...(meshScalesRef.current.get(selectedMesh.id) || { x: 1, y: 1, z: 1 }) },
          numericBuffer: '',
        };
        startHistoryEntry('mesh', selectedMesh.id);
      } else if (op === 'translate' && selectedSkeleton) {
        state = {
          op,
          axis: 'free',
          startScreen: { x: lastMouse.x, y: lastMouse.y },
          pivot,
          target: 'skeleton',
          skeletonId: selectedSkeleton.id,
          originalSkeletonPos: { ...(skeletonPositionsRef.current.get(selectedSkeleton.id) || { x: 0, y: 0, z: 0 }) },
          numericBuffer: '',
        };
        startHistoryEntry('skeleton', selectedSkeleton.id);
      } else if (op === 'translate' && selectedIds.size > 0) {
        const originals = new Map<string, { x: number; y: number; z: number }>();
        const ids: string[] = [];
        for (const id of selectedIds) {
          const s = editStates.get(id);
          originals.set(id, { ...(s?.translation ?? { x: 0, y: 0, z: 0 }) });
          ids.push(id);
        }
        // History only captures one entry at a time (existing limitation)
        if (ids[0]) startHistoryEntry('cloud', ids[0]);
        state = {
          op,
          axis: 'free',
          startScreen: { x: lastMouse.x, y: lastMouse.y },
          pivot,
          target: 'cloud',
          cloudIds: ids,
          originalCloudTranslations: originals,
          numericBuffer: '',
        };
      }

      if (!state) return;
      transformModalRef.current = state;
      setTransformModal(state);
      setGizmoDragging(true);
      // Apply with the start position so the object doesn't visibly jump until the mouse moves.
      updateModal(lastMouse.x, lastMouse.y);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const modal = transformModalRef.current;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (!modal) {
        if (isInputFocused()) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (k === 't') { e.preventDefault(); startModal('translate'); }
        else if (k === 's') { e.preventDefault(); startModal('scale'); }
        return;
      }

      // Modal is active
      if (k === 'x' || k === 'y' || k === 'z') {
        e.preventDefault();
        const planeMap = { x: 'yz', y: 'xz', z: 'xy' } as const;
        const wanted: TransformAxis = e.shiftKey ? planeMap[k] : k;
        const next: TransformAxis = modal.axis === wanted ? 'free' : wanted;
        const updated = { ...modal, axis: next };
        transformModalRef.current = updated;
        setTransformModal(updated);
        updateModal(lastMouse.x, lastMouse.y);
      } else if (k === 'Enter') {
        e.preventDefault();
        commitModal();
      } else if (k === 'Escape') {
        e.preventDefault();
        cancelModal();
      } else if (k === 'Backspace') {
        e.preventDefault();
        const buf = modal.numericBuffer.slice(0, -1);
        const updated = { ...modal, numericBuffer: buf };
        transformModalRef.current = updated;
        setTransformModal(updated);
        updateModal(lastMouse.x, lastMouse.y);
      } else if (/^[0-9]$/.test(k) || k === '.' || k === '-') {
        e.preventDefault();
        let buf = modal.numericBuffer;
        if (k === '.') {
          if (buf.includes('.')) return;
          if (buf === '' || buf === '-') buf += '0';
          buf += '.';
        } else if (k === '-') {
          buf = buf.startsWith('-') ? buf.slice(1) : '-' + buf;
        } else {
          buf += k;
        }
        const updated = { ...modal, numericBuffer: buf };
        transformModalRef.current = updated;
        setTransformModal(updated);
        updateModal(lastMouse.x, lastMouse.y);
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      lastMouse.x = e.clientX;
      lastMouse.y = e.clientY;
      lastMouse.set = true;
      if (transformModalRef.current) updateModal(e.clientX, e.clientY);
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (!transformModalRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 2) cancelModal();
      else commitModal();
    };

    const handleContextMenu = (e: MouseEvent) => {
      if (transformModalRef.current) e.preventDefault();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('contextmenu', handleContextMenu);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [
    selectedMesh,
    selectedSkeleton,
    selectedIds,
    clouds,
    editStates,
    startHistoryEntry,
    commitHistoryEntry,
  ]);

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
      ...(shapeType === 'voxel' ? { gridSubdivisions: { x: 1, y: 1, z: 1 } } : {}),
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
  }, [shapeCounter, onDeselectAll]);

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
  const handleCreatePlant = useCallback(async (payload: PlantGenerationPayload) => {
    if (isGeneratingPlant) return;

    setIsGeneratingPlant(true);
    setPlantProgress(0);
    setPlantProgressMsg('Preparing...');
    // Keep the popup open so it can show the progress bar; it closes on success.

    // Canopy info captured for the new mesh's display name (single plants leave it undefined).
    let canopyInfo: { countX: number; countY: number; plantCount: number } | undefined;
    // Position used for plant metadata: canopy center, or single-plant position.
    let plantPosition: { x: number; y: number; z: number };
    // The requested seed (single or canopy), used for reproducible regeneration.
    const requestedSeed = payload.request.random_seed;

    if (payload.mode === 'canopy') {
      const { request } = payload;
      plantPosition = { x: request.center_x ?? 0, y: request.center_y ?? 0, z: request.center_z ?? 0 };
    } else {
      const { request } = payload;
      plantPosition = { x: request.position_x ?? 0, y: request.position_y ?? 0, z: request.position_z ?? 0 };
    }

    const abort = new AbortController();
    plantAbortRef.current = abort;

    try {
      // Stream the build so the popup shows live progress (and can cancel).
      const response = await generatePlantStreaming(
        payload,
        (p, msg) => { setPlantProgress(p); setPlantProgressMsg(msg); },
        abort.signal,
      );

      // Single plants come back with a retained session for age scrubbing.
      const sessionId = response.session_id;

      if (payload.mode === 'canopy' && response.success) {
        const { request } = payload;
        canopyInfo = {
          countX: response.count_x ?? request.count_x ?? 0,
          countY: response.count_y ?? request.count_y ?? 0,
          plantCount: response.plant_count ?? 0,
        };
      }

      if (!response.success) {
        showToast({ title: response.error || 'Plant generation failed', type: 'error' });
        return;
      }

      // Result received; building the three.js geometry from a large canopy is
      // itself non-trivial, so show a final phase instead of a frozen bar.
      setPlantProgress(0.98);
      setPlantProgressMsg('Building scene...');

      // Debug: Log response data
      console.log('[Plant] Response received:', {
        vertex_count: response.vertex_count,
        triangle_count: response.triangle_count,
        has_colors: response.colors?.length || 0,
        has_uvs: response.uv_coordinates?.length || 0,
        materials: response.materials?.length || 0,
        textures: Object.keys(response.textures || {}).length,
      });

      // Convert response data to MeshData + materials (real Helios UVs + textures).
      const { data: meshData, plantMaterials } = plantResponseToMeshData(response);

      const newMeshId = crypto.randomUUID();
      // Generate a random seed if not provided, for reproducible regeneration
      const seed = requestedSeed ?? Math.floor(Math.random() * 1000000);
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
        plantPosition,
        plantSeed: seed,
        plantSessionId: sessionId, // Session ID for consistent age stepping (canopies have none)
        regenerationKey: 0, // Counter for forcing React remount on age change
        heliosXml: response.helios_xml,
        plantMaterials,
        plantCanopy: canopyInfo,
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

      // Mesh is in the scene — close the popup now.
      setShowPlantPopup(false);

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
      // A user-initiated cancel aborts the fetch; that's not an error.
      if (abort.signal.aborted) {
        console.log('[Plant] Generation cancelled by user');
      } else {
        console.error('Plant generation failed:', error);
        showToast({ title: `Plant generation failed: ${error}`, type: 'error' });
      }
    } finally {
      if (plantAbortRef.current === abort) plantAbortRef.current = null;
      setIsGeneratingPlant(false);
      setPlantProgress(null);
      setPlantProgressMsg('');
    }
  }, [isGeneratingPlant, shapeCounter, onDeselectAll]);

  // Cancel an in-flight plant/canopy build (aborts the SSE stream).
  const handleCancelPlantGenerate = useCallback(() => {
    plantAbortRef.current?.abort();
  }, []);

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

      // Convert response (+ real Helios UVs / textures) to MeshData.
      const { data: morphedData, plantMaterials } = plantResponseToMeshData(response);

      // Replace mesh in-place with new geometry
      setMeshes(prev => prev.map(m => {
        if (m.id === selectedMeshId) {
          return {
            ...m,
            data: morphedData,
            plantMaterials,
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
          // Convert response data (+ real Helios UVs / textures) to MeshData.
          const { data: advancedData, plantMaterials } = plantResponseToMeshData(response);

          // Update the mesh with new geometry from session
          setMeshes(prev => prev.map(m => {
            if (m.id === meshId) {
              return {
                ...m,
                data: advancedData,
                plantMaterials,
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
        const { data: regenData, plantMaterials } = plantResponseToMeshData(response);

        setMeshes(prev => prev.map(m => {
          if (m.id === meshId) {
            return {
              ...m,
              data: regenData,
              plantMaterials,
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

      // Convert response data (+ real Helios UVs / textures) to MeshData.
      const { data: newSessionData, plantMaterials } = plantResponseToMeshData(advanceResponse);

      // Update the mesh with new session
      setMeshes(prev => prev.map(m => {
        if (m.id === meshId) {
          return {
            ...m,
            data: newSessionData,
            plantMaterials,
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
        const { data: animData, plantMaterials } = plantResponseToMeshData(response);
        setMeshes(prev => prev.map(m => {
          if (m.id === meshId) {
            return {
              ...m,
              data: animData,
              plantMaterials,
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

      // Helper to create an offscreen mesh for GIF frames. This uses vertex
      // colors only (no image textures) — the GIF export renders organ colors,
      // not leaf textures, which keeps the offscreen pipeline simple.
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

  // Color modes that benefit from a colormap + colorbar (continuous scalars).
  const isScalarColorMode = (
    colorMode === 'x' ||
    colorMode === 'y' ||
    colorMode === 'height' ||
    colorMode === 'intensity' ||
    colorMode === 'scalar'
  );

  // Stable key for the active continuous mode (so per-mode min/max overrides
  // don't leak across different fields/axes).
  const colorRangeKey =
    colorMode === 'scalar' && selectedScalarField
      ? `scalar:${selectedScalarField}`
      : colorMode;

  // Compute the data-derived default min/max for the active mode against a
  // representative cloud (the first visible selected cloud, or the first
  // visible cloud overall). Returns null if no defaults apply.
  const colorbarSourceCloud = useMemo(() => {
    const firstSelected = Array.from(selectedIds)
      .map(id => clouds.find(c => c.id === id))
      .find(c => c?.visible);
    if (firstSelected) return firstSelected;
    return clouds.find(c => c.visible) ?? null;
  }, [clouds, selectedIds]);

  const dataRange = useMemo<{ min: number; max: number; label: string } | null>(() => {
    if (!colorbarSourceCloud || !isScalarColorMode) return null;
    const d = colorbarSourceCloud.data;
    if (colorMode === 'x') return { min: d.bounds.min.x, max: d.bounds.max.x, label: 'X' };
    if (colorMode === 'y') return { min: d.bounds.min.y, max: d.bounds.max.y, label: 'Y' };
    if (colorMode === 'height') return { min: d.bounds.min.z, max: d.bounds.max.z, label: 'Z (Height)' };
    if (colorMode === 'intensity') return { min: 0, max: 1, label: 'Intensity' };
    if (colorMode === 'scalar' && selectedScalarField) {
      // Flat clouds carry per-field min/max in scalarFields; octree clouds
      // carry it in octree.attributeRanges (keyed by on-disk slug). Prefer
      // the human-readable label for the colorbar caption when we have one.
      if (d.scalarFields?.[selectedScalarField]) {
        const f = d.scalarFields[selectedScalarField];
        return { min: f.min, max: f.max, label: selectedScalarField };
      }
      const r = d.octree?.attributeRanges?.[selectedScalarField];
      if (r && r.min.length > 0 && r.max.length > 0) {
        const label = d.octree?.attributeLabels?.[selectedScalarField] ?? selectedScalarField;
        return { min: r.min[0], max: r.max[0], label };
      }
    }
    return null;
  }, [colorbarSourceCloud, colorMode, selectedScalarField, isScalarColorMode]);

  // The actual min/max being applied to the colormap (override → fallback).
  const activeRange = useMemo<{ min: number; max: number } | null>(() => {
    if (!dataRange) return null;
    const override = colorRanges[colorRangeKey];
    return {
      min: override?.min ?? dataRange.min,
      max: override?.max ?? dataRange.max,
    };
  }, [dataRange, colorRanges, colorRangeKey]);

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

        {/* Render all visible clouds.
            We pass the source `cloud.data` (or the resample preview when
            active) straight to <PointCloud> without copying. Crop preview
            and erase produce a Uint32Array of visible indices that
            three.js uses as the geometry index — see getDisplayIndices
            for the rationale. Translation is applied to the parent group;
            it is no longer baked into the position buffer. */}
        {clouds.map(cloud => {
          if (!cloud.visible) return null;
          const editState = getEditState(cloud.id);
          const isSelected = selectedIds.has(cloud.id);
          // Keep the crop preview (hidden to-be-cropped points) alive while
          // the apply's backend round-trip is in flight. handleApplyCrop
          // flips editMode to 'none' immediately (to hide the box handles +
          // crop panel) but sets isApplyingCrop, so the clip box / index
          // filter keep hiding the cropped points until the new data is live.
          const showCropPreview = isSelected && (editMode === 'crop' || isApplyingCrop);
          const hasResamplePreview = resamplePreview?.cloudId === cloud.id;

          // Resample preview replaces the source dataset entirely; crop
          // and erase do not apply to it.
          const sourceData = hasResamplePreview ? resamplePreview.previewData : cloud.data;
          if (!sourceData || sourceData.pointCount === 0) return null;
          // Octree clouds don't have flat positions to filter against —
          // their LOD streaming handles everything, and getDisplayIndices
          // would return an empty Uint32Array (no positions → no matches).
          // The kill-switch below would then hide the whole cloud the
          // moment the user opens crop or any range filter. Crop preview
          // for octree clouds is going to be a ClipBox in M3; for now,
          // skip the indices path entirely.
          const isOctreeCloud = !!cloud.data.octree;
          const indices = hasResamplePreview || isOctreeCloud
            ? null
            : getDisplayIndices(cloud, showCropPreview);
          if (indices && indices.length === 0) return null;

          return (
            <group
              key={cloud.id}
              position={hasResamplePreview
                ? [0, 0, 0]
                : [editState.translation.x, editState.translation.y, editState.translation.z]}
            >
              {sourceData.octree ? (
                <OctreePointCloud
                  // Re-mount the component when colorMode changes — the
                  // octree's per-tile sceneNodes are constructed by
                  // potree-core with the material at tile-load time, and
                  // three.js's BindingState cache keeps the old attribute
                  // slot mapping even when the cloud material's shader
                  // source is replaced. A fresh mount means a fresh
                  // material from potree-core's loader, which gets fresh
                  // BindingStates for every tile that re-streams. The
                  // octree.bin tiles themselves are cached on disk (and
                  // potree-core caches PCOGeometry in memory across
                  // loads), so re-mount cost is one shader compile per
                  // mode switch — measured at ~10 ms.
                  // Re-mount also when the selected scalar field changes, not
                  // just the colour mode — switching the field needs a fresh
                  // material + BindingStates so the new attribute's buffer
                  // (swapped into `intensity`) binds correctly.
                  key={`octree-${colorMode}-${selectedScalarField ?? ''}-${sourceData.octree ? (octreePaintGen[sourceData.octree.cacheId] ?? 0) : 0}`}
                  data={sourceData}
                  onFirstTilesReady={
                    sourceData.octree
                      ? () => handleOctreeFirstTiles(sourceData.octree!.cacheId)
                      : undefined
                  }
                  pointSize={pointSize}
                  // 'per-scan' renders as a uniform single-colour swatch
                  // (the cloud's own colour), same convention as the flat
                  // PointCloud dispatch below. 'x' and 'y' don't have a
                  // clean octree equivalent yet (no axis-scalar shader),
                  // so they fall through to 'height' which colours by Z.
                  colorMode={
                    colorMode === 'per-scan'
                      ? 'single'
                      : colorMode === 'x' || colorMode === 'y'
                        ? 'height'
                        : colorMode
                  }
                  selectedScalarField={selectedScalarField}
                  singleColor={colorMode === 'per-scan' ? cloud.color : undefined}
                  colormap={colormap}
                  rangeMin={activeRange?.min}
                  rangeMax={activeRange?.max}
                  // Live crop preview: pass the current crop box only in
                  // box mode while a crop is being drawn AND this cloud
                  // is in the selection. Polygon mode falls back to the
                  // overlay-only preview (the gizmo-screen polygon is
                  // already drawn); the apply still runs full polygon
                  // through the backend.
                  clipBox={
                    showCropPreview && cropMode === 'box' && cropBox
                      ? {
                          min: new THREE.Vector3(cropBox.min.x, cropBox.min.y, cropBox.min.z),
                          max: new THREE.Vector3(cropBox.max.x, cropBox.max.y, cropBox.max.z),
                          invert: cropInvert,
                        }
                      : null
                  }
                />
              ) : (
                <PointCloud
                  data={sourceData}
                  indices={indices}
                  pointSize={pointSize}
                  // 'per-scan' is rendered as 'single' with the cloud's own
                  // swatch color — keeps PointCloud unaware of multi-cloud state.
                  colorMode={colorMode === 'per-scan' ? 'single' : colorMode}
                  singleColor={colorMode === 'per-scan' ? cloud.color : undefined}
                  selectedScalarField={selectedScalarField}
                  filters={cloudFilters.get(cloud.id)}
                  colormap={colormap}
                  rangeMin={activeRange?.min}
                  rangeMax={activeRange?.max}
                />
              )}
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
              {/* Render textured (plant / imported OBJ+MTL) meshes through the
                  material-group renderer when UVs and a textured material are
                  present; otherwise fall back to the vertex-colored mesh.
                  Key includes regenerationKey to force remount on regeneration. */}
              {mesh.data.uvCoordinates && mesh.data.uvCoordinates.length > 0 &&
               mesh.plantMaterials && mesh.plantMaterials.some(m => m.textureData) ? (
                <TexturedPlantMesh
                  key={`mesh-${mesh.id}-${mesh.regenerationKey ?? 0}`}
                  data={mesh.data}
                  plantMaterials={mesh.plantMaterials}
                  opacity={meshOpacity}
                  wireframe={meshWireframe}
                />
              ) : (
                <TriangleMesh
                  key={`mesh-${mesh.id}-${mesh.regenerationKey ?? 0}`}
                  data={mesh.data}
                  color={mesh.color}
                  opacity={meshOpacity}
                  wireframe={meshWireframe}
                  useVertexColors={mesh.data.vertexColors !== undefined && mesh.data.vertexColors.length > 0}
                />
              )}
              {mesh.gridSubdivisions &&
                (mesh.gridSubdivisions.x > 1 || mesh.gridSubdivisions.y > 1 || mesh.gridSubdivisions.z > 1) && (
                  <VoxelGridOverlay subdivisions={mesh.gridSubdivisions} />
                )}
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

        {/* Scanner markers for every scan that carries scan parameters.
            Rendered at a fixed physical height (a typical tripod scanner is
            ~0.3-0.4 m tall) — scene-relative scaling made them tower over
            small trees and shrink to specks against large scans. */}
        {scansWithParams.map(scan => {
          if (!scan.visible) return null;
          const scannerHeight = 0.35;
          const isMarkerSelected = selectedMarkerScanId === scan.id;
          return (
            <ScannerMarker
              key={scan.id}
              origin={scan.params.origin}
              heightMeters={scannerHeight}
              color={scan.color}
              selected={isMarkerSelected}
            />
          );
        })}

        <CameraController
          bounds={combinedBounds}
          hasContent={clouds.length > 0 || meshes.length > 0 || skeletons.length > 0}
          enabled={!gizmoDragging && cropDrawState !== 'drawing-polygon' && cropDrawState !== 'drawing-rect'}
        />

        {/* Snapshots the camera/size for the polygon- and rect-crop in/out
            test. Both freeze the camera at draw time, so the snapshotter
            lives whenever either screen-space shape could be active. */}
        {editMode === 'crop' && (cropMode === 'polygon' || cropMode === 'rect') && (
          <PolygonCameraSnapshotter
            cameraRef={polygonCameraRef}
            sizeRef={polygonCanvasSizeRef}
          />
        )}

        {/* While drawing a Rect, project orthographically so the screen
            rectangle extrudes as a straight prism (true rectangle footprint)
            instead of a perspective trapezoid. The projection is snapshotted
            into the region on mouse-up, so it only needs to be active up to
            the commit. */}
        {editMode === 'crop' && cropMode === 'rect' && cropDrawState === 'drawing-rect' && (
          <OrthoProjectionOverride />
        )}

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

        {/* Crop Box (world-space) — shown only in box mode. The polygon
            lasso is drawn as an SVG overlay outside the canvas so it
            doesn't fight three.js event handling. */}
        {editMode === 'crop' && cropMode === 'box' && cropBox && (
          <CropBox
            min={cropBox.min}
            max={cropBox.max}
            keepInside={!cropInvert}
          />
        )}

        {/* Two-click ground-plane box-draw raycaster. Active only while
            the user has clicked "Draw box" in the panel. */}
        {editMode === 'crop' &&
          (cropDrawState === 'awaiting-box-corner-1' || cropDrawState === 'awaiting-box-corner-2') && (
          <BoxDrawRaycaster
            groundZ={combinedBounds.min.z}
            onMove={(x, y) => {
              boxDrawCursorRef.current = { x, y };
              // Re-render so the corner-1 marker / preview box follows the
              // cursor. Cheap — the preview is a single wireframe box.
              setBoxDrawCursorTick(t => t + 1);
            }}
            onPick={(x, y) => {
              if (cropDrawState === 'awaiting-box-corner-1') {
                boxDrawFirstCornerRef.current = { x, y };
                setCropDrawState('awaiting-box-corner-2');
                return;
              }
              const first = boxDrawFirstCornerRef.current;
              if (!first) { setCropDrawState('idle'); return; }
              const minX = Math.min(first.x, x);
              const minY = Math.min(first.y, y);
              const maxX = Math.max(first.x, x);
              const maxY = Math.max(first.y, y);
              setCropBox({
                min: { x: minX, y: minY, z: combinedBounds.min.z },
                max: { x: maxX, y: maxY, z: combinedBounds.max.z },
              });
              boxDrawFirstCornerRef.current = null;
              boxDrawCursorRef.current = null;
              setCropDrawState('idle');
            }}
          />
        )}

        {/* Live in-viewport feedback while placing box corners: a small
            marker at the first corner and, once it's placed, a preview box
            spanning corner 1 → current cursor that updates on every move.
            Mirrors the polygon lasso's cursor-follows preview. */}
        {editMode === 'crop' &&
          (cropDrawState === 'awaiting-box-corner-1' || cropDrawState === 'awaiting-box-corner-2') && (() => {
          // Read the tick so this re-renders as the cursor moves.
          void boxDrawCursorTick;
          const first = boxDrawFirstCornerRef.current;
          const cursor = boxDrawCursorRef.current;
          const markerColor = cropInvert ? '#ef4444' : '#22c55e';
          const markerSize = Math.max(
            (combinedBounds.max.x - combinedBounds.min.x),
            (combinedBounds.max.y - combinedBounds.min.y),
          ) * 0.01 || 0.1;
          return (
            <group>
              {first && (
                <mesh position={[first.x, first.y, combinedBounds.min.z]}>
                  <sphereGeometry args={[markerSize, 16, 16]} />
                  <meshBasicMaterial color={markerColor} />
                </mesh>
              )}
              {first && cursor && (
                <CropBox
                  min={{
                    x: Math.min(first.x, cursor.x),
                    y: Math.min(first.y, cursor.y),
                    z: combinedBounds.min.z,
                  }}
                  max={{
                    x: Math.max(first.x, cursor.x),
                    y: Math.max(first.y, cursor.y),
                    z: combinedBounds.max.z,
                  }}
                  keepInside={!cropInvert}
                />
              )}
            </group>
          );
        })()}

        {/* Erase Brush - for erasing points from point cloud. Skipped for
            octree-backed clouds: the brush picks the closest point in
            data.positions (an empty Float32Array for octrees) and would
            never select anything. Use Crop with invert instead. */}
        {editMode === 'erase' && firstSelectedCloud && !firstSelectedCloud.data.octree && (() => {
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

        {showAxes && <ViewportAxesGizmo />}
      </Canvas>

      {/* Polygon lasso overlay — covers the canvas in screen space.
          Captures clicks only while drawing; in "closed polygon" state
          it's a non-interactive visualization that lets the user see
          their selection before pressing Enter to apply. */}
      {/* Trunk-seed capture overlay (TreeIso human-in-the-loop). Active while
          the Tree Segmentation panel's "Seed trunks" mode is on. Left-click
          unprojects onto the cloud's ground plane (via the live camera) and
          records a world-space seed; right-click removes the last one. Markers
          are drawn at their projected screen positions. The overlay captures
          pointer events, so the camera is effectively fixed while seeding. */}
      {showTreeSegmentPanel && treeSeedMode && selectedIds.size === 1 && (() => {
        const cam = mainCameraRef.current;
        const cloud = clouds.find(c => selectedIds.has(c.id));
        const groundZ = cloud?.data.bounds?.min.z ?? 0;
        const project = (p: [number, number, number]) => {
          if (!cam) return null;
          const v = new THREE.Vector3(p[0], p[1], p[2]).project(cam);
          return { x: (v.x * 0.5 + 0.5) * 100, y: (-v.y * 0.5 + 0.5) * 100, behind: v.z > 1 };
        };
        const onSeedClick = (e: React.MouseEvent<SVGSVGElement>) => {
          if (e.button !== 0 || !cam) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -(((e.clientY - rect.top) / rect.height) * 2 - 1),
          );
          const rc = new THREE.Raycaster();
          rc.setFromCamera(ndc, cam);
          const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -groundZ);
          const hit = new THREE.Vector3();
          if (rc.ray.intersectPlane(plane, hit)) {
            setTreeSeedPoints(prev => [...prev, [hit.x, hit.y, hit.z]]);
          }
        };
        const onSeedContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
          e.preventDefault();
          setTreeSeedPoints(prev => prev.slice(0, -1));
        };
        return (
          <svg
            data-testid="tree-seed-overlay"
            className="absolute inset-0 z-10"
            width="100%"
            height="100%"
            style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
            onClick={onSeedClick}
            onContextMenu={onSeedContextMenu}
          >
            {treeSeedPoints.map((p, i) => {
              const s = project(p);
              if (!s || s.behind) return null;
              return (
                <g key={i}>
                  <circle cx={`${s.x}%`} cy={`${s.y}%`} r={6} fill="rgba(34,197,94,0.85)" stroke="#fff" strokeWidth={1.5} />
                  <text x={`${s.x}%`} y={`${s.y}%`} dy={-10} fill="#fff" fontSize={11} textAnchor="middle">{i + 1}</text>
                </g>
              );
            })}
          </svg>
        );
      })()}

      {editMode === 'crop' && cropMode === 'polygon' && (cropDrawState === 'drawing-polygon' || cropPolygon) && (() => {
        const isDrawing = cropDrawState === 'drawing-polygon';
        const points = isDrawing ? polygonInProgress : (cropPolygon?.points ?? []);
        const cursor = isDrawing ? polygonCursorRef.current : null;

        const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
          if (!isDrawing) return;
          if (e.button !== 0) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          setPolygonInProgress(prev => [...prev, { x, y }]);
        };
        const handleContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
          if (!isDrawing) return;
          e.preventDefault();
          setPolygonInProgress(prev => prev.slice(0, -1));
        };
        const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
          if (!isDrawing) return;
          const rect = e.currentTarget.getBoundingClientRect();
          polygonCursorRef.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          };
          // Bump the tick so the cursor preview line re-renders. Cheap —
          // the overlay's only a handful of SVG elements.
          setPolygonCursorTick(t => t + 1);
        };

        const polylinePoints = points.map(p => `${p.x},${p.y}`).join(' ');
        const closedPoints = !isDrawing && points.length >= 3 ? polylinePoints : null;
        // Suppress unused-state warning — we read polygonCursorTick to force re-render.
        void polygonCursorTick;

        return (
          <svg
            data-testid="crop-polygon-overlay"
            className="absolute inset-0 z-10"
            // An <svg> has an intrinsic 300×150 default size; `inset-0`
            // only positions its edges, it does NOT stretch the element.
            // Without an explicit 100%×100% the overlay collapses to
            // 300×150 in the top-left while the three.js canvas fills the
            // full container — so lasso clicks (recorded in the SVG's
            // pixel space) and the crop projection (computed in the
            // canvas' pixel space) use different coordinate systems and
            // the polygon encloses the wrong region (usually nothing).
            width="100%"
            height="100%"
            style={{
              pointerEvents: isDrawing ? 'auto' : 'none',
              cursor: isDrawing ? 'crosshair' : 'default',
            }}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            onMouseMove={handleMouseMove}
          >
            {closedPoints && (
              <polygon
                points={closedPoints}
                fill={cropInvert ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)'}
                stroke={cropInvert ? '#ef4444' : '#22c55e'}
                strokeWidth={2}
              />
            )}
            {isDrawing && points.length > 0 && (
              <>
                <polyline
                  points={polylinePoints}
                  fill="none"
                  stroke="#22c55e"
                  strokeWidth={2}
                />
                {cursor && (
                  <line
                    x1={points[points.length - 1].x}
                    y1={points[points.length - 1].y}
                    x2={cursor.x}
                    y2={cursor.y}
                    stroke="#22c55e"
                    strokeWidth={1}
                    strokeDasharray="4 4"
                  />
                )}
                {points.length >= 3 && cursor && (
                  <line
                    x1={cursor.x}
                    y1={cursor.y}
                    x2={points[0].x}
                    y2={points[0].y}
                    stroke="#22c55e"
                    strokeWidth={1}
                    strokeDasharray="2 4"
                    opacity={0.5}
                  />
                )}
              </>
            )}
            {points.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={4}
                fill={isDrawing ? '#22c55e' : (cropInvert ? '#ef4444' : '#22c55e')}
                stroke="#0a0a0a"
                strokeWidth={1.5}
              />
            ))}
          </svg>
        );
      })()}

      {/* Rect crop overlay — a screen-space rectangle drag that works from
          any view. While drawing, mousedown sets one corner and the drag
          rubber-bands the opposite corner; mouseup freezes the four corners
          into cropPolygon (camera snapshotted), so the backend / predicate
          path is identical to the polygon lasso. */}
      {editMode === 'crop' && cropMode === 'rect' && (cropDrawState === 'drawing-rect' || cropPolygon) && (() => {
        const isDrawing = cropDrawState === 'drawing-rect';
        // Read the tick so the rubber-band re-renders as the cursor moves.
        void rectDragTick;

        // Build the 4 corners (TL, TR, BR, BL) of the axis-aligned rect
        // spanned by two diagonal canvas-pixel points.
        const cornersOf = (a: { x: number; y: number }, b: { x: number; y: number }) => {
          const minX = Math.min(a.x, b.x);
          const minY = Math.min(a.y, b.y);
          const maxX = Math.max(a.x, b.x);
          const maxY = Math.max(a.y, b.y);
          return [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY },
          ];
        };

        let corners: { x: number; y: number }[] | null = null;
        if (isDrawing && rectDragStart && rectDragCurrentRef.current) {
          corners = cornersOf(rectDragStart, rectDragCurrentRef.current);
        } else if (!isDrawing && cropPolygon && cropPolygon.points.length >= 3) {
          corners = cropPolygon.points;
        }

        const commit = (start: { x: number; y: number }, end: { x: number; y: number }) => {
          // Ignore zero-area drags (a click without movement).
          if (Math.abs(end.x - start.x) < 3 || Math.abs(end.y - start.y) < 3) {
            setRectDragStart(null);
            rectDragCurrentRef.current = null;
            setCropDrawState('idle');
            return;
          }
          if (polygonCameraRef.current && polygonCanvasSizeRef.current) {
            const region = polygonRegionFromCamera(
              cornersOf(start, end),
              polygonCameraRef.current,
              polygonCanvasSizeRef.current,
              false,
            );
            setCropPolygon({
              points: region.points,
              projection: region.projection,
              view: region.view,
              canvasSize: region.canvasSize,
            });
          }
          setRectDragStart(null);
          rectDragCurrentRef.current = null;
          setCropDrawState('idle');
        };

        const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
          if (!isDrawing || e.button !== 0) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          setRectDragStart(p);
          rectDragCurrentRef.current = p;
          setRectDragTick(t => t + 1);
        };
        const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
          if (!isDrawing || !rectDragStart) return;
          const rect = e.currentTarget.getBoundingClientRect();
          rectDragCurrentRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          setRectDragTick(t => t + 1);
        };
        const handleMouseUp = (e: React.MouseEvent<SVGSVGElement>) => {
          if (!isDrawing || e.button !== 0 || !rectDragStart) return;
          const rect = e.currentTarget.getBoundingClientRect();
          commit(rectDragStart, { x: e.clientX - rect.left, y: e.clientY - rect.top });
        };

        const polyPoints = corners ? corners.map(p => `${p.x},${p.y}`).join(' ') : '';
        const strokeColor = cropInvert ? '#ef4444' : '#22c55e';
        const fillColor = cropInvert ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)';

        return (
          <svg
            data-testid="crop-rect-overlay"
            className="absolute inset-0 z-10"
            width="100%"
            height="100%"
            style={{
              pointerEvents: isDrawing ? 'auto' : 'none',
              cursor: isDrawing ? 'crosshair' : 'default',
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            {corners && (
              <polygon
                points={polyPoints}
                fill={fillColor}
                stroke={strokeColor}
                strokeWidth={2}
                strokeDasharray={isDrawing ? '6 4' : undefined}
              />
            )}
            {corners && !isDrawing && corners.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={4}
                fill={strokeColor}
                stroke="#0a0a0a"
                strokeWidth={1.5}
              />
            ))}
          </svg>
        );
      })()}

      {/* Crop apply status indicator. Mirrors the Helios pill but without a
          cancel button — the crop apply isn't cancelable today. Shown while
          the backend crop round-trip runs (octree re-conversion is ~15-20s);
          the to-be-cropped points stay hidden via isApplyingCrop. */}
      {isApplyingCrop && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-neutral-800/80 backdrop-blur-sm rounded-full border border-neutral-700/50 z-20">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="text-[11px] text-neutral-300">Cropping…</span>
        </div>
      )}

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

      {/* Modal transform indicator (Blender-style T/S) */}
      {transformModal && (() => {
        const axisLabel: Record<typeof transformModal.axis, string> = {
          free: 'free',
          x: 'X',
          y: 'Y',
          z: 'Z',
          yz: 'YZ',
          xz: 'XZ',
          xy: 'XY',
        };
        const opLabel = transformModal.op === 'translate' ? 'Translate' : 'Scale';
        const color = transformModal.op === 'translate' ? 'bg-blue-500' : 'bg-amber-500';
        return (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-neutral-800/90 backdrop-blur-sm rounded-full border border-neutral-700/50 z-30 shadow-lg">
            <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
            <span className="text-[11px] text-neutral-200 font-medium">{opLabel}</span>
            <span className="text-[11px] text-neutral-400">·</span>
            <span className="text-[11px] text-neutral-300 font-mono">{axisLabel[transformModal.axis]}</span>
            {transformModal.numericBuffer && (
              <span className="text-[11px] text-amber-300 font-mono bg-neutral-900/70 px-1.5 py-0.5 rounded">
                {transformModal.numericBuffer}
              </span>
            )}
            <span className="text-[10px] text-neutral-500 ml-2">type value · click / ↵ confirm · esc cancel</span>
          </div>
        );
      })()}

      {/* Right Side Panels Container */}
      <div className="absolute top-4 right-4 flex flex-col gap-2 max-h-[calc(100vh-100px)]">
        {/* Unified Scans Panel — shows every scan whether it has data, params,
            or both. Per-row actions adapt to which fields are present. */}
        <div data-testid="scans-panel" className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-64 max-h-[40vh] flex flex-col">
          <div className="p-2 border-b border-neutral-700 flex items-center gap-2">
            <Layers className="w-4 h-4 text-neutral-400" />
            <span className="text-xs font-medium text-neutral-300 flex-1">Scans</span>
            <button
              data-testid="scan-add-button"
              onClick={openAddScanPopup}
              className="p-1 hover:bg-neutral-700 rounded"
              title="Add scan"
            >
              <Plus className="w-3 h-3 text-neutral-300" />
            </button>
            <button onClick={onSelectAll} className="p-1 hover:bg-neutral-700 rounded" title="Select All">
              <CheckSquare className="w-3 h-3 text-neutral-400" />
            </button>
            <button onClick={onDeselectAll} className="p-1 hover:bg-neutral-700 rounded" title="Deselect All">
              <XSquare className="w-3 h-3 text-neutral-400" />
            </button>
          </div>
          <div className="overflow-y-auto flex-1 p-1">
            {scansAll.map(scan => {
              const isSelected = selectedScanIds.has(scan.id);
              const scanHasData = hasData(scan);
              const scanHasParams = hasParams(scan);
              const editState = scanHasData ? getEditState(scan.id) : null;
              const hasCloudEdits = editState
                ? editState.translation.x !== 0 || editState.translation.y !== 0 || editState.translation.z !== 0 || editState.erasedIndices.size > 0
                : false;
              const effectivePointCount = scanHasData && editState
                ? scan.data.pointCount - editState.erasedIndices.size
                : 0;
              const displayName = scanDisplayName(scan);
              const isExpanded = expandedScanIds.has(scan.id);

              // Build subtitle text based on which fields the scan carries.
              const originText = scanHasParams
                ? `(${scan.params.origin.x.toFixed(2)}, ${scan.params.origin.y.toFixed(2)}, ${scan.params.origin.z.toFixed(2)})`
                : null;
              let subtitle: React.ReactNode;
              if (scanHasData && scanHasParams) {
                subtitle = (<>
                  {effectivePointCount.toLocaleString()} pts
                  {hasCloudEdits && <span className="ml-1 text-amber-400">*</span>}
                  <span className="mx-1">·</span>
                  <span className="font-mono">origin {originText}</span>
                </>);
              } else if (scanHasData) {
                subtitle = (<>
                  {effectivePointCount.toLocaleString()} pts
                  {hasCloudEdits && <span className="ml-1 text-amber-400">*</span>}
                </>);
              } else {
                subtitle = (<>
                  params <span className="mx-1">·</span>
                  <span className="font-mono">origin {originText}</span>
                </>);
              }

              return (
                <div key={scan.id} className="mb-0.5">
                  <div
                    data-testid="scan-row"
                    data-scan-id={scan.id}
                    data-scan-name={displayName}
                    data-point-count={scanHasData ? effectivePointCount : 0}
                    data-has-data={scanHasData ? 'true' : 'false'}
                    data-has-params={scanHasParams ? 'true' : 'false'}
                    data-octree={scanHasData && scan.data?.octree ? 'true' : 'false'}
                    data-selected={isSelected ? 'true' : 'false'}
                    onClick={(e) => {
                      onToggleSelection(scan.id, e.shiftKey || e.ctrlKey || e.metaKey);
                      if (scanHasParams) {
                        setSelectedMarkerScanId(prev => prev === scan.id ? null : scan.id);
                      }
                    }}
                    className={`flex items-center gap-1.5 p-2 rounded cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-600/30 border border-blue-500/50' : 'hover:bg-neutral-700/50'
                    }`}
                  >
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: scan.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-neutral-200 truncate" data-testid="scan-row-name" title={displayName}>{displayName}</div>
                      <div className="text-[10px] text-neutral-500" data-testid="scan-row-subtitle">
                        {subtitle}
                      </div>
                    </div>
                    {/* Expand chevron — only useful when there's something to show. */}
                    {scanHasParams && (
                      <button
                        data-testid={`scan-expand-${scan.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedScanIds(prev => {
                            const next = new Set(prev);
                            if (next.has(scan.id)) next.delete(scan.id); else next.add(scan.id);
                            return next;
                          });
                        }}
                        className="p-1 hover:bg-neutral-600 rounded"
                        title={isExpanded ? 'Collapse' : 'Expand'}
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3 h-3 text-neutral-400" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-neutral-400" />
                        )}
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); onToggleVisibility(scan.id); }}
                      className="p-1 hover:bg-neutral-600 rounded"
                      title={scan.visible ? 'Hide' : 'Show'}
                    >
                      {scan.visible ? (
                        <Eye className="w-3 h-3 text-neutral-400" />
                      ) : (
                        <EyeOff className="w-3 h-3 text-neutral-600" />
                      )}
                    </button>
                    {!scanHasData && (
                      <button
                        data-testid={`scan-attach-data-${scan.id}`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          const picked = await window.electronAPI.dialog.open({
                            title: 'Attach point cloud data',
                            filters: [{ name: 'Point cloud', extensions: ['las', 'laz', 'ply', 'pcd', 'xyz', 'txt', 'csv', 'pts', 'asc'] }],
                          });
                          if (!picked) return;
                          const path = Array.isArray(picked) ? picked[0] : picked;
                          // Show the progress modal while the backend parses —
                          // a large scan can take 15-30s and otherwise the UI
                          // would sit idle until the points appear.
                          setBulkImportProgress({
                            current: 1,
                            total: 1,
                            label: `Loading ${path.split(/[\\/]/).pop()}`,
                          });
                          try {
                            const data = await parsePointCloudFromPath(path);
                            onUpdateScanData(scan.id, data);
                            showToast({ title: `Attached ${data.pointCount.toLocaleString()} points to ${scan.label}`, type: 'success' });
                          } catch (err) {
                            const msg = err instanceof Error ? err.message : 'Failed to read file';
                            showToast({ title: `Could not attach point cloud: ${msg}`, type: 'error' });
                          } finally {
                            setBulkImportProgress(null);
                          }
                        }}
                        className="p-1 hover:bg-neutral-600 rounded"
                        title="Attach point cloud data…"
                      >
                        <FileUp className="w-3 h-3 text-neutral-400" />
                      </button>
                    )}
                    {!scanHasParams && (
                      <button
                        data-testid={`scan-attach-params-${scan.id}`}
                        onClick={(e) => { e.stopPropagation(); openAddParamsPopupFor(scan); }}
                        className="p-1 hover:bg-neutral-600 rounded"
                        title="Add scan parameters…"
                      >
                        <Radio className="w-3 h-3 text-neutral-400" />
                      </button>
                    )}
                    {scanHasParams && (
                      <button
                        data-testid={`scan-edit-${scan.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setScanPopupState({ kind: 'edit', id: scan.id });
                        }}
                        className="p-1 hover:bg-neutral-600 rounded"
                        title="Edit scan parameters"
                      >
                        <Pencil className="w-3 h-3 text-neutral-400" />
                      </button>
                    )}
                    <button
                      data-testid={`scan-delete-${scan.id}`}
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ type: 'cloud', id: scan.id, name: displayName }); }}
                      className="p-1 hover:bg-red-600/30 rounded"
                      title="Remove"
                    >
                      <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
                    </button>
                  </div>
                  {/* Expanded parameters block. */}
                  {isExpanded && scanHasParams && (
                    <div data-testid={`scan-expanded-${scan.id}`} className="pl-6 pr-2 pb-2 pt-1 text-[10px] text-neutral-400 space-y-0.5">
                      <div className="grid grid-cols-3 gap-x-2">
                        <div>x: <span className="font-mono text-neutral-300">{scan.params.origin.x.toFixed(3)}</span></div>
                        <div>y: <span className="font-mono text-neutral-300">{scan.params.origin.y.toFixed(3)}</span></div>
                        <div>z: <span className="font-mono text-neutral-300">{scan.params.origin.z.toFixed(3)}</span></div>
                      </div>
                      <div>
                        size: <span className="font-mono text-neutral-300">{scan.params.zenithPoints} × {scan.params.azimuthPoints}</span>
                        <span className="mx-1">·</span>
                        sweep: <span className="font-mono text-neutral-300">θ {scan.params.zenithMinDeg.toFixed(0)}–{scan.params.zenithMaxDeg.toFixed(0)}° · φ {scan.params.azimuthMinDeg.toFixed(0)}–{scan.params.azimuthMaxDeg.toFixed(0)}°</span>
                      </div>
                      <div>
                        return: <span className="text-neutral-300">{scan.params.returnType}</span>
                        {scan.params.returnType === 'multi' && (
                          <>
                            <span className="mx-1">·</span>
                            beam Ø <span className="font-mono text-neutral-300">{scan.params.beamExitDiameterM} m</span>
                            <span className="mx-1">·</span>
                            div <span className="font-mono text-neutral-300">{scan.params.beamDivergenceMrad} mrad</span>
                          </>
                        )}
                      </div>
                    </div>
                  )}
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
                  ? (mesh.plantCanopy
                      ? `${mesh.plantType} canopy ${mesh.plantCanopy.countX}×${mesh.plantCanopy.countY} (${mesh.plantAge}d)`
                      : `${mesh.plantType} (${mesh.plantAge}d)`)
                  : (sourceCloud?.data.fileName || 'Mesh');
                return (
                  <div
                    key={mesh.id}
                    data-testid="mesh-row"
                    data-mesh-name={displayName}
                    data-triangle-count={mesh.data.triangleCount}
                    data-is-plant={mesh.isPlant ? 'true' : 'false'}
                    data-textured-materials={mesh.plantMaterials?.filter(m => m.textureData).length ?? 0}
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

        {/* The standalone Scan Locations panel was unified into the Scans
            panel above — every entry there can hold data, params, or both. */}
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
          <div className="grid grid-cols-3 gap-1">
            <button
              onClick={() => handleCreateShape('voxel')}
              className="p-2 rounded transition-colors hover:bg-cyan-600 hover:text-white bg-neutral-700"
              title="Create Voxel (Cube)"
            >
              <Box className="w-4 h-4 text-neutral-300" />
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
            <button
              data-testid="tool-add-scan"
              onClick={openAddScanPopup}
              className="p-2 rounded transition-colors hover:bg-neutral-600 bg-neutral-700"
              title="Add Scan"
            >
              <Radio className="w-4 h-4 text-neutral-300" />
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
              {/* Multi-Cloud Selection Tools - Move to Origin, Crop, Alignment, Helios */}
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
                  {/* Crop — same world-space region applied across every
                      selected scan. */}
                  <button
                    data-testid="tool-crop-multi"
                    onClick={toggleCropMode}
                    className={`p-2 rounded transition-colors ${editMode === 'crop' ? 'bg-blue-600 text-white' : 'hover:bg-neutral-700'}`}
                    title={`Crop ${selectedIds.size} scans`}
                  >
                    <Crop className={`w-4 h-4 ${editMode === 'crop' ? 'text-white' : 'text-neutral-300'}`} />
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
                  {/* Triangulate (Helios - multi-scan). Disabled when any
                      selected data-bearing scan lacks scan parameters
                      (origin), since Helios needs per-scan origins to
                      reconstruct pulse directions. */}
                  {(() => {
                    const selectedDataScans = scans.filter(s => selectedScanIds.has(s.id) && hasData(s));
                    const heliosReady = selectedDataScans.length >= 2 && selectedDataScans.every(hasParams);
                    const tooltip = heliosReady
                      ? 'Triangulate (Helios)'
                      : 'Requires scan parameters (origin, etc.) — edit this scan to add them.';
                    return (
                      <button
                        data-testid="tool-triangulate-helios"
                        onClick={() => {
                          if (!heliosReady) return;
                          closeAllToolPanels();
                          setShowHeliosPopup(true);
                        }}
                        disabled={!heliosReady}
                        className={`p-2 rounded transition-colors ${
                          !heliosReady
                            ? 'opacity-50 cursor-not-allowed'
                            : showHeliosPopup ? 'bg-green-600 text-white' : 'hover:bg-neutral-700'
                        }`}
                        title={tooltip}
                      >
                        <Triangle className={`w-4 h-4 ${showHeliosPopup ? 'text-white' : 'text-neutral-300'}`} />
                      </button>
                    );
                  })()}
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
                  {/* 3. Crop — works for one OR many selected scans. When
                       multiple are selected the crop region lives in
                       world space and applies uniformly across them. */}
                  <button
                    data-testid="tool-crop"
                    onClick={toggleCropMode}
                    className={`p-2 rounded transition-colors ${editMode === 'crop' ? 'bg-blue-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Crop"
                  >
                    <Crop className={`w-4 h-4 ${editMode === 'crop' ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                  {/* 4. Filter (single cloud only) */}
                  {selectedIds.size === 1 && (
                    <button
                      data-testid="tool-filter"
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
                  {/* 8b. Segment Ground (single cloud only) */}
                  <button
                    data-testid="tool-ground-segment"
                    onClick={() => {
                      if (showGroundSegmentPanel) {
                        setShowGroundSegmentPanel(false);
                      } else {
                        closeAllToolPanels('ground-segment');
                        setShowGroundSegmentPanel(true);
                      }
                    }}
                    className={`p-2 rounded transition-colors ${showGroundSegmentPanel ? 'bg-green-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Segment ground points"
                    disabled={selectedIds.size !== 1}
                  >
                    <Layers className={`w-4 h-4 ${showGroundSegmentPanel ? 'text-white' : selectedIds.size !== 1 ? 'text-neutral-500' : 'text-neutral-300'}`} />
                  </button>
                  {/* 8c. Segment Trees (single cloud only) */}
                  <button
                    data-testid="tool-tree-segment"
                    onClick={() => {
                      if (showTreeSegmentPanel) {
                        setShowTreeSegmentPanel(false);
                        setTreeSeedMode(false);
                      } else {
                        closeAllToolPanels('tree-segment');
                        setShowTreeSegmentPanel(true);
                      }
                    }}
                    className={`p-2 rounded transition-colors ${showTreeSegmentPanel ? 'bg-green-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Segment individual trees"
                    disabled={selectedIds.size !== 1}
                  >
                    <Sprout className={`w-4 h-4 ${showTreeSegmentPanel ? 'text-white' : selectedIds.size !== 1 ? 'text-neutral-500' : 'text-neutral-300'}`} />
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
                  {/* 1. Transform (position + rotation + scale) */}
                  <button
                    onClick={() => setShowResizePanel(!showResizePanel)}
                    className={`p-2 rounded transition-colors ${showResizePanel ? 'bg-blue-600 text-white' : 'hover:bg-neutral-700'}`}
                    title="Transform"
                  >
                    <Maximize2 className={`w-4 h-4 ${showResizePanel ? 'text-white' : 'text-neutral-300'}`} />
                  </button>
                  {/* 2. Sample to Point Cloud */}
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

      {/* Crop Panel — single panel handles Box, Rect, and Polygon modes
          and applies to every selected scan when N > 1. */}
      {editMode === 'crop' && selectedIds.size > 0 && (() => {
        const closeCropPanel = () => {
          setEditMode('none');
          setCropDrawState('idle');
          setPolygonInProgress([]);
          setRectDragStart(null);
          rectDragCurrentRef.current = null;
        };
        const resetWorldBox = () => {
          const initial = worldBoundsUnion(
            Array.from(selectedIds)
              .map(id => clouds.find(c => c.id === id))
              .filter((c): c is PointCloudEntry => !!c)
              .map(c => ({
                bounds: {
                  min: { x: c.data.bounds.min.x, y: c.data.bounds.min.y, z: c.data.bounds.min.z },
                  max: { x: c.data.bounds.max.x, y: c.data.bounds.max.y, z: c.data.bounds.max.z },
                },
                translation: getEditState(c.id).translation,
              })),
          );
          if (initial) setCropBox(initial);
        };

        const cropBoxMinStr = cropBox
          ? `${cropBox.min.x.toFixed(3)},${cropBox.min.y.toFixed(3)},${cropBox.min.z.toFixed(3)}`
          : '';
        const cropBoxMaxStr = cropBox
          ? `${cropBox.max.x.toFixed(3)},${cropBox.max.y.toFixed(3)},${cropBox.max.z.toFixed(3)}`
          : '';
        return (
          <div
            data-testid="crop-panel"
            data-selection-count={selectedIds.size}
            data-crop-mode={cropMode}
            data-crop-min={cropBoxMinStr}
            data-crop-max={cropBoxMaxStr}
            // Projection kind of a committed screen-space region (rect /
            // polygon). An orthographic projection matrix has m[15]=1, m[11]=0;
            // a perspective one has m[15]=0, m[11]=-1. The Rect tool draws
            // orthographically so its extrusion is a true prism — this exposes
            // that for the trapezoid-regression test. Empty until committed.
            data-crop-projection-kind={
              cropPolygon
                ? (Math.abs(cropPolygon.projection[15] - 1) < 1e-6 &&
                   Math.abs(cropPolygon.projection[11]) < 1e-6
                    ? 'orthographic'
                    : 'perspective')
                : ''
            }
            // z-20 keeps the panel above the polygon lasso overlay (z-10),
            // which now fills the whole viewport while drawing — without
            // this the transparent SVG would swallow clicks on the panel's
            // controls (shape toggle, Keep In/Out, Apply, dim inputs).
            className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56 z-20"
          >
            <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Crop className="w-3 h-3" />
                Crop Region
              </span>
              <button
                data-testid="crop-close"
                onClick={closeCropPanel}
                className="p-1 rounded hover:bg-neutral-700 transition-colors"
                aria-label="Close"
                title="Close (don't apply crop)"
              >
                <X className="w-4 h-4 text-neutral-400" />
              </button>
            </div>

            {selectedIds.size > 1 && (
              <div data-testid="crop-multi-hint" className="text-[10px] text-blue-300 text-center mb-2 py-1 bg-blue-900/20 rounded">
                Applies to {selectedIds.size} scans
              </div>
            )}

            {/* Shape: Box (world AABB) vs Rect (screen-space rectangle, any
                view) vs Polygon (freeform lasso, any view). */}
            <div className="mb-3 p-2 bg-neutral-900/50 rounded">
              <div className="text-[10px] text-neutral-400 mb-2">Shape</div>
              <div className="flex gap-1">
                <button
                  data-testid="crop-shape-box"
                  onClick={() => {
                    setCropMode('box');
                    setCropDrawState('idle');
                    setPolygonInProgress([]);
                    setCropPolygon(null);
                    setRectDragStart(null);
                    rectDragCurrentRef.current = null;
                    if (!cropBox) resetWorldBox();
                  }}
                  className={`flex-1 px-2 py-1.5 text-xs rounded ${cropMode === 'box' ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                >
                  Box
                </button>
                <button
                  data-testid="crop-shape-rect"
                  onClick={() => {
                    setCropMode('rect');
                    setCropDrawState('drawing-rect');
                    setPolygonInProgress([]);
                    setCropPolygon(null);
                    setRectDragStart(null);
                    rectDragCurrentRef.current = null;
                  }}
                  className={`flex-1 px-2 py-1.5 text-xs rounded ${cropMode === 'rect' ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                >
                  Rect
                </button>
                <button
                  data-testid="crop-shape-polygon"
                  onClick={() => {
                    setCropMode('polygon');
                    setCropDrawState('drawing-polygon');
                    setPolygonInProgress([]);
                    setCropPolygon(null);
                    setRectDragStart(null);
                    rectDragCurrentRef.current = null;
                  }}
                  className={`flex-1 px-2 py-1.5 text-xs rounded ${cropMode === 'polygon' ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                >
                  Polygon
                </button>
              </div>
            </div>

            {/* Mode: Keep Inside / Keep Outside / Segment.
                These are mutually exclusive. Internally they map onto two
                states: cropInvert picks which half the original keeps, and
                cropSegment decides whether the other half is discarded or
                spun off as a new cloud. Segment keeps the in-region points in
                the original and the out-of-region points in the new cloud. */}
            <div className="mb-3 p-2 bg-neutral-900/50 rounded">
              <div className="text-[10px] text-neutral-400 mb-2">Mode</div>
              <div className="flex gap-1">
                <button
                  data-testid="crop-mode-inside"
                  aria-pressed={!cropInvert && !cropSegment}
                  onClick={() => { setCropInvert(false); setCropSegment(false); }}
                  className={`flex-1 px-2 py-1.5 text-xs rounded ${!cropInvert && !cropSegment ? 'bg-green-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                >
                  Keep Inside
                </button>
                <button
                  data-testid="crop-mode-outside"
                  aria-pressed={cropInvert && !cropSegment}
                  onClick={() => { setCropInvert(true); setCropSegment(false); }}
                  className={`flex-1 px-2 py-1.5 text-xs rounded ${cropInvert && !cropSegment ? 'bg-red-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                >
                  Keep Outside
                </button>
                <button
                  data-testid="crop-mode-segment"
                  aria-pressed={cropSegment}
                  onClick={() => { setCropInvert(false); setCropSegment(true); }}
                  className={`flex-1 px-2 py-1.5 text-xs rounded ${cropSegment ? 'bg-amber-500 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                >
                  Segment
                </button>
              </div>
              <div className="text-[10px] text-neutral-500 mt-1.5 leading-tight">
                {cropSegment
                  ? 'Splits in two: original keeps the in-region points, a new cloud gets the rest.'
                  : 'Cropped-out points are discarded.'}
              </div>
            </div>

            {cropMode === 'box' && cropBox && (
              <>
                {/* Box dimensions */}
                <div className="mb-3 p-2 bg-neutral-900/50 rounded">
                  <div className="text-[10px] text-neutral-400 mb-2">Dimensions</div>
                  <div className="grid grid-cols-3 gap-1">
                    {(['x', 'y', 'z'] as const).map((axisKey) => {
                      const size = cropBox.max[axisKey] - cropBox.min[axisKey];
                      return (
                        <div key={axisKey} className="flex flex-col">
                          <label className="text-[9px] text-neutral-500 mb-0.5">{axisKey.toUpperCase()}</label>
                          <DebouncedNumberInput
                            data-testid={`crop-dim-${axisKey}`}
                            step={0.1}
                            value={parseFloat(size.toFixed(2))}
                            onCommit={(newSize) => {
                              setCropBox(prev => {
                                if (!prev) return prev;
                                const center = (prev.min[axisKey] + prev.max[axisKey]) / 2;
                                return {
                                  min: { ...prev.min, [axisKey]: center - newSize / 2 },
                                  max: { ...prev.max, [axisKey]: center + newSize / 2 },
                                };
                              });
                            }}
                            className="w-full px-1 py-0.5 text-[10px] bg-neutral-700 border border-neutral-600 rounded text-white text-center"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
                {/* Center position */}
                <div className="mb-3 p-2 bg-neutral-900/50 rounded">
                  <div className="text-[10px] text-neutral-400 mb-2">Center Position</div>
                  <div className="grid grid-cols-3 gap-1">
                    {(['x', 'y', 'z'] as const).map((axisKey) => {
                      const center = (cropBox.max[axisKey] + cropBox.min[axisKey]) / 2;
                      return (
                        <div key={axisKey} className="flex flex-col">
                          <label className="text-[9px] text-neutral-500 mb-0.5">{axisKey.toUpperCase()}</label>
                          <DebouncedNumberInput
                            data-testid={`crop-center-${axisKey}`}
                            step={0.1}
                            value={parseFloat(center.toFixed(2))}
                            onCommit={(newCenter) => {
                              setCropBox(prev => {
                                if (!prev) return prev;
                                const halfSize = (prev.max[axisKey] - prev.min[axisKey]) / 2;
                                return {
                                  min: { ...prev.min, [axisKey]: newCenter - halfSize },
                                  max: { ...prev.max, [axisKey]: newCenter + halfSize },
                                };
                              });
                            }}
                            className="w-full px-1 py-0.5 text-[10px] bg-neutral-700 border border-neutral-600 rounded text-white text-center"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
                <button
                  data-testid="crop-draw-box"
                  onClick={() => {
                    boxDrawFirstCornerRef.current = null;
                    boxDrawCursorRef.current = null;
                    setCropDrawState('awaiting-box-corner-1');
                  }}
                  className={`w-full px-2 py-1.5 text-xs rounded mb-2 ${cropDrawState === 'awaiting-box-corner-1' || cropDrawState === 'awaiting-box-corner-2' ? 'bg-amber-600 text-white' : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'}`}
                >
                  {cropDrawState === 'awaiting-box-corner-1'
                    ? 'Click first corner on ground…'
                    : cropDrawState === 'awaiting-box-corner-2'
                      ? 'Click second corner on ground…'
                      : 'Draw box in viewport'}
                </button>
                <button
                  onClick={resetWorldBox}
                  className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded mb-2"
                >
                  Reset Crop Box
                </button>
              </>
            )}

            {cropMode === 'polygon' && (
              <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-300">
                {cropDrawState === 'drawing-polygon' ? (
                  <>
                    <div className="font-medium text-neutral-200 mb-1">Drawing polygon</div>
                    Click in the viewport to add vertices. Right-click or Backspace removes the last. Press Enter to close, Esc to cancel.
                    <div className="mt-2 text-neutral-400">Vertices: {polygonInProgress.length}</div>
                  </>
                ) : cropPolygon ? (
                  <>
                    <div className="font-medium text-neutral-200 mb-1">Polygon ({cropPolygon.points.length} vertices)</div>
                    Preview shown above. Press Enter to apply, or click below to redraw.
                    <button
                      onClick={() => {
                        setCropPolygon(null);
                        setPolygonInProgress([]);
                        setCropDrawState('drawing-polygon');
                      }}
                      className="mt-2 w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200"
                    >
                      Redraw polygon
                    </button>
                  </>
                ) : (
                  <>
                    No polygon yet.
                    <button
                      onClick={() => {
                        setPolygonInProgress([]);
                        setCropDrawState('drawing-polygon');
                      }}
                      className="mt-2 w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200"
                    >
                      Start drawing
                    </button>
                  </>
                )}
              </div>
            )}

            {cropMode === 'rect' && (
              <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-300">
                {cropDrawState === 'drawing-rect' ? (
                  <>
                    <div className="font-medium text-neutral-200 mb-1">Drawing rectangle</div>
                    Drag in the viewport to draw a rectangle from any angle. Esc to cancel.
                  </>
                ) : cropPolygon ? (
                  <>
                    <div className="font-medium text-neutral-200 mb-1">Rectangle ready</div>
                    Preview shown above. Press Apply, or click below to redraw.
                    <button
                      onClick={() => {
                        setCropPolygon(null);
                        setRectDragStart(null);
                        rectDragCurrentRef.current = null;
                        setCropDrawState('drawing-rect');
                      }}
                      className="mt-2 w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200"
                    >
                      Redraw rectangle
                    </button>
                  </>
                ) : (
                  <>
                    No rectangle yet.
                    <button
                      onClick={() => {
                        setRectDragStart(null);
                        rectDragCurrentRef.current = null;
                        setCropDrawState('drawing-rect');
                      }}
                      className="mt-2 w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded text-neutral-200"
                    >
                      Start drawing
                    </button>
                  </>
                )}
              </div>
            )}

            <button
              data-testid="crop-apply"
              onClick={handleApplyCrop}
              disabled={
                (cropMode === 'box' && !cropBox) ||
                ((cropMode === 'polygon' || cropMode === 'rect') && !cropPolygon)
              }
              className="w-full px-2 py-1.5 mt-1 text-xs font-medium rounded bg-green-600 hover:bg-green-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white disabled:cursor-not-allowed transition-colors"
            >
              {cropSegment ? 'Segment' : 'Apply crop to'} {selectedIds.size} scan{selectedIds.size === 1 ? '' : 's'}
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
        // Octree-backed clouds hold no flat `scalarFields`; their imported
        // scalar attributes live in `octree.attributeRanges` (keyed by on-disk
        // slug). Mirror the Color-by dropdown: reuse octreeScalarFieldOptions
        // so builtin LAS attributes are filtered out, and read each scalar's
        // range from attributeRanges[slug].{min,max}[0]. The `scalar:<slug>`
        // value encoding matches the flat path, so getFieldFilter/applyFilter/
        // removeFilter and the backend slug lookup all work unchanged.
        if (data.octree?.attributeRanges) {
          const ranges = data.octree.attributeRanges;
          for (const { value: slug, label } of octreeScalarFieldOptions(ranges, data.octree.attributeLabels)) {
            const r = ranges[slug];
            availableFields.push({
              value: `scalar:${slug}`,
              label,
              bounds: { min: r?.min?.[0] ?? 0, max: r?.max?.[0] ?? 0 },
            });
          }
        }

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
        // Commit the selected field's range into cloudFilters. Called live from
        // the Min/Max inputs (no Apply button) so flat clouds preview as you
        // type; the values are passed in explicitly because the pending* state
        // hasn't re-rendered yet inside the input's onChange.
        const commitFilter = (minStr: string, maxStr: string) => {
          if (!selectedFilterField) return;
          const min = parseFloat(minStr);
          const max = parseFloat(maxStr);
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
                data-testid="filter-field-select"
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
                      data-testid="filter-min-input"
                      type="number"
                      value={pendingFilterMin}
                      onChange={(e) => { setPendingFilterMin(e.target.value); commitFilter(e.target.value, pendingFilterMax); }}
                      step="any"
                      className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] text-neutral-400 block mb-1">Max</label>
                    <input
                      data-testid="filter-max-input"
                      type="number"
                      value={pendingFilterMax}
                      onChange={(e) => { setPendingFilterMax(e.target.value); commitFilter(pendingFilterMin, e.target.value); }}
                      step="any"
                      className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
                    />
                  </div>
                </div>
                {currentFilter?.enabled && (
                  <button
                    onClick={removeFilter}
                    className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
                  >
                    Remove this filter
                  </button>
                )}
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

            {/* Commit actions: remove the out-of-range points, or segment the
                cloud into in-range + out-of-range (keeps both). */}
            {hasAnyFilter && (
              <div className="flex flex-col gap-2">
                <button
                  data-testid="filter-remove"
                  onClick={handleApplyFilterPermanently}
                  className="w-full px-2 py-1.5 text-xs bg-red-600 hover:bg-red-500 rounded text-white"
                >
                  Filter (remove points)
                </button>
                <button
                  data-testid="filter-segment"
                  onClick={handleSegmentFilter}
                  className="w-full px-2 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 rounded text-white"
                >
                  Segment (split into two clouds)
                </button>
              </div>
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

      {/* Settings Panel (global) */}
      {showSettingsPanel && (
        <div data-testid="settings-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 z-30">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <Settings className="w-3 h-3" />
              Settings
            </div>
            <button
              onClick={() => setShowSettingsPanel(false)}
              className="p-1 hover:bg-neutral-700 rounded"
            >
              <X className="w-3 h-3 text-neutral-400" />
            </button>
          </div>

          <div className="mb-2">
            <label className="text-[10px] text-neutral-400 block mb-1">
              Triangulate max points
            </label>
            <input
              data-testid="settings-triangulate-max-points"
              type="number"
              min={1000}
              step={100000}
              value={triangulateMaxPoints}
              onChange={(e) => setTriangulateMaxPoints(parseInt(e.target.value) || 0)}
              onBlur={(e) => commitTriangulateMaxPoints(parseInt(e.target.value) || 5_000_000)}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
            />
            <div className="text-[9px] text-neutral-500 mt-1 leading-snug">
              Streamed (octree) clouds are downsampled to this many points before
              triangulation to bound memory. You'll be warned when a cloud is
              downsampled.
            </div>
          </div>
        </div>
      )}

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

      {/* Ground Segmentation Panel */}
      {showGroundSegmentPanel && selectedIds.size === 1 && (
        <div data-testid="ground-segment-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <Layers className="w-3 h-3" />
              Ground Segmentation
            </div>
            <button
              onClick={() => setShowGroundSegmentPanel(false)}
              className="p-1 hover:bg-neutral-700 rounded"
            >
              <X className="w-3 h-3 text-neutral-400" />
            </button>
          </div>

          <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
            Cloth Simulation Filter separates ground from plant points. Lower
            tolerance keeps low plant material; higher merges it into ground.
          </div>

          {/* Cloth resolution */}
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">Cloth resolution (m)</label>
            <DebouncedNumberInput
              data-testid="ground-cloth-resolution"
              value={groundClothResolution}
              onCommit={(n) => setGroundClothResolution(n)}
              min={0.005}
              max={2}
              step={0.01}
              disabled={groundSegmentInProgress}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
            />
          </div>

          {/* Ground tolerance (class threshold) */}
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">Ground tolerance (m)</label>
            <DebouncedNumberInput
              data-testid="ground-class-threshold"
              value={groundClassThreshold}
              onCommit={(n) => setGroundClassThreshold(n)}
              min={0.001}
              max={1}
              step={0.01}
              disabled={groundSegmentInProgress}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
            />
          </div>

          {/* Rigidness */}
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">Rigidness (1–3)</label>
            <DebouncedNumberInput
              data-testid="ground-rigidness"
              value={groundRigidness}
              onCommit={(n) => setGroundRigidness(Math.max(1, Math.min(3, Math.round(n))))}
              min={1}
              max={3}
              step={1}
              disabled={groundSegmentInProgress}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
            />
          </div>

          {/* Split checkbox */}
          <label className="flex items-center gap-2 text-[10px] text-neutral-400 mb-3">
            <input
              data-testid="ground-split-clouds"
              type="checkbox"
              checked={groundSplitClouds}
              onChange={(e) => setGroundSplitClouds(e.target.checked)}
              className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
              disabled={groundSegmentInProgress}
            />
            Split into ground + plant clouds
          </label>

          {groundSegmentError && (
            <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
              {groundSegmentError}
            </div>
          )}

          <button
            data-testid="ground-segment-run-button"
            onClick={handleGroundSegment}
            disabled={groundSegmentInProgress}
            className={`w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 ${
              groundSegmentInProgress
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-500 text-white'
            }`}
          >
            {groundSegmentInProgress ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Segmenting...
              </>
            ) : (
              <>
                <Layers className="w-3 h-3" />
                Segment Ground
              </>
            )}
          </button>
        </div>
      )}

      {/* Tree Segmentation Panel (TreeIso) */}
      {showTreeSegmentPanel && selectedIds.size === 1 && (
        <div data-testid="tree-segment-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 max-h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
              <Sprout className="w-3 h-3" />
              Tree Segmentation
            </div>
            <button
              onClick={() => { setShowTreeSegmentPanel(false); setTreeSeedMode(false); }}
              className="p-1 hover:bg-neutral-700 rounded"
            >
              <X className="w-3 h-3 text-neutral-400" />
            </button>
          </div>

          <div className="mb-3 p-2 bg-neutral-900/50 rounded text-[10px] text-neutral-400">
            TreeIso isolates individual trees by cut-pursuit graph segmentation.
            Works best on ground-removed clouds — run Ground Segmentation first.
          </div>

          {/* Regularization strength 1 (3D) */}
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">3D reg. strength (λ₁)</label>
            <DebouncedNumberInput
              data-testid="tree-reg-strength1"
              value={treeRegStrength1}
              onCommit={(n) => setTreeRegStrength1(n)}
              min={0.1} max={10} step={0.1}
              disabled={treeSegmentInProgress}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
            />
          </div>

          {/* Regularization strength 2 (2D) */}
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">2D reg. strength (λ₂)</label>
            <DebouncedNumberInput
              data-testid="tree-reg-strength2"
              value={treeRegStrength2}
              onCommit={(n) => setTreeRegStrength2(n)}
              min={1} max={100} step={1}
              disabled={treeSegmentInProgress}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
            />
          </div>

          {/* Max gap */}
          <div className="mb-3">
            <label className="text-[10px] text-neutral-400 block mb-1">Max intra-tree gap (m)</label>
            <DebouncedNumberInput
              data-testid="tree-max-gap"
              value={treeMaxGap}
              onCommit={(n) => setTreeMaxGap(n)}
              min={0.1} max={10} step={0.1}
              disabled={treeSegmentInProgress}
              className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
            />
          </div>

          {/* Trunk seeding (human-in-the-loop) */}
          <div className="mb-3 p-2 bg-neutral-900/50 rounded">
            <label className="flex items-center gap-2 text-[10px] text-neutral-400 mb-2">
              <input
                data-testid="tree-seed-mode"
                type="checkbox"
                checked={treeSeedMode}
                onChange={(e) => setTreeSeedMode(e.target.checked)}
                className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
                disabled={treeSegmentInProgress}
              />
              Seed trunks (left-click to add)
            </label>
            {treeSeedMode && (
              <div className="text-[10px] text-neutral-500 mb-1">
                Click trunks in the view (camera locked); right-click removes the last seed.
              </div>
            )}
            <div className="flex items-center justify-between text-[10px] text-neutral-500">
              <span data-testid="tree-seed-count">{treeSeedPoints.length} seed{treeSeedPoints.length === 1 ? '' : 's'}</span>
              {treeSeedPoints.length > 0 && (
                <button
                  className="px-2 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-300"
                  onClick={() => setTreeSeedPoints([])}
                  disabled={treeSegmentInProgress}
                >
                  Clear seeds
                </button>
              )}
            </div>
          </div>

          {/* Split checkbox */}
          <label className="flex items-center gap-2 text-[10px] text-neutral-400 mb-3">
            <input
              data-testid="tree-split-clouds"
              type="checkbox"
              checked={treeSplitClouds}
              onChange={(e) => setTreeSplitClouds(e.target.checked)}
              className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
              disabled={treeSegmentInProgress}
            />
            Split into one cloud per tree
          </label>

          {treeSegmentError && (
            <div className="mb-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
              {treeSegmentError}
            </div>
          )}

          <button
            data-testid="tree-segment-run-button"
            onClick={handleSegmentTrees}
            disabled={treeSegmentInProgress}
            className={`w-full px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 ${
              treeSegmentInProgress
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-500 text-white'
            }`}
          >
            {treeSegmentInProgress ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Segmenting...
              </>
            ) : (
              <>
                <Sprout className="w-3 h-3" />
                Segment Trees
              </>
            )}
          </button>

          {/* Refine: merge / split the current tree_instance field (flat clouds). */}
          {(() => {
            const c = clouds.find(cl => selectedIds.has(cl.id));
            const hasTrees = !!c?.data.scalarFields?.[TREE_INSTANCE_ATTRIBUTE];
            if (!hasTrees) return null;
            return (
              <div data-testid="tree-refine" className="mt-3 pt-3 border-t border-neutral-700">
                <div className="text-[10px] font-medium text-neutral-300 mb-2">Refine</div>
                {/* Merge */}
                <div className="flex items-end gap-1 mb-2">
                  <div className="flex-1">
                    <label className="text-[10px] text-neutral-500 block">Merge tree</label>
                    <DebouncedNumberInput
                      data-testid="tree-merge-a"
                      value={treeMergeA}
                      onCommit={(n) => setTreeMergeA(Math.max(1, Math.round(n)))}
                      min={1} step={1}
                      className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
                    />
                  </div>
                  <span className="text-[10px] text-neutral-500 pb-1">+</span>
                  <div className="flex-1">
                    <label className="text-[10px] text-neutral-500 block">into</label>
                    <DebouncedNumberInput
                      data-testid="tree-merge-b"
                      value={treeMergeB}
                      onCommit={(n) => setTreeMergeB(Math.max(1, Math.round(n)))}
                      min={1} step={1}
                      className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
                    />
                  </div>
                  <button
                    data-testid="tree-merge-run"
                    onClick={handleMergeTrees}
                    className="px-2 py-1 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
                  >
                    Merge
                  </button>
                </div>
                {/* Split */}
                <div className="flex items-end gap-1">
                  <div className="flex-1">
                    <label className="text-[10px] text-neutral-500 block">Split tree (by gaps)</label>
                    <DebouncedNumberInput
                      data-testid="tree-split-id"
                      value={treeSplitId}
                      onCommit={(n) => setTreeSplitId(Math.max(1, Math.round(n)))}
                      min={1} step={1}
                      className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
                    />
                  </div>
                  <button
                    data-testid="tree-split-run"
                    onClick={handleSplitTree}
                    className="px-2 py-1 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
                  >
                    Split
                  </button>
                </div>
              </div>
            );
          })()}
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

      {/* Transform Panel - shows when a mesh is selected and the Transform button is toggled */}
      {showResizePanel && selectedMesh && (() => {
        const scale = meshScales.get(selectedMesh.id) || { x: 1, y: 1, z: 1 };
        const pos = meshPositions.get(selectedMesh.id) || { x: 0, y: 0, z: 0 };
        const rotation = meshRotations.get(selectedMesh.id) || { x: 0, y: 0, z: 0 };
        const isShape = selectedMesh.sourceCloudId.startsWith('shape-');
        const isVoxel = selectedMesh.sourceCloudId.includes('voxel');
        const grid = selectedMesh.gridSubdivisions || { x: 1, y: 1, z: 1 };
        const translateActive = editMode === 'translate';
        const rotateActive = editMode === 'rotate';

        const handleSetGrid = (axis: 'x' | 'y' | 'z', value: string) => {
          // Allow empty while editing; commit only valid positive integers.
          if (value === '') return;
          const v = Math.max(1, Math.floor(Number(value)));
          if (!Number.isFinite(v)) return;
          setMeshes(prev => prev.map(m => {
            if (m.id !== selectedMesh.id) return m;
            const cur = m.gridSubdivisions || { x: 1, y: 1, z: 1 };
            return { ...m, gridSubdivisions: { ...cur, [axis]: v } };
          }));
        };

        const handleSetMeshPos = (axis: 'x' | 'y' | 'z', value: string) => {
          const v = parseFloat(value);
          if (isNaN(v)) return;
          setMeshPositions(prev => {
            const next = new Map(prev);
            const cur = next.get(selectedMesh.id) || { x: 0, y: 0, z: 0 };
            next.set(selectedMesh.id, { ...cur, [axis]: v });
            return next;
          });
        };

        const handleSetMeshRot = (axis: 'x' | 'y' | 'z', value: string) => {
          const v = parseFloat(value);
          if (isNaN(v)) return;
          setMeshRotations(prev => {
            const next = new Map(prev);
            const cur = next.get(selectedMesh.id) || { x: 0, y: 0, z: 0 };
            next.set(selectedMesh.id, { ...cur, [axis]: v });
            return next;
          });
        };

        return (
          <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56">
            <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Maximize2 className="w-3 h-3" />
                Transform {isShape ? 'Shape' : 'Mesh'}
              </span>
              <button
                onClick={() => setShowResizePanel(false)}
                className="text-neutral-500 hover:text-neutral-300"
              >
                ×
              </button>
            </div>

            {/* Position */}
            <div className="mb-3 p-2 bg-neutral-900/50 rounded">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] text-neutral-400 flex items-center gap-1">
                  <Move className="w-3 h-3" />
                  Position
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleMoveToOrigin}
                    className="p-0.5 hover:bg-neutral-700 rounded text-neutral-400 hover:text-neutral-200"
                    title="Move to Origin"
                  >
                    <CircleDot className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => setEditMode(translateActive ? 'none' : 'translate')}
                    className={`p-0.5 rounded ${translateActive ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700'}`}
                    title={translateActive ? 'Hide translate gizmo' : 'Show translate gizmo'}
                  >
                    <Move className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <div key={axis} className="flex items-center gap-2">
                    <label className="text-[10px] text-neutral-500 w-3 uppercase font-medium">{axis}</label>
                    <DebouncedNumberInput
                      step={0.1}
                      value={pos[axis]}
                      format={(n) => n.toFixed(3)}
                      onCommit={(n) => handleSetMeshPos(axis, String(n))}
                      className="flex-1 bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-0.5 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  setMeshPositions(prev => {
                    const next = new Map(prev);
                    next.set(selectedMesh.id, { x: 0, y: 0, z: 0 });
                    return next;
                  });
                }}
                className="w-full mt-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[10px]"
              >
                Reset Position
              </button>
            </div>

            {/* Rotation */}
            <div className="mb-3 p-2 bg-neutral-900/50 rounded">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] text-neutral-400 flex items-center gap-1">
                  <RotateCcw className="w-3 h-3" />
                  Rotation (°)
                </div>
                <button
                  onClick={() => setEditMode(rotateActive ? 'none' : 'rotate')}
                  className={`p-0.5 rounded ${rotateActive ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700'}`}
                  title={rotateActive ? 'Hide rotate gizmo' : 'Show rotate gizmo'}
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-1.5">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <div key={axis} className="flex items-center gap-2">
                    <label className="text-[10px] text-neutral-500 w-3 uppercase font-medium">{axis}</label>
                    <DebouncedNumberInput
                      step={5}
                      value={rotation[axis]}
                      format={(n) => n.toFixed(1)}
                      onCommit={(n) => handleSetMeshRot(axis, String(n))}
                      className="flex-1 bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-0.5 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  setMeshRotations(prev => {
                    const next = new Map(prev);
                    next.set(selectedMesh.id, { x: 0, y: 0, z: 0 });
                    return next;
                  });
                }}
                className="w-full mt-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[10px]"
              >
                Reset Rotation
              </button>
            </div>

            {/* Per-Axis Scale */}
            <div className={`${isVoxel ? 'mb-3' : ''} p-2 bg-neutral-900/50 rounded`}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] text-neutral-400 flex items-center gap-1">
                  <Maximize2 className="w-3 h-3" />
                  Scale
                </div>
                <label className="flex items-center gap-1 text-[10px] text-neutral-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={scaleLocked}
                    onChange={(e) => setScaleLocked(e.target.checked)}
                    className="accent-blue-500"
                  />
                  Lock
                </label>
              </div>
              <div className="space-y-1.5">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <div key={axis} className="flex items-center gap-2">
                    <label className="text-[10px] text-neutral-500 w-3 uppercase font-medium">{axis}</label>
                    <DebouncedNumberInput
                      step={0.1}
                      min={0}
                      value={scale[axis]}
                      format={(n) => n.toFixed(2)}
                      onCommit={(v) => {
                        setMeshScales(prev => {
                          const next = new Map(prev);
                          next.set(selectedMesh.id, scaleLocked ? { x: v, y: v, z: v } : { ...scale, [axis]: v });
                          return next;
                        });
                      }}
                      className="flex-1 bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-0.5 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  setMeshScales(prev => {
                    const next = new Map(prev);
                    next.set(selectedMesh.id, { x: 1, y: 1, z: 1 });
                    return next;
                  });
                }}
                className="w-full mt-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[10px]"
              >
                Reset Scale
              </button>
            </div>

            {/* Voxel-specific: Grid subdivision (for PyHelios LiDAR grid) */}
            {isVoxel && (
              <div className="p-2 bg-neutral-900/50 rounded">
                <div className="text-[10px] text-neutral-400 mb-1.5 flex items-center gap-1">
                  <Grid3x3 className="w-3 h-3" />
                  Grid Resolution
                </div>
                <div className="space-y-1.5">
                  {(['x', 'y', 'z'] as const).map((axis) => (
                    <div key={axis} className="flex items-center gap-2">
                      <label className="text-[10px] text-neutral-500 w-3 uppercase font-medium">{axis}</label>
                      <DebouncedNumberInput
                        min={1}
                        step={1}
                        parse={(s) => parseInt(s, 10)}
                        value={grid[axis]}
                        onCommit={(n) => handleSetGrid(axis, String(n))}
                        className="flex-1 bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-0.5 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => setMeshes(prev => prev.map(m => m.id === selectedMesh.id ? { ...m, gridSubdivisions: { x: 1, y: 1, z: 1 } } : m))}
                  className="w-full mt-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded text-[10px]"
                >
                  Reset Grid
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {/* Translate Coordinates Panel - shown for clouds/skeletons. Meshes use the Transform panel instead. */}
      {editMode === 'translate' && !selectedMesh && (selectedSkeletonId || selectedIds.size > 0) && (() => {
        // Get current position based on selection type
        let currentPos = { x: 0, y: 0, z: 0 };
        let objectName = '';

        if (selectedSkeletonId) {
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

          if (selectedSkeletonId) {
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
                const state = next.get(cloudId) || { translation: { x: 0, y: 0, z: 0 }, erasedIndices: new Set<number>() };
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
                  <DebouncedNumberInput
                    step={0.1}
                    value={currentPos[axis]}
                    format={(n) => n.toFixed(3)}
                    onCommit={(n) => handleCoordChange(axis, String(n))}
                    className="flex-1 bg-neutral-700 text-neutral-200 text-xs px-2 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              ))}
            </div>

            <button
              onClick={() => {
                if (selectedSkeletonId) {
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

      {/* Scalar overlay — categorical attributes (e.g. ground_class) show a
          discrete class legend; continuous scalars show the gradient colorbar.
          Both require `dataRange`, which is null unless a visible cloud
          actually carries the active field — so the overlay disappears when the
          segmented scan is deleted. */}
      {isScalarColorMode && colorMode === 'scalar' && selectedScalarField &&
       dataRange && categoricalSchemeForRange(selectedScalarField, [dataRange.min, dataRange.max]) ? (
        <div
          className="absolute bottom-4 right-56 z-20"
          data-testid="class-legend"
          data-legend-attribute={selectedScalarField}
        >
          <ClassLegend
            scheme={categoricalSchemeForRange(selectedScalarField, [dataRange.min, dataRange.max])!}
            label={dataRange.label}
          />
        </div>
      ) : isScalarColorMode && activeRange && dataRange && (
        <div
          className="absolute bottom-4 right-56 z-20"
          data-testid="colorbar"
          data-colorbar-label={dataRange.label}
          data-colorbar-min={activeRange.min}
          data-colorbar-max={activeRange.max}
        >
          <Colorbar
            colormap={colormap}
            min={activeRange.min}
            max={activeRange.max}
            label={dataRange.label}
          />
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
            {/* Color by — global across all clouds. Options are derived from a
                representative cloud (first selected-visible, else first
                visible): X/Y are hidden for octree clouds, and that cloud's
                scalar fields are offered as additional modes. */}
            {(() => {
              const cloud = colorbarSourceCloud;
              if (!cloud) return null;
              const isOctree = !!cloud.data.octree;
              const baseOptions = [
                { value: 'x', label: 'X Axis' },
                { value: 'y', label: 'Y Axis' },
                { value: 'height', label: 'Z Axis (Height)' },
                { value: 'intensity', label: 'Intensity' },
                { value: 'rgb', label: 'RGB' },
                { value: 'per-scan', label: 'Per-scan color' },
                { value: 'single', label: 'Solid Color' },
              ].filter(o => !isOctree || (o.value !== 'x' && o.value !== 'y'));
              // Scalar field options: flat clouds expose named scalarFields;
              // octree clouds expose imported extra-dim attributes (value =
              // on-disk slug, label = human-readable name). Builtin LAS
              // attributes (intensity/rgb/classification/…) are filtered out
              // of the octree list — they have their own modes.
              const scalarFields: Array<{ value: string; label: string }> = isOctree
                ? octreeScalarFieldOptions(
                    cloud.data.octree?.attributeRanges,
                    cloud.data.octree?.attributeLabels,
                  )
                : cloud.data.scalarFields
                  ? Object.keys(cloud.data.scalarFields).sort().map(f => ({ value: f, label: f }))
                  : [];
              // Encode scalar selections as `scalar:<field>` so the single
              // <select> can drive both colorMode and selectedScalarField.
              const selectValue =
                colorMode === 'scalar' && selectedScalarField
                  ? `scalar:${selectedScalarField}`
                  : colorMode;
              return (
                <div>
                  <label className="text-[10px] text-neutral-400 block mb-1">Color by</label>
                  <select
                    data-testid="display-color-mode"
                    value={selectValue}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v.startsWith('scalar:')) {
                        setColorMode('scalar');
                        setSelectedScalarField(v.slice('scalar:'.length));
                      } else {
                        setColorMode(v as ColorMode);
                      }
                    }}
                    className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
                  >
                    {baseOptions.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                    {scalarFields.length > 0 && (
                      <optgroup label="Scalar fields">
                        {scalarFields.map(f => (
                          <option key={f.value} value={`scalar:${f.value}`}>{f.label}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>

                  {/* Colormap + range — only for continuous (scalar) modes. */}
                  {isScalarColorMode && (
                    <>
                      <select
                        data-testid="display-colormap"
                        value={colormap}
                        onChange={(e) => setColormap(e.target.value as ColormapName)}
                        className="w-full mt-1 bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600"
                      >
                        {COLORMAP_NAMES.map((name) => (
                          <option key={name} value={name}>{COLORMAP_LABELS[name]}</option>
                        ))}
                      </select>

                      {dataRange && (
                        <div className="mt-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-neutral-500">Range</span>
                            <button
                              onClick={() =>
                                setColorRanges(prev => {
                                  const next = { ...prev };
                                  delete next[colorRangeKey];
                                  return next;
                                })
                              }
                              className="text-[10px] text-neutral-400 hover:text-blue-400 transition-colors"
                              title="Reset to data range"
                            >
                              Reset
                            </button>
                          </div>
                          <div className="flex gap-1 mt-0.5">
                            <DebouncedNumberInput
                              data-testid="display-range-min"
                              step="any"
                              value={colorRanges[colorRangeKey]?.min ?? dataRange.min}
                              onCommit={(v) => {
                                setColorRanges(prev => {
                                  const curMax = prev[colorRangeKey]?.max ?? dataRange.max;
                                  const clamped = v > curMax ? curMax : v;
                                  return { ...prev, [colorRangeKey]: { ...prev[colorRangeKey], min: clamped } };
                                });
                              }}
                              className="flex-1 w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-white text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <DebouncedNumberInput
                              data-testid="display-range-max"
                              step="any"
                              value={colorRanges[colorRangeKey]?.max ?? dataRange.max}
                              onCommit={(v) => {
                                setColorRanges(prev => {
                                  const curMin = prev[colorRangeKey]?.min ?? dataRange.min;
                                  const clamped = v < curMin ? curMin : v;
                                  return { ...prev, [colorRangeKey]: { ...prev[colorRangeKey], max: clamped } };
                                });
                              }}
                              className="flex-1 w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-white text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

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
                data-testid="confirm-delete"
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
        onClose={() => { if (!isGeneratingPlant) setShowPlantPopup(false); }}
        onGenerate={handleCreatePlant}
        isGenerating={isGeneratingPlant}
        progress={plantProgress}
        progressMessage={plantProgressMsg}
        onCancelGenerate={handleCancelPlantGenerate}
      />

      {/* Helios Triangulation Popup */}
      <HeliosTriangulationPopup
        isOpen={showHeliosPopup}
        onClose={() => setShowHeliosPopup(false)}
        scans={scans}
        onStartTriangulate={handleHeliosTriangulate}
        initialSelectedIds={selectedScanIds}
        onOpenScanParams={(id) => {
          setShowHeliosPopup(false);
          setScanPopupState({ kind: 'edit', id });
        }}
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

      {/* Scan Parameters Popup. Three modes:
            - add: create a brand-new params-only scan
            - add-params-to: attach params to an existing data-only scan
            - edit: update an existing scan's params and label
          The "Import from XML" affordance inside the popup uses the bulk
          callback to materialise N scans at once, optionally auto-attaching
          point data referenced by <filename>. */}
      <ScanParametersPopup
        isOpen={scanPopupState.kind !== 'closed'}
        onClose={() => setScanPopupState({ kind: 'closed' })}
        initial={(() => {
          if (scanPopupState.kind === 'edit') {
            const found = scans.find(s => s.id === scanPopupState.id);
            if (found?.params) return { label: found.label, params: found.params };
          }
          return undefined;
        })()}
        defaults={scanPopupState.kind === 'add' || scanPopupState.kind === 'add-params-to' ? scanDefaults : undefined}
        mode={
          scanPopupState.kind === 'edit'
            ? 'edit'
            : scanPopupState.kind === 'add-params-to'
              ? 'attach'
              : 'create'
        }
        showBulkImport={scanPopupState.kind === 'add'}
        onSubmit={(label, params) => {
          if (scanPopupState.kind === 'edit') {
            const editingId = scanPopupState.id;
            onUpdateScanParams(editingId, params);
            onUpdateScanLabel?.(editingId, label);
          } else if (scanPopupState.kind === 'add-params-to') {
            const targetId = scanPopupState.id;
            onUpdateScanParams(targetId, params);
            onUpdateScanLabel?.(targetId, label);
          } else {
            // Create a params-only scan. Allocate a color from the same
            // palette as data-bearing scans so the dot is consistent.
            const used = new Set(scans.map(s => s.color));
            const PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
            const nextColor = PALETTE.find(c => !used.has(c)) ?? PALETTE[scans.length % PALETTE.length];
            const id = crypto.randomUUID();
            onAddScan?.({
              id,
              label,
              visible: true,
              color: nextColor,
              params,
            });
            setSelectedMarkerScanId(id);
          }
          setScanPopupState({ kind: 'closed' });
        }}
        onBulkImport={async (heliosScans, xmlPath) => {
          if (heliosScans.length === 0) return;
          const xmlDir = xmlPath ? dirname(xmlPath) : '';
          const used = new Set(scans.map(s => s.color));
          const PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
          const allocateColor = () => {
            const free = PALETTE.find(c => !used.has(c));
            const chosen = free ?? PALETTE[(scans.length + used.size) % PALETTE.length];
            used.add(chosen);
            return chosen;
          };
          // Renumber labels off the current count so an import after manual
          // adds doesn't collide with existing "Scan N" names.
          const offset = scans.length;
          const newScans: Scan[] = [];
          let attachedCount = 0;
          let attachFailed = 0;
          // Show the progress modal immediately so the user knows the import
          // is in flight — backend parsing of a multi-GB scan can take 30s+
          // and the launching popup has already closed.
          setBulkImportProgress({
            current: 0,
            total: heliosScans.length,
            label: 'Preparing…',
          });
          try {
            for (let i = 0; i < heliosScans.length; i++) {
              const h = heliosScans[i];
              const scan: Scan = {
                id: crypto.randomUUID(),
                label: `Scan ${offset + i + 1}`,
                visible: true,
                color: allocateColor(),
                params: h.params,
              };
              setBulkImportProgress({
                current: i + 1,
                total: heliosScans.length,
                label: h.filename
                  ? `Loading ${h.filename.split(/[\\/]/).pop()}`
                  : `Loading ${scan.label}`,
              });
              if (h.filename) {
                try {
                  const resolved = await resolveAttachedScanFile(h.filename, xmlDir);
                  if (resolved) {
                    const data = await parsePointCloudFromPath(resolved, h.asciiFormat);
                    scan.data = data;
                    scan.sourcePath = resolved;
                    scan.asciiFormat = h.asciiFormat;
                    attachedCount += 1;
                  }
                } catch (err) {
                  attachFailed += 1;
                  console.warn(`Could not attach point cloud for ${scan.label}:`, err);
                }
              }
              newScans.push(scan);
            }
            onAddScans?.(newScans);
            if (newScans.length > 0) {
              setSelectedMarkerScanId(newScans[newScans.length - 1].id);
            }
            const parts = [`${newScans.length} scan(s)`];
            if (attachedCount > 0) parts.push(`${attachedCount} with data`);
            if (attachFailed > 0) parts.push(`${attachFailed} attach failed`);
            showToast({ title: `Imported ${parts.join(', ')}`, type: attachFailed > 0 ? 'info' : 'success' });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('Bulk import failed:', err);
            showToast({ title: `Import failed: ${msg}`, type: 'error' });
          } finally {
            // Always clear the modal — leaving it up would lock the UI.
            setBulkImportProgress(null);
          }
        }}
      />

      <BulkImportProgress progress={bulkImportProgress} />

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

    </div>
  );
}
