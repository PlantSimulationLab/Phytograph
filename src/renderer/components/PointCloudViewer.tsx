import { useRef, useMemo, useState, useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { Eye, EyeOff, Maximize2, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Circle, Square, Move, Crop, Trash2, Layers, CheckSquare, XSquare, Triangle, Loader2, Box, Merge, GitBranch, ChevronRight, ChevronDown, Download, Plus, Home, Sprout, Trees, CircleDot, Minus, Grid3x3, ChartScatter, ChartColumn, Eraser, Filter, Globe, Search, Dna, Radio, Pencil, FileUp, Copy, Compass, CloudFog, X} from 'lucide-react';
import GIF from 'gif.js';
import { triangulatePointCloud, TriangulationMethod, extractSkeleton, generatePlantModel, generatePlantStreaming, runLidarScan, type LidarScanResult, type LidarScanMaterial, exportPointCloudLasLaz, createPlantSession, advancePlantSession, computeAlignmentDistance, AlignmentDistanceResponse, icpRegisterMeshToCloud, icpRegisterCloudToCloud, icpRegisterMeshToMesh, HeliosTriangulationRequest, heliosTriangulate, computeLAD, type LADRequest, checkTriangulationSpacing, morphPlant, PlantMorphRequest, deletePlantSession, deleteCloudRegion, resetCloudEdits, bakeCloudSession, sessionFilter, sessionSplit, sessionExtract, duplicateCloudSession, sessionSegmentGround, sessionSegmentTrees, sessionSegmentWood, segmentGround, segmentTrees, segmentWood, buildQSM, addQSMLeaves, adjustQSMLeafAngles, type QSMLeavesRequest, type QSMAdjustLeafAnglesRequest, type CropOctreeRegion, type BackendPointSource, type OctreeMetadata, type HeliosGrid, backfillMisses, type BackfillMissesRaster, type BinaryFrameProgress, cancelRun, ScanCancelledError } from '../utils/backendApi';
import { showToast } from './Toast';
import { getSettings } from '../lib/store';
import { resolveTargets, resolveDeleteIds, anyTargetVisible, buildDeleteLabel } from '../lib/bulkActions';
import {
  ColormapName,
  COLORMAP_NAMES,
  COLORMAP_LABELS,
} from '../lib/colormaps';
import { PlantGenerationPopup, type PlantGenerationPayload } from './PlantGenerationPopup';
import { TriangulationPopup, type TriangulationStartArgs } from './TriangulationPopup';
import type { GridOption } from '../lib/gridOption';
import { LADPopup, type LADTriangulationOption } from './LADPopup';
import { BackfillMissesPopup } from './BackfillMissesPopup';
import { QSMPopup, type QSMStartOptions } from './QSMPopup';
import { Toolbar } from './Toolbar';
import { StitchDialog } from './StitchDialog';
import { AlignDialog } from './AlignDialog';
import { type ToolCommand, type SelectionState, isCommandAvailable, requiresText as toolRequiresText, CREATE_GROUPS } from '../lib/toolCommands';
import { LeafAnglePlotPopup } from './LeafAnglePlotPopup';
import { QSMResultsPopup } from './QSMResultsPopup';
import { AddLeavesPopup } from './AddLeavesPopup';
import { CreatePlanePopup, type CreatePlaneParams } from './CreatePlanePopup';
import { AdjustLeafAnglesPopup } from './AdjustLeafAnglesPopup';
import { MorphPopup } from './MorphPopup';
import { ScanParametersPopup } from './ScanParametersPopup';
import { type HeliosXmlScan, type HeliosXmlGrid } from '../lib/heliosScanXml';
import { SyntheticScanOptionsPopup } from './SyntheticScanOptionsPopup';
import { type SyntheticScanOptions } from '../lib/syntheticScanOptions';
import { SCAN_HIT_FIELDS, STANDARD_HIT_FIELD_SLUGS } from '../lib/scanHitFields';
import { ScanMarkerEntry } from './ScannerMarker';
import { ScanWireframeEntry } from './ScanPatternWireframe';
import { getScannerModel } from '../lib/scannerModels';
import { DebouncedNumberInput } from './DebouncedNumberInput';
import { BulkImportProgress, type BulkImportProgressState } from './BulkImportProgress';
import StatusPill from './StatusPill';
import { type ScanParameters, scanParametersFromFile } from '../lib/scanParameters';
import { groundSegmentDefaultsForExtent } from '../lib/groundSegmentDefaults';
import { poseStreamToWire, trajectoryDurationS, deriveMovingScanGrid } from '../lib/poseStream';
import { prettifyQSMError } from '../lib/qsmErrors';
import { type Scan, hasData, hasParams, scanDisplayName, duplicateScanName, allocateScanColor, isBackfillEligible } from '../lib/scan';
import { parsePointCloudFromPath, buildPointCloudFromOctree } from '../lib/pointCloudParsers';
import { resolveAttachedScanFile } from '../lib/scanFileResolver';
import type { WizardScanInput, WizardResult } from './PointCloudImportWizard';
import { dirname } from '../lib/pathUtils';
import { useScene, type SceneState } from '../state/sceneStore';
import type { TransformState } from '../state/sceneActions';
import {
  pointInPolygon,
  projectWorldToCanvasPixel,
  worldBoundsUnion,
  polygonRegionFromCamera,
} from '../lib/cropGeometry';
import { pendingDeletesToClipBoxes } from '../lib/deletePreview';
import {
  computeBoundsFromPositions,
  fitGridToBounds,
  fuzzyMatch,
  generateShapeMesh,
  octreeScalarFieldOptions,
  assembleScanScalarFields,
  voxelMeshToHeliosGrid,
  buildMeshNonIndexedPositions,
  buildMeshTriangleColors,
  buildMeshScanColors,
  meshColorModeLabel,
  ladRange,
  roundCoord3,
  resampleCloud,
  cloneFlatPointCloudData,
  computeDisplayOffset,
  displayViewToWorldView,
  buildLADRequest,
  type Vec3Like,
  type ReuseMeshPayload,
} from '../lib/pointCloudHelpers';
import { applyTriangleFilter, computeTriangleMetrics, triangleFilterCounts } from '../lib/triangleFilter';
import type { TriangleFilterEstimate } from '../lib/triangleFilter';
import { Colorbar } from './viewer/Colorbar';
import { ClassLegend } from './viewer/ClassLegend';
import { categoricalSchemeForRange, isCategoricalAttribute, registerCategoricalSlug, registerContinuousSlug, GROUND_CLASS_ATTRIBUTE, WOOD_CLASS_ATTRIBUTE, TREE_INSTANCE_ATTRIBUTE, MISS_ATTRIBUTE } from '../lib/classification';
import { exportScanXml, type ScanExportEntry } from '../utils/backendApi';
import { mergeTrees, splitTreeByGaps } from '../lib/treeEdit';
import { OctreePointCloud } from './viewer/renderers/OctreePointCloud';
import { MissOctree } from './viewer/renderers/MissOctree';
import { PointCloud } from './viewer/renderers/PointCloud';
import { TriangleMesh } from './viewer/renderers/TriangleMesh';
import { JFAOutline, OutlineSelect } from './viewer/outline/JFAOutline';
import { setPointBudget, DEFAULT_POINT_BUDGET, CROP_PREVIEW_POINT_BUDGET } from './viewer/potreeManager';
import { VoxelGridOverlay } from './viewer/renderers/VoxelGridOverlay';
import { LADVoxelGrid } from './viewer/renderers/LADVoxelGrid';
import { TexturedPlantMesh } from './viewer/renderers/TexturedPlantMesh';
export { TexturedPlantMesh } from './viewer/renderers/TexturedPlantMesh';
import { Skeleton3D } from './viewer/renderers/Skeleton3D';
import { QSM3D, type QSMColorMode } from './viewer/renderers/QSM3D';
import { QsmIcon } from './icons/QsmIcon';
import { SkeletonPoints } from './viewer/renderers/SkeletonPoints';
import { CameraController } from './viewer/scene/CameraController';
import { GroundGrid } from './viewer/scene/GroundGrid';
import { ViewportAxesGizmo } from './viewer/scene/ViewportAxesGizmo';
import { SceneBackground } from './viewer/scene/SceneBackground';
import { CameraCapture } from './viewer/scene/CameraCapture';
import { TranslationGizmo } from './viewer/gizmos/TranslationGizmo';
import { CropBox } from './viewer/gizmos/CropBox';
import { BoxDrawRaycaster } from './viewer/gizmos/BoxDrawRaycaster';
import { PolygonCameraSnapshotter } from './viewer/gizmos/PolygonCameraSnapshotter';
import { OrthoProjectionOverride } from './viewer/gizmos/OrthoProjectionOverride';
import { EraseBrush } from './viewer/gizmos/EraseBrush';
import { EraseBrushOctree, type EraseSquareFrame } from './viewer/gizmos/EraseBrushOctree';
import { GroundSegmentPanel } from './viewer/panels/GroundSegmentPanel';
import { WoodSegmentPanel, type WoodSegmentMode, type WoodMultiMode, type WoodMethod } from './viewer/panels/WoodSegmentPanel';
import { TreeSegmentPanel } from './viewer/panels/TreeSegmentPanel';
import { SkeletonExtractionPanel } from './viewer/panels/SkeletonExtractionPanel';
import { AlignmentPanel } from './viewer/panels/AlignmentPanel';
import { ExportModal } from './ExportModal';
import { defaultExportColumns, buildAsciiExport } from '../lib/exportColumns';
import { QSMExportPanel } from './viewer/panels/QSMExportPanel';
import { PlantGrowthPanel } from './viewer/panels/PlantGrowthPanel';
import { TransformPanel } from './viewer/panels/TransformPanel';
import { TranslatePanel } from './viewer/panels/TranslatePanel';
import { ResamplePanel } from './viewer/panels/ResamplePanel';
import { FilterPanel } from './viewer/panels/FilterPanel';
import { ErasePanel } from './viewer/panels/ErasePanel';
import { CropPanel } from './viewer/panels/CropPanel';
import { SkeletonsListPanel } from './viewer/panels/SkeletonsListPanel';
import { LADResultsPanel } from './viewer/panels/LADResultsPanel';
import { MeshesListPanel } from './viewer/panels/MeshesListPanel';

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
  PendingDeleteRegion,
  MeshData,
  MeshEntry,
  SkeletonData,
  SkeletonEntry,
  QSMEntry,
  LADVoxel,
  LADResultEntry,
  ColorMode,
  MeshColorMode,
  ShapeType,
  FilterRange,
  CloudFilters,
} from '../lib/pointCloudTypes';
import { meshDisplayNameFor } from '../lib/pointCloudTypes';
import { eligibleLeafAngleMeshes, meanLeafInclination, qsmAabb } from '../lib/adjustLeafAngles';
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
import { serializeQsm, sanitizeQsmFilename, qsmExtForFormat, type QSMExportFormat } from '../lib/qsmExport';

// Grid plane options
type GridPlane = 'z-up' | 'y-up';
type EditMode = 'none' | 'translate' | 'crop' | 'rotate' | 'erase';

// Tuning fields threaded from handleWoodSegment to each per-cloud worker. The
// optional `reflectance_weight_max` (>0) and `scalar_slug` enable the reflectance
// assist; `reflectance` carries the inline scalar for the flat-cloud path.
type WoodSegmentTuning = {
  wood_bias: number;
  k_max: number;
  reg_iters: number;
  reflectance_weight_max?: number;
  scalar_slug?: string;
  method?: WoodMethod;
};

// Converts the user-facing Mesh Lighting multiplier (Display panel, default
// 1.0) into the physical three.js light intensity fed to the ambient + key
// directional lights. 1.0 × this scale reproduces the prior default look
// (0.75 base × 1.5).
const LIGHT_INTENSITY_SCALE = 1.125;

// Default opacity for a freshly-rendered mesh that has no explicit per-mesh
// override yet. Solid surfaces render slightly translucent so an underlying
// point cloud stays visible through a triangulation.
const MESH_DEFAULT_OPACITY = 0.7;

// Grid (voxel-box) meshes default to more translucent so the points and any
// structure inside the box stay visible through its faces. A voxel box is a
// mesh carrying `gridSubdivisions`.
const GRID_MESH_DEFAULT_OPACITY = 0.4;

// Default opacity for a mesh with no explicit per-mesh override. Kept as a
// single source of truth so the render path and the meshes-panel slider agree.
//  - voxel-grid boxes      -> GRID_MESH_DEFAULT_OPACITY (0.4): see the box's contents
//  - file-imported meshes  -> 1.0: no underlying cloud to see through
//  - in-app triangulations -> MESH_DEFAULT_OPACITY (0.7): let the source cloud show through
const defaultMeshOpacity = (mesh: MeshEntry): number => {
  if (mesh.gridSubdivisions) return GRID_MESH_DEFAULT_OPACITY;
  if (mesh.sourceCloudId === 'imported') return 1.0;
  return MESH_DEFAULT_OPACITY;
};


// Import function refs for mesh/skeleton
export interface ImportRefs {
  importMesh: (mesh: Omit<MeshEntry, 'id'>) => void;
  importSkeleton: (skeleton: Omit<SkeletonEntry, 'id'>) => void;
  // Import scans + grids parsed from a Helios scan XML (File → Import / drop
  // zone reach the same flow the Add-Scan popup uses). xmlPath is the on-disk
  // path of the XML so relative <filename> references resolve; null when none.
  bulkImportScans: (heliosScans: HeliosXmlScan[], grids: HeliosXmlGrid[], xmlPath: string | null) => Promise<void>;
}

interface PointCloudViewerProps {
  scans: Scan[];
  selectedScanIds: Set<string>;
  onToggleVisibility: (id: string) => void;
  // Bulk show/hide for the Scans panel header — acts on the selection when one
  // exists, otherwise every scan. Visibility lives in App (setScans), so this
  // is a prop rather than a local handler.
  onToggleScansVisibility: () => void;
  // Force a scan hidden (idempotent — unlike onToggleVisibility). Used after a
  // QSM build to get the source scan's points out of the way so the new QSM
  // isn't obscured by the cloud it was derived from.
  onHideScan: (id: string) => void;
  // Toggle the sky/miss overlay for a scan (hidden by default). Offered only on
  // scans whose cloud carries miss info (octree.hasMisses).
  onToggleMisses?: (id: string) => void;
  // allowDeselect: when true, a plain click on the row that is the sole scan
  // selection toggles it OFF. The Scans pane passes false when a mesh/skeleton
  // is ALSO selected (mixed mode) — there the click should keep the scan and
  // let the "clear mesh on cloud-select" effect drop back to single-cloud mode,
  // not deselect everything.
  onToggleSelection: (id: string, additive: boolean, range: boolean, allowDeselect?: boolean) => void;
  onRemoveScan: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onUpdateScanData: (id: string, data: PointCloudData) => void;
  onUpdateScanParams: (id: string, params: ScanParameters | undefined) => void;
  onUpdateScanLabel?: (id: string, label: string) => void;
  onUpdateScanColor?: (id: string, color: string) => void;
  onSave: (data: PointCloudData, fileName: string) => void;
  onAddScan?: (scan: Scan) => void;
  onAddScans?: (scans: Scan[]) => void;
  onStitchScans?: (ids: string[]) => void;
  className?: string;
  importRefsCallback?: (refs: ImportRefs) => void;
  // Fired when the number of session clouds with UNBAKED deletions changes, so
  // App can warn before quit (the deletions live only in the backend session's
  // in-RAM mask until baked; closing without baking discards them).
  onPendingDeletesChange?: (count: number) => void;
  // Fired when the set of viewer-owned content (meshes, skeletons) changes
  // between empty and non-empty. App uses this to dismiss the empty-state hint
  // when content arrives that isn't a scan — e.g. a generated Helios plant,
  // which is a mesh, not a scan.
  onViewerContentChange?: (hasContent: boolean) => void;
  // Opens App's import wizard for the given scans and resolves with the user's
  // per-scan choices (or null on cancel). Used by the Helios XML bulk import so
  // multi-scan XML imports get the same preview/column-mapping flow as a
  // drag-drop. App owns the single wizard mount.
  onRequestImportWizard?: (inputs: WizardScanInput[]) => Promise<WizardResult[] | null>;
  // Opens the app-wide Settings modal (owned by App). Used by the command palette.
  onOpenSettings?: () => void;
  // Incremented by App whenever the Settings dialog closes, so this always-mounted
  // viewer can re-read persisted settings (e.g. scan-marker scale) and apply them
  // without a restart.
  settingsEpoch?: number;
}

// Compute the next selection Set for a modifier-aware click, mirroring App's
// handleToggleScanSelection so meshes/skeletons/QSMs behave identically:
//   - Shift+click: select the range between the anchor and the clicked id
//     (additive when ctrl/cmd is also held, else replacing the selection).
//   - Ctrl/Cmd+click: toggle the clicked id in/out of the selection.
//   - Plain click: select only the clicked id, unless it's already the sole
//     selection (then deselect it).
// `orderedIds` is the list in display order (for range math). Returns the new
// Set; the caller updates the anchor ref for non-range clicks.
function nextSelection(
  prev: Set<string>,
  id: string,
  orderedIds: string[],
  anchorId: string | null,
  additive: boolean,
  range: boolean,
): Set<string> {
  if (range && anchorId) {
    const anchorIdx = orderedIds.indexOf(anchorId);
    const clickedIdx = orderedIds.indexOf(id);
    if (anchorIdx !== -1 && clickedIdx !== -1) {
      const [lo, hi] = anchorIdx < clickedIdx ? [anchorIdx, clickedIdx] : [clickedIdx, anchorIdx];
      const rangeIds = orderedIds.slice(lo, hi + 1);
      return new Set(additive ? [...prev, ...rangeIds] : rangeIds);
    }
  }
  const isSoleSelection = !additive && prev.size === 1 && prev.has(id);
  if (isSoleSelection) return new Set();
  const next = new Set(additive ? prev : []);
  if (prev.has(id) && additive) next.delete(id);
  else next.add(id);
  return next;
}

// Build the `triangulationParams` provenance block for a Helios mesh under a
// given interactive filter. The kept/dropped counts come from the unfiltered
// candidate metrics (triangleFilterCounts), so the mesh-list breakdown updates
// live as the user adjusts Lmax/aspect. `candidateTriangles` includes the
// degenerate triangles the backend already excluded, so the displayed total
// reconciles: candidates === kept + droppedLmax + droppedAspect + degenerate.
function buildHeliosTriParams(
  unfilteredData: MeshData,
  lmax: number,
  maxAspectRatio: number,
  scanCount: number,
  droppedDegenerate: number,
  sourceScanIds: string[] = [],
  gridMeshId?: string,
): NonNullable<MeshEntry['triangulationParams']> {
  const c = triangleFilterCounts(unfilteredData, lmax, maxAspectRatio);
  return {
    lmax,
    maxAspectRatio,
    scanCount,
    candidateTriangles: c.candidates + droppedDegenerate,
    droppedLmax: c.droppedLmax,
    droppedAspect: c.droppedAspect,
    droppedDegenerate,
    sourceScanIds: sourceScanIds.length > 0 ? sourceScanIds : undefined,
    gridMeshId,
  };
}

// Open3D triangulation methods (ball pivoting, poisson, alpha shape, delaunay)
// do NOT get a post-triangulation Lmax / aspect filter. Each method already
// applies its own length scale during reconstruction — ball pivoting's ball
// radius, alpha shape's alpha, poisson's octree depth — so the long bridge
// triangles the Helios path trims with Otsu-derived Lmax don't survive into the
// returned mesh. Re-filtering by edge length would be a no-op (filtering 0.02 vs
// 10 leaves the same triangle count) while implying to the user that there's a
// meaningful knob to turn. The Lmax / aspect controls are therefore Helios-only;
// Open3D meshes carry no `triangleFilter` / `unfilteredMesh`, so the Meshes panel
// hides those controls for them.

export default function PointCloudViewer({
  scans,
  selectedScanIds,
  onToggleVisibility,
  onToggleScansVisibility,
  onHideScan,
  onToggleMisses,
  onToggleSelection,
  onRemoveScan,
  onSelectAll,
  onDeselectAll,
  onUpdateScanData,
  onUpdateScanParams,
  onUpdateScanLabel,
  onUpdateScanColor,
  onSave: _onSave,
  onAddScan,
  onAddScans,
  onStitchScans,
  className = '',
  importRefsCallback,
  onPendingDeletesChange,
  onViewerContentChange,
  onRequestImportWizard,
  onOpenSettings,
  settingsEpoch,
}: PointCloudViewerProps) {
  // Unified scene store: single owner of the migrated collections (transform
  // maps, editStates, meshes, …) and of the undo/redo history. `makeFieldSetter`
  // returns a React-setter-shaped adapter (value or updater) that dispatches a
  // NON-history `replaceCollection` on one SceneState field — so existing
  // `setX(prev => ...)` call sites keep their exact syntax while the store owns
  // the data. History is recorded explicitly via scene.commit (object add/remove
  // in the relevant handlers, transforms/mask edits in commitHistoryEntry), NOT
  // by these setters. See the scene store / action model in src/renderer/state/.
  const scene = useScene();
  const makeFieldSetter = useCallback(
    <K extends keyof SceneState>(field: K) =>
      (update: SceneState[K] | ((prev: SceneState[K]) => SceneState[K])) => {
        scene.dispatch({
          c: 'replaceCollection',
          apply: (s) => ({
            [field]:
              typeof update === 'function'
                ? (update as (prev: SceneState[K]) => SceneState[K])(s[field])
                : update,
          }),
        });
      },
    [scene],
  );

  // Undoable mesh add helpers. Each commits an `add` action (with the transform
  // folded in, so the reducer seeds meshPositions/Rotations/Scales) — replacing
  // the old `setMeshes(prev => [...prev, m])` + 3 transform-seed setters. Undo of
  // a create removes the mesh (and its seeded transform); redo re-adds it.
  const meshTransform = (t?: { position?: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number }; scale?: { x: number; y: number; z: number } }): TransformState => ({
    position: t?.position ?? { x: 0, y: 0, z: 0 },
    rotation: t?.rotation ?? { x: 0, y: 0, z: 0 },
    scale: t?.scale ?? { x: 1, y: 1, z: 1 },
  });
  const addMesh = useCallback((mesh: MeshEntry, transform?: TransformState, label = 'Add mesh') => {
    scene.commit({ label, actions: [{ t: 'add', kind: 'mesh', id: mesh.id, object: mesh, transform: transform ?? meshTransform() }] });
  }, [scene]);
  // Several meshes in ONE undoable transaction (multi-triangulate).
  const addMeshes = useCallback((meshList: MeshEntry[], label = 'Add meshes') => {
    if (meshList.length === 0) return;
    scene.commit({ label, actions: meshList.map(m => ({ t: 'add' as const, kind: 'mesh' as const, id: m.id, object: m, transform: meshTransform() })) });
  }, [scene]);
  // Remove N objects of one kind (mesh/skeleton/qsm/lad) as ONE undoable
  // transaction — a single Cmd+Z restores the whole batch. Captures each object's
  // index (+ transform for mesh/skeleton) so undo reinstates exactly.
  const removeObjects = useCallback((kind: 'mesh' | 'skeleton' | 'qsm' | 'lad', ids: string[]) => {
    const s = scene.state;
    const list = kind === 'mesh' ? s.meshes : kind === 'skeleton' ? s.skeletons : kind === 'qsm' ? s.qsms : s.ladResults;
    const actions = ids
      .map((id) => {
        const index = list.findIndex((o) => o.id === id);
        if (index < 0) return null;
        const object = list[index];
        if (kind === 'mesh') {
          return { t: 'remove' as const, kind, id, index, object, transform: {
            position: s.meshPositions.get(id) ?? { x: 0, y: 0, z: 0 },
            rotation: s.meshRotations.get(id) ?? { x: 0, y: 0, z: 0 },
            scale: s.meshScales.get(id) ?? { x: 1, y: 1, z: 1 },
          } };
        }
        if (kind === 'skeleton') {
          return { t: 'remove' as const, kind, id, index, object, transform: { position: s.skeletonPositions.get(id) ?? { x: 0, y: 0, z: 0 } } };
        }
        return { t: 'remove' as const, kind, id, index, object };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
    if (actions.length === 0) return;
    const noun = kind === 'lad' ? 'LAD result' : kind;
    scene.commit({ label: ids.length > 1 ? `Delete ${ids.length} ${noun}s` : `Delete ${noun}`, actions });
  }, [scene]);

  // Undoable add/remove for skeletons (position-only transform), QSMs and LAD
  // results (no transform). Same shape as the mesh helpers (Phase C).
  const addSkeleton = useCallback((skeleton: SkeletonEntry, label = 'Add skeleton') => {
    scene.commit({ label, actions: [{ t: 'add', kind: 'skeleton', id: skeleton.id, object: skeleton, transform: { position: { x: 0, y: 0, z: 0 } } }] });
  }, [scene]);
  const addQSM = useCallback((qsm: QSMEntry, label = 'Build QSM') => {
    scene.commit({ label, actions: [{ t: 'add', kind: 'qsm', id: qsm.id, object: qsm }] });
  }, [scene]);
  const addLad = useCallback((lad: LADResultEntry, label = 'Compute LAD') => {
    scene.commit({ label, actions: [{ t: 'add', kind: 'lad', id: lad.id, object: lad }] });
  }, [scene]);
  // Undoable single-property edit (rename / color / opacity / colorMode). No-op
  // when before === after so a no-change commit doesn't clutter history.
  const commitProperty = useCallback((kind: 'scan' | 'mesh' | 'skeleton' | 'qsm' | 'lad', id: string, key: 'label' | 'color' | 'opacity' | 'colorMode', before: string | number | undefined, after: string | number | undefined, label?: string) => {
    if (before === after) return;
    scene.commit({ label: label ?? `Change ${key}`, actions: [{ t: 'property', kind, id, key, before, after }] });
  }, [scene]);

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
      showMisses: s.showMisses,
      params: s.params,
    })),
    [scans],
  );

  // Rehydrate the categorical-attribute registry from each octree cloud. The
  // import wizard marks scalar fields categorical and stores their slugs on the
  // OctreeRef; the classification predicates are module-level (consulted by slug
  // from the renderers), so we re-register here whenever the cloud set changes
  // — covering both fresh imports and a future session restore. Additive only:
  // we never unregister, since two clouds could legitimately share a slug.
  useEffect(() => {
    for (const cloud of clouds) {
      for (const slug of cloud.data.octree?.categoricalAttributes ?? []) {
        registerCategoricalSlug(slug);
      }
      for (const slug of cloud.data.octree?.continuousAttributes ?? []) {
        registerContinuousSlug(slug);
      }
    }
  }, [clouds]);
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
  // Mesh-lighting multiplier for lit meshes (plants, scanner OBJ models).
  // Shown 1:1 in the Display panel; the physical light intensity is this
  // value × LIGHT_INTENSITY_SCALE, applied to both the ambient and key
  // directional light so meshes brighten/darken together. Point clouds use
  // unlit materials and are unaffected. Default 1.0 reproduces the prior
  // 1.125 intensity (= 0.75 base × 1.5).
  const [lightIntensity, setLightIntensity] = useState(1.0);
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
  // before its material effect could override potree-core's defaults recompiles
  // its shader with geometry present — the same cure as a manual mode toggle.
  //
  // This used to be gated to gradient/scalar modes only, on the assumption that
  // per-scan / single / rgb "render correctly on first paint." That assumption
  // breaks under batch import: when several octrees mount at once, the first
  // paint can land before the material effect runs, so a per-scan cloud renders
  // with potree-core's DEFAULT pointColorType (elevation) instead of our COLOR
  // material — the cloud shows a flat z-height/grey ramp until the user toggles
  // color mode and back. Because per-scan was excluded here, nothing corrected
  // it. We now fire for EVERY mode so the one-shot recompile always runs.
  // Guarded → fires at most once per cacheId, never loops.
  const handleOctreeFirstTiles = useCallback((cacheId: string) => {
    if (octreePaintedRef.current.has(cacheId)) return;
    octreePaintedRef.current.add(cacheId);
    // Test hook: E2E can't read WebGL pixels in the offscreen window, so it
    // verifies the first-paint recompile by reading the set of cacheIds the
    // one-shot fix fired for. See tests/e2e/import-multi-pointcloud.spec.ts.
    (window as any).__octreeRepainted = Array.from(octreePaintedRef.current);
    setOctreePaintGen(prev => ({ ...prev, [cacheId]: (prev[cacheId] ?? 0) + 1 }));
  }, []);
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
  // Show/hide the scan-position model markers (the scanner-shaped meshes). On by
  // default. Session-only, like the Grid/Axes toggles next to it.
  const [showScanMarkers, setShowScanMarkers] = useState(true);
  // Scan-pattern wireframe overlay (each scanner's angular coverage). OFF by
  // default; toggled from the native View menu (the menu checkbox is the source
  // of truth). Session-only like showScanMarkers.
  const [showScanWireframes, setShowScanWireframes] = useState(false);
  // Global size multiplier for scan markers, seeded from persisted settings.
  const [scanMarkerScale, setScanMarkerScale] = useState(1);
  const [displayPanelCollapsed, setDisplayPanelCollapsed] = useState(true);
  const [gizmoDragging, setGizmoDragging] = useState(false);
  const [bgColor, setBgColor] = useState<'black' | 'white'>('black');
  const [bgStyle, setBgStyle] = useState<'solid' | 'gradient'>('solid');

  // Mesh state — now store-owned so add/remove are undoable. Reads keep array
  // syntax; non-history `.map(...)` mutations (visibility, color, spacing checks,
  // grid, morph) keep `setMeshes(prev => ...)` via the adapter; genuine add/remove
  // go through scene.commit in their handlers.
  const meshes = scene.state.meshes;
  const setMeshes = useMemo(() => makeFieldSetter('meshes'), [makeFieldSetter]);
  // Per-mesh opacity (0.1–1). Absent entry means MESH_DEFAULT_OPACITY. Only
  // surfaced for meshes where blending is meaningful — i.e. solid / vertex-
  // colored surfaces, not textured plants whose alpha-cutout leaf materials
  // ignore opacity (see meshSupportsOpacity / TexturedPlantMesh).
  const [meshOpacities, setMeshOpacities] = useState<Map<string, number>>(new Map());
  const [meshWireframe, setMeshWireframe] = useState(false);
  // Per-mesh pseudocolor mode (color by inclination / azimuth / area / scan).
  // Absent entry means 'solid'. The colormap is shared with point-cloud scalar
  // modes.
  const [meshColorModes, setMeshColorModes] = useState<Map<string, MeshColorMode>>(new Map());
  // Which mesh rows have their inline "Color by" section expanded.
  const [expandedMeshIds, setExpandedMeshIds] = useState<Set<string>>(new Set());
  // Inline rename: which mesh row is being edited, and the in-progress text.
  const [renamingMeshId, setRenamingMeshId] = useState<string | null>(null);
  const [renamingMeshValue, setRenamingMeshValue] = useState('');
  // Which mesh row's color popover is open (null = none), and the screen anchor
  // (the swatch's bounding rect) so the popover can render as a fixed overlay —
  // escaping the panel's overflow clip and backdrop-blur stacking context.
  const [colorPopoverMeshId, setColorPopoverMeshId] = useState<string | null>(null);
  const [colorPopoverAnchor, setColorPopoverAnchor] = useState<{ top: number; left: number } | null>(null);
  // Same anchored-overlay pattern for per-scan color, keyed by scan id.
  const [colorPopoverScanId, setColorPopoverScanId] = useState<string | null>(null);
  const [scanColorPopoverAnchor, setScanColorPopoverAnchor] = useState<{ top: number; left: number } | null>(null);

  // Triangulation state. The unified TriangulationPopup owns the method + per-
  // method parameters (radius / depth / alpha) as local form state; the viewer
  // only tracks whether the modal is open and the run's in-progress / error state.
  const [showTriangulationPopup, setShowTriangulationPopup] = useState(false);
  const [triangulationInProgress, setTriangulationInProgress] = useState(false);
  const [triangulationError, setTriangulationError] = useState<string | null>(null);
  // Per-stage progress shared by the Open3D and Helios triangulation handlers;
  // which pill renders is gated by triangulationInProgress / isHeliosRunning.
  const [triProgress, setTriProgress] = useState<{ label: string; value: number | null } | null>(null);
  const triAbortRef = useRef<AbortController | null>(null);
  // Backend cancellation token for the in-flight triangulation (its first PHP1
  // marker). Cancel POSTs /api/cancel/{runId} so the server stops and frees memory.
  const triRunIdRef = useRef<string | null>(null);
  // Per-stage progress for the leaf-area-density inversion (mirrors triProgress).
  const [ladProgress, setLadProgress] = useState<{ label: string; value: number | null } | null>(null);
  // Backend cancellation token for the in-flight LAD inversion.
  const ladRunIdRef = useRef<string | null>(null);

  // Ground segmentation state (Cloth Simulation Filter)
  const [showGroundSegmentPanel, setShowGroundSegmentPanel] = useState(false);
  const [groundSegmentInProgress, setGroundSegmentInProgress] = useState(false);
  const [groundSegmentError, setGroundSegmentError] = useState<string | null>(null);
  const [groundClothResolution, setGroundClothResolution] = useState(0.05);
  const [groundClassThreshold, setGroundClassThreshold] = useState(0.02);
  const [groundRigidness, setGroundRigidness] = useState(3);
  const [groundSplitClouds, setGroundSplitClouds] = useState(false);
  // Seed CSF cloth-resolution / class-threshold from the selected cloud's
  // horizontal extent each time the ground panel OPENS. CSF's params are
  // absolute distances, so a fixed default that suits a ~1 m plant scan badly
  // under-segments a 50 m field (nearly everything labelled non-ground); scaling
  // by extent makes the out-of-the-box run sensible at any scale, and the user
  // can still override in the panel. Guarded by a ref so it only fires on the
  // open transition — re-running on a later `clouds`/`selectedIds` change would
  // clobber any manual tweaks the user made while the panel is open.
  const groundPanelWasOpen = useRef(false);
  useEffect(() => {
    if (showGroundSegmentPanel && !groundPanelWasOpen.current) {
      const sel = clouds.find((c) => selectedIds.has(c.id));
      const size = sel?.data.bounds?.size;
      if (size) {
        const defaults = groundSegmentDefaultsForExtent(Math.max(size.x, size.y));
        setGroundClothResolution(defaults.clothResolution);
        setGroundClassThreshold(defaults.classThreshold);
      }
    }
    groundPanelWasOpen.current = showGroundSegmentPanel;
  }, [showGroundSegmentPanel, clouds, selectedIds]);
  // Wood/leaf segmentation state (geometric, non-ML).
  const [showWoodSegmentPanel, setShowWoodSegmentPanel] = useState(false);
  const [woodSegmentInProgress, setWoodSegmentInProgress] = useState(false);
  const [woodSegmentError, setWoodSegmentError] = useState<string | null>(null);
  const [woodBias, setWoodBias] = useState(0.6);
  const [woodKMax, setWoodKMax] = useState(100);
  const [woodRegIters, setWoodRegIters] = useState(3);
  const [woodMode, setWoodMode] = useState<WoodSegmentMode>('label');
  // >1 scan: 'aggregate' segments them together (denser geometry) then writes
  // labels back to each; 'per-scan' segments each independently.
  const [woodMultiMode, setWoodMultiMode] = useState<WoodMultiMode>('per-scan');
  // Classification method: 'sota' (branch-segment + cylinder-fit — recovers thin
  // branches without flooding leaves; needs ground removed) is the default;
  // 'connectivity' (skeleton backbone) and 'geometric' (point-wise) are alternatives.
  const [woodMethod, setWoodMethod] = useState<WoodMethod>('sota');
  // Reflectance assist (opt-in toggle; defaults on when the selected cloud
  // carries a reflectance/intensity scalar — see woodReflectanceAvailable).
  const [woodUseReflectance, setWoodUseReflectance] = useState(true);
  // segment_wood's reflectance_weight_max when the assist is active.
  const WOOD_REFLECTANCE_WEIGHT_MAX = 0.4;
  // Holds the latest single-cloud wood segmenter; see segmentOneWoodCloud below.
  const segmentOneWoodCloudRef = useRef<(cloud: PointCloudEntry, WOOD: number, LEAF: number, woodParams: WoodSegmentTuning) => Promise<void>>(async () => {});
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

  // Skeleton state — store-owned so add/remove are undoable (Phase C).
  const skeletons = scene.state.skeletons;
  const setSkeletons = useMemo(() => makeFieldSetter('skeletons'), [makeFieldSetter]);
  const [skeletonTubeRadius, setSkeletonTubeRadius] = useState(0.02);
  const [skeletonColorByBranchOrder, setSkeletonColorByBranchOrder] = useState(false);
  const [skeletonShowAsCylinders, setSkeletonShowAsCylinders] = useState(true);

  // Selection state for meshes and skeletons (internal)
  const [selectedMeshIds, setSelectedMeshIds] = useState<Set<string>>(new Set());
  // Derived single mesh ID for backward compatibility (first selected mesh)
  const selectedMeshId = selectedMeshIds.size > 0 ? Array.from(selectedMeshIds)[0] : null;
  // Skeletons are multi-selectable (Set) like meshes; selectedSkeletonId is the
  // back-compat first-element derive that the translate gizmo / edit memos read
  // as "the focused skeleton".
  const [selectedSkeletonIds, setSelectedSkeletonIds] = useState<Set<string>>(new Set());
  const selectedSkeletonId = useMemo(() => (selectedSkeletonIds.size > 0 ? Array.from(selectedSkeletonIds)[0] : null), [selectedSkeletonIds]);

  // Range-select anchors (last plain/ctrl-clicked id) for Shift+click in each
  // panel, mirroring the Scans panel's lastSelectedScanIdRef in App.
  const lastSelectedMeshIdRef = useRef<string | null>(null);
  const lastSelectedSkeletonIdRef = useRef<string | null>(null);
  // Pointer-down position (client px) over the viewport, so the empty-space
  // deselect (onPointerMissed, whose native event carries no R3F drag `delta`)
  // can tell a click from a camera-orbit drag that happened to end on nothing.
  const viewportPointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const lastSelectedQSMIdRef = useRef<string | null>(null);

  // Copy confirmation flash state
  const [coordsCopied, setCoordsCopied] = useState(false);

  // Delete confirmation dialog state. `ids` is a batch (length 1 for a single
  // row's trash button, N for a header bulk delete); `label` is either the one
  // item's name or a count like "3 scans".
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: 'mesh' | 'skeleton' | 'cloud' | 'qsm';
    ids: string[];
    label: string;
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

  // QSM (Quantitative Structure Model) build state. Mirrors the skeleton feature:
  // a build panel + options, a results panel, and a 3D renderer. The headline is
  // the per-shoot RANK (continuous shoots classified by branching order with axis
  // continuation, trunk=0). All compute is in the qsm/ backend package.
  const [showQSMPopup, setShowQSMPopup] = useState(false);
  const [qsmInProgress, setQSMInProgress] = useState(false);
  const [qsmError, setQSMError] = useState<string | null>(null);
  // Per-scan QSM build progress for the StatusPill (mirrors backfillProgress).
  const [qsmProgress, setQSMProgress] = useState<{ label: string; value: number | null } | null>(null);
  const qsmAbortRef = useRef<AbortController | null>(null);
  // QSM state — store-owned so add/remove are undoable (Phase C).
  const qsms = scene.state.qsms;
  const setQSMs = useMemo(() => makeFieldSetter('qsms'), [makeFieldSetter]);
  // The QSM id whose Add-Leaves modal is open (null = closed).
  const [addLeavesQSMId, setAddLeavesQSMId] = useState<string | null>(null);
  // The QSM id whose Adjust-Leaf-Angles modal is open (null = closed).
  const [adjustLeavesQSMId, setAdjustLeavesQSMId] = useState<string | null>(null);
  const [qsmColorMode, setQSMColorMode] = useState<QSMColorMode>('rank');
  // QSM-entry multi-selection (for the panel header bulk actions).
  const [selectedQSMIds, setSelectedQSMIds] = useState<Set<string>>(new Set());
  // Stable "zoom to selection" entry point. The implementation closes over
  // getSnapViewTarget (declared further down), so it's assigned each render to a
  // ref here that earlier callbacks (command registry, keydown) can call safely.
  const zoomToSelectionRef = useRef<() => void>(() => {});
  // QSM export dialog: format + per-QSM selection, then one file per QSM into a
  // user-picked folder. See handleExportQSMs below.
  const [showQSMExportPanel, setShowQSMExportPanel] = useState(false);
  const [qsmExporting, setQSMExporting] = useState(false);

  // Clear any stale QSM error when the modal opens, so a failure from a previous
  // attempt doesn't linger after the user closes and re-opens the modal (e.g.
  // after re-importing a scan that had failed).
  useEffect(() => {
    if (showQSMPopup) setQSMError(null);
  }, [showQSMPopup]);

  // Import functions for external use
  const importMesh = useCallback((
    mesh: Omit<MeshEntry, 'id'>,
    transform?: {
      position?: { x: number; y: number; z: number };
      scale?: { x: number; y: number; z: number };
      rotation?: { x: number; y: number; z: number };
    },
  ) => {
    const newMesh: MeshEntry = {
      ...mesh,
      id: crypto.randomUUID(),
    };
    // One undoable `add`, with the transform seeded so the first translate/scale/
    // rotate reads a real origin (matches the shape/plant creation paths).
    addMesh(newMesh, {
      position: transform?.position ?? { x: 0, y: 0, z: 0 },
      rotation: transform?.rotation ?? { x: 0, y: 0, z: 0 },
      scale: transform?.scale ?? { x: 1, y: 1, z: 1 },
    });
  }, [addMesh]);

  const importSkeleton = useCallback((skeleton: Omit<SkeletonEntry, 'id'>) => {
    const newSkeleton: SkeletonEntry = {
      ...skeleton,
      id: crypto.randomUUID(),
    };
    addSkeleton(newSkeleton, 'Import skeleton');
  }, [addSkeleton]);

  // Bulk-import scans + grids parsed from a Helios scan XML. This is the shared
  // workhorse behind every XML entry point: the Add-Scan popup's "Import from
  // XML file" button, the File → Import menu, and the viewport drop zone (the
  // latter two reach it via importRefsCallback below). It owns its own progress
  // modal and success/failure toasts. xmlPath is the on-disk path of the XML so
  // relative <filename> references can be resolved; null when unavailable.
  const bulkImportScans = useCallback(async (
    heliosScans: HeliosXmlScan[],
    grids: HeliosXmlGrid[],
    xmlPath: string | null,
  ): Promise<void> => {
    if (heliosScans.length === 0 && grids.length === 0) return;
    // Create voxel-grid meshes from any <grid> blocks first — they're
    // independent of scans (top-level siblings) and need no wizard, so a
    // grid-only XML still produces objects. Each grid maps onto a voxel
    // box: center → position, size → scale, Nx/Ny/Nz → gridSubdivisions,
    // rotation (deg about z) → mesh z-rotation.
    grids.forEach((g, i) => {
      importMesh(
        {
          sourceCloudId: `helios-grid-${i}`,
          data: generateShapeMesh('voxel'),
          visible: true,
          color: '#60a5fa', // same blue as Create Voxel
          method: 'delaunay', // placeholder, matches handleCreateShape
          name: g.label,
          gridSubdivisions: { ...g.subdivisions },
        },
        {
          position: { ...g.center },
          scale: { ...g.size },
          rotation: { x: 0, y: 0, z: g.rotationDeg },
        },
      );
    });
    if (heliosScans.length === 0) {
      showToast({ title: `Imported ${grids.length} grid(s)`, type: 'success' });
      return;
    }
    const xmlDir = xmlPath ? dirname(xmlPath) : '';
    const used = new Set(scans.map(s => s.color));
    const allocateColor = () => {
      const chosen = allocateScanColor(used);
      used.add(chosen);
      return chosen;
    };
    // Renumber labels off the current count so an import after manual
    // adds doesn't collide with existing "Scan N" names.
    const offset = scans.length;
    // Failures attaching point data are fatal to the whole import:
    // committing scans without points leaves the user with empty,
    // useless entries (e.g. when the backend is down). We collect
    // failures here and, if any occurred, abort without adding any
    // scans so the user can fix the cause and re-import.
    const failures: { label: string; reason: string }[] = [];
    // Show the progress modal immediately so the user knows the import
    // is in flight — backend parsing of a multi-GB scan can take 30s+
    // and the launching popup has already closed.
    setBulkImportProgress({
      current: 0,
      total: heliosScans.length,
      label: 'Preparing…',
    });
    try {
      // Phase 1: resolve every referenced file FIRST (keeps the existing
      // missing-file prompt), and split scans into those with data
      // (→ wizard) and params-only scans. A scan whose file can't be
      // located is a hard failure (all-or-nothing, as before).
      type Pending = { label: string; color: string; params: typeof heliosScans[number]['params'];
                       resolved: string | null; asciiFormat: string | null };
      const pending: Pending[] = [];
      for (let i = 0; i < heliosScans.length; i++) {
        const h = heliosScans[i];
        const label = `Scan ${offset + i + 1}`;
        setBulkImportProgress({
          current: i + 1,
          total: heliosScans.length,
          label: h.filename ? `Locating ${h.filename.split(/[\\/]/).pop()}` : `Preparing ${label}`,
        });
        let resolved: string | null = null;
        if (h.filename) {
          try {
            resolved = await resolveAttachedScanFile(h.filename, xmlDir);
            if (!resolved) throw new Error(`could not locate file "${h.filename}"`);
          } catch (err) {
            failures.push({ label, reason: err instanceof Error ? err.message : String(err) });
          }
        }
        pending.push({ label, color: allocateColor(), params: h.params, resolved, asciiFormat: h.asciiFormat });
      }
      if (failures.length > 0) {
        const detail = failures.slice(0, 3).map(f => `${f.label}: ${f.reason}`).join('; ');
        const more = failures.length > 3 ? ` (+${failures.length - 3} more)` : '';
        throw new Error(
          `${failures.length} of ${heliosScans.length} scan(s) could not load point data — ${detail}${more}. ` +
            `No scans were imported; fix the issue and re-import.`,
        );
      }

      // Phase 2: walk the scans that carry a file through the import
      // wizard (one stepper for all of them), carrying their Helios
      // params + ASCII_format hint. Params-only scans skip the wizard.
      const wizardPending = pending.filter(p => p.resolved);
      const inputs: WizardScanInput[] = wizardPending.map(p => ({
        path: p.resolved!,
        fileName: p.resolved!.split(/[\\/]/).pop() ?? p.label,
        asciiFormatHint: p.asciiFormat,
        params: p.params,
        label: p.label,
        color: p.color,
      }));

      let results: WizardResult[] | null = inputs.length === 0 ? [] : null;
      if (inputs.length > 0) {
        // Hide the progress modal while the wizard is up.
        setBulkImportProgress(null);
        results = onRequestImportWizard
          ? await onRequestImportWizard(inputs)
          : // No wizard host (defensive): import with auto-detect.
            inputs.map(input => ({ input, asciiFormat: input.asciiFormatHint ?? null, columnPlan: null, categoricalSlugs: [], continuousSlugs: [], worldShift: null }));
        if (!results) return; // user cancelled the wizard
      }

      // Phase 3: build the Scans. Wizard results carry data; params-only
      // scans are added as-is.
      const newScans: Scan[] = [];
      let attachedCount = 0;
      const byPath = new Map(results!.map(r => [r.input.path, r]));
      for (const p of pending) {
        const scan: Scan = {
          id: crypto.randomUUID(),
          label: p.label,
          visible: true,
          color: p.color,
          params: p.params,
        };
        if (p.resolved) {
          const r = byPath.get(p.resolved);
          if (r) {
            setBulkImportProgress({ current: attachedCount + 1, total: wizardPending.length, label: `Loading ${r.input.fileName}` });
            try {
              const data = await parsePointCloudFromPath(p.resolved, r.asciiFormat, r.columnPlan, r.categoricalSlugs, null, r.continuousSlugs);
              for (const slug of r.categoricalSlugs) registerCategoricalSlug(slug);
              for (const slug of r.continuousSlugs) registerContinuousSlug(slug);
              scan.data = data;
              scan.sourcePath = p.resolved;
              scan.asciiFormat = r.asciiFormat;
              // Reconstructed scan params from the file (e.g. a LAS with per-pulse
              // beam-origin ExtraBytes → a moving-platform trajectory) populate the
              // scan's parameters when the import didn't already carry them.
              if (!scan.params && data.octree?.scanParams) {
                scan.params = scanParametersFromFile(data.octree.scanParams);
              }
              attachedCount += 1;
            } catch (err) {
              failures.push({ label: p.label, reason: err instanceof Error ? err.message : String(err) });
            }
          }
        }
        newScans.push(scan);
      }
      if (failures.length > 0) {
        const detail = failures.slice(0, 3).map(f => `${f.label}: ${f.reason}`).join('; ');
        const more = failures.length > 3 ? ` (+${failures.length - 3} more)` : '';
        throw new Error(
          `${failures.length} of ${heliosScans.length} scan(s) could not load point data — ${detail}${more}. ` +
            `No scans were imported; fix the issue and re-import.`,
        );
      }

      onAddScans?.(newScans);
      const parts = [`${newScans.length} scan(s)`];
      if (attachedCount > 0) parts.push(`${attachedCount} with data`);
      if (grids.length > 0) parts.push(`${grids.length} grid(s)`);
      showToast({ title: `Imported ${parts.join(', ')}`, type: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Bulk import failed:', err);
      // Persist (duration 0): a hard "nothing was imported" failure must
      // not flash away in 3s — the user needs to read it and act.
      showToast({ title: `Import failed: ${msg}`, type: 'error', duration: 0 });
    } finally {
      // Always clear the modal — leaving it up would lock the UI.
      setBulkImportProgress(null);
    }
  }, [importMesh, onRequestImportWizard, onAddScans, scans]);

  // Expose import functions to parent
  useEffect(() => {
    if (importRefsCallback) {
      importRefsCallback({ importMesh, importSkeleton, bulkImportScans });
    }
  }, [importRefsCallback, importMesh, importSkeleton, bulkImportScans]);

  // Report whether the viewer holds any non-scan content (meshes, skeletons, or
  // QSMs) so App can dismiss the empty-state hint when e.g. a plant is generated
  // or a QSM is built — these outlive the source scan, so deleting the scan must
  // not bring the import overlay back while they're still rendered.
  useEffect(() => {
    onViewerContentChange?.(meshes.length > 0 || skeletons.length > 0 || qsms.length > 0);
  }, [onViewerContentChange, meshes.length, skeletons.length, qsms.length]);

  // Export panel state
  const [showExportPanel, setShowExportPanel] = useState(false);

  // Global app settings (persisted via electron-store, edited in SettingsDialog).
  // Loaded once on mount: the triangulate point cap for octree clouds, plus the
  // default background color and point size that seed the per-session viewer
  // controls below. The SettingsDialog owns editing; here we only consume.
  const [triangulateMaxPoints, setTriangulateMaxPoints] = useState(5_000_000);
  // Soft cap (MB) on the synthetic-scan ray-tracing buffers; null = Helios default.
  const [syntheticScanMemoryBudgetMb, setSyntheticScanMemoryBudgetMb] = useState<number | null>(null);
  const settingsSeededRef = useRef(false);
  useEffect(() => {
    getSettings()
      .then(s => {
        setTriangulateMaxPoints(s.triangulateMaxPoints);
        setSyntheticScanMemoryBudgetMb(s.syntheticScanMemoryBudgetMb);
        setScanMarkerScale(s.scanMarkerScale);
        // Background and point size are launch seeds (the Display panel owns the
        // live values), so only adopt them on the very first load — not on every
        // settings-dialog close, which would clobber a session tweak. Marker
        // scale has no live Display control, so it re-reads each time.
        if (!settingsSeededRef.current) {
          settingsSeededRef.current = true;
          setBgColor(s.defaultBackgroundColor);
          setPointSize(s.defaultPointSize);
        }
      })
      .catch(() => {});
    // Re-read when the settings dialog closes (settingsEpoch bumps).
  }, [settingsEpoch]);

  // Subscribe to native-menu commands. Currently only the View > Show Scan Pattern
  // Wireframes checkbox is handled here (the menu item is the source of truth, so we
  // just mirror its post-click state); other MenuCommandPayload kinds are dispatched
  // elsewhere or not yet wired, so they're ignored.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onMenuCommand) return;
    return api.onMenuCommand((payload) => {
      if (payload.kind === 'toggle-scan-wireframes') {
        setShowScanWireframes(payload.show);
      }
    });
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
  // Backfill Misses: a setup modal (scan picker) + a streamed StatusPill progress
  // bar, mirroring the Triangulation / LAD pattern.
  const [showBackfillPopup, setShowBackfillPopup] = useState(false);
  const [isBackfillRunning, setIsBackfillRunning] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ label: string; value: number | null } | null>(null);
  const backfillAbortRef = useRef<AbortController | null>(null);
  // Stops the synthetic-progress ticker for the opaque gapfill stage. Set while a
  // backfill runs so Cancel can clear the interval, not just abort the fetch.
  const backfillSynthStopRef = useRef<(() => void) | null>(null);

  // Shift key tracking for mixed selection (cloud + mesh together)
  const isShiftHeldRef = useRef(false);

  // Shape creator state
  const [shapeCounter, setShapeCounter] = useState(1);
  // Plant generation state
  const [isGeneratingPlant, setIsGeneratingPlant] = useState(false);
  const [showPlantPopup, setShowPlantPopup] = useState(false);
  const [showPlanePopup, setShowPlanePopup] = useState(false);
  // Live build progress (0-1) + phase message, shown in the popup's progress bar.
  const [plantProgress, setPlantProgress] = useState<number | null>(null);
  const [plantProgressMsg, setPlantProgressMsg] = useState('');
  // Abort controller for an in-flight streaming build (Cancel button).
  const plantAbortRef = useRef<AbortController | null>(null);
  // Backend cancellation token for the in-flight build (its first SSE event).
  // Cancel POSTs /api/cancel/{runId} so the C++ build loops bail and free memory.
  const plantRunIdRef = useRef<string | null>(null);
  // Helios triangulation background task state (the setup UI is now the unified
  // TriangulationPopup; isHeliosRunning gates the in-flight Helios run).
  const [isHeliosRunning, setIsHeliosRunning] = useState(false);
  // Which mesh's leaf-angle distribution plot is open (null = closed).
  const [showLeafAngleMeshId, setShowLeafAngleMeshId] = useState<string | null>(null);
  // The QSM whose detailed-results window is open (null = closed).
  const [showQSMResultsId, setShowQSMResultsId] = useState<string | null>(null);
  const heliosAbortRef = useRef<AbortController | null>(null);
  // Multi-input tool dialogs (pick their own inputs; always launchable).
  const [showAlignDialog, setShowAlignDialog] = useState(false);
  const [showStitchDialog, setShowStitchDialog] = useState(false);
  // Leaf area density popup + results + background task state
  const [showLADPopup, setShowLADPopup] = useState(false);
  // LAD results — store-owned so add/remove are undoable (Phase C).
  const ladResults = scene.state.ladResults;
  const setLadResults = useMemo(() => makeFieldSetter('ladResults'), [makeFieldSetter]);
  const [isLadRunning, setIsLadRunning] = useState(false);
  const ladAbortRef = useRef<AbortController | null>(null);
  // The LAD voxel currently under the cursor (for the value readout tooltip).
  const [hoveredLadVoxel, setHoveredLadVoxel] = useState<LADVoxel | null>(null);
  // Which LAD result drives the colorbar / details panel (last computed by default).
  const [selectedLadId, setSelectedLadId] = useState<string | null>(null);
  // True while handleApplyCrop's backend round-trip is in flight. Keeps the
  // crop preview (hidden to-be-cropped points) alive after editMode flips to
  // 'none' and drives the "Cropping…" badge.
  const [isApplyingCrop, setIsApplyingCrop] = useState(false);
  // Synthetic LiDAR scan state
  const [isScanning, setIsScanning] = useState(false);
  // Per-stage progress for the synthetic scan (mirrors triProgress/ladProgress).
  // The uninterruptible C++ ray-trace can't self-report, so executeScan drives a
  // synthetic creep across that stage (see scanSynthStopRef) and `value` stays a
  // finite fraction throughout — a null only briefly precedes the first marker.
  const [scanProgress, setScanProgress] = useState<{ label: string; value: number | null } | null>(null);
  // AbortController for the in-flight scan request, so the user can cancel a
  // hung/long scan. Aborting tears down the HTTP request and frees the UI; the
  // backend ALSO cancels the run (see scanRunIdRef) so the C++ ray trace bails
  // mid-pass and the multi-GB Helios/numpy memory is freed promptly rather than
  // held until a huge scan finishes on its own.
  const scanAbortRef = useRef<AbortController | null>(null);
  // The backend's cancellation token for the in-flight scan (its first PHP1
  // marker). Cancel POSTs /api/cancel/{runId} so the server stops computing.
  const scanRunIdRef = useRef<string | null>(null);
  // Stops the synthetic-progress ticker for the ray-trace stage (reported as
  // null). Set while a scan runs so Cancel clears the interval, not just aborts
  // the fetch (mirrors backfillSynthStopRef).
  const scanSynthStopRef = useRef<(() => void) | null>(null);
  const cancelScan = useCallback(() => {
    scanSynthStopRef.current?.();
    // Tell the backend to stop and free memory, THEN tear down the fetch. Order
    // matters: aborting first can drop the request before the cancel lands, but
    // the backend's own disconnect detection is a backstop either way.
    if (scanRunIdRef.current) void cancelRun(scanRunIdRef.current);
    scanAbortRef.current?.abort();
  }, []);
  // Pending scan awaiting the user's choice when ≥1 target scanner already holds
  // point data (overwrite / duplicate / cancel). Null when no prompt is open.
  // Carries the chosen synthetic-scan options so the run proceeds with them.
  const [scanOverwriteConfirm, setScanOverwriteConfirm] = useState<{
    targetMeshes: MeshEntry[];
    activeScanners: Scan[];
    count: number;
    options: SyntheticScanOptions;
  } | null>(null);
  // Validated scan targets awaiting the Synthetic Scan Options popup. The popup
  // sits between "Run Synthetic LiDAR Scan" and the actual run so the user picks
  // noise / misses / waveform / crop-to-grid each run. Null when closed.
  const [pendingScan, setPendingScan] = useState<{
    targetMeshes: MeshEntry[];
    activeScanners: Scan[];
  } | null>(null);
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
  // Transform maps now live in the scene store (single owner; enables undo of
  // adds/removes that seed transforms). Reads keep the `.get(id)` syntax; writes
  // keep the `setX(prev => ...)` syntax via the makeFieldSetter adapter above.
  // Mesh scales - per mesh id, default {x:1,y:1,z:1}
  const meshScales = scene.state.meshScales;
  const setMeshScales = useMemo(() => makeFieldSetter('meshScales'), [makeFieldSetter]);
  // Mesh positions - per mesh id, default {x:0,y:0,z:0}
  const meshPositions = scene.state.meshPositions;
  const setMeshPositions = useMemo(() => makeFieldSetter('meshPositions'), [makeFieldSetter]);
  // Mesh rotations - per mesh id in degrees, default {x:0,y:0,z:0}
  const meshRotations = scene.state.meshRotations;
  const setMeshRotations = useMemo(() => makeFieldSetter('meshRotations'), [makeFieldSetter]);
  // Skeleton positions - per skeleton id, default {x:0,y:0,z:0}
  const skeletonPositions = scene.state.skeletonPositions;
  const setSkeletonPositions = useMemo(() => makeFieldSetter('skeletonPositions'), [makeFieldSetter]);
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
  const [duplicateProgress, setDuplicateProgress] = useState<BulkImportProgressState | null>(null);
  // Per-row expansion state for the scans panel. Held in-memory only; resets
  // on app reload.
  const [expandedScanIds, setExpandedScanIds] = useState<Set<string>>(new Set());

  // Edit mode and per-cloud edit states
  const [editMode, setEditMode] = useState<EditMode>('none');

  // Lower the octree point budget while a crop box is being previewed, restore
  // when it ends. potree clips with a fragment `discard` (no early-Z), so the
  // GPU can't cull occluded points during preview and overdraw goes quadratic
  // with on-screen point density — concentrating the crop box pins the frame
  // rate to single digits on a large cloud. Fewer points ⇒ proportionally fewer
  // fragment invocations. The budget is global (shared potree manager), which is
  // fine: crop is a modal, single-cloud-focused mode. Apply re-converts at full
  // resolution, so the reduced preview detail never reaches the saved cloud.
  const cropPreviewActive = editMode === 'crop' || isApplyingCrop;
  useEffect(() => {
    const budget = cropPreviewActive ? CROP_PREVIEW_POINT_BUDGET : DEFAULT_POINT_BUDGET;
    setPointBudget(budget);
    // E2E hook: lets a test confirm the preview budget engages/restores.
    (window as { __pointBudget?: number }).__pointBudget = budget;
    return () => {
      setPointBudget(DEFAULT_POINT_BUDGET);
      (window as { __pointBudget?: number }).__pointBudget = DEFAULT_POINT_BUDGET;
    };
  }, [cropPreviewActive]);
  // Cloud edit states (translation + erased indices + pending deletes) now live
  // in the scene store. Reads keep `.get(id)`; writes keep `setEditStates(prev => ...)`.
  const editStates = scene.state.editStates;
  const setEditStates = useMemo(() => makeFieldSetter('editStates'), [makeFieldSetter]);

  // Report the count of clouds with unbaked deletions up to App (drives the
  // before-quit warning). Only erase deletes accumulate as pendingDeletes;
  // crops/filters/segments bake immediately, so this is the erase-not-yet-baked
  // count.
  useEffect(() => {
    if (!onPendingDeletesChange) return;
    let count = 0;
    for (const st of editStates.values()) {
      if ((st.pendingDeletes?.length ?? 0) > 0) count++;
    }
    onPendingDeletesChange(count);
  }, [editStates, onPendingDeletesChange]);

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

  // Erase brush state.
  //
  // Flat clouds keep the old per-point model (eraseBrushSize world radius +
  // erasedIndices). Octree clouds use the screen-space SQUARE-STAMP model: the
  // brush is a screen-pixel square, painted stamps accumulate into eraseFrame
  // (centers + frozen camera) for the backend Apply, the live preview is a set
  // of camera-aligned clip boxes, and the indicator is a camera-facing square.
  const [eraseBrushSize, setEraseBrushSize] = useState(0.1);  // flat-cloud world radius
  const [eraseBrushPosition, setEraseBrushPosition] = useState<THREE.Vector3 | null>(null);
  const [isErasing, setIsErasing] = useState(false);
  // Erase MODE within the open Erase tool. The tool (editMode === 'erase') can
  // be open with the panel visible while the view stays interactive; toggling
  // erase mode ON freezes the view and makes clicks stamp. Controlled by the
  // panel's toggle button and the 'e' key (only when the tool is open). Always
  // starts OFF so opening the tool lets the user frame their view first.
  const [eraseActive, setEraseActive] = useState(false);
  // Octree erase (screen-space squares): brush half-size in canvas pixels.
  const [eraseBrushPx, setEraseBrushPx] = useState(24);
  // Painted square stamps + frozen camera, sent to crop_octree on Apply.
  const [eraseFrame, setEraseFrame] = useState<EraseSquareFrame | null>(null);
  // Per-stamp camera-aligned clip-box transforms driving the live GPU preview.
  const [erasePreviewBoxes, setErasePreviewBoxes] = useState<THREE.Matrix4[]>([]);
  // Camera-facing square indicator transform that follows the cursor.
  const [eraseBrushMatrix, setEraseBrushMatrix] = useState<THREE.Matrix4 | null>(null);
  // Live PointCloudOctree of the selected cloud, handed up by OctreePointCloud
  // so the octree erase brush can pick the hovered surface point. Typed loosely
  // to avoid importing potree-core's class into this already-large module.
  const eraseOctreeRef = useRef<{ pick: (...args: unknown[]) => unknown } | null>(null);

  // Undo/redo history now lives in the scene store (scene.commit / scene.undo /
  // scene.redo / scene.boundary). isUndoingRef still guards capture during replay
  // so applying a store undo doesn't re-record a new transaction.
  const isUndoingRef = useRef(false);

  // Refs to track latest positions synchronously (for history capture during drag)
  const meshPositionsRef = useRef<Map<string, { x: number; y: number; z: number }>>(new Map());
  const meshRotationsRef = useRef<Map<string, { x: number; y: number; z: number }>>(new Map());
  const meshScalesRef = useRef<Map<string, { x: number; y: number; z: number }>>(new Map());
  // Latest scene grid options, mirrored for callbacks defined before the memo
  // (e.g. exportScanXmlBundle) so they can resolve grid ids without a stale dep.
  const heliosGridOptionsRef = useRef<GridOption[]>([]);
  const skeletonPositionsRef = useRef<Map<string, { x: number; y: number; z: number }>>(new Map());

  // Blender-style modal transform state: T (translate), S (scale) with X/Y/Z axis lock
  // and Shift+X/Y/Z plane lock (Shift+X = constrain to YZ plane, etc.).
  type TransformAxis = 'free' | 'x' | 'y' | 'z' | 'yz' | 'xz' | 'xy';
  interface TransformModalState {
    op: 'translate' | 'scale' | 'rotate';
    axis: TransformAxis;
    startScreen: { x: number; y: number };
    pivot: { x: number; y: number; z: number };
    target: 'mesh' | 'skeleton' | 'cloud';
    meshId?: string;
    skeletonId?: string;
    cloudIds?: string[];
    originalMeshPos?: { x: number; y: number; z: number };
    originalMeshScale?: { x: number; y: number; z: number };
    originalMeshRot?: { x: number; y: number; z: number };
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
      // Frame *all* newly added clouds, not just the first — importing several
      // at once should fit the camera to their union, not whichever loaded
      // first. Accumulate min/max over every new cloud with bounds (same union
      // pattern as the combinedBounds useMemo below).
      const newIdSet = new Set(newCloudIds);
      const min = new THREE.Vector3(Infinity, Infinity, Infinity);
      const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const cloud of clouds) {
        if (!newIdSet.has(cloud.id) || !cloud.data.bounds) continue;
        min.min(cloud.data.bounds.min);
        max.max(cloud.data.bounds.max);
      }
      if (isFinite(min.x)) {
        const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
        const size = new THREE.Vector3().subVectors(max, min);
        // Small delay to ensure camera controller is ready
        setTimeout(() => {
          const snapToView = (window as any).__snapToView;
          if (snapToView) {
            snapToView('iso', { center, size });
          }
        }, 50);
      }
    }

    // Update ref with current IDs
    prevCloudIdsRef.current = currentIds;
  }, [clouds]);

  // Track previous mesh IDs to detect new additions
  const prevMeshIdsRef = useRef<Set<string>>(new Set());

  // Frame a newly added mesh WITHOUT changing the viewing angle. We deliberately
  // use __frameSelection (preserves the current camera→target direction and up
  // vector, only re-centers + re-zooms) rather than __snapToView('iso', …),
  // which would slam the camera to a fixed isometric angle and reset camera.up —
  // rotating the view ~180° just because e.g. a voxel grid was added to a scene
  // the user had already orbited. First-content framing is handled separately by
  // the empty→loaded iso snap in CameraController.
  useEffect(() => {
    const currentIds = new Set(meshes.map(m => m.id));
    const prevIds = prevMeshIdsRef.current;

    const newMeshIds = [...currentIds].filter(id => !prevIds.has(id));

    if (newMeshIds.length > 0) {
      const newMesh = meshes.find(m => m.id === newMeshIds[0]);
      if (newMesh && newMesh.data.vertices && newMesh.data.vertexCount > 0) {
        setTimeout(() => {
          const frameSelection = (window as any).__frameSelection;
          if (frameSelection) {
            // Frame the mesh in WORLD space. computeBoundsFromPositions on the raw
            // local vertices ignores the mesh transform, which for a Helios <grid>
            // voxel (a unit cube placed at [center] with [size] scale) collapses to
            // a ±0.5 box at the origin and makes the framing zoom to near-zero
            // distance, culling everything. Transform first (scale -> rotate Euler
            // XYZ -> translate, matching extractMeshWorldGeometry).
            const pos = meshPositionsRef.current.get(newMesh.id) || { x: 0, y: 0, z: 0 };
            const scl = meshScalesRef.current.get(newMesh.id) || { x: 1, y: 1, z: 1 };
            const rot = meshRotationsRef.current.get(newMesh.id) || { x: 0, y: 0, z: 0 };
            const rotX = rot.x * Math.PI / 180, rotY = rot.y * Math.PI / 180, rotZ = rot.z * Math.PI / 180;
            const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
            const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
            const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);
            const min = new THREE.Vector3(Infinity, Infinity, Infinity);
            const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
            const v = newMesh.data.vertices;
            for (let i = 0; i < newMesh.data.vertexCount; i++) {
              const x = v[i * 3] * scl.x, y = v[i * 3 + 1] * scl.y, z = v[i * 3 + 2] * scl.z;
              const y1 = y * cosX - z * sinX, z1 = y * sinX + z * cosX;
              const x2 = x * cosY + z1 * sinY, z2 = -x * sinY + z1 * cosY;
              const x3 = x2 * cosZ - y1 * sinZ, y3 = x2 * sinZ + y1 * cosZ;
              const wx = x3 + pos.x, wy = y3 + pos.y, wz = z2 + pos.z;
              min.x = Math.min(min.x, wx); min.y = Math.min(min.y, wy); min.z = Math.min(min.z, wz);
              max.x = Math.max(max.x, wx); max.y = Math.max(max.y, wy); max.z = Math.max(max.z, wz);
            }
            const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
            const size = new THREE.Vector3().subVectors(max, min);
            frameSelection({ center, size });
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
    if (except !== 'triangulation') setShowTriangulationPopup(false);
    if (except !== 'ground-segment') setShowGroundSegmentPanel(false);
    if (except !== 'wood-segment') setShowWoodSegmentPanel(false);
    if (except !== 'tree-segment') { setShowTreeSegmentPanel(false); setTreeSeedMode(false); }
    if (except !== 'skeleton') setShowSkeletonPanel(false);
    if (except !== 'qsm') setShowQSMPopup(false);
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

  // Undo/redo now flows through the scene store. These wrappers keep their
  // original names + signatures so the ~15 drag/gizmo/keyboard call sites are
  // unchanged. The two-phase pattern (start captures BEFORE, commit pairs with
  // AFTER and emits one transaction) is preserved; per-frame drag updates still
  // mutate the synchronous refs only — history is recorded on commit.
  const pendingHistoryRef = useRef<{ type: 'cloud' | 'mesh' | 'skeleton'; id: string; before: TransformState | CloudEditState } | null>(null);

  // Capture current state for an object (uses refs for synchronous capture during
  // drag). Returns a flat TransformState for mesh/skeleton, a cloned
  // CloudEditState for cloud.
  const captureTransform = useCallback((type: 'cloud' | 'mesh' | 'skeleton', id: string): TransformState | CloudEditState => {
    if (type === 'mesh') {
      const pos = meshPositionsRef.current.get(id) || { x: 0, y: 0, z: 0 };
      const rot = meshRotationsRef.current.get(id) || { x: 0, y: 0, z: 0 };
      const scl = meshScalesRef.current.get(id) || { x: 1, y: 1, z: 1 };
      return { position: { ...pos }, rotation: { ...rot }, scale: { ...scl } };
    } else if (type === 'skeleton') {
      const pos = skeletonPositionsRef.current.get(id) || { x: 0, y: 0, z: 0 };
      return { position: { ...pos } };
    } else {
      const state = editStates.get(id) || { translation: { x: 0, y: 0, z: 0 }, erasedIndices: new Set<number>() };
      // Deep clone, including the erasedIndices Set (snapshots must not share it).
      return { ...state, erasedIndices: new Set(state.erasedIndices), pendingDeletes: state.pendingDeletes ? state.pendingDeletes.map(r => ({ ...r })) : undefined };
    }
  }, [editStates]);

  // Start a history entry (call before operation begins).
  const startHistoryEntry = useCallback((type: 'cloud' | 'mesh' | 'skeleton', id: string) => {
    if (isUndoingRef.current) return;
    pendingHistoryRef.current = { type, id, before: captureTransform(type, id) };
  }, [captureTransform]);

  // Commit a history entry (call after operation completes): pair BEFORE with the
  // current AFTER and push one transaction to the store.
  const commitHistoryEntry = useCallback(() => {
    if (isUndoingRef.current || !pendingHistoryRef.current) return;
    const { type, id, before } = pendingHistoryRef.current;
    const after = captureTransform(type, id);
    if (type === 'cloud') {
      scene.commit({ label: 'edit cloud', actions: [{ t: 'maskEdit', id, before: before as CloudEditState, after: after as CloudEditState }] });
    } else {
      scene.commit({ label: `move ${type}`, actions: [{ t: 'transform', kind: type, id, before: before as TransformState, after: after as TransformState }] });
    }
    pendingHistoryRef.current = null;
  }, [captureTransform, scene]);

  // Save to history in one step (for immediate operations like move-to-origin).
  // Captures BEFORE; the caller mutates then calls commitHistoryEntry. For a
  // multi-cloud move this records only the FIRST selected cloud (pre-existing
  // limitation; full multi-object batching arrives with the store's transactions
  // in a later phase).
  const saveToHistory = useCallback((overrideType?: 'cloud' | 'mesh' | 'skeleton', overrideId?: string) => {
    if (isUndoingRef.current) return;
    if (overrideType && overrideId) {
      startHistoryEntry(overrideType, overrideId);
    } else if (selectedIds.size > 0) {
      // Only one pendingHistoryRef exists, so the last write wins — matching the
      // pre-store behavior where each startHistoryEntry overwrote the pending entry.
      for (const id of selectedIds) {
        startHistoryEntry('cloud', id);
      }
    }
  }, [selectedIds, startHistoryEntry]);

  // Undo via the unified store. Stitch is now just another transaction in the
  // same history (Phase D folded the old separate stitch stack in), so there's
  // no longer a special-cased stitch-first branch.
  const handleUndo = useCallback(() => {
    isUndoingRef.current = true;
    scene.undo();
    setTimeout(() => { isUndoingRef.current = false; }, 0);
  }, [scene]);

  // Redo
  const handleRedo = useCallback(() => {
    isUndoingRef.current = true;
    scene.redo();
    setTimeout(() => { isUndoingRef.current = false; }, 0);
  }, [scene]);

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
    // Fit the current selection (or everything, if nothing is selected) without
    // changing the viewing angle. Delegates to zoomToSelectionRef, which is
    // re-pointed at the latest implementation on every render, so this stable
    // wrapper never goes stale. Used by the View → Fit to Selection app menu.
    (window as any).__zoomToSelection = () => zoomToSelectionRef.current();
    return () => {
      delete (window as any).__handleUndo;
      delete (window as any).__handleRedo;
      delete (window as any).__openExportPanel;
      delete (window as any).__zoomToSelection;
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

  // Build a session-backed octree PointCloudData from a session endpoint result
  // (bake / filter / segment / split / extract) that carries octree metadata + a
  // cache_id. Carries forward the existing octree's source/ascii/columnPlan/
  // categoricals. By default keeps the SAME sessionId (the array is unchanged;
  // only the derived octree was rebuilt). Pass `sessionIdOverride` for a NEW
  // child cloud (split leftover / extracted class) so it routes its own edits.
  const buildSessionOctreeData = useCallback((
    result: OctreeMetadata & { cache_id: string; point_count: number; miss_octree_cache_id?: string | null },
    octreeInfo: NonNullable<PointCloudData['octree']>,
    fileName: string,
    sessionIdOverride?: string | null,
  ): PointCloudData => {
    const data = buildPointCloudFromOctree(
      { ...result, cache_dir: result.cache_dir ?? '', cached: false },
      octreeInfo.sourceXyzPath,
      fileName,
      octreeInfo.asciiFormat ?? null,
      octreeInfo.columnPlan ?? null,
      octreeInfo.categoricalAttributes,
      sessionIdOverride !== undefined ? sessionIdOverride : octreeInfo.sessionId,
      octreeInfo.worldShift ?? null,
      octreeInfo.continuousAttributes,
    );
    // A bake/filter/segment result carries the new hits octree (+ miss octree id)
    // but NOT has_misses/scanOrigin/scanParams — those are scan-level facts set at
    // create. Carry them forward from the prior OctreeRef so a bake never drops
    // the "Show misses" toggle or the projection origin. The miss octree id comes
    // from the result when present (bake/backfill rebuild it), else is preserved.
    if (data.octree) {
      data.octree.hasMisses = octreeInfo.hasMisses;
      data.octree.scanOrigin = octreeInfo.scanOrigin;
      data.octree.scanParams = octreeInfo.scanParams;
      data.octree.missOctreeCacheId = 'miss_octree_cache_id' in result
        ? (result.miss_octree_cache_id ?? null)
        : octreeInfo.missOctreeCacheId;
    }
    return data;
  }, []);

  // Duplicate a scan — its point data AND any scan-parameter metadata — into a
  // fully independent copy. Three flavors:
  //   • params-only scanner → structural clone of the params (no data).
  //   • flat (in-RAM) data → deep-copy every typed array (cloneFlatPointCloudData)
  //     so the copy shares no buffers with the source.
  //   • octree-backed data → the points live in a backend session; copy them
  //     server-side (duplicateCloudSession: a pure array copy, no file re-read)
  //     so wizard customizations survive and edits to one copy never touch the
  //     other.
  // The new label enumerates "(copy)" / "(copy N)". A fresh id gives the copy
  // independent edit state (editStates is keyed by id), so nothing else to do.
  const handleDuplicateScan = useCallback(async (id: string) => {
    if (!onAddScan) return;
    const src = scans.find(s => s.id === id);
    if (!src) return;

    const newId = crypto.randomUUID();
    const label = duplicateScanName(scanDisplayName(src), scans.map(scanDisplayName));
    // Give the copy a fresh unused color rather than inheriting the source's,
    // so the two scans are visually distinct in the viewer/list.
    const color = allocateScanColor(new Set(scans.map(s => s.color)));
    const params = src.params
      ? { ...src.params, origin: { ...src.params.origin } }
      : undefined;

    // Octree-backed cloud: copy the backend session, build the copy from arrays.
    if (hasData(src) && src.data.octree?.sessionId) {
      const octreeInfo = src.data.octree;
      const baseName = src.data.fileName ?? label;
      setDuplicateProgress({ current: 1, total: 1, label: scanDisplayName(src) });
      try {
        const res = await duplicateCloudSession(octreeInfo.sessionId!);
        if (!res.duplicate) throw new Error('Duplicate returned no points.');
        const data = buildSessionOctreeData(res.duplicate, octreeInfo, baseName, res.duplicate.session_id);
        onAddScan({ id: newId, label, visible: true, color, data, params });
        showToast({ title: `Duplicated ${data.pointCount.toLocaleString()} points to ${label}`, type: 'success' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to duplicate scan';
        showToast({ title: `Could not duplicate scan: ${msg}`, type: 'error' });
      } finally {
        setDuplicateProgress(null);
      }
      return;
    }

    // Flat data and/or params-only: clone in RAM (no backend round-trip).
    const data = hasData(src) ? cloneFlatPointCloudData(src.data) : undefined;
    onAddScan({ id: newId, label, visible: true, color, data, params });
  }, [onAddScan, scans, buildSessionOctreeData]);

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
    // with no large JS buffer, so keeping it alive is free. The backend
    // session crop allocates in Python, not V8. If a
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
        // Destructive boundary: the cropped point arrays are the new ground
        // truth, so drop any undo history that touches these clouds.
        scene.boundary(touchedCloudIds);

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
        setDeleteConfirm({ type: 'cloud', ids: [emptied[0].id], label: emptied[0].name });
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

      // Octree-backed clouds: the editable session flow. A crop KEEPS the
      // points inside the box (deletes the outside), so the delete region is
      // the crop region with `invert` FLIPPED: crop(invert=false) → keep inside
      // → delete outside → delete_region(invert=true). delete_region is instant
      // (in-RAM mask, no rebuild); we accumulate the region into edit-state so
      // the GPU clip-volume preview hides the deleted points and undo can pop
      // it. Downstream ops read the masked array via the session id.
      if (cloud.data.octree && cloud.data.octree.sessionId) {
        const octreeInfo = cloud.data.octree;
        const sessionId = octreeInfo.sessionId!;
        let deleteRegion: CropOctreeRegion | null = null;
        if (cropMode === 'box' && cropBox) {
          deleteRegion = {
            kind: 'box',
            min: [cropBox.min.x, cropBox.min.y, cropBox.min.z],
            max: [cropBox.max.x, cropBox.max.y, cropBox.max.z],
            invert: !cropInvert,  // crop keeps inside → delete outside
          };
        } else if ((cropMode === 'polygon' || cropMode === 'rect') && cropPolygon && cropPolygon.points.length >= 3) {
          deleteRegion = {
            kind: 'polygon',
            points: cropPolygon.points.map(p => [p.x, p.y] as [number, number]),
            projection: cropPolygon.projection,
            view: cropPolygon.view,
            canvas: {
              width: cropPolygon.canvasSize.width,
              height: cropPolygon.canvasSize.height,
            },
            invert: !cropInvert,
          };
        }

        if (deleteRegion) {
          // The crop KEEPS the complement of `deleteRegion` (deleteRegion is the
          // delete set). The keep-region is therefore deleteRegion with invert
          // flipped back — i.e. the original crop selection.
          const keepRegion: CropOctreeRegion = {
            ...deleteRegion, invert: !(deleteRegion.invert ?? false),
          } as CropOctreeRegion;
          try {
            if (segment && onAddCloud) {
              // Segment mode: split the session into kept (inside the crop) +
              // a NEW leftover session (the cropped-out points). One array-side
              // call, no file read; both octrees rebuilt from the arrays.
              const result = await sessionSplit(sessionId, { region: keepRegion });
              if (result.kept.point_count === 0) {
                emptied.push({ id: cloud.id, name: src.fileName || 'Unnamed' });
                return;
              }
              onUpdateCloud(cloud.id, buildSessionOctreeData(result.kept, octreeInfo, src.fileName ?? cloud.id));
              if (result.leftover) {
                onAddCloud({
                  id: crypto.randomUUID(),
                  data: buildSessionOctreeData(
                    result.leftover, octreeInfo, `${src.fileName ?? cloud.id} (segment)`,
                    result.leftover.session_id,
                  ),
                  visible: true,
                  color: SEGMENT_COLOR,
                });
                segmentedCount++;
              }
              touchedCloudIds.push(cloud.id);
              keptCounts.push(result.kept.point_count);
              return;
            }

            // Plain crop: delete the outside region on the array + rebuild from
            // the arrays (no file read). Crop is a keep-inside (inverted) volume
            // that doesn't combine with the instant CLIP_INSIDE preview, so it
            // applies exactly via rebuild. Only erase accumulates as instant.
            const result = await deleteCloudRegion(sessionId, deleteRegion);
            if (result.remaining_count === 0) {
              emptied.push({ id: cloud.id, name: src.fileName || 'Unnamed' });
              return;
            }
            // A crop that touched a cloud with separately-backfilled misses leaves
            // them stale (gap-filled against the pre-crop hits). We keep them but
            // warn so the user re-runs Backfill Misses before LAD.
            if (result.backfilled_misses_stale) {
              showToast({
                type: 'warning',
                title: 'Sky/miss points are now stale',
                message: `Misses for ${src.fileName || 'this cloud'} were computed before this crop. `
                  + 'Re-run Backfill Misses on the cropped cloud before estimating leaf-area density.',
              });
            }
            const baked = await bakeCloudSession(sessionId);
            onUpdateCloud(cloud.id, buildSessionOctreeData(baked, octreeInfo, src.fileName ?? cloud.id));
            touchedCloudIds.push(cloud.id);
            keptCounts.push(result.remaining_count);
            return;
          } catch (err) {
            console.error('[handleApplyCrop] session crop/split failed:', err);
            showToast({ title: `Crop failed for ${src.fileName || 'cloud'}`, type: 'error' });
            return;
          }
        }
      }

      // Flat (non-session) clouds: crop in-renderer over the in-memory typed
      // arrays. These have no backend session and their positions already live
      // in `data.positions`, so there is nothing to re-read from disk — every
      // file-imported cloud is session-backed and handled above. (Flat clouds
      // here are renderer-synthesised / stitched overlays.)

      // In-renderer crop. Two-pass over typed arrays (count, then
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
  const handleApplyErase = useCallback(async () => {
    if (editMode !== 'erase' || selectedIds.size !== 1) return;

    const cloudId = Array.from(selectedIds)[0];
    const cloud = clouds.find(c => c.id === cloudId);
    const state = editStates.get(cloudId);

    if (!cloud || !state) return;

    // Octree (session) clouds: erase deletes points inside the union of painted
    // screen-space SQUARE stamps. The session flow makes this instant — set the
    // mask via delete_region (squares_union, invert=false → delete INSIDE the
    // squares) and accumulate the region so the GPU clip-volume preview keeps
    // the points hidden and undo can pop it. No octree rebuild.
    if (cloud.data.octree) {
      const frame = eraseFrame;
      if (!frame || frame.centers.length === 0) return;
      const octreeInfo = cloud.data.octree;
      if (!octreeInfo.sessionId) {
        showToast({ title: 'Cannot erase: cloud has no editable session.', type: 'error' });
        return;
      }
      const sessionId = octreeInfo.sessionId;
      // The frame's `view` is the DISPLAY-space camera (world − displayOffset),
      // but the backend reprojects TRUE WORLD positions. Convert to the world
      // view V_world = V_disp · T(−offset) before sending (no-op when offset 0).
      const off = displayOffsetRef.current;
      const worldView =
        off.x === 0 && off.y === 0 && off.z === 0
          ? frame.view
          : displayViewToWorldView(
              new THREE.Matrix4().fromArray(frame.view),
              off,
            ).toArray();
      const deleteRegion: PendingDeleteRegion = {
        kind: 'squares_union',
        centers: frame.centers.map(c => [c.cx, c.cy] as [number, number]),
        half_sizes: frame.centers.map(() => eraseBrushPx),
        projection: frame.projection,
        view: worldView,
        canvas: frame.canvas,
        invert: false, // delete points INSIDE the painted squares
      };
      let deletedCount = 0;
      try {
        const result = await deleteCloudRegion(sessionId, deleteRegion as CropOctreeRegion);
        if (result.remaining_count === 0) {
          // Every point erased → offer to delete the cloud, like the flat path.
          setDeleteConfirm({ type: 'cloud', ids: [cloud.id], label: cloud.data.fileName || 'Unnamed' });
          setEditMode('none');
          return;
        }
        deletedCount = result.deleted_count;
      } catch (err) {
        showToast({
          title: `Erase failed: ${err instanceof Error ? err.message : String(err)}`,
          type: 'error',
        });
        return;
      }
      // Clear the painted squares / live preview, but KEEP the committed delete
      // in edit-state so the persistent clip-volume preview hides the erased
      // points. (finishUp / undo manage the accumulated stack.) Record the
      // backend-reported deleted count so the scan row's point count drops now.
      setEraseFrame(null);
      setErasePreviewBoxes([]);
      setEraseBrushMatrix(null);
      setEditStates(prev => {
        const next = new Map(prev);
        const cur = next.get(cloud.id) ?? { translation: { x: 0, y: 0, z: 0 }, erasedIndices: new Set<number>() };
        next.set(cloud.id, {
          translation: { x: 0, y: 0, z: 0 },
          erasedIndices: new Set<number>(),
          pendingDeletes: [...(cur.pendingDeletes ?? []), deleteRegion],
          pendingDeletedCount: deletedCount,
        });
        return next;
      });
      // Keep the Erase tool OPEN (so "Permanently apply deletions" / "Undo last
      // deletion" stay reachable and further stamps can accumulate), but turn
      // erase MODE off so the view is interactive again.
      setEraseActive(false);
      return;
    }

    if (state.erasedIndices.size === 0) return;

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
        ids: [cloud.id],
        label: cloud.data.fileName || 'Unnamed'
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

    // Destructive boundary: data changed, so drop this cloud's undo history.
    scene.boundary([cloud.id]);

    setEditMode('none');
  }, [editMode, selectedIds, clouds, editStates, onUpdateCloud, eraseFrame, eraseBrushPx]);

  // Permanently apply (bake) a session cloud's pending deletions: rebuild the
  // octree from the survivors and clear the in-session mask + the accumulated
  // delete stack. The deliberately-slow step (one PotreeConverter run). After
  // bake the cloud's deletions are real on disk, so the GPU clip preview is no
  // longer needed (pendingDeletes cleared) and downstream ops/export see the
  // reduced cloud whether or not they go through the session.
  const handleBakeEdits = useCallback(async (cloudId: string) => {
    const cloud = clouds.find(c => c.id === cloudId);
    const octreeInfo = cloud?.data.octree;
    if (!cloud || !octreeInfo?.sessionId) return;
    const sessionId = octreeInfo.sessionId;
    try {
      const baked = await bakeCloudSession(sessionId);
      const newData = buildPointCloudFromOctree(
        {
          cache_id: baked.cache_id,
          cache_dir: baked.cache_dir ?? '',
          cached: baked.cached,
          version: baked.version,
          point_count: baked.point_count,
          spacing: baked.spacing,
          scale: baked.scale,
          offset: baked.offset,
          bounds: baked.bounds,
          tight_bounds: baked.tight_bounds,
          attributes: baked.attributes,
        },
        octreeInfo.sourceXyzPath,
        cloud.data.fileName ?? cloud.id,
        octreeInfo.asciiFormat ?? null,
        octreeInfo.columnPlan ?? null,
        octreeInfo.categoricalAttributes,
        sessionId,
        octreeInfo.worldShift ?? null,
        octreeInfo.continuousAttributes,
      );
      onUpdateCloud(cloud.id, newData);
      // Clear the pending-delete stack + history for this cloud now that the
      // deletions are baked into the octree.
      setEditStates(prev => {
        const next = new Map(prev);
        const cur = next.get(cloud.id);
        if (cur) next.set(cloud.id, { ...cur, pendingDeletes: [], pendingDeletedCount: 0 });
        return next;
      });
      // Destructive boundary: baked deletions are now the ground truth.
      scene.boundary([cloud.id]);
      showToast({ title: `Applied deletions — ${baked.point_count.toLocaleString()} points remain`, type: 'success' });
    } catch (err) {
      showToast({
        title: `Apply deletions failed: ${err instanceof Error ? err.message : String(err)}`,
        type: 'error',
      });
    }
  }, [clouds, onUpdateCloud]);

  // Recover sky/miss points (beams that returned nothing) for the selected
  // session-backed scans and persist them in the backend session, so they can be
  // visualised and consumed by LAD (which no longer gapfills silently). Misses are
  // reconstructed from the scan's timestamp and/or row/column grid. This mutates
  // the backend session in place — a destructive boundary, not a reversible
  // transaction. Per-scan loop with an aggregate skip summary for multi-select.
  // Run by the Backfill Misses modal (and the LAD banner). Recovers sky/miss
  // points for the given scans, streaming per-stage progress into a StatusPill
  // like Triangulation / LAD. `showAfter` reveals the overlay on completion (only
  // for scans with a known scanner origin — the modal already gates it).
  const handleBackfillMisses = useCallback(async (scanIds: string[], showAfter: boolean) => {
    if (isBackfillRunning) return;
    const eligible = scanIds
      .map(id => clouds.find(c => c.id === id))
      .filter((c): c is PointCloudEntry => !!c)
      .filter(c => isBackfillEligible(c) && c.data.octree?.sessionId);
    if (eligible.length === 0) {
      showToast({ title: 'No selected scan can be backfilled', type: 'info' });
      return;
    }

    const abort = new AbortController();
    backfillAbortRef.current = abort;
    setIsBackfillRunning(true);
    setBackfillProgress({ label: 'Backfilling misses…', value: 0 });

    const n = eligible.length;
    let totalRecovered = 0;
    let failed = 0;
    let anyUnplaceable = false;
    // Last real fraction reported by the backend, so a synthetic creep (below) can
    // resume from it and a real marker can snap the bar back onto truth.
    let lastValue = 0;
    // Drives the synthetic progress during the opaque gapfill stage (one C++ call,
    // reported as null). Cleared whenever a real marker arrives or the run ends.
    let synthTimer: ReturnType<typeof setInterval> | null = null;
    const stopSynth = () => { if (synthTimer) { clearInterval(synthTimer); synthTimer = null; } };
    backfillSynthStopRef.current = stopSynth;
    try {
      for (let i = 0; i < n; i++) {
        const cloud = eligible[i];
        const oct = cloud.data.octree!;
        const origin: [number, number, number] =
          cloud.params?.origin
            ? [cloud.params.origin.x, cloud.params.origin.y, cloud.params.origin.z]
            : (oct.scanOrigin ?? [0, 0, 0]);
        // Forward the scan's REAL angular raster so the C++ gapfiller reconstructs
        // misses over the actual scan grid/sweep — not a point-count estimate that
        // assumes a full 0–180°/0–360° sweep (which fabricates a 360° ring of sky
        // misses for a limited-zenith or partial-azimuth scan). Mirrors the raster
        // LAD already forwards via buildLADRequest; omit it when the scan has no
        // params (the backend then falls back to its estimate).
        const p = cloud.params;
        const raster: BackfillMissesRaster | undefined = p
          ? {
              n_theta: p.zenithPoints,
              n_phi: p.azimuthPoints,
              theta_min: p.zenithMinDeg,
              theta_max: p.zenithMaxDeg,
              phi_min: p.azimuthMinDeg,
              phi_max: p.azimuthMaxDeg,
              // Beam optics drive the cone sampling for single- and multi-return
              // scans alike (at rays-per-pulse = 1 the cone collapses to one ray).
              beam_exit_diameter: p.beamExitDiameterM,
              beam_divergence: p.beamDivergenceMrad,
            }
          : undefined;
        const prefix = n > 1 ? `Scan ${i + 1} of ${n} — ` : '';
        // The gapfill stage occupies ~[0.15, 0.9] of a scan's fraction. Map that to
        // an overall band; the synthetic creep eases from the band's start toward
        // (just shy of) its end, paced by the point count.
        const bandStart = (i + 0.15) / n;
        const bandEnd = (i + 0.85) / n;
        // Benchmark: ~35 s for 14M points. We pace the creep a bit FASTER than the
        // real wall-clock (~23 s for 14M here) and front-load the curve, so the bar
        // is near the band end when the gapfill actually finishes — minimising the
        // forward jump when the real "Storing" marker snaps it onward. Floored so a
        // tiny cloud still animates briefly rather than snapping.
        const estimatedMs = Math.max(1200, cloud.data.pointCount / 600);

        // Blend the per-scan index with the streamed stage fraction into one
        // overall 0..1 bar. A real fraction snaps the bar onto truth (and stops any
        // synthetic creep); a null fraction (the opaque gapfill) starts the creep.
        const report = (p: number | null, msg: string) => {
          if (p != null) {
            stopSynth();
            lastValue = (i + p) / n;
            setBackfillProgress({ label: `${prefix}${msg}`, value: lastValue });
            return;
          }
          // Indeterminate stage → ease asymptotically from bandStart toward bandEnd
          // over ~estimatedMs, never quite reaching the end (real completion does).
          const t0 = performance.now();
          const span = bandEnd - bandStart;
          setBackfillProgress({ label: `${prefix}${msg}`, value: Math.max(lastValue, bandStart) });
          stopSynth();
          synthTimer = setInterval(() => {
            const elapsed = performance.now() - t0;
            // 1 - e^(-t/τ) approaches 1 asymptotically; τ = estimatedMs/3 reaches
            // ~95% of the band at the (already-shortened) estimate, ~98% at 1.5×
            // over — so the bar sits close to the band end before the real marker.
            const eased = 1 - Math.exp(-elapsed / (estimatedMs / 3));
            const value = bandStart + span * eased;
            setBackfillProgress({ label: `${prefix}${msg}`, value });
          }, 100);
        };
        try {
          const res = await backfillMisses(oct.sessionId!, origin, raster, undefined, abort.signal, report);
          stopSynth();  // the request resolved — no more synthetic creep for this scan
          if (abort.signal.aborted) return;
          if (res.error) {
            failed += 1;
            showToast({ title: `Backfill Misses failed for ${cloud.data.fileName ?? cloud.id}`, message: res.error, type: 'error' });
            continue;
          }
          totalRecovered += res.backfilled;
          // Reflect the recovered misses on the scan: gate the toggle and adopt
          // the rebuilt miss octree (its fresh sha1 remounts MissOctree even
          // though the hits cacheId is unchanged). Don't fabricate a scanOrigin
          // from a placeholder.
          report(1.0, 'Loading miss points…');
          const rebuiltMissCacheId = res.miss_octree_cache_id ?? oct.missOctreeCacheId ?? null;
          onUpdateCloud(cloud.id, {
            ...cloud.data,
            octree: {
              ...oct,
              hasMisses: true,
              missOctreeCacheId: rebuiltMissCacheId,
            },
          });
          // Auto-enable the shell when requested AND the miss octree was actually
          // built (row/col + timestamp paths both build it; the projection is
          // baked in, so a live scanner origin is no longer required to show it).
          // It's only undrawable when every recovered miss was unplaceable.
          if (showAfter && rebuiltMissCacheId) {
            if (!cloud.showMisses) onToggleMisses?.(cloud.id);
          } else if (!rebuiltMissCacheId) {
            anyUnplaceable = true;
          }
          // Destructive boundary: the backend session now holds the misses.
          scene.boundary([cloud.id]);
        } catch (err) {
          stopSynth();
          if (abort.signal.aborted) return;
          failed += 1;
          showToast({
            title: `Backfill Misses failed for ${cloud.data.fileName ?? cloud.id}: ${err instanceof Error ? err.message : String(err)}`,
            type: 'error',
          });
        }
      }
    } finally {
      stopSynth();
      backfillSynthStopRef.current = null;
      setIsBackfillRunning(false);
      setBackfillProgress(null);
      backfillAbortRef.current = null;
    }

    if (failed < n) {
      showToast({
        title: `Recovered ${totalRecovered.toLocaleString()} sky/miss point(s)`,
        message: anyUnplaceable
          ? 'Misses are ready for leaf-area density. Some scans’ misses couldn’t be placed for display (no recovered beam direction), so the viewer shows none for those.'
          : undefined,
        type: 'success',
      });
    }
  }, [clouds, isBackfillRunning, onUpdateCloud, onToggleMisses]);

  const cancelBackfill = useCallback(() => {
    backfillSynthStopRef.current?.();
    backfillAbortRef.current?.abort();
    setIsBackfillRunning(false);
    setBackfillProgress(null);
    backfillAbortRef.current = null;
  }, []);

  // Build the crop_octree args (region + scalarFilters + translation) for an
  // octree-backed cloud from its active filters. X/Y/Z range filters become a
  // box region (full extent on any disabled axis); enabled scalar filters
  // become scalar_filters AND-combined with it. Shared by Filter and Segment.
  const buildOctreeFilterArgs = useCallback((cloud: PointCloudEntry, filters: CloudFilters) => {
    const editState = editStates.get(cloud.id);
    const otx = editState?.translation.x ?? 0;
    const oty = editState?.translation.y ?? 0;
    const otz = editState?.translation.z ?? 0;

    // Categorical fields (ground_class / tree_instance) emit `values` (the
    // selected class ids to keep) instead of a min/max range; continuous fields
    // emit the range. A categorical field with no class selected keeps nothing,
    // so it's a valid (if empty) filter — still sent.
    const scalarFilters = Object.entries(filters.scalarFields)
      .filter(([, f]) => f.enabled)
      .map(([slug, f]) =>
        f.selectedClasses
          ? { slug, min: f.min, max: f.max, values: f.selectedClasses }
          : { slug, min: f.min, max: f.max });

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
    // Destructive boundary: filter/segment rewrote this cloud's data.
    scene.boundary([cloudId]);
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
          // Categorical: keep iff the rounded value is a selected class.
          // Continuous: keep iff within [min, max].
          if (sf.selectedClasses) {
            if (!sf.selectedClasses.includes(Math.round(v))) return false;
          } else if (v < sf.min || v > sf.max) {
            return false;
          }
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

    // Session-backed octree clouds: apply the filter on the in-RAM arrays
    // (delete the excluded points + rebuild from the arrays). No file re-read.
    if (cloud.data.octree?.sessionId) {
      const octreeInfo = cloud.data.octree;
      const sessionId = octreeInfo.sessionId!;
      const args = buildOctreeFilterArgs(cloud, filters);
      try {
        const result = await sessionFilter(sessionId, {
          region: args.region ?? null,
          scalarFilters: args.scalarFilters ?? null,
          rebuild: true,
        });
        if (result.point_count === 0) {
          setDeleteConfirm({ type: 'cloud', ids: [cloud.id], label: cloud.data.fileName || 'Unnamed' });
          return;
        }
        onUpdateCloud(cloud.id, buildSessionOctreeData(result, octreeInfo, cloud.data.fileName ?? cloud.id));
      } catch (err) {
        console.error('[handleApplyFilterPermanently] session filter failed:', err);
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
      setDeleteConfirm({ type: 'cloud', ids: [cloud.id], label: cloud.data.fileName || 'Unnamed' });
      return;
    }
    onUpdateCloud(cloud.id, newData);
    clearFilterStateForCloud(cloud.id);
  }, [selectedIds, clouds, cloudFilters, editStates, onUpdateCloud, buildOctreeFilterArgs, clearFilterStateForCloud, buildFlatKeepPredicate, rebuildFlatCloudData]);

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

    // Session-backed octree: split the in-RAM array into kept (this session) +
    // a NEW leftover session. One backend call, no source file read; the two
    // sides exactly partition the cloud.
    if (cloud.data.octree?.sessionId) {
      const octreeInfo = cloud.data.octree;
      const sessionId = octreeInfo.sessionId!;
      const args = buildOctreeFilterArgs(cloud, filters);
      try {
        const result = await sessionSplit(sessionId, {
          region: args.region ?? null,
          scalarFilters: args.scalarFilters ?? null,
        });
        if (result.kept.point_count === 0) {
          setDeleteConfirm({ type: 'cloud', ids: [cloud.id], label: cloud.data.fileName || 'Unnamed' });
          return;
        }
        onUpdateCloud(cloud.id, buildSessionOctreeData(result.kept, octreeInfo, cloud.data.fileName ?? cloud.id));
        if (result.leftover) {
          // The leftover is its OWN session — carry its new sessionId (not the
          // parent's) so its later edits route correctly.
          onAddCloud({
            id: crypto.randomUUID(),
            data: buildSessionOctreeData(result.leftover, octreeInfo, leftoverName, result.leftover.session_id),
            visible: true,
            color: cloud.color,
          });
        }
      } catch (err) {
        console.error('[handleSegmentFilter] session split failed:', err);
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
      setDeleteConfirm({ type: 'cloud', ids: [cloud.id], label: cloud.data.fileName || 'Unnamed' });
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
  }, [selectedIds, clouds, cloudFilters, editStates, onUpdateCloud, onAddCloud, buildOctreeFilterArgs, clearFilterStateForCloud, buildFlatKeepPredicate, rebuildFlatCloudData]);

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
      // F: zoom/fit to the current selection (frame selection), keeping the
      // current viewing angle. Ignored while typing, with a modifier held, or
      // while a transform modal (t/s/r) owns the keyboard.
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !transformModalRef.current) {
        const el = document.activeElement as HTMLElement | null;
        const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
          || el.tagName === 'SELECT' || el.isContentEditable);
        if (!typing) {
          e.preventDefault();
          zoomToSelectionRef.current();
        }
      }
      // E: toggle erase MODE while the Erase tool is open (the same as the
      // panel's Erase-mode button). It does NOT open or close the tool — that's
      // the toolbar Eraser button's job. Toggling mode ON freezes the view and
      // makes clicks stamp; OFF lets the user orbit to reframe without leaving
      // the tool. Ignored while typing or with a modifier held.
      if ((e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const el = document.activeElement as HTMLElement | null;
        const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
          || el.tagName === 'SELECT' || el.isContentEditable);
        if (!typing && editMode === 'erase') {
          e.preventDefault();
          setEraseActive(a => !a);
        }
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
                displayOffsetRef.current,
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
    // A scan with params (scanner marker / moving-platform trajectory) carries no
    // geometry but DOES occupy the scene — a scans-only import (e.g. a drone
    // trajectory at z=170) must frame on it, not fall back to the origin box,
    // which would put the marker off-camera and blank the view.
    const hasParamsScan = scansWithParams.some(s => s.visible);
    const hasContent = clouds.length > 0 || meshes.length > 0 ||
      skeletons.length > 0 || qsms.length > 0 || hasParamsScan;

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

    // Include mesh bounds. Vertices are stored in the mesh's local space; apply
    // the same world transform the renderer uses (scale -> rotate(Euler XYZ) ->
    // translate, see extractMeshWorldGeometry) before accumulating. Skipping the
    // transform collapses e.g. a Helios <grid> voxel — a unit cube placed at
    // [center] with [size] scale — back to a ±0.5 box at the origin, which makes
    // fit-to-view zoom to near-zero distance and cull everything.
    for (const mesh of meshes) {
      if (!mesh.visible) continue;
      const { vertices, vertexCount } = mesh.data;
      const pos = meshPositions.get(mesh.id) || { x: 0, y: 0, z: 0 };
      const scl = meshScales.get(mesh.id) || { x: 1, y: 1, z: 1 };
      const rot = meshRotations.get(mesh.id) || { x: 0, y: 0, z: 0 };
      const rotX = rot.x * Math.PI / 180, rotY = rot.y * Math.PI / 180, rotZ = rot.z * Math.PI / 180;
      const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);
      for (let i = 0; i < vertexCount; i++) {
        const x = vertices[i * 3] * scl.x;
        const y = vertices[i * 3 + 1] * scl.y;
        const z = vertices[i * 3 + 2] * scl.z;
        const y1 = y * cosX - z * sinX;
        const z1 = y * sinX + z * cosX;
        const x2 = x * cosY + z1 * sinY;
        const z2 = -x * sinY + z1 * cosY;
        const x3 = x2 * cosZ - y1 * sinZ;
        const y3 = x2 * sinZ + y1 * cosZ;
        const wx = x3 + pos.x, wy = y3 + pos.y, wz = z2 + pos.z;
        min.x = Math.min(min.x, wx);
        min.y = Math.min(min.y, wy);
        min.z = Math.min(min.z, wz);
        max.x = Math.max(max.x, wx);
        max.y = Math.max(max.y, wy);
        max.z = Math.max(max.z, wz);
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

    // Include QSM bounds (cylinder endpoints, already world-space)
    for (const qsm of qsms) {
      if (!qsm.visible) continue;
      const box = qsmAabb(qsm);
      if (!box) continue;
      min.x = Math.min(min.x, box.min[0]); max.x = Math.max(max.x, box.max[0]);
      min.y = Math.min(min.y, box.min[1]); max.y = Math.max(max.y, box.max[1]);
      min.z = Math.min(min.z, box.min[2]); max.z = Math.max(max.z, box.max[2]);
    }

    // Include scanner-marker positions so a scans-only scene frames on them. For
    // a moving-platform scan use the WHOLE trajectory extent (not just the
    // first-pose anchor), so a data-less drone pass at z=170 frames its path
    // instead of collapsing the camera onto the origin (which blanks the view
    // and hides the ground grid). Mirrors the staticBounds loop.
    for (const scan of scansWithParams) {
      if (!scan.visible) continue;
      if (scan.params.trajectory) {
        for (const p of scan.params.trajectory.poses) {
          min.x = Math.min(min.x, p.x); max.x = Math.max(max.x, p.x);
          min.y = Math.min(min.y, p.y); max.y = Math.max(max.y, p.y);
          min.z = Math.min(min.z, p.z); max.z = Math.max(max.z, p.z);
        }
      } else {
        const o = scan.params.origin;
        min.x = Math.min(min.x, o.x); max.x = Math.max(max.x, o.x);
        min.y = Math.min(min.y, o.y); max.y = Math.max(max.y, o.y);
        min.z = Math.min(min.z, o.z); max.z = Math.max(max.z, o.z);
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
  }, [clouds, meshes, skeletons, qsms, scansWithParams, meshPositions, meshScales, meshRotations, getEditState]);

  // Open the add-scan popup with sensible defaults: next label and current
  // scene center as origin. Shared by the toolbar Radio button (Create
  // section) and the "+" inside the right-hand Scans panel.
  const openAddScanPopup = useCallback(() => {
    const center = combinedBounds.center;
    setScanDefaults({
      label: `Scan ${scansAll.length + 1}`,
      params: { origin: roundCoord3({ x: center.x, y: center.y, z: center.z }) },
    });
    setScanPopupState({ kind: 'add' });
  }, [combinedBounds, scansAll.length]);

  // Open the params popup pre-filled to attach scan params to an existing
  // data-only scan. The origin defaults to the scan's bounds center.
  const openAddParamsPopupFor = useCallback((scan: Scan) => {
    const origin = scan.data?.bounds.center
      ? roundCoord3(scan.data.bounds.center)
      : combinedBounds.center
        ? roundCoord3(combinedBounds.center)
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
      // Scanner markers carry no geometry but still occupy the scene; include
      // their ids so adding a scan re-grounds the grid (and so a scans-only
      // scene isn't treated as empty).
      ...scansWithParams.map(s => s.id),
    ]);
    const prevIds = prevStaticBoundsIdsRef.current;
    const hasNewIds = [...allIds].some(id => !prevIds.has(id));
    prevStaticBoundsIdsRef.current = allIds;

    // Recompute bounds ONLY when a new object enters the scene. Pure removals,
    // and pure transform edits (a Translate/Rotate/Scale drag or Fit-to-scans,
    // which mutate meshPositions/Rotations/Scales without changing the id set),
    // keep the latched bounds so the ground grid and axes never jump mid-edit.
    // meshPositions/Rotations/Scales are in the dep array only so a freshly
    // imported object's transform is available on the same render it appears.
    if (!hasNewIds) {
      return stableStaticBoundsRef.current;
    }

    // New objects added: recompute bounds from all current objects
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const corner = new THREE.Vector3();

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

    // Include mesh bounds in WORLD space. A mesh's vertices are authored in
    // local space — an imported Helios <grid> is a UNIT cube — and placed in
    // the world by its position/rotation/scale group transform at render time
    // (see the mesh <group> below). We must apply that same transform here, or
    // the bounds (and the ground grid pinned to staticBounds.min.z) land at the
    // untransformed local origin instead of where the mesh actually renders.
    // Compute the local AABB, then transform its 8 corners and expand.
    for (const mesh of meshes) {
      if (!mesh.visible) continue;
      const { vertices, vertexCount } = mesh.data;
      if (vertexCount === 0) continue;
      const lmin = new THREE.Vector3(Infinity, Infinity, Infinity);
      const lmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (let i = 0; i < vertexCount; i++) {
        lmin.x = Math.min(lmin.x, vertices[i * 3]);
        lmin.y = Math.min(lmin.y, vertices[i * 3 + 1]);
        lmin.z = Math.min(lmin.z, vertices[i * 3 + 2]);
        lmax.x = Math.max(lmax.x, vertices[i * 3]);
        lmax.y = Math.max(lmax.y, vertices[i * 3 + 1]);
        lmax.z = Math.max(lmax.z, vertices[i * 3 + 2]);
      }
      const p = meshPositions.get(mesh.id) || { x: 0, y: 0, z: 0 };
      const r = meshRotations.get(mesh.id) || { x: 0, y: 0, z: 0 };
      const s = meshScales.get(mesh.id) || { x: 1, y: 1, z: 1 };
      // T * R * S — matches Object3D's matrix (and the render group's
      // position / rotation[deg→rad] / scale).
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(p.x, p.y, p.z),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            (r.x * Math.PI) / 180,
            (r.y * Math.PI) / 180,
            (r.z * Math.PI) / 180,
          ),
        ),
        new THREE.Vector3(s.x, s.y, s.z),
      );
      for (let cx = 0; cx < 2; cx++) {
        for (let cy = 0; cy < 2; cy++) {
          for (let cz = 0; cz < 2; cz++) {
            corner
              .set(cx ? lmax.x : lmin.x, cy ? lmax.y : lmin.y, cz ? lmax.z : lmin.z)
              .applyMatrix4(matrix);
            min.min(corner);
            max.max(corner);
          }
        }
      }
    }

    // Include scanner-marker origins (world coords). Keeps a scans-only Helios
    // import grounded at the rig height instead of the unit fallback. For a
    // moving-platform scan, include the WHOLE trajectory extent (not just the
    // first-pose anchor origin) so a data-less moving scan frames its full path
    // instead of collapsing the camera onto one far-away point (a drone pass at
    // z=170 would otherwise blank the viewport and hide the ground grid).
    for (const scan of scansWithParams) {
      if (!scan.visible) continue;
      if (scan.params.trajectory) {
        for (const p of scan.params.trajectory.poses) {
          min.min(corner.set(p.x, p.y, p.z));
          max.max(corner);
        }
      } else {
        const o = scan.params.origin;
        min.min(corner.set(o.x, o.y, o.z));
        max.max(corner);
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
  }, [clouds, meshes, skeletons, scansWithParams, meshPositions, meshRotations, meshScales]);

  // Render-only display offset (Layer 2 precision safety net). Derived from the
  // world-space scene center, rounded to integers, zero below ~1e4 magnitude.
  // It's keyed on `staticBounds` (already latched on the add-only id-set), so it
  // only changes when the loaded object SET changes materially — never on a
  // Translate drag — keeping geometry rebuilds + camera reframes rare. The whole
  // scene renders at (world − displayOffset); every world coordinate shown to the
  // user or sent to the backend adds it back. Distinct from a cloud's persistent
  // `worldShift` (which lives in the stored data); displayOffset never leaves the
  // viewer. A ref mirrors it for imperative event handlers (seed/crop/erase).
  const displayOffset = useMemo<Vec3Like>(
    () => computeDisplayOffset(staticBounds.center),
    [staticBounds],
  );
  const displayOffsetRef = useRef<Vec3Like>(displayOffset);
  displayOffsetRef.current = displayOffset;

  // World-space coordinate of the ground-grid plane along the up-axis (z for
  // z-up, y for y-up). The natural ground reference in a local coordinate system
  // is 0, so we SNAP to 0 whenever 0 is a plausible floor near the geometry —
  // i.e. the scene's up-axis span is within half a scene-diagonal of the origin.
  // That covers the common case where geometry sits a little above 0 (e.g. a
  // scan rig mounted ~1.25 m up, with the real ground at 0). Only when the whole
  // scene lives far from the origin — a UTM-style coordinate system where 0 is
  // hundreds/thousands of metres below everything — do we fall back to the
  // computed extent floor, since 0 there is meaningless (and invisible).
  const gridFloor = useMemo(() => {
    const upAxis = gridPlane === 'z-up' ? 'z' : 'y';
    const floor = staticBounds.min[upAxis];
    const ceil = staticBounds.max[upAxis];
    const sceneScale = Math.max(staticBounds.size.length(), 1e-6);
    // Distance from 0 to the geometry's up-axis span (0 if the span straddles 0).
    const distFromZero =
      floor <= 0 && ceil >= 0 ? 0 : Math.min(Math.abs(floor), Math.abs(ceil));
    return distFromZero <= sceneScale * 0.5 ? 0 : floor;
  }, [staticBounds, gridPlane]);

  // Determine what's currently selected. A cloud tool needs an actual
  // data-bearing cloud, not a param-only scanner marker: loading a Helios scan
  // XML (e.g. almond.xml) creates param-only scans that share the selection set
  // but carry no points. Counting those as "selected clouds" made cloud tools
  // (Segment Ground/Trees, Extract Skeleton, …) look clickable while their
  // panels — which require a single *data* cloud — never opened. Gate on
  // selected scans that actually have data instead.
  const selectedCloudCount = useMemo(
    () => clouds.reduce((n, c) => (selectedIds.has(c.id) ? n + 1 : n), 0),
    [clouds, selectedIds],
  );
  const hasCloudSelected = selectedCloudCount > 0;
  const hasMeshSelected = selectedMeshIds.size > 0;
  const hasSkeletonSelected = selectedSkeletonId !== null;
  const hasPlantMeshSelected = hasMeshSelected && meshes.find(m => selectedMeshIds.has(m.id))?.isPlant;
  const hasQSMSelected = selectedQSMIds.size > 0;
  // True when any framable object is selected — gates "Zoom to Selection".
  const hasAnySelection = hasCloudSelected || hasMeshSelected || hasSkeletonSelected || hasQSMSelected;

  // Command registry — the single source of truth for the static Toolbar, the
  // Cmd+K palette, and the native Tools menu (see lib/toolCommands.ts for the
  // ToolCommand type and the availability helpers shared across all three).
  const commands = useMemo(() => {
    const cmds: ToolCommand[] = [
      // View commands - always available
      { id: 'reset-view', name: 'Reset View', keywords: ['home', 'camera'], action: () => (window as any).__resetPointCloudCamera?.(), category: 'View', requires: null },
      // Named views REORIENT only (rotate to the axis, preserve target + zoom),
      // matching the Snap View toolbar buttons. "Reset View" reframes everything.
      { id: 'view-top', name: 'Top View', keywords: ['camera', 'snap'], action: () => (window as any).__orientToAxis?.({ x: 0, y: 0, z: 1 }), category: 'View', requires: null },
      { id: 'view-bottom', name: 'Bottom View', keywords: ['camera', 'snap'], action: () => (window as any).__orientToAxis?.({ x: 0, y: 0, z: -1 }), category: 'View', requires: null },
      { id: 'view-front', name: 'Front View', keywords: ['camera', 'snap'], action: () => (window as any).__orientToAxis?.({ x: 0, y: -1, z: 0 }), category: 'View', requires: null },
      { id: 'view-back', name: 'Back View', keywords: ['camera', 'snap'], action: () => (window as any).__orientToAxis?.({ x: 0, y: 1, z: 0 }), category: 'View', requires: null },
      { id: 'view-left', name: 'Left View', keywords: ['camera', 'snap'], action: () => (window as any).__orientToAxis?.({ x: -1, y: 0, z: 0 }), category: 'View', requires: null },
      { id: 'view-right', name: 'Right View', keywords: ['camera', 'snap'], action: () => (window as any).__orientToAxis?.({ x: 1, y: 0, z: 0 }), category: 'View', requires: null },
      { id: 'view-iso', name: 'Isometric View', keywords: ['camera', 'snap', 'diagonal'], action: () => (window as any).__orientToAxis?.({ x: 0.6, y: -0.6, z: 0.5 }), category: 'View', requires: null },

      // Selection commands
      { id: 'select-all', name: 'Select All', keywords: ['pick', 'choose'], action: () => onSelectAll(), category: 'Selection', requires: null },
      { id: 'deselect-all', name: 'Deselect All', keywords: ['clear', 'none'], action: () => onDeselectAll(), category: 'Selection', requires: null },


      // ── Pre-processing ──────────────────────────────────────────────
      { id: 'cloud-translate', name: 'Translate Point Cloud', keywords: ['move', 'position'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'translate' ? 'none' : 'translate'); }, category: 'Point Cloud', requires: 'cloud', toolGroup: 'preprocess', icon: Move, isActive: () => editMode === 'translate' },
      { id: 'cloud-crop', name: 'Crop Point Cloud', keywords: ['cut', 'trim', 'box'], action: () => toggleCropMode(), category: 'Point Cloud', requires: 'cloud', toolGroup: 'preprocess', icon: Crop, testId: 'tool-crop', isActive: () => editMode === 'crop' },
      { id: 'cloud-erase', name: 'Erase Brush', keywords: ['delete', 'remove', 'paint'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'erase' ? 'none' : 'erase'); }, category: 'Point Cloud', requires: 'cloud', toolGroup: 'preprocess', icon: Eraser, testId: 'tool-erase', isActive: () => editMode === 'erase' },
      { id: 'cloud-filter', name: 'Filter Points', keywords: ['range', 'intensity'], action: () => { closeAllToolPanels('filter'); setShowFilterPanel(!showFilterPanel); }, category: 'Point Cloud', requires: 'cloud', toolGroup: 'preprocess', icon: Filter, testId: 'tool-filter', isActive: () => showFilterPanel },
      { id: 'cloud-resample', name: 'Resample Point Cloud', keywords: ['downsample', 'reduce', 'decimate'], action: () => { closeAllToolPanels('resample'); setShowResamplePanel(!showResamplePanel); }, category: 'Point Cloud', requires: 'cloud', toolGroup: 'preprocess', icon: ChartScatter, isActive: () => showResamplePanel },
      { id: 'cloud-move-origin', name: 'Move to Origin', keywords: ['center', 'zero', 'reset position'], action: () => handleMoveToOrigin(), category: 'Point Cloud', requires: 'cloud', toolGroup: 'preprocess', icon: CircleDot },
      { id: 'cloud-backfill-misses', name: 'Backfill Misses', keywords: ['sky', 'miss', 'gapfill', 'lad', 'leaf area', 'transmission', 'recover', 'beam'], action: () => { closeAllToolPanels(); setShowBackfillPopup(true); }, category: 'Point Cloud', requires: null, toolGroup: 'preprocess', icon: CloudFog, testId: 'tool-backfill-misses', multiInput: true },
      { id: 'cloud-align', name: 'Align Clouds (ICP)', keywords: ['register', 'icp', 'alignment', 'fit'], action: () => setShowAlignDialog(true), category: 'Point Cloud', toolGroup: 'preprocess', icon: Globe, multiInput: true },
      { id: 'cloud-stitch', name: 'Stitch Clouds', keywords: ['merge', 'combine', 'join'], action: () => setShowStitchDialog(true), category: 'Point Cloud', toolGroup: 'preprocess', icon: Merge, multiInput: true },

      // ── Segmentation ────────────────────────────────────────────────
      { id: 'cloud-ground-segment', name: 'Segment Ground', keywords: ['ground', 'classify', 'classification', 'plant', 'csf', 'cloth', 'lidar'], action: () => { closeAllToolPanels('ground-segment'); setShowGroundSegmentPanel(!showGroundSegmentPanel); }, category: 'Point Cloud', requires: 'cloud', toolGroup: 'segment', icon: Layers, testId: 'tool-ground-segment', isActive: () => showGroundSegmentPanel },
      { id: 'cloud-wood-segment', name: 'Segment Wood / Leaf', keywords: ['wood', 'leaf', 'branch', 'foliage', 'classify', 'classification', 'lewos', 'remove wood', 'separate'], action: () => { closeAllToolPanels('wood-segment'); setShowWoodSegmentPanel(!showWoodSegmentPanel); }, category: 'Point Cloud', requires: 'cloud', toolGroup: 'segment', icon: GitBranch, testId: 'tool-wood-segment', isActive: () => showWoodSegmentPanel },
      { id: 'cloud-segment-trees', name: 'Segment Trees', keywords: ['tree', 'trees', 'instance', 'treeiso', 'individual', 'forest', 'isolate', 'crown', 'trunk'], action: () => { closeAllToolPanels('tree-segment'); setShowTreeSegmentPanel(!showTreeSegmentPanel); }, category: 'Point Cloud', requires: 'cloud', toolGroup: 'segment', icon: Trees, testId: 'tool-tree-segment', isActive: () => showTreeSegmentPanel },

      // ── Reconstruction & analysis ───────────────────────────────────
      // Triangulate opens a popup with its own scan picker (seeded from the
      // current selection but not requiring one), so it stays clickable whenever
      // any cloud exists in the scene — like the other picker-driven tools.
      { id: 'cloud-triangulate', name: 'Triangulate', keywords: ['mesh', 'surface', 'reconstruct'], action: () => { closeAllToolPanels('triangulation'); setShowTriangulationPopup(true); }, category: 'Point Cloud', toolGroup: 'reconstruct', icon: Triangle, testId: 'tool-triangulate', multiInput: true, isActive: () => showTriangulationPopup },
      { id: 'cloud-skeleton', name: 'Extract Skeleton', keywords: ['branch', 'structure'], action: () => { closeAllToolPanels('skeleton'); setShowSkeletonPanel(!showSkeletonPanel); }, category: 'Point Cloud', requires: 'cloud', toolGroup: 'reconstruct', icon: Dna, testId: 'tool-skeleton', isActive: () => showSkeletonPanel },
      { id: 'cloud-qsm', name: 'Build QSM', keywords: ['qsm', 'cylinder', 'radius', 'shoot', 'rank', 'scaffold', 'structure', 'quantitative'], action: () => { closeAllToolPanels('qsm'); setShowQSMPopup(true); }, category: 'Point Cloud', requires: null, toolGroup: 'reconstruct', icon: QsmIcon, testId: 'tool-qsm', multiInput: true, isActive: () => showQSMPopup },
      { id: 'compute-lad', name: 'Compute Leaf Area Density', keywords: ['lad', 'leaf area density', 'voxel', 'foliage', 'beer', 'canopy', 'helios'], action: () => { closeAllToolPanels(); setShowLADPopup(true); }, category: 'Point Cloud', requires: null, toolGroup: 'reconstruct', icon: Grid3x3, testId: 'tool-compute-lad', multiInput: true },

      // ── Create (geometry + scanner placement — scene-building, not analysis) ──
      { id: 'create-plant', name: 'Generate Plant', keywords: ['helios', 'leaf', 'vegetation', 'build', 'geometry'], action: () => setShowPlantPopup(true), category: 'Create', requires: null, toolGroup: 'create', icon: Sprout, testId: 'tool-plant-generate' },
      { id: 'import-model', name: 'Import Model', keywords: ['mesh', 'obj', 'ply', 'load', 'geometry'], action: () => { (window as any).__importMesh?.(); }, category: 'Create', requires: null, toolGroup: 'create', icon: FileUp },
      { id: 'create-voxel', name: 'Create Voxel Grid', keywords: ['cube', 'box', 'shape', 'grid', 'lad'], action: () => handleCreateShape('voxel'), category: 'Create', requires: null, toolGroup: 'create', icon: Box, testId: 'tool-create-voxel' },
      { id: 'create-plane', name: 'Create Plane', keywords: ['surface', 'ground', 'quad', 'flat', 'reference'], action: () => setShowPlanePopup(true), category: 'Create', requires: null, toolGroup: 'create', icon: Square, testId: 'tool-create-plane' },
      { id: 'add-scan', name: 'Add Scan', keywords: ['scanner', 'lidar', 'marker', 'sensor'], action: () => openAddScanPopup(), category: 'Create', requires: null, toolGroup: 'create', icon: Radio, testId: 'tool-add-scan' },

      // ── Simulate (synthetic scanning) ───────────────────────────────
      // Synthetic scan consumes scannable meshes + scanner markers and PRODUCES
      // a cloud — it must not require a cloud to already exist (that's backwards),
      // so it stays always-clickable and handleRunScan toasts what's missing
      // (no scannable geometry / no scanner positions).
      { id: 'lidar-scan', name: 'Run Synthetic Scan', keywords: ['scan', 'lidar', 'simulate', 'points', 'point cloud', 'ray'], action: () => handleRunScan(), category: 'Simulate', requires: null, toolGroup: 'simulate', icon: Compass, testId: 'tool-lidar-scan' },

      // Mesh tools — the per-mesh Transform (move / rotate / scale) is reached
      // from the double-arrow button on each row in the Meshes list panel, not
      // from the toolbar. The alignment variants are palette/menu only since
      // they're selection-driven multi-object operations.
      { id: 'mesh-cloud-align', name: 'Align Mesh to Cloud', keywords: ['icp', 'register', 'fit', 'compare', 'distance'], action: () => { void handleAlignmentCompute(); }, category: 'Mesh' },
      { id: 'mesh-mesh-align', name: 'Align Mesh to Mesh (ICP)', keywords: ['icp', 'register', 'fit'], action: () => { void handleMeshToMeshICP(); }, category: 'Mesh', requires: 'multiple-meshes' },

      // Plant-specific (palette/menu only)
      { id: 'plant-growth', name: 'Plant Growth Panel', keywords: ['age', 'time', 'animate'], action: () => setShowPlantGrowthPanel(!showPlantGrowthPanel), category: 'Plant', requires: 'plant' },
      { id: 'plant-morph', name: 'Morph Plant', keywords: ['parameter', 'shoot', 'tune', 'modify'], action: () => setShowMorphPopup(true), category: 'Plant', requires: 'plant' },

      // Skeleton tools (palette/menu only)
      { id: 'skeleton-translate', name: 'Translate Skeleton', keywords: ['move', 'position'], action: () => { closeAllToolPanels('editMode'); setEditMode(editMode === 'translate' ? 'none' : 'translate'); }, category: 'Skeleton', requires: 'skeleton' },

      // Export (palette/menu only — removed from the static toolbar; lives in File → Export)
      { id: 'cloud-export', name: 'Export Point Cloud', keywords: ['save', 'las', 'laz', 'xyz'], action: () => { closeAllToolPanels('export'); setShowExportPanel(!showExportPanel); }, category: 'Point Cloud', requires: 'cloud' },
      { id: 'mesh-export', name: 'Export Mesh', keywords: ['save', 'obj', 'ply'], action: () => { closeAllToolPanels('export'); setShowExportPanel(!showExportPanel); }, category: 'Mesh', requires: 'mesh' },
      { id: 'skeleton-export', name: 'Export Skeleton', keywords: ['save', 'json'], action: () => { closeAllToolPanels('export'); setShowExportPanel(!showExportPanel); }, category: 'Skeleton', requires: 'skeleton' },

      // History
      { id: 'undo', name: 'Undo', keywords: ['back', 'revert'], action: () => handleUndo(), category: 'History', requires: null },
      { id: 'redo', name: 'Redo', keywords: ['forward'], action: () => handleRedo(), category: 'History', requires: null },

      // Global settings (always available)
      { id: 'settings', name: 'Settings', keywords: ['options', 'preferences', 'triangulate', 'max points', 'cap', 'background', 'point size'], action: () => onOpenSettings?.(), category: 'App', requires: null },
    ];

    return cmds;
    // NOTE: handlers declared later in the component (handleMoveToOrigin,
    // handleRunScan, handleCreateShape, openAddScanPopup) are intentionally
    // omitted from deps — they're const-declared below this useMemo (TDZ), and
    // their action closures only run on click, by which point they're defined.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, showFilterPanel, showResamplePanel, showTriangulationPopup, showGroundSegmentPanel, showWoodSegmentPanel, showTreeSegmentPanel, showSkeletonPanel, showQSMPopup, showExportPanel, showPlantGrowthPanel, closeAllToolPanels, toggleCropMode, onSelectAll, onDeselectAll, selectedIds, handleUndo, handleRedo, onOpenSettings]);

  // Bridge for the native Tools menu (src/main/menu.ts → App.tsx) to run a tool
  // by id. A ref keeps the latest `commands` (with fresh action closures) so the
  // menu always invokes the current handler, never a stale one. One global,
  // matching the __handleUndo / __snapToView pattern.
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  // Latest selection so the menu bridge gates on availability identically to the
  // toolbar/palette — otherwise a menu click with an unmet prerequisite would
  // still fire the action (e.g. toggle a panel that never renders).
  const toolSelectionRef = useRef<SelectionState | null>(null);
  useEffect(() => {
    (window as any).__runToolCommand = (id: string) => {
      const cmd = commandsRef.current.find(c => c.id === id);
      if (!cmd) return;
      if (toolSelectionRef.current && !isCommandAvailable(cmd, toolSelectionRef.current)) return;
      cmd.action();
    };
    return () => { delete (window as any).__runToolCommand; };
  }, []);

  // Current selection state, shared by the static Toolbar, the Tools menu, and
  // the Cmd+K palette so all three derive availability identically.
  const toolSelection = useMemo<SelectionState>(() => ({
    hasCloud: hasCloudSelected,
    hasMesh: hasMeshSelected,
    hasSkeleton: hasSkeletonSelected,
    hasPlantMesh: !!hasPlantMeshSelected,
    cloudCount: selectedCloudCount,
    meshCount: selectedMeshIds.size,
    // Every scan present in the scene (data clouds + param-only scanner
    // markers), regardless of selection — gates picker-driven multi-input tools
    // (triangulate / stitch / align / LAD) so they stay clickable whenever any
    // scan exists and only grey out in a truly empty scene. Loading a Helios
    // scan XML (e.g. almond.xml) creates param-only scans with no point data;
    // those still count, so the tools' own modals can take over from there.
    totalScanCount: scans.length,
  }), [hasCloudSelected, hasMeshSelected, hasSkeletonSelected, hasPlantMeshSelected, selectedCloudCount, selectedMeshIds.size, scans.length]);
  toolSelectionRef.current = toolSelection;

  // Filter and sort commands based on search
  const filteredCommands = useMemo(() => {
    return commands
      .map(cmd => {
        const nameScore = fuzzyMatch(commandSearch, cmd.name);
        const keywordScore = cmd.keywords?.reduce((max, kw) => Math.max(max, fuzzyMatch(commandSearch, kw)), 0) || 0;
        const score = Math.max(nameScore, keywordScore * 0.8);
        const available = isCommandAvailable(cmd, toolSelection);
        const requiresText = toolRequiresText(cmd.requires ?? null);
        return { ...cmd, score, available, requiresText };
      })
      .filter(cmd => cmd.score > 0)
      .sort((a, b) => {
        // Available commands first
        if (a.available !== b.available) return a.available ? -1 : 1;
        // Then by score
        return b.score - a.score;
      });
  }, [commands, commandSearch, toolSelection]);

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

  // Get the target for snap/frame view based on the current selection. Unions the
  // world-space AABB of EVERY selected object across all types (meshes, skeletons,
  // QSMs, clouds) into a single box. Earlier this short-circuited on the first
  // non-empty type and used only the first selected mesh/skeleton, so selecting a
  // small mesh alongside a large scan framed just the mesh — i.e. way over-zoomed.
  const getSnapViewTarget = useCallback(() => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let hasData = false;
    const grow = (x: number, y: number, z: number) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      hasData = true;
    };

    // Meshes — vertices are local; add the mesh's render position to reach world.
    for (const id of selectedMeshIds) {
      const mesh = meshes.find(m => m.id === id);
      if (!mesh) continue;
      const pos = meshPositions.get(id) || { x: 0, y: 0, z: 0 };
      const { vertices, vertexCount } = mesh.data;
      for (let i = 0; i < vertexCount; i++) {
        grow(vertices[i * 3] + pos.x, vertices[i * 3 + 1] + pos.y, vertices[i * 3 + 2] + pos.z);
      }
    }

    // Skeletons — points are local; add the skeleton's render position.
    for (const id of selectedSkeletonIds) {
      const skeleton = skeletons.find(s => s.id === id);
      if (!skeleton) continue;
      const pos = skeletonPositions.get(id) || { x: 0, y: 0, z: 0 };
      const { points, pointCount } = skeleton.data;
      for (let i = 0; i < pointCount; i++) {
        grow(points[i * 3] + pos.x, points[i * 3 + 1] + pos.y, points[i * 3 + 2] + pos.z);
      }
    }

    // QSMs — cylinder endpoints are already world-space (no per-QSM translation).
    for (const id of selectedQSMIds) {
      const qsm = qsms.find(q => q.id === id);
      if (!qsm) continue;
      const box = qsmAabb(qsm);
      if (!box) continue;
      grow(box.min[0], box.min[1], box.min[2]);
      grow(box.max[0], box.max[1], box.max[2]);
    }

    // Point clouds — stored bounds are local; add the cloud's translation.
    for (const id of selectedIds) {
      const cloud = clouds.find(c => c.id === id);
      if (!cloud) continue;
      const trans = getEditState(id).translation;
      const bounds = cloud.data.bounds;
      grow(bounds.min.x + trans.x, bounds.min.y + trans.y, bounds.min.z + trans.z);
      grow(bounds.max.x + trans.x, bounds.max.y + trans.y, bounds.max.z + trans.z);
    }

    if (hasData) {
      return {
        center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
        size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ)
      };
    }

    // No selection - use origin with a default size
    return {
      center: new THREE.Vector3(0, 0, 0),
      size: new THREE.Vector3(2, 2, 2)
    };
  }, [selectedMeshIds, selectedSkeletonIds, selectedQSMIds, selectedIds, meshes, skeletons, qsms, clouds, meshPositions, skeletonPositions, getEditState]);

  // Frame the current selection (or everything, if nothing is selected) without
  // changing the viewing angle. Wired into zoomToSelectionRef (declared earlier)
  // so callbacks created *before* getSnapViewTarget's declaration — the command
  // registry and the global keydown handler — always invoke the latest version
  // without a stale closure or a TDZ on first render.
  zoomToSelectionRef.current = () => {
    (window as any).__frameSelection?.(getSnapViewTarget());
  };

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
    // Route through the backend `source` branch whenever the cloud is
    // session-backed (sessionId) OR file-backed (sourceXyzPath). Gating on
    // sessionId — not on sourceXyzPath — is load-bearing: a synthetic-scan cloud
    // is session-backed but its `sourceXyzPath` is `session.cache_dir ?? ''`,
    // which is EMPTY when the octree build failed (best-effort, swallowed) or
    // carried no cache_dir. The old `if (octree.sourceXyzPath)` gate dropped
    // those clouds to the inline branch, which (a) serialized the WHOLE cloud as
    // an uncapped `number[][]` JSON body (the triangulateMaxPoints cap only
    // applies to `source` payloads — a multi-million-point synthetic scan would
    // OOM the backend's JSON parse, the same failure mode as the Helios fix) and
    // (b) bypassed the session, ignoring unbaked deletions. The backend reads the
    // in-RAM session array when session_id is present and ignores source_path, so
    // an empty source_path is fine for a session-backed cloud.
    if (octree && (octree.sessionId || octree.sourceXyzPath)) {
      const t = getEditState(cloud.id).translation;
      const translation: [number, number, number] | null =
        (t.x !== 0 || t.y !== 0 || t.z !== 0) ? [t.x, t.y, t.z] : null;
      return {
        kind: 'source',
        source: {
          source_path: octree.sourceXyzPath || '',
          ascii_format: octree.asciiFormat ?? null,
          translation,
          // When the cloud is session-backed, downstream ops read the in-RAM
          // masked array (deletions already applied) instead of re-reading the
          // source file — so unbaked deletions are honored with no bake.
          session_id: octree.sessionId ?? null,
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
  // `columns` is the ordered ASCII column slug list (xyz/txt/csv) chosen in the
  // export modal, or null for binary/structured formats (fixed schema).
  const exportPointCloud = useCallback(async (format: 'xyz' | 'txt' | 'csv' | 'ply' | 'obj' | 'las' | 'laz', columns: string[] | null = null) => {
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

    if (format === 'xyz' || format === 'txt' || format === 'csv') {
      // ASCII export: honor the column list + order chosen in the export modal.
      // Fall back to a sensible default when none was passed (xyz; plus rgb /
      // intensity / scalars for txt/csv). CSV uses a plain header row + commas;
      // xyz/txt use a '#'-prefixed header (CloudCompare convention) + spaces.
      let slugs = columns ?? [];
      if (slugs.length === 0) {
        slugs = ['x', 'y', 'z'];
        if (format !== 'xyz') {
          if (data.colors) slugs.push('r', 'g', 'b');
          if (data.intensities) slugs.push('intensity');
          for (const f of Object.keys(data.scalarFields ?? {})) {
            if (f !== 'x' && f !== 'y' && f !== 'z' && f !== 'intensity') slugs.push(f);
          }
        }
      }
      const delimiter = format === 'csv' ? ',' : ' ';
      const headerPrefix = format === 'csv' ? '' : '# ';
      const text = buildAsciiExport(data, slugs, delimiter, headerPrefix);
      downloadFile(text, `${baseName}.${format}`);
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

  // Export the selected scan(s) as a Helios XML metadata file + one ASCII data
  // file per scan (re-loadable via loadXML, round-trips back into Phytograph).
  // `includeMisses` writes the sky/miss points (+ is_miss column); when off, the
  // export is returns-only. Requires a scan that carries scanner parameters.
  // Build the export entry for one scan-bearing cloud (source precedence
  // session → file → inline, plus viewer translation and the is_miss column).
  // Returns null when the cloud has no scanner params or no point data.
  const buildScanExportEntry = useCallback((cloudId: string): ScanExportEntry | null => {
    const cloud = clouds.find(c => c.id === cloudId);
    if (!cloud || !cloud.params) return null;
    const params = cloud.params;
    const entry: ScanExportEntry = {
      origin: [params.origin.x, params.origin.y, params.origin.z],
      scan_pattern: params.pattern,
      beam_elevation_angles_deg:
        params.pattern === 'spinning_multibeam' ? params.beamElevationAnglesDeg : undefined,
      n_theta: params.zenithPoints,
      n_phi: params.azimuthPoints,
      theta_min: params.zenithMinDeg,
      theta_max: params.zenithMaxDeg,
      phi_min: params.azimuthMinDeg,
      phi_max: params.azimuthMaxDeg,
      beam_exit_diameter: params.beamExitDiameterM,
      beam_divergence: params.beamDivergenceMrad,
      // Carried for the round-trip; backend cannot yet write it to the XML.
      scan_azimuth_offset: params.azimuthOffsetDeg,
    };
    const t = getEditState(cloud.id).translation;
    if (t.x !== 0 || t.y !== 0 || t.z !== 0) entry.translation = [t.x, t.y, t.z];

    const sessionId = cloud.data.octree?.sessionId;
    if (sessionId) {
      entry.session_id = sessionId;
      if (cloud.sourcePath) {
        entry.file_path = cloud.sourcePath;
        entry.ascii_format = cloud.asciiFormat ?? null;
      }
    } else if (cloud.sourcePath) {
      entry.file_path = cloud.sourcePath;
      entry.ascii_format = cloud.asciiFormat ?? null;
    } else if (cloud.data.positions.length > 0) {
      const points: number[][] = [];
      for (let i = 0; i < cloud.data.pointCount; i++) {
        points.push([cloud.data.positions[i * 3], cloud.data.positions[i * 3 + 1], cloud.data.positions[i * 3 + 2]]);
      }
      entry.points = points;
      // Inline clouds must ship the is_miss column so misses survive export.
      const miss = cloud.data.scalarFields?.[MISS_ATTRIBUTE];
      if (miss && miss.values.length === cloud.data.pointCount) {
        entry.scalar_columns = { [MISS_ATTRIBUTE]: Array.from(miss.values) };
      }
    } else {
      return null;  // no point data
    }
    return entry;
  }, [clouds, getEditState]);

  // Export one or more selected scans, either as a Helios XML + per-scan ASCII
  // bundle (writeXml=true) or as the per-scan ASCII data files only
  // (writeXml=false). `scanIds` are the user-chosen scans (from the panel's list).
  const exportScanXmlBundle = useCallback(async (scanIds: string[], includeMisses: boolean, writeXml: boolean, columns?: string[], dataFormat: string = 'xyz', gridIds: string[] = []) => {
    const entries: ScanExportEntry[] = [];
    for (const id of scanIds) {
      const e = buildScanExportEntry(id);
      // Apply the chosen column order to every scan (the picker offers a shared
      // column set; scans that don't carry a given column just skip it backend-side).
      if (e && columns && columns.length) e.columns = columns;
      if (e) entries.push(e);
    }
    if (entries.length === 0) {
      showToast({ title: 'Export Failed', type: 'error',
        message: 'No exportable scans selected (a scan needs scanner parameters and point data).' });
      return;
    }

    // Voxel-box grids the user added (XML mode only). Each grid's center/size are
    // already its viewer world transform (heliosGridOptions reads meshPositions/
    // meshScales/meshRotations), mirroring how import maps <grid> center → position
    // — so no scan-translation shift applies here; the grid is its own object.
    // Read via a ref since heliosGridOptions is declared later in the component.
    const gridOpts = heliosGridOptionsRef.current;
    const grids: HeliosGrid[] = gridIds
      .map(id => gridOpts.find(g => g.id === id)?.grid)
      .filter((g): g is HeliosGrid => !!g);

    // Effective per-scan file extension: XML mode always writes Helios .xyz data;
    // data-only writes the chosen format. The save picker fixes the folder + base
    // name only — the actual per-scan files are named <base>_<id>.<ext> by the backend.
    const ext = writeXml ? 'xml' : dataFormat;
    // Default save name: the single scan's label (filesystem-sanitised), matching
    // the Scans panel; a generic name for a multi-scan bundle.
    const firstScan = scans.find(s => s.id === scanIds[0]);
    const firstLabel = firstScan
      ? scanDisplayName(firstScan).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim()
      : '';
    const baseName = entries.length === 1
      ? (firstLabel || 'scan')
      : 'scans';
    const savePath = await window.electronAPI?.dialog.save({
      defaultPath: `${baseName}.${ext}`,
      title: writeXml ? 'Export Scan (XML + per-scan data)' : `Export Scan Data (${dataFormat.toUpperCase()})`,
      filters: writeXml
        ? [{ name: 'Helios scan XML', extensions: ['xml'] }]
        : [{ name: `Scan data (${dataFormat.toUpperCase()})`, extensions: [dataFormat] }],
    });
    if (!savePath) { setShowExportPanel(false); return; }

    // Derive the chosen folder + base name so the backend names match the files we
    // write. Strip ANY trailing extension the user may have typed — the per-scan
    // files are named by the backend in the chosen format.
    const sep = savePath.includes('\\') ? '\\' : '/';
    const dir = savePath.slice(0, savePath.lastIndexOf(sep));
    const chosenBase = savePath.slice(savePath.lastIndexOf(sep) + 1).replace(/\.[^.]+$/, '') || 'scan';

    try {
      const resp = await exportScanXml({
        scans: entries, base_name: chosenBase, include_misses: includeMisses,
        write_xml: writeXml, data_format: dataFormat,
        ...(grids.length ? { grids } : {}),
      });
      if (!resp.success || !resp.files) {
        showToast({ title: 'Export Failed', type: 'error', message: resp.error || 'Unknown error' });
        return;
      }
      // Write each returned file into the chosen folder, decoding base64.
      for (const f of resp.files) {
        const bin = atob(f.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const target = `${dir}${sep}${f.name}`;
        await window.electronAPI?.fs.writeBinary(target, bytes.buffer.slice(0) as ArrayBuffer);
      }
      showToast({ title: 'Export Complete', type: 'success',
        message: `Wrote ${resp.files.length} file(s) (${resp.point_count?.toLocaleString() ?? '?'} points).` });
    } catch (error) {
      showToast({ title: 'Export Failed', type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error' });
    }
    setShowExportPanel(false);
  }, [clouds, buildScanExportEntry]);

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

  // Whether a mesh was produced by triangulating a point cloud (standard or
  // Helios) — as opposed to a procedural plant, a shape/voxel primitive, or an
  // imported OBJ. Only these meshes get the per-triangle "Color by" control,
  // since the geometric/scan scalars are meaningful for reconstructed surfaces.
  // Helios meshes use sourceCloudId 'helios'; standard triangulations point at
  // a real cloud id. Plants/shapes/imports use synthetic ids ('plant-…',
  // 'shape-…', 'imported') that won't match a cloud and aren't plants here.
  const isTriangulatedMesh = useCallback((mesh: MeshEntry): boolean => {
    if (mesh.isPlant) return false;
    if (mesh.method === 'helios' || mesh.sourceCloudId === 'helios') return true;
    return clouds.some(c => c.id === mesh.sourceCloudId);
  }, [clouds]);

  // Resolve a mesh's source-cloud filename, for meshDisplayNameFor. Shared by
  // every call site so they all compute the same collision-deduped name.
  const meshFileNameFor = useCallback(
    (m: MeshEntry) => clouds.find(c => c.id === m.sourceCloudId)?.data.fileName,
    [clouds],
  );
  const displayNameOfMesh = useCallback(
    (mesh: MeshEntry) => meshDisplayNameFor(mesh, meshes, meshFileNameFor),
    [meshes, meshFileNameFor],
  );

  // Whether a mesh is a valid synthetic-scan TARGET: plant models and
  // imported-from-file meshes — but NOT triangulation results, the voxel grid,
  // or generated primitive shapes (those are derived geometry, not real scenes
  // a user would scan). isTriangulatedMesh already excludes plants and matches
  // triangulation/helios meshes; we additionally drop voxel grids and shapes.
  const isScannableMesh = useCallback((mesh: MeshEntry): boolean => {
    if (mesh.gridSubdivisions) return false;            // voxel grid overlay (incl. shape-voxel)
    if (isTriangulatedMesh(mesh)) return false;         // triangulation / helios
    // Generated primitives (plane/sphere/cube/cylinder/cone) ARE real surfaces a
    // user may want to scan — e.g. a manually-added ground plane. They used to be
    // blanket-excluded here, which silently dropped a ground plane from the scan
    // geometry (no ground hits). The only generated shape that must NOT be scanned
    // is the voxel grid, already excluded by the gridSubdivisions check above.
    return true;                                        // plants + imported meshes + solid shapes
  }, [isTriangulatedMesh]);

  // Whether a mesh renders through the textured material-group path (plant /
  // OBJ+MTL with UVs and at least one texture). Mirrors the render-side
  // condition that picks TexturedPlantMesh over TriangleMesh.
  const isTexturedMesh = useCallback((mesh: MeshEntry): boolean => {
    return !!(mesh.data.uvCoordinates && mesh.data.uvCoordinates.length > 0 &&
              mesh.plantMaterials && mesh.plantMaterials.some(m => m.textureData));
  }, []);

  // Whether a per-mesh opacity control is meaningful. Transparency blends a
  // solid / vertex-colored surface; it's a no-op on textured plants, whose
  // alpha-cutout leaf materials ignore opacity (see TexturedPlantMesh). So we
  // surface the slider for everything EXCEPT plants and textured meshes.
  const meshSupportsOpacity = useCallback((mesh: MeshEntry): boolean => {
    if (mesh.isPlant) return false;
    return !isTexturedMesh(mesh);
  }, [isTexturedMesh]);

  // Extract a mesh's geometry in WORLD space (scale -> rotate(Euler XYZ) ->
  // translate), matching how it's rendered. Returns the arrays the scan/scene
  // API expects. Shared so every scan target is transformed identically.
  const extractMeshWorldGeometry = useCallback((mesh: MeshEntry, carryOrgan = false) => {
    const meshPos = meshPositions.get(mesh.id) || { x: 0, y: 0, z: 0 };
    const meshScale = meshScales.get(mesh.id) || { x: 1, y: 1, z: 1 };
    const meshRot = meshRotations.get(mesh.id) || { x: 0, y: 0, z: 0 };

    const rotX = meshRot.x * Math.PI / 180;
    const rotY = meshRot.y * Math.PI / 180;
    const rotZ = meshRot.z * Math.PI / 180;
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);

    const vertices: number[][] = [];
    for (let i = 0; i < mesh.data.vertexCount; i++) {
      let x = mesh.data.vertices[i * 3] * meshScale.x;
      let y = mesh.data.vertices[i * 3 + 1] * meshScale.y;
      let z = mesh.data.vertices[i * 3 + 2] * meshScale.z;
      // Rotate around X
      let y1 = y * cosX - z * sinX;
      let z1 = y * sinX + z * cosX;
      // Rotate around Y
      let x2 = x * cosY + z1 * sinY;
      let z2 = -x * sinY + z1 * cosY;
      // Rotate around Z
      let x3 = x2 * cosZ - y1 * sinZ;
      let y3 = x2 * sinZ + y1 * cosZ;
      vertices.push([x3 + meshPos.x, y3 + meshPos.y, z2 + meshPos.z]);
    }

    const triangles: number[][] = [];
    for (let i = 0; i < mesh.data.triangleCount; i++) {
      triangles.push([
        mesh.data.indices[i * 3],
        mesh.data.indices[i * 3 + 1],
        mesh.data.indices[i * 3 + 2],
      ]);
    }

    let colors: number[][] | undefined;
    if (mesh.data.vertexColors && mesh.data.vertexColors.length > 0) {
      colors = [];
      for (let i = 0; i < mesh.data.vertexCount; i++) {
        colors.push([
          mesh.data.vertexColors[i * 3],
          mesh.data.vertexColors[i * 3 + 1],
          mesh.data.vertexColors[i * 3 + 2],
        ]);
      }
    }

    // Forward texture/UV/material info so the scan can honor leaf alpha masks
    // (Helios ray-traces against the texture's alpha channel — a leaf-shaped
    // cutout — instead of treating each leaf quad as opaque). Plant meshes and
    // imported OBJ+MTL meshes share the same plantMaterials / uvCoordinates
    // shape, so one path covers both. UVs are per-vertex and the world-space
    // transform above preserves vertex order, so they map 1:1; triangleIndices
    // are per-triangle ordinals into the same `triangles` array. We only forward
    // textured materials — flat-colored organs (stems/flowers) keep the
    // vertex-color path on the backend.
    let uv_coordinates: number[][] | undefined;
    let materials: LidarScanMaterial[] | undefined;
    if (isTexturedMesh(mesh) && mesh.data.uvCoordinates &&
        mesh.data.uvCoordinates.length === mesh.data.vertexCount * 2) {
      const texturedMats = (mesh.plantMaterials ?? []).filter(
        m => m.textureData && m.triangleIndices.length > 0
      );
      if (texturedMats.length > 0) {
        uv_coordinates = [];
        for (let i = 0; i < mesh.data.vertexCount; i++) {
          uv_coordinates.push([
            mesh.data.uvCoordinates[i * 2],
            mesh.data.uvCoordinates[i * 2 + 1],
          ]);
        }
        materials = texturedMats.map(m => ({
          name: m.name,
          texture_data: m.textureData as string,
          has_alpha: m.hasAlpha,
          triangle_indices: m.triangleIndices,
        }));
      }
    }

    // Organ-type code per triangle, forwarded only when the user opted in (the
    // 'organ' retained field is checked). `triangles` above is built in mesh
    // index order, so these line up 1:1 on the backend. Imported meshes have no
    // organ codes and simply forward nothing here.
    let organ_codes: number[] | undefined;
    if (carryOrgan && mesh.data.triangleOrganCodes &&
        mesh.data.triangleOrganCodes.length === mesh.data.triangleCount) {
      organ_codes = Array.from(mesh.data.triangleOrganCodes);
    }

    return { vertices, triangles, colors, uv_coordinates, materials, organ_codes };
  }, [meshPositions, meshScales, meshRotations, isTexturedMesh]);

  // Build PointCloudData from one scanner's scan result: positions, RGB colors,
  // a dedicated `intensities` array (so "color by intensity" works), and the rest
  // of the per-hit scalars as named scalarFields (each with min/max), plus bounds.
  const buildScanCloudData = useCallback((result: LidarScanResult, fileName: string, retainedFields: string[]): PointCloudData | null => {
    const n = result.numPoints;
    if (n === 0) return null;

    // Points arrive as a flat xyz Float32Array (zero-copy from the binary frame).
    const positions = result.points;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    const colors = result.colors && result.colors.length === n * 3 ? result.colors : undefined;

    // Turn each returned scalar list into a ScalarField, honoring the user's
    // retained-fields selection: unchecked standard fields are pruned, and
    // checked fields are kept even when constant (so e.g. a single-sweep
    // `timestamp` still shows in Color by). `intensity` also populates the
    // dedicated `intensities` array used by the intensity color mode + filter.
    const { scalarFields, intensities } = assembleScanScalarFields(
      result.scalars, n, retainedFields, STANDARD_HIT_FIELD_SLUGS,
    );

    // When the backend recorded misses it routed this scan through a cloud
    // session; attach a minimal octree ref carrying the session id + miss flag +
    // the projected-miss octree id so the MissOctree overlay and session-backed
    // ops (LAD, crop) work. Unlike imported octree clouds, the synthetic cloud
    // still renders from its in-memory `positions` above — the session is only the
    // source of truth for misses/LAD, not the primary render.
    let octree: PointCloudData['octree'];
    const session = result.session;
    if (session?.session_id) {
      octree = {
        cacheId: session.cache_id ?? session.session_id,
        sourceXyzPath: session.cache_dir ?? '',
        sessionId: session.session_id,
        hasMisses: Boolean(session.has_misses),
        scanOrigin: session.scan_origin ?? null,
        missOctreeCacheId: session.miss_octree_cache_id ?? null,
      };
    }

    return {
      positions,
      colors,
      intensities,
      scalarFields: Object.keys(scalarFields).length ? scalarFields : undefined,
      pointCount: n,
      bounds: {
        min: new THREE.Vector3(minX, minY, minZ),
        max: new THREE.Vector3(maxX, maxY, maxZ),
        center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
        size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ),
      },
      fileName,
      octree,
    };
  }, []);

  // Execute the scan and write each scanner's hits back into ITS OWN scan.
  // `overwriteMode` decides what to do for scanners that already carry point data:
  //   'overwrite' — replace the existing data in place
  //   'duplicate' — keep the original, add a new scan carrying the synthetic data
  // Scanners with no existing data always get their data attached in place.
  const executeScan = useCallback(async (
    targetMeshes: MeshEntry[],
    activeScanners: Scan[],
    overwriteMode: 'overwrite' | 'duplicate',
    options: SyntheticScanOptions,
  ) => {
    setIsScanning(true);
    setScanProgress(null);
    try {
      // Carry organ-type codes into the scan only when the user checked the
      // 'organ' retained field, so each hit can be labeled/colored by organ.
      const carryOrgan = options.retainedFields.includes('organ');
      const requestMeshes = targetMeshes.map((m) => extractMeshWorldGeometry(m, carryOrgan));
      const requestScanners = activeScanners.map(s => {
        const p = s.params!;
        return {
          id: s.id,
          origin: [p.origin.x, p.origin.y, p.origin.z],
          scan_pattern: p.pattern,
          beam_elevation_angles_deg:
            p.pattern === 'spinning_multibeam' ? p.beamElevationAnglesDeg : undefined,
          n_theta: p.zenithPoints,
          n_phi: p.azimuthPoints,
          theta_min_deg: p.zenithMinDeg,
          theta_max_deg: p.zenithMaxDeg,
          phi_min_deg: p.azimuthMinDeg,
          phi_max_deg: p.azimuthMaxDeg,
          return_mode: p.returnMode,
          max_returns: p.maxReturns,
          return_selection: p.returnSelection,
          exit_diameter_m: p.beamExitDiameterM,
          beam_divergence_mrad: p.beamDivergenceMrad,
          // Tilt is a per-scan property; noise is a per-run simulation option
          // applied uniformly to every scanner this run.
          tilt_roll_deg: p.tiltRollDeg,
          tilt_pitch_deg: p.tiltPitchDeg,
          // Initial scanner heading; rotates the ray fan about world +z (raster
          // scans) or folds into the trajectory yaw (spinning multibeam).
          scan_azimuth_offset_deg: p.azimuthOffsetDeg,
          range_noise_m: options.rangeNoiseMm / 1000,  // mm → m
          angle_noise_mrad: options.angleNoiseMrad,
          // Moving-platform scan: forward the trajectory + pulse rate so the
          // backend drives addScanMoving instead of a static scan from origin.
          ...(p.trajectory
            ? {
                trajectory: poseStreamToWire(p.trajectory),
                pulse_rate_hz: p.pulseRateHz ?? 300000,
              }
            : {}),
        };
      });

      // Crop-to-grid: send the single visible voxel grid (the popup only enabled
      // the toggle when exactly one is available).
      let grid: HeliosGrid | undefined;
      if (options.cropToGrid) {
        const gridMesh = meshes.find(m => m.visible && m.gridSubdivisions);
        if (gridMesh) {
          grid = voxelMeshToHeliosGrid(
            meshPositions.get(gridMesh.id),
            meshScales.get(gridMesh.id),
            gridMesh.gridSubdivisions,
          ) ?? undefined;
        }
      }

      const controller = new AbortController();
      scanAbortRef.current = controller;

      // Total pulses across the participating scanners — the ray-trace cost
      // scales with this, so it paces the synthetic creep below (mirrors how the
      // backfill creep is paced by point count). Same derivation the options
      // popup uses for its estimate: a static scanner fires Ntheta×Nphi; a moving
      // one fires ≈PRF×flight-duration. rays_per_pulse multiplies the C++ work,
      // so fold it in too.
      let totalPulses = 0;
      for (const s of activeScanners) {
        const p = s.params;
        if (!p) continue;
        const nTheta = p.pattern === 'spinning_multibeam'
          ? Math.max(p.beamElevationAnglesDeg.length, 1)
          : p.zenithPoints;
        totalPulses += p.trajectory
          ? deriveMovingScanGrid(
              nTheta, p.azimuthPoints, p.pulseRateHz ?? 300000,
              trajectoryDurationS(p.trajectory),
            ).totalPulses
          : nTheta * p.azimuthPoints;
      }
      const rayWork = Math.max(totalPulses, 1) * Math.max(options.raysPerPulse, 1);
      // Pace the creep to roughly track real ray-trace wall-clock so the bar sits
      // near the band end as the scan finishes (minimising the snap when the real
      // "Extracting hits" marker arrives). Floored so a tiny scan still animates.
      const estimatedMs = Math.max(1500, rayWork / 400);

      // The ray-trace is one opaque C++ call reported as a null fraction; ease the
      // bar across its band with an asymptotic creep, snapping onto truth whenever
      // a real marker arrives. Mirrors the Backfill Misses gapfill reporter.
      let lastValue = 0;
      let synthTimer: ReturnType<typeof setInterval> | null = null;
      const stopSynth = () => { if (synthTimer) { clearInterval(synthTimer); synthTimer = null; } };
      scanSynthStopRef.current = stopSynth;
      const report = (p: number | null, msg: string) => {
        if (p != null) {
          // Real marker: snap the bar onto the streamed fraction and end any creep.
          stopSynth();
          lastValue = p;
          setScanProgress({ label: msg, value: p });
          return;
        }
        // Indeterminate stage (the ray-trace): ease from where we are toward a cap
        // just shy of the next real marker (0.85 "Extracting hits"), never quite
        // reaching it — real completion snaps the bar forward.
        const bandStart = Math.max(lastValue, 0.15);
        const bandEnd = 0.82;
        const span = Math.max(bandEnd - bandStart, 0);
        const t0 = performance.now();
        setScanProgress({ label: msg, value: bandStart });
        stopSynth();
        synthTimer = setInterval(() => {
          const elapsed = performance.now() - t0;
          // 1 - e^(-t/τ) approaches 1 asymptotically; τ = estimatedMs/3 reaches
          // ~95% of the band at the estimate, so the bar sits near the band end
          // before the real marker arrives.
          const eased = 1 - Math.exp(-elapsed / (estimatedMs / 3));
          setScanProgress({ label: msg, value: bandStart + span * eased });
        }, 100);
      };

      // Split the retained-field selection: non-standard fields (deviation /
      // nRaysHit / reflectance) must be requested via extra_fields so the backend
      // reads them; the standard ones the user kept are sent so the misses-on
      // session path prunes the rest from color-by (parity with the flat path).
      const optionalToRead = options.retainedFields.filter((slug) => {
        const f = SCAN_HIT_FIELDS.find((x) => x.slug === slug);
        return f && !f.isStandard;
      });
      const retainedStandards = options.retainedFields.filter(
        (slug) => STANDARD_HIT_FIELD_SLUGS.includes(slug));

      const response = await runLidarScan({
        meshes: requestMeshes,
        scanners: requestScanners,
        extra_fields: optionalToRead,
        retained_standard_fields: retainedStandards,
        rays_per_pulse: options.raysPerPulse,
        pulse_distance_threshold: options.pulseDistanceThresholdM,
        record_misses: options.includeMisses,
        scan_grid_only: grid !== undefined,
        grid,
        synthetic_scan_memory_budget_mb: syntheticScanMemoryBudgetMb ?? undefined,
      }, controller.signal, report, (runId) => { scanRunIdRef.current = runId; });
      stopSynth();  // request resolved — no more synthetic creep
      if (!response.success) {
        showToast({ title: response.error || 'Scan failed', type: 'error' });
        return;
      }

      const scannerById = new Map(activeScanners.map(s => [s.id, s]));
      let totalPoints = 0;
      let scannersWithHits = 0;

      for (const result of response.results) {
        const scanner = scannerById.get(result.scannerId);
        if (!scanner) continue;
        if (result.numPoints === 0) continue;

        const baseName = `${scanDisplayName(scanner)}_scan`;
        const data = buildScanCloudData(result, baseName, options.retainedFields);
        if (!data) continue;

        totalPoints += result.numPoints;
        scannersWithHits++;

        const alreadyHasData = hasData(scanner);
        if (alreadyHasData && overwriteMode === 'duplicate') {
          // Keep the original; spawn a new scan carrying both the params and data.
          onAddScan?.({
            id: crypto.randomUUID(),
            label: `${scanDisplayName(scanner)} (scan)`,
            visible: true,
            color: scanner.color,
            params: scanner.params,
            data,
          });
        } else {
          // Attach (or overwrite) data on the scanner's own scan in place.
          onUpdateScanData(scanner.id, data);
        }
      }

      if (scannersWithHits === 0) {
        showToast({ title: 'Scan returned no hits — check that scanners point at the geometry', type: 'error' });
        return;
      }
      showToast({
        title: `Scanned ${totalPoints.toLocaleString()} points across ${scannersWithHits} scanner${scannersWithHits === 1 ? '' : 's'}`,
        type: 'success',
      });
    } catch (error) {
      // User-initiated cancel isn't a failure. Either the fetch aborted
      // (AbortError) or the backend acknowledged the cancel with a terminal
      // marker (ScanCancelledError) — both surface as a neutral notice.
      if (
        (error instanceof DOMException && error.name === 'AbortError') ||
        error instanceof ScanCancelledError
      ) {
        showToast({ title: 'Scan cancelled', type: 'info' });
        return;
      }
      console.error('Synthetic LiDAR scan failed:', error);
      showToast({ title: `Scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`, type: 'error' });
    } finally {
      scanSynthStopRef.current?.();
      scanSynthStopRef.current = null;
      scanAbortRef.current = null;
      scanRunIdRef.current = null;
      setIsScanning(false);
      setScanProgress(null);
    }
  }, [extractMeshWorldGeometry, buildScanCloudData, onUpdateScanData, onAddScan, meshes, meshPositions, meshScales, syntheticScanMemoryBudgetMb]);

  // Entry point: validate the targets, then open the Synthetic Scan Options popup
  // (the actual run happens from handleScanOptionsRun once the user confirms).
  const handleRunScan = useCallback(async () => {
    // Scanner positions are what the options modal lets you pick, so we need at
    // least one to EXIST to have anything to show. Visibility is NOT a gate —
    // the picker lists every scan position with scanner parameters whether or
    // not it is currently visible/selected (a hidden scanner is still a valid
    // origin to ray-trace from). Geometry is NOT pre-checked here — the modal
    // opens regardless (e.g. right after loading a scan XML that placed scanners
    // but no mesh) and surfaces the missing-geometry requirement inside,
    // disabling Run until a scannable mesh exists.
    const activeScanners = scans.filter(s => s.params);
    if (activeScanners.length === 0) {
      showToast({ title: 'No scanner — place a scanner marker to define a scan position', type: 'error' });
      return;
    }
    const targetMeshes = meshes.filter(m => m.visible && isScannableMesh(m));
    setPendingScan({ targetMeshes, activeScanners });
  }, [meshes, scans, isScannableMesh]);

  // After the options popup confirms: either scan immediately or prompt about
  // scanners that already hold point data (overwrite / duplicate / cancel).
  // `selectedScannerIds` is the subset of scan positions the user kept enabled
  // in the popup; everything downstream operates on that subset only.
  const handleScanOptionsRun = useCallback(async (options: SyntheticScanOptions, selectedScannerIds: string[]) => {
    const pending = pendingScan;
    setPendingScan(null);
    if (!pending) return;
    const { targetMeshes } = pending;
    if (targetMeshes.length === 0) {  // popup disables Run without geometry; guard anyway
      showToast({ title: 'No scannable geometry — add a plant or import a mesh, and make it visible', type: 'error' });
      return;
    }
    const idSet = new Set(selectedScannerIds);
    const activeScanners = pending.activeScanners.filter(s => idSet.has(s.id));
    if (activeScanners.length === 0) return;  // popup disables Run in this case

    // If any participating scanner already has point data, ask first.
    const withData = activeScanners.filter(hasData);
    if (withData.length > 0) {
      setScanOverwriteConfirm({ targetMeshes, activeScanners, count: withData.length, options });
      return;
    }

    await executeScan(targetMeshes, activeScanners, 'overwrite', options);
  }, [pendingScan, executeScan]);

  const pendingGridAvailable = useMemo(
    () => meshes.filter(m => m.visible && m.gridSubdivisions).length === 1,
    [meshes],
  );

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


  // Serialize a FLAT cloud's display positions into the backend's `points`
  // (`number[][]`), STRIDE-DOWNSAMPLED to the triangulate cap. Only reached for
  // clouds with neither a session nor a source file (genuinely flat, in-RAM) —
  // session/file clouds go through buildPointSource's `source` branch (capped
  // server-side). The cap matters because this branch JSON-serializes the points:
  // an uncapped multi-million-point flat cloud (e.g. a large no-path import) would
  // build a huge `number[][]` + JSON body, the same OOM shape as the Helios fix.
  // Stride (not reservoir) preserves spatial uniformity, matching the backend's
  // _read_points_from_source downsample. Returns {points, used, total}.
  const flatPointsCapped = useCallback((data: PointCloudData): { points: number[][]; used: number; total: number } => {
    const total = data.pointCount;
    const stride = total > triangulateMaxPoints ? Math.ceil(total / triangulateMaxPoints) : 1;
    const points: number[][] = [];
    for (let i = 0; i < total; i += stride) {
      const idx = i * 3;
      points.push([data.positions[idx], data.positions[idx + 1], data.positions[idx + 2]]);
    }
    return { points, used: points.length, total };
  }, [triangulateMaxPoints]);

  // Open3D triangulation (ball_pivoting / poisson / alpha_shape / delaunay),
  // driven by the unified TriangulationPopup. Supports multiple selected scans,
  // either per-scan (one mesh each) or merged (selected scans' points fused into
  // one mesh). Helios goes through handleHeliosTriangulate instead.
  const handleTriangulateOpen3D = useCallback(async (args: {
    method: Exclude<TriangulationMethod, 'helios'>;
    scanIds: string[];
    merge: boolean;
    depth?: number;
    alpha?: number | null;
    radii?: number[];
    cropBox?: {
      min: [number, number, number];
      max: [number, number, number];
      rotationDeg?: number;
    };
    // Ball Pivot LAD pin: the grid the mesh is pinned to (drives backend
    // per-triangle cell binning) and the source voxel-box mesh id. Set only for
    // ball_pivoting + per-scan (the dispatcher omits them for merged meshes).
    grid?: HeliosGrid;
    gridMeshId?: string;
  }) => {
    const { method, scanIds, merge, depth, alpha, radii, cropBox, grid, gridMeshId } = args;
    // Flatten the optional crop box to the backend's [minx,miny,minz,maxx,maxy,maxz].
    const cropBoxArr = cropBox
      ? [cropBox.min[0], cropBox.min[1], cropBox.min[2], cropBox.max[0], cropBox.max[1], cropBox.max[2]]
      : undefined;
    // Rotated crop box: the box's azimuthal rotation (deg about +z), sent so the
    // backend crops the rotated box rather than its axis-aligned extent.
    const cropBoxRotationDeg = cropBox?.rotationDeg;
    const targets = scanIds
      .map(id => clouds.find(c => c.id === id))
      .filter((c): c is PointCloudEntry => c != null);
    if (targets.length === 0) return;

    setTriangulationInProgress(true);
    setTriangulationError(null);
    setTriProgress({ label: 'Triangulating…', value: null });
    const abort = new AbortController();
    triAbortRef.current = abort;

    // Method-specific request fields, applied identically to every request.
    const applyMethodParams = (request: Parameters<typeof triangulatePointCloud>[0]) => {
      if (method === 'poisson' && depth != null) request.depth = depth;
      else if (method === 'alpha_shape' && alpha != null) request.alpha = alpha;
      else if (method === 'ball_pivoting' && radii && radii.length > 0) request.radii = radii;
    };
    const methodParamProvenance = (p: NonNullable<MeshEntry['triangulationParams']>) => {
      if (method === 'poisson' && depth != null) p.depth = depth;
      else if (method === 'alpha_shape' && alpha != null) p.alpha = alpha;
      else if (method === 'ball_pivoting' && radii && radii.length > 0) p.radii = radii;
    };

    try {
      if (merge) {
        // Merged: fuse every selected cloud into one mesh. Octree-backed clouds
        // hold their points in the backend session (cloud.data.positions is
        // empty — they stream from the octree), so they can't be merged on the
        // client; we send each as a source descriptor in `sources[]` and the
        // backend reads + vstacks them (per-source max_points caps each). Flat
        // clouds (inline data) fold in via `points`. The backend honors session
        // deletions, so this stays consistent with "array is source of truth".
        const sources: NonNullable<Parameters<typeof triangulatePointCloud>[0]['sources']> = [];
        const points: number[][] = [];
        for (const cloud of targets) {
          const ps = buildPointSource(cloud);
          if (ps.kind === 'source') {
            sources.push({ ...ps.source, max_points: triangulateMaxPoints });
          } else {
            // Flat cloud (no session/file): fold in its points, capped.
            points.push(...flatPointsCapped(ps.data).points);
          }
        }

        const request: Parameters<typeof triangulatePointCloud>[0] = {
          method,
          estimate_normals: true,
          normal_radius: 0.1,
          normal_max_nn: 30,
          ...(sources.length > 0 ? { sources } : {}),
          ...(points.length > 0 ? { points } : {}),
          ...(cropBoxArr ? { crop_box: cropBoxArr } : {}),
          ...(cropBoxRotationDeg ? { crop_box_rotation_deg: cropBoxRotationDeg } : {}),
        };
        applyMethodParams(request);

        const response = await triangulatePointCloud(request, abort.signal, (p, msg) =>
          setTriProgress({ label: msg, value: p }), (runId) => { triRunIdRef.current = runId; });
        if (!response.success) throw new Error(response.error || 'Triangulation failed');

        const meshData: MeshData = {
          vertices: response.vertices,
          indices: response.triangles,
          normals: response.normals,
          vertexCount: response.numVertices,
          triangleCount: response.numTriangles,
          surfaceArea: response.surfaceArea,
        };
        const triangulationParams: NonNullable<MeshEntry['triangulationParams']> = {
          normalRadius: request.normal_radius,
          normalMaxNn: request.normal_max_nn,
          pointsUsed: response.pointsUsed,
          scanCount: targets.length,
        };
        methodParamProvenance(triangulationParams);

        const meshEntry: MeshEntry = {
          id: crypto.randomUUID(),
          sourceCloudId: targets[0].id,
          data: meshData,
          visible: true,
          color: targets[0].color,
          method,
          triangulationParams,
        };
        addMesh(meshEntry, undefined, 'Triangulate');
        setShowTriangulationPopup(false);
        for (const c of targets) onHideScan(c.id);

        const totalPoints = targets.reduce((sum, c) => sum + c.data.pointCount, 0);
        if (response.downsampled && typeof response.pointsUsed === 'number') {
          showToast({
            type: 'warning',
            title: 'Merged cloud downsampled for triangulation',
            message: `Triangulated ${response.pointsUsed.toLocaleString()} of ${totalPoints.toLocaleString()} merged points (Settings → Triangulate max points). Raise the cap for more detail.`,
          });
        }
        showToast({
          type: 'success',
          title: 'Triangulation Complete',
          message: `Created mesh from ${targets.length} scans with ${meshData.triangleCount.toLocaleString()} triangles`,
        });
        return;
      }

      // Per-scan: one mesh per selected cloud. Octree clouds send a source
      // descriptor capped at the global max; flat clouds send inline points.
      const newMeshes: MeshEntry[] = [];
      let totalTriangles = 0;
      let downsampledNote: string | null = null;
      for (let cloudIdx = 0; cloudIdx < targets.length; cloudIdx++) {
        const cloud = targets[cloudIdx];
        const ps = buildPointSource(cloud);
        const request: Parameters<typeof triangulatePointCloud>[0] = {
          method,
          estimate_normals: true,
          normal_radius: 0.1,
          normal_max_nn: 30,
          ...(cropBoxArr ? { crop_box: cropBoxArr } : {}),
          ...(cropBoxRotationDeg ? { crop_box_rotation_deg: cropBoxRotationDeg } : {}),
          // Grid pin (per-scan ball-pivot): drives the backend's per-triangle cell
          // binning so this mesh can later be re-used for the LAD inversion.
          ...(grid ? { grid } : {}),
        };
        if (ps.kind === 'source') {
          request.source = { ...ps.source, max_points: triangulateMaxPoints };
        } else {
          // Flat cloud (no session/file): serialize its points, capped.
          request.points = flatPointsCapped(ps.data).points;
        }
        applyMethodParams(request);

        // Fold the backend's per-cloud fraction into overall progress across the
        // N clouds; prefix the stage label with [N/M] when there's more than one.
        const response = await triangulatePointCloud(request, abort.signal, (p, msg) => {
          const frac = p == null ? null : (cloudIdx + p) / targets.length;
          const label = targets.length > 1 ? `[${cloudIdx + 1}/${targets.length}] ${msg}` : msg;
          setTriProgress({ label, value: frac });
        }, (runId) => { triRunIdRef.current = runId; });
        if (!response.success) throw new Error(response.error || 'Triangulation failed');

        const meshData: MeshData = {
          vertices: response.vertices,
          indices: response.triangles,
          normals: response.normals,
          vertexCount: response.numVertices,
          triangleCount: response.numTriangles,
          surfaceArea: response.surfaceArea,
          // Grid pin provenance (per-scan ball-pivot): the grid the mesh is pinned
          // to plus the per-triangle cell ids, so the LAD reuse path can keep only
          // in-grid triangles. Mirrors the fields a Helios mesh carries.
          ...(grid ? { grid } : {}),
          ...(grid && response.triangleCellIds ? { triangleCellIds: response.triangleCellIds } : {}),
        };
        const triangulationParams: NonNullable<MeshEntry['triangulationParams']> = {
          normalRadius: request.normal_radius,
          normalMaxNn: request.normal_max_nn,
          pointsUsed: response.pointsUsed,
          // Grid pin: record the source voxel-box mesh id (so LAD can auto-hide it)
          // and the single owning scan id (this mesh is one scan), so the LAD option
          // builder and reuse-payload remap can resolve the scan. Set only when
          // pinned to a real grid — these two together mark the mesh LAD-reusable.
          ...(grid ? { gridMeshId, sourceScanIds: [cloud.id] } : {}),
        };
        methodParamProvenance(triangulationParams);

        newMeshes.push({
          id: crypto.randomUUID(),
          sourceCloudId: cloud.id,
          data: meshData,
          visible: true,
          color: cloud.color,
          method,
          triangulationParams,
        });
        totalTriangles += meshData.triangleCount;

        if (
          ps.kind === 'source' &&
          response.downsampled &&
          typeof response.pointsUsed === 'number'
        ) {
          downsampledNote = `${response.pointsUsed.toLocaleString()} of ${cloud.data.pointCount.toLocaleString()} points (Settings → Triangulate max points)`;
        }
      }

      addMeshes(newMeshes, 'Triangulate');
      setShowTriangulationPopup(false);
      for (const c of targets) onHideScan(c.id);

      if (downsampledNote) {
        showToast({
          type: 'warning',
          title: 'Cloud downsampled for triangulation',
          message: `Triangulated ${downsampledNote}. Raise the cap for more detail.`,
        });
      }
      showToast({
        type: 'success',
        title: 'Triangulation Complete',
        message: newMeshes.length === 1
          ? `Created mesh with ${totalTriangles.toLocaleString()} triangles`
          : `Created ${newMeshes.length} meshes with ${totalTriangles.toLocaleString()} triangles total`,
      });
    } catch (error) {
      // User-initiated cancel (pill X) — fetch abort OR a backend cancelled
      // marker — is not an error to surface.
      if ((error instanceof DOMException && error.name === 'AbortError')
          || error instanceof ScanCancelledError) {
        setTriangulationError(null);
      } else {
        console.error('Triangulation error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Triangulation failed';
        setTriangulationError(errorMessage);
        showToast({
          type: 'error',
          title: 'Triangulation Failed',
          message: errorMessage,
        });
      }
    } finally {
      setTriangulationInProgress(false);
      setTriProgress(null);
      triAbortRef.current = null;
      triRunIdRef.current = null;
    }
  }, [clouds, buildPointSource, triangulateMaxPoints, flatPointsCapped, onHideScan, addMesh, addMeshes]);

  // Segment ground vs plant points (Cloth Simulation Filter). Writes a
  // `ground_class` scalar attribute (1=ground, 2=plant) and colors by it.
  // Session (octree) clouds run CSF on the in-RAM array and append the column
  // (sessionSegmentGround) — no file re-read; flat clouds get the labels written
  // into scalarFields directly. Optionally splits into ground/plant clouds: for
  // session clouds via sessionExtract (parent untouched), for flat clouds in
  // memory.
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

      // --- Session-backed octree cloud: CSF on the in-RAM array, append
      // ground_class, rebuild from arrays (no file re-read). ---
      if (ps.kind === 'source') {
        const octreeInfo = cloud.data.octree;
        if (!octreeInfo?.sessionId) {
          throw new Error('Octree cloud is missing its editable session.');
        }
        const baseName = cloud.data.fileName ?? id;
        const sessionId = octreeInfo.sessionId;
        const meta = await sessionSegmentGround(sessionId, csfParams);
        // The parent keeps ALL points, classified + coloured by ground_class.
        onUpdateCloud(id, buildSessionOctreeData(meta, octreeInfo, baseName));
        setColorMode('scalar');
        setSelectedScalarField(GROUND_CLASS_ATTRIBUTE);
        setShowGroundSegmentPanel(false);

        // Optional split: extract each class into its own child session (parent
        // untouched). Pure array operation — no source file read.
        if (groundSplitClouds && onAddCloud) {
          const addClassCloud = async (cls: number, suffix: string, color: string) => {
            const r = await sessionExtract(sessionId, {
              scalarFilters: [{ slug: 'ground_class', min: cls, max: cls, values: [cls] }],
            });
            if (r.extracted) {
              onAddCloud({
                id: crypto.randomUUID(),
                data: buildSessionOctreeData(
                  r.extracted, octreeInfo, `${baseName} (${suffix})`, r.extracted.session_id,
                ),
                visible: true,
                color,
              });
            }
          };
          await addClassCloud(1, 'ground', '#8c6643');
          await addClassCloud(2, 'non-ground', '#4caf50');
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

  // Pull a per-point reflectance/intensity scalar from a flat cloud's display
  // data for the inline reflectance-assist path, as a plain number[] aligned to
  // the point order, or null when none is present. Prefers a 'reflectance'
  // scalar field, then 'intensity' field, then the `intensities` array.
  const inlineReflectance = useCallback((d: PointCloudData): number[] | null => {
    const sf = d.scalarFields;
    if (sf) {
      const key = Object.keys(sf).find(k => /^(reflectance|intensity)$/i.test(k));
      if (key && sf[key]?.values?.length === d.pointCount) {
        return Array.from(sf[key].values);
      }
    }
    if (d.intensities && d.intensities.length === d.pointCount) {
      return Array.from(d.intensities);
    }
    return null;
  }, []);

  // True when the (single) selected cloud carries a reflectance/intensity scalar
  // — gates the assist toggle in the panel. Octree/session clouds expose it via
  // a scalar field or the source's intensity, which the backend re-reads.
  const woodReflectanceAvailable = useMemo(() => {
    const ids = Array.from(selectedIds);
    return ids.some(tid => {
      const c = clouds.find(x => x.id === tid);
      if (!c) return false;
      const sf = c.data.scalarFields;
      const hasField = !!sf && Object.keys(sf).some(k => /^(reflectance|intensity)$/i.test(k));
      return hasField || !!(c.data.intensities && c.data.intensities.length > 0);
    });
  }, [selectedIds, clouds]);

  // Segment wood vs leaf points (geometric, non-ML: verticality + low-sphericity).
  // Writes a `wood_class` scalar attribute (1=wood, 2=leaf) and colours by it.
  // Mirrors handleGroundSegment: session (octree) clouds run on the in-RAM array
  // and append the column (sessionSegmentWood) — no file re-read; flat clouds get
  // labels written into scalarFields. `woodMode` selects the output:
  //  - 'label':  keep all points, classified + coloured.
  //  - 'split':  additionally emit wood-only and leaf-only child clouds.
  //  - 'remove': drop the wood points, leaving a leaf-only cloud (wood removal).
  const handleWoodSegment = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const targets = ids
      .map(tid => clouds.find(c => c.id === tid))
      .filter((c): c is PointCloudEntry => !!c);
    if (targets.length === 0) return;

    const WOOD = 1, LEAF = 2;
    // Surface non-fatal backend advisories (e.g. the connectivity method warning
    // that the cloud's base looks like un-removed ground) as a warning toast.
    const showWoodWarnings = (warnings?: string[]) => {
      if (warnings && warnings.length > 0) {
        showToast({ type: 'info', title: 'Wood / Leaf Segmentation', message: warnings.join(' ') });
      }
    };
    // Reflectance assist: enabled only when the user toggle is on. The backend
    // self-weights by per-cloud separability (≈0 on low-contrast species), and
    // for octree/session clouds it re-reads the scalar itself, so we just pass a
    // positive weight cap; the inline path additionally sends the scalar array.
    const reflWeight = woodUseReflectance ? WOOD_REFLECTANCE_WEIGHT_MAX : 0;
    const woodParams: WoodSegmentTuning = {
      wood_bias: woodBias,
      k_max: woodKMax,
      reg_iters: woodRegIters,
      reflectance_weight_max: reflWeight,
      method: woodMethod,
    };
    const aggregate = targets.length > 1 && woodMultiMode === 'aggregate';

    setWoodSegmentInProgress(true);
    setWoodSegmentError(null);

    try {
      // === Aggregate: segment all selected scans TOGETHER (denser local
      // geometry), then scatter the labels back to each scan in place as a
      // wood_class scalar field. Assumes the scans are pre-registered (a common
      // coordinate frame). Works on flat (in-RAM) clouds: their world-space
      // points are concatenated IN ORDER, segmented once, then sliced back.
      // Octree-backed clouds can't take an externally-computed label array
      // (no apply-labels endpoint), so a selection containing any octree cloud
      // falls back to per-scan. ===
      if (aggregate) {
        const resolved = targets.map(c => ({ cloud: c, ps: buildPointSource(c) }));
        const anyOctree = resolved.some(r => r.ps.kind === 'source');
        if (anyOctree) {
          showToast({
            type: 'info',
            title: 'Segmenting scans separately',
            message: 'Together-mode needs in-memory clouds; one or more selections stream from an octree, so each is segmented on its own.',
          });
        } else {
          // Concatenate every cloud's world-space points in selection order,
          // tracking each run so labels can be sliced back.
          const inlineParts: number[][] = [];
          const reflParts: number[] = [];
          // Reflectance assist only applies if EVERY scan carries the scalar
          // (otherwise the concatenated array can't align 1:1) — mirrors the
          // backend's all-or-nothing rule for multi-source requests.
          let allHaveRefl = reflWeight > 0;
          const order: { id: string; count: number; displayData: PointCloudData }[] = [];
          for (const { cloud, ps } of resolved) {
            const d = (ps as { data: PointCloudData }).data;
            const t = getEditState(cloud.id).translation;
            for (let i = 0; i < d.pointCount; i++) {
              inlineParts.push([
                d.positions[i * 3] + t.x,
                d.positions[i * 3 + 1] + t.y,
                d.positions[i * 3 + 2] + t.z,
              ]);
            }
            const r = allHaveRefl ? inlineReflectance(d) : null;
            if (r) reflParts.push(...r); else allHaveRefl = false;
            order.push({ id: cloud.id, count: d.pointCount, displayData: d });
          }

          const response = await segmentWood({
            points: inlineParts,
            ...woodParams,
            ...(allHaveRefl && reflParts.length === inlineParts.length
              ? { reflectance: reflParts }
              : {}),
          });
          if (!response.success) {
            throw new Error(response.error || 'Wood/leaf segmentation failed');
          }
          showWoodWarnings(response.warnings);
          const labels = response.labels;

          let cursor = 0;
          for (const o of order) {
            const slice = labels.slice(cursor, cursor + o.count);
            cursor += o.count;
            const cd = o.displayData;
            onUpdateCloud(o.id, {
              ...cd,
              scalarFields: { ...(cd.scalarFields ?? {}), [WOOD_CLASS_ATTRIBUTE]: { values: Float32Array.from(slice), min: 1, max: 2 } },
            });
          }

          setColorMode('scalar');
          setSelectedScalarField(WOOD_CLASS_ATTRIBUTE);
          setShowWoodSegmentPanel(false);
          showToast({
            type: 'success',
            title: 'Wood/Leaf Segmentation Complete',
            message: `Segmented ${targets.length} scans together (${response.num_wood.toLocaleString()} wood, ${response.num_leaf.toLocaleString()} leaf).`,
          });
          return;
        }
      }

      // === Per-scan (and the single-selection case): segment each cloud
      // independently, in sequence. Call through the ref so the LATEST worker
      // (capturing the current woodMode) is used — handleWoodSegment is memoised
      // and would otherwise close over a stale worker. ===
      for (const cloud of targets) {
        await segmentOneWoodCloudRef.current(cloud, WOOD, LEAF, woodParams);
      }
      setShowWoodSegmentPanel(false);
    } catch (error) {
      console.error('Wood/leaf segmentation error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Wood/leaf segmentation failed';
      setWoodSegmentError(errorMessage);
      showToast({ type: 'error', title: 'Wood/Leaf Segmentation Failed', message: errorMessage });
    } finally {
      setWoodSegmentInProgress(false);
    }
  }, [selectedIds, clouds, buildPointSource, getEditState, onUpdateCloud, woodBias, woodKMax, woodRegIters, woodMultiMode, woodMethod, woodUseReflectance, inlineReflectance]);

  // Segment a single cloud and apply the result per `woodMode` (label / split /
  // remove). Used by the per-scan path (and single selection).
  const segmentOneWoodCloud = useCallback(async (
    cloud: PointCloudEntry,
    WOOD: number,
    LEAF: number,
    woodParams: WoodSegmentTuning,
  ) => {
    const id = cloud.id;
    {
      const ps = buildPointSource(cloud);

      // --- Session-backed octree cloud: classify the in-RAM array, append
      // wood_class, rebuild from arrays (no file re-read). ---
      if (ps.kind === 'source') {
        const octreeInfo = cloud.data.octree;
        if (!octreeInfo?.sessionId) {
          throw new Error('Octree cloud is missing its editable session.');
        }
        const baseName = cloud.data.fileName ?? id;
        const sessionId = octreeInfo.sessionId;
        const meta = await sessionSegmentWood(sessionId, woodParams);
        if (meta.warnings && meta.warnings.length > 0) {
          showToast({ type: 'info', title: 'Wood / Leaf Segmentation', message: meta.warnings.join(' ') });
        }

        if (woodMode === 'remove') {
          // Keep only leaf points (delete wood) on the same session.
          const r = await sessionFilter(sessionId, {
            scalarFilters: [{ slug: WOOD_CLASS_ATTRIBUTE, min: LEAF, max: LEAF, values: [LEAF] }],
            rebuild: true,
          });
          onUpdateCloud(id, buildSessionOctreeData(r, octreeInfo, baseName));
        } else {
          // Label in place; the parent keeps ALL points, coloured by wood_class.
          onUpdateCloud(id, buildSessionOctreeData(meta, octreeInfo, baseName));
          setColorMode('scalar');
          setSelectedScalarField(WOOD_CLASS_ATTRIBUTE);
        }
        setShowWoodSegmentPanel(false);

        // Optional split: extract each class into its own child session.
        if (woodMode === 'split' && onAddCloud) {
          const addClassCloud = async (cls: number, suffix: string, color: string) => {
            const r = await sessionExtract(sessionId, {
              scalarFilters: [{ slug: WOOD_CLASS_ATTRIBUTE, min: cls, max: cls, values: [cls] }],
            });
            if (r.extracted) {
              onAddCloud({
                id: crypto.randomUUID(),
                data: buildSessionOctreeData(
                  r.extracted, octreeInfo, `${baseName} (${suffix})`, r.extracted.session_id,
                ),
                visible: true,
                color,
              });
            }
          };
          await addClassCloud(WOOD, 'wood', '#67421f');
          await addClassCloud(LEAF, 'leaf', '#4caf50');
        }

        showToast({
          type: 'success',
          title: 'Wood/Leaf Segmentation Complete',
          message: woodMode === 'remove'
            ? `Removed wood; kept leaf points.`
            : `Classified ${meta.point_count.toLocaleString()} points (wood vs leaf).`,
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

      // Reflectance assist (inline path): send the per-point scalar when present
      // and the assist is on. The backend self-limits its effect, so passing it
      // is safe even on low-contrast clouds.
      const refl = (woodParams.reflectance_weight_max ?? 0) > 0
        ? inlineReflectance(displayData)
        : null;
      const response = await segmentWood({
        points,
        ...woodParams,
        ...(refl && refl.length === count ? { reflectance: refl } : {}),
      });
      if (!response.success) {
        throw new Error(response.error || 'Wood/leaf segmentation failed');
      }
      if (response.warnings && response.warnings.length > 0) {
        showToast({ type: 'info', title: 'Wood / Leaf Segmentation', message: response.warnings.join(' ') });
      }

      // Build a child cloud holding only the points of `classValue` (used by
      // both split and remove modes — remove keeps just the leaf class).
      const makeChild = (classValue: number, suffix: string, color: string, replaceParent: boolean) => {
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
        const childData = {
          positions: pos,
          colors: col,
          pointCount: idxs.length,
          bounds: { min: bmin, max: bmax, center, size },
          fileName: replaceParent ? baseName : `${baseName} (${suffix})`,
        };
        if (replaceParent) {
          onUpdateCloud(id, childData);
        } else if (onAddCloud) {
          onAddCloud({ id: crypto.randomUUID(), data: childData, visible: true, color });
        }
      };

      if (woodMode === 'remove') {
        // Replace the cloud in place with just the leaf points.
        makeChild(LEAF, 'leaf', '#4caf50', true);
      } else {
        const labels = Float32Array.from(response.labels);
        const newScalarFields = {
          ...(displayData.scalarFields ?? {}),
          [WOOD_CLASS_ATTRIBUTE]: { values: labels, min: 1, max: 2 },
        };
        onUpdateCloud(id, { ...displayData, scalarFields: newScalarFields });
        setColorMode('scalar');
        setSelectedScalarField(WOOD_CLASS_ATTRIBUTE);
        if (woodMode === 'split') {
          makeChild(WOOD, 'wood', '#67421f', false);
          makeChild(LEAF, 'leaf', '#4caf50', false);
        }
      }

      showToast({
        type: 'success',
        title: 'Wood/Leaf Segmentation Complete',
        message: `${response.num_wood.toLocaleString()} wood, ${response.num_leaf.toLocaleString()} leaf`,
      });
    }
  }, [buildPointSource, onUpdateCloud, onAddCloud, woodMode, inlineReflectance]);
  // Keep a ref to the latest worker so the memoised handleWoodSegment dispatcher
  // (which excludes it from deps to avoid a use-before-declaration cycle) always
  // invokes the current-woodMode version.
  segmentOneWoodCloudRef.current = segmentOneWoodCloud;

  // Segment individual trees (TreeIso cut-pursuit). Writes a `tree_instance`
  // scalar attribute (0=unassigned, 1..N=trees) and colors by it. Mirrors
  // handleGroundSegment: session (octree) clouds run TreeIso on the in-RAM array
  // and append the column (sessionSegmentTrees) — no file re-read; flat clouds
  // get labels written into scalarFields. Optional trunk seeds (treeSeedPoints)
  // drive human-in-the-loop seeding.
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

      // --- Session-backed octree cloud: TreeIso on the in-RAM array, append
      // tree_instance, rebuild from arrays (no file re-read). ---
      if (ps.kind === 'source') {
        const octreeInfo = cloud.data.octree;
        if (!octreeInfo?.sessionId) {
          throw new Error('Octree cloud is missing its editable session.');
        }
        const baseName = cloud.data.fileName ?? id;
        const meta = await sessionSegmentTrees(octreeInfo.sessionId, {
          ...tiParams,
          ...(seeds ? { seed_points: seeds } : {}),
        });
        onUpdateCloud(id, buildSessionOctreeData(meta, octreeInfo, baseName));
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

      // If a prior ground segmentation labelled (but didn't delete) the ground,
      // pass those labels so TreeIso excludes ground instead of clustering it.
      const groundField = displayData.scalarFields?.[GROUND_CLASS_ATTRIBUTE];
      const groundClass =
        groundField && groundField.values.length === count
          ? Array.from(groundField.values)
          : undefined;

      const response = await segmentTrees({ points, seed_points: seeds, ground_class: groundClass, ...tiParams });
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
  const handleCloudToCloudICP = useCallback(async (targetId?: string, sourceId?: string) => {
    // Inputs come from the Align dialog (explicit target/source) or, as a
    // fallback, from a 2-cloud viewport selection (target = first selected).
    let tId = targetId;
    let sId = sourceId;
    if (!tId || !sId) {
      if (selectedIds.size !== 2) {
        showToast({ type: 'error', title: 'Selection Required', message: 'Select exactly 2 point clouds for cloud-to-cloud alignment' });
        return;
      }
      const cloudIds = Array.from(selectedIds);
      tId = cloudIds[0];
      sId = cloudIds[1];
    }

    const targetCloud = clouds.find(c => c.id === tId);
    const sourceCloud = clouds.find(c => c.id === sId);

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


  // Toggle mesh visibility
  const handleToggleMeshVisibility = useCallback((meshId: string) => {
    setMeshes(prev => prev.map(m => m.id === meshId ? { ...m, visible: !m.visible } : m));
  }, []);

  // Rename a mesh. A blank name clears the override so the computed default name
  // (plant type/age, or source filename) is shown again.
  const handleRenameMesh = useCallback((meshId: string, name: string) => {
    const trimmed = name.trim();
    const next = trimmed.length > 0 ? trimmed : undefined;
    const before = scene.state.meshes.find(m => m.id === meshId)?.name;
    commitProperty('mesh', meshId, 'label', before, next, 'Rename mesh');
  }, [scene, commitProperty]);

  // Set a mesh's solid color (undoable). Ignored for textured meshes at render
  // time (TexturedPlantMesh draws the texture and does not read mesh.color).
  const handleSetMeshColor = useCallback((meshId: string, color: string) => {
    const before = scene.state.meshes.find(m => m.id === meshId)?.color;
    commitProperty('mesh', meshId, 'color', before, color, 'Change mesh color');
  }, [scene, commitProperty]);

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

      addSkeleton(skeletonEntry, 'Extract skeleton');
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

  // Build a QSM from the selected point cloud. The backend pipeline does all the
  // preprocessing/skeleton/fit/correction; the renderer just hands it points (a
  // backend source for octree clouds, inline+downsampled for flat clouds, same as
  // the skeleton path).
  const handleBuildQSM = useCallback(async (scanIds: string[], opts: QSMStartOptions) => {
    if (qsmInProgress) return;
    const targets = scanIds
      .map(id => clouds.find(c => c.id === id))
      .filter((c): c is PointCloudEntry => !!c);
    if (targets.length === 0) return;

    const { twigRadiusMm } = opts;
    const MAX_QSM_POINTS = 60000; // dormant trees are sparse; this is plenty
    // 'aggregate' fuses several multi-view scans of ONE tree into a single QSM;
    // 'per-scan' builds one QSM per scan (separate trees). Only meaningful for
    // >1 scan — a single selection always builds one QSM regardless.
    const aggregate = targets.length > 1 && opts.aggregate;
    const batch = targets.length > 1 && !aggregate;

    const abort = new AbortController();
    qsmAbortRef.current = abort;
    setQSMInProgress(true);
    setQSMError(null);
    setQSMProgress({ label: 'Building QSM…', value: 0 });

    // Builds one QSM for a single scan, returning the raw backend response or
    // throwing on failure. The caller turns it into a QSMEntry. `report` folds the
    // streamed per-stage fraction into the overall bar (see the loop below).
    const buildOne = async (cloud: PointCloudEntry, report: BinaryFrameProgress) => {
      const ps = buildPointSource(cloud);
      let points: number[][] | undefined;
      let source: BackendPointSource | undefined;

      if (ps.kind === 'source') {
        source = { ...ps.source, max_points: MAX_QSM_POINTS };
      } else {
        const displayData = ps.data;
        const total = displayData.pointCount;
        const skip = total > MAX_QSM_POINTS ? Math.ceil(total / MAX_QSM_POINTS) : 1;
        points = [];
        for (let i = 0; i < total; i += skip) {
          points.push([
            displayData.positions[i * 3],
            displayData.positions[i * 3 + 1],
            displayData.positions[i * 3 + 2],
          ]);
        }
      }

      const response = await buildQSM({
        points,
        source,
        twig_radius_mm: twigRadiusMm,
      }, abort.signal, report);

      if (!response.success) {
        throw new Error(response.error || 'QSM build failed');
      }
      return response;
    };

    try {
      // === Aggregate: fuse all selected scans into ONE QSM ===
      if (aggregate) {
        // Resolve each scan to a point source. Octree-backed clouds carry a
        // backend source (their in-RAM display buffer is empty, so they MUST be
        // read server-side); flat clouds carry inline display points. The two
        // resolve through the same buildPointSource the per-scan path uses.
        const resolved = targets.map(c => ({ cloud: c, ps: buildPointSource(c) }));
        const sources: BackendPointSource[] = [];
        const inlineParts: number[][] = [];
        for (const { cloud, ps } of resolved) {
          if (ps.kind === 'source') {
            sources.push({ ...ps.source, max_points: MAX_QSM_POINTS });
          } else {
            // Flat cloud: concatenate its display points in WORLD space
            // (translation applied here — getDisplayData leaves it to the parent
            // group). Scans are assumed pre-registered (e.g. ICP-aligned).
            const d = ps.data;
            const t = getEditState(cloud.id).translation;
            for (let i = 0; i < d.pointCount; i++) {
              inlineParts.push([
                d.positions[i * 3] + t.x,
                d.positions[i * 3 + 1] + t.y,
                d.positions[i * 3 + 2] + t.z,
              ]);
            }
          }
        }

        // Send both: the backend reads every `source` and concatenates the
        // inline `points`, so a mixed octree+flat selection fuses correctly.
        // Downsample the flat inline points to the budget (sources are capped
        // server-side via max_points). When there are no sources, `sources` is
        // omitted and this is a pure inline build.
        const skip = inlineParts.length > MAX_QSM_POINTS ? Math.ceil(inlineParts.length / MAX_QSM_POINTS) : 1;
        const points = skip > 1 ? inlineParts.filter((_, i) => i % skip === 0) : inlineParts;
        // Single fused build: the streamed fraction IS the overall bar.
        const report: BinaryFrameProgress = (p, msg) =>
          setQSMProgress({ label: msg, value: p });
        let response;
        try {
          response = await buildQSM({
            sources: sources.length > 0 ? sources : undefined,
            points: points.length > 0 ? points : undefined,
            twig_radius_mm: twigRadiusMm,
          }, abort.signal, report);
        } catch (err) {
          if (abort.signal.aborted) return;
          const msg = err instanceof Error ? err.message : 'QSM build failed';
          setQSMError(prettifyQSMError(msg));
          showToast({ title: 'Aggregate QSM build failed', type: 'error' });
          return;
        }
        if (abort.signal.aborted) return;
        if (!response.success) {
          setQSMError(prettifyQSMError(response.error || 'QSM build failed'));
          showToast({ title: 'Aggregate QSM build failed', type: 'error' });
          return;
        }

        const firstName = targets[0].data.fileName ?? 'Scan';
        const entry: QSMEntry = {
          id: crypto.randomUUID(),
          sourceCloudId: targets[0].id,
          sourceLabel: `${firstName} + ${targets.length - 1} more`,
          cylinders: response.cylinders,
          shoots: response.shoots,
          metrics: response.metrics,
          visible: true,
        };
        addQSM(entry, 'Build QSM');
        // Hide every contributing scan so the new QSM isn't obscured by the
        // dense point cloud it was fused from.
        for (const t of targets) onHideScan(t.id);

        const m = response.metrics;
        showToast({
          title:
            `Fused QSM from ${targets.length} scans: ${response.n_cylinders} cylinders, ${response.n_shoots} shoots` +
            (m ? ` (${m.n_scaffolds} scaffolds, trunk ${m.trunk_diameter_mm.toFixed(0)}mm)` : ''),
          type: 'success',
        });
        return;
      }

      // === Per-scan: one QSM per selected scan, in sequence ===
      const failures: string[] = [];
      // Kept for the single-scan toast, which preserves the original detailed wording.
      let lastResponse: Awaited<ReturnType<typeof buildOne>> | null = null;
      let succeeded = 0;
      const n = targets.length;

      for (let i = 0; i < n; i++) {
        const cloud = targets[i];
        const cloudName = cloud.data.fileName ?? 'Scan';
        // Blend the per-scan index with the streamed stage fraction into one
        // overall 0..1 bar (each scan owns the band [i/n, (i+1)/n]). QSM stages
        // report real fractions throughout, so a plain linear map suffices — no
        // synthetic creep needed (cf. backfill's opaque C++ stage).
        const prefix = n > 1 ? `Scan ${i + 1} of ${n} — ` : '';
        const report: BinaryFrameProgress = (p, msg) =>
          setQSMProgress({ label: `${prefix}${msg}`, value: p == null ? null : (i + p) / n });
        try {
          const response = await buildOne(cloud, report);
          if (abort.signal.aborted) return;
          lastResponse = response;
          const entry: QSMEntry = {
            id: crypto.randomUUID(),
            sourceCloudId: cloud.id,
            cylinders: response.cylinders,
            shoots: response.shoots,
            metrics: response.metrics,
            visible: true,
          };
          addQSM(entry, 'Build QSM');
          // Hide the source scan so its points don't obscure the new QSM.
          onHideScan(cloud.id);
          succeeded++;
        } catch (err) {
          if (abort.signal.aborted) return;
          const msg = err instanceof Error ? err.message : 'build failed';
          failures.push(`${cloudName}: ${prettifyQSMError(msg)}`);
        }
      }

      if (succeeded === 0) {
        // All failed — surface the error (the modal can be reopened to retry).
        setQSMError(failures[0] || 'QSM build failed');
        showToast({ title: `QSM build failed for all ${n} scan(s)`, type: 'error' });
        return;
      }

      if (!batch && lastResponse) {
        const m = lastResponse.metrics;
        showToast({
          title:
            `QSM built: ${lastResponse.n_cylinders} cylinders, ${lastResponse.n_shoots} shoots` +
            (m ? ` (${m.n_scaffolds} scaffolds, trunk ${m.trunk_diameter_mm.toFixed(0)}mm)` : ''),
          type: 'success',
        });
      } else if (failures.length === 0) {
        showToast({ title: `QSM built for ${succeeded} scans`, type: 'success' });
      } else {
        showToast({
          title: `Built ${succeeded} of ${n} QSMs (${failures.length} failed)`,
          type: 'error',
        });
      }
    } finally {
      setQSMProgress(null);
      setQSMInProgress(false);
      qsmAbortRef.current = null;
    }
  }, [qsmInProgress, clouds, buildPointSource, getEditState, showToast, onHideScan, addQSM]);

  const cancelQSM = useCallback(() => {
    qsmAbortRef.current?.abort();
    setQSMProgress(null);
    qsmAbortRef.current = null;
  }, []);


  const handleToggleQSMVisibility = useCallback((qsmId: string) => {
    setQSMs(prev => prev.map(q => (q.id === qsmId ? { ...q, visible: !q.visible } : q)));
  }, []);

  // Show/hide the procedural leaves of a single QSM (independent of the woody
  // QSM's own visibility).
  const handleToggleLeavesVisibility = useCallback((qsmId: string) => {
    setQSMs(prev => prev.map(q =>
      q.id === qsmId ? { ...q, leavesVisible: q.leavesVisible === false } : q));
  }, []);

  // Phase-1 leaf reconstruction: place leaves on the QSM's terminal shoots and
  // store the resulting textured mesh on the QSM entry (rendered via
  // TexturedPlantMesh). The QSM topology is round-tripped to the backend.
  const handleAddLeaves = useCallback(async (qsmId: string, request: QSMLeavesRequest) => {
    try {
      const resp = await addQSMLeaves(request);
      if (!resp.success || resp.triangle_count === 0) {
        showToast({ title: resp.error || 'Leaf placement produced no geometry', type: 'error' });
        return;
      }
      const { data, plantMaterials } = plantResponseToMeshData(resp);
      // Keep the originating request so "Adjust Leaf Angles" (Phase 2) can
      // re-place these leaves identically before matching their angles.
      setQSMs(prev => prev.map(q =>
        q.id === qsmId
          ? { ...q, leaves: { data, plantMaterials, leafCount: resp.leaf_count, request }, leavesVisible: true }
          : q));
      // Boundary: leaf placement mutates the QSM entry's geometry; clear its
      // forward history so undo can't restore a pre-leaf state out of sync.
      scene.boundary([qsmId]);
      showToast({ title: `Added ${resp.leaf_count.toLocaleString()} leaves`, type: 'success' });
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : 'Failed to add leaves', type: 'error' });
    }
  }, [showToast, scene]);

  // Phase 2: adjust a QSM's leaves to match a measured per-cell leaf-angle
  // distribution (from a leaf-on Helios triangulation). Replaces the leaf mesh
  // in place, keeping its visibility.
  const handleAdjustLeafAngles = useCallback(async (qsmId: string, request: QSMAdjustLeafAnglesRequest) => {
    try {
      const resp = await adjustQSMLeafAngles(request);
      if (!resp.success || resp.triangle_count === 0) {
        showToast({ title: resp.error || 'Leaf-angle adjustment produced no geometry', type: 'error' });
        return;
      }
      const { data, plantMaterials } = plantResponseToMeshData(resp);
      setQSMs(prev => prev.map(q =>
        q.id === qsmId && q.leaves
          ? { ...q, leaves: { ...q.leaves, data, plantMaterials, leafCount: resp.leaf_count } }
          : q));
      scene.boundary([qsmId]);
      showToast({ title: `Adjusted ${resp.leaf_count.toLocaleString()} leaf angles`, type: 'success' });
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : 'Failed to adjust leaf angles', type: 'error' });
    }
  }, [showToast, scene]);

  // Display label for a QSM, matching the results panel + delete dialog:
  // sourceLabel override (aggregate) → source scan fileName → 'QSM'.
  const qsmDisplayLabel = useCallback((qsm: QSMEntry): string => {
    return qsm.sourceLabel || clouds.find(c => c.id === qsm.sourceCloudId)?.data.fileName || 'QSM';
  }, [clouds]);

  // Export the selected QSMs, one file per QSM, into a user-picked folder.
  const handleExportQSMs = useCallback(async (qsmIds: string[], format: QSMExportFormat) => {
    const targets = qsms.filter(q => qsmIds.includes(q.id));
    if (targets.length === 0) return;

    // Pick the output folder. Falls back to a single save dialog when running
    // outside Electron (e.g. vite dev in a plain browser) — there we can only
    // export one file, so require a single selection.
    let dir: string | null = null;
    if (window.electronAPI) {
      // directory:true returns a single folder path (or null when cancelled).
      const picked = await window.electronAPI.dialog.open({ directory: true, title: 'Choose export folder' });
      dir = typeof picked === 'string' ? picked : null;
      if (!dir) return; // cancelled
    } else if (targets.length > 1) {
      showToast({ type: 'error', title: 'Export', message: 'Select a single QSM to export in browser mode.' });
      return;
    }

    setQSMExporting(true);
    try {
      const ext = qsmExtForFormat(format);
      const usedNames = new Set<string>();
      let written = 0;
      for (const qsm of targets) {
        // De-dup filenames within this batch (two scans can share a fileName).
        let base = sanitizeQsmFilename(qsmDisplayLabel(qsm));
        let name = `${base}.${ext}`;
        let n = 2;
        while (usedNames.has(name)) name = `${base}_${n++}.${ext}`;
        usedNames.add(name);

        const content = serializeQsm(qsm, format);
        if (window.electronAPI && dir) {
          const sep = dir.includes('\\') ? '\\' : '/';
          const path = dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
          await window.electronAPI.fs.writeText(path, content);
        } else {
          // Browser fallback: anchor-download a single file.
          const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
        written++;
      }
      showToast({ type: 'success', title: 'Export complete', message: `Exported ${written} QSM${written === 1 ? '' : 's'} (${format.toUpperCase()})` });
      setShowQSMExportPanel(false);
    } catch (err) {
      showToast({ type: 'error', title: 'Export failed', message: (err as Error)?.message ?? String(err) });
    } finally {
      setQSMExporting(false);
    }
  }, [qsms, qsmDisplayLabel, showToast]);


  // Confirm and execute deletion
  const handleConfirmDelete = useCallback(() => {
    if (!deleteConfirm) return;
    const { type, ids } = deleteConfirm;

    // Each kind deletes as ONE undoable transaction → a single Cmd+Z restores all.
    if (type === 'mesh') {
      removeObjects('mesh', ids);
      setSelectedMeshIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    } else if (type === 'skeleton') {
      removeObjects('skeleton', ids);
      setSelectedSkeletonIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    } else if (type === 'cloud') {
      // onRemoveCloud === App's handleRemoveScan: it frees each scan's backend
      // session and prunes selectedScanIds, so looping here frees every session.
      ids.forEach(id => onRemoveCloud(id));
    } else if (type === 'qsm') {
      removeObjects('qsm', ids);
      setSelectedQSMIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    }

    setDeleteConfirm(null);
  }, [deleteConfirm, removeObjects, onRemoveCloud]);

  // Toggle skeleton visibility
  const handleToggleSkeletonVisibility = useCallback((skeletonId: string) => {
    setSkeletons(prev => prev.map(s => s.id === skeletonId ? { ...s, visible: !s.visible } : s));
  }, []);

  // Select a mesh — Ctrl/Cmd toggles, Shift selects a range, plain click selects
  // only this mesh (or deselects if already sole). A plain click also clears the
  // skeleton + cloud selection (single-focus for the gizmo); additive clicks
  // leave other panels alone so a multi-select can be built up.
  const handleSelectMesh = useCallback((meshId: string, additive: boolean, range: boolean) => {
    setSelectedMeshIds(prev => nextSelection(prev, meshId, meshes.map(m => m.id), lastSelectedMeshIdRef.current, additive, range));
    if (!range) lastSelectedMeshIdRef.current = meshId;
    if (!additive && !range) {
      setSelectedSkeletonIds(new Set());
      onDeselectAll();
    }
  }, [meshes, onDeselectAll]);

  // Select a skeleton — same modifier semantics as meshes.
  const handleSelectSkeleton = useCallback((skeletonId: string, additive: boolean, range: boolean) => {
    setSelectedSkeletonIds(prev => nextSelection(prev, skeletonId, skeletons.map(s => s.id), lastSelectedSkeletonIdRef.current, additive, range));
    if (!range) lastSelectedSkeletonIdRef.current = skeletonId;
    if (!additive && !range) {
      setSelectedMeshIds(new Set());
      onDeselectAll();
    }
  }, [skeletons, onDeselectAll]);

  // Select a QSM entry — same modifier semantics. QSM selection doesn't drive a
  // gizmo, so it doesn't clear the other panels.
  const handleToggleQSMSelection = useCallback((qsmId: string, additive: boolean, range: boolean) => {
    setSelectedQSMIds(prev => nextSelection(prev, qsmId, qsms.map(q => q.id), lastSelectedQSMIdRef.current, additive, range));
    if (!range) lastSelectedQSMIdRef.current = qsmId;
  }, [qsms]);

  // Clear mesh/skeleton selection when point cloud is selected (unless shift held for mixed selection)
  useEffect(() => {
    if (selectedIds.size > 0 && !isShiftHeldRef.current) {
      setSelectedMeshIds(new Set());
      setSelectedSkeletonIds(new Set());
    }
  }, [selectedIds]);

  // Display name for a skeleton row / delete dialog (source cloud filename).
  const skeletonDisplayName = useCallback((s: SkeletonEntry): string =>
    clouds.find(c => c.id === s.sourceCloudId)?.data.fileName || 'Skeleton', [clouds]);

  // ----- Header bulk actions (Meshes / Skeletons / QSMs) -------------------
  // Each acts on the selection when one exists, else the whole section.
  // Visibility toggles land on a uniform state (hide if any visible, else show);
  // delete opens the shared batched confirm dialog.

  const handleToggleMeshesVisibility = useCallback(() => {
    const { targetIds, nextVisible } = resolveTargets(meshes, selectedMeshIds);
    const target = new Set(targetIds);
    setMeshes(prev => prev.map(m => target.has(m.id) ? { ...m, visible: nextVisible } : m));
  }, [meshes, selectedMeshIds]);

  const handleDeleteMeshes = useCallback(() => {
    const ids = resolveDeleteIds(meshes, selectedMeshIds);
    if (ids.length === 0) return;
    const single = displayNameOfMesh(meshes.find(m => m.id === ids[0])!);
    setDeleteConfirm({ type: 'mesh', ids, label: buildDeleteLabel(ids, single, 'meshes') });
  }, [meshes, selectedMeshIds, displayNameOfMesh]);

  const handleToggleSkeletonsVisibility = useCallback(() => {
    const { targetIds, nextVisible } = resolveTargets(skeletons, selectedSkeletonIds);
    const target = new Set(targetIds);
    setSkeletons(prev => prev.map(s => target.has(s.id) ? { ...s, visible: nextVisible } : s));
  }, [skeletons, selectedSkeletonIds]);

  const handleDeleteSkeletons = useCallback(() => {
    const ids = resolveDeleteIds(skeletons, selectedSkeletonIds);
    if (ids.length === 0) return;
    const single = skeletonDisplayName(skeletons.find(s => s.id === ids[0])!);
    setDeleteConfirm({ type: 'skeleton', ids, label: buildDeleteLabel(ids, single, 'skeletons') });
  }, [skeletons, selectedSkeletonIds, skeletonDisplayName]);

  const handleToggleQSMsVisibility = useCallback(() => {
    const { targetIds, nextVisible } = resolveTargets(qsms, selectedQSMIds);
    const target = new Set(targetIds);
    setQSMs(prev => prev.map(q => target.has(q.id) ? { ...q, visible: nextVisible } : q));
  }, [qsms, selectedQSMIds]);

  const handleDeleteQSMs = useCallback(() => {
    const ids = resolveDeleteIds(qsms, selectedQSMIds);
    if (ids.length === 0) return;
    const single = qsmDisplayLabel(qsms.find(q => q.id === ids[0])!);
    setDeleteConfirm({ type: 'qsm', ids, label: buildDeleteLabel(ids, single, 'QSMs') });
  }, [qsms, selectedQSMIds, qsmDisplayLabel]);

  // Open the batched delete confirm for the Scans header. Visibility for scans
  // lives in App (onToggleScansVisibility prop); deletion routes through the
  // shared confirm here with type 'cloud'.
  const handleDeleteScans = useCallback(() => {
    const ids = resolveDeleteIds(scans, selectedScanIds);
    if (ids.length === 0) return;
    const first = scans.find(s => s.id === ids[0]);
    const single = first ? scanDisplayName(first) : 'scan';
    setDeleteConfirm({ type: 'cloud', ids, label: buildDeleteLabel(ids, single, 'scans') });
  }, [scans, selectedScanIds]);

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

  // Blender-style modal transform shortcuts (T translate, S scale, R rotate;
  // X/Y/Z lock axis, Shift+X/Y/Z lock to the perpendicular plane; typing digits
  // enters an exact value — units for rotate are degrees). Enter/click commits,
  // Esc/right-click cancels. Scale and rotate apply to the selected mesh only;
  // translate also works on skeletons and point clouds. Suppressed while an input
  // is focused.
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

    // Screen-space rotation: the signed angle (degrees) swept by the cursor
    // around the pivot's projected screen point, from drag start to current.
    // Sign is adjusted per locked axis so a clockwise on-screen drag matches the
    // expected right-hand rotation about that world axis.
    const computeRotationAngle = (
      camera: THREE.Camera,
      canvas: HTMLCanvasElement,
      axis: TransformAxis,
      pivot: { x: number; y: number; z: number },
      startScreen: { x: number; y: number },
      currentScreen: { x: number; y: number },
    ): number => {
      const rect = canvas.getBoundingClientRect();
      const proj = new THREE.Vector3(pivot.x, pivot.y, pivot.z).project(camera);
      const pivotPx = {
        x: rect.left + ((proj.x + 1) / 2) * rect.width,
        y: rect.top + ((-proj.y + 1) / 2) * rect.height,
      };
      const aStart = Math.atan2(startScreen.y - pivotPx.y, startScreen.x - pivotPx.x);
      const aCur = Math.atan2(currentScreen.y - pivotPx.y, currentScreen.x - pivotPx.x);
      let deg = ((aCur - aStart) * 180) / Math.PI;
      // Align screen-CW drag with the rotation direction about the locked axis as
      // seen from the camera: flip when the axis points away from the viewer.
      if (axis === 'x' || axis === 'y' || axis === 'z') {
        const axisDir = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        if (axisDir.dot(camDir) > 0) deg = -deg;
      }
      return deg;
    };

    const applyRotate = (modal: TransformModalState, angleDeg: number) => {
      if (modal.target !== 'mesh' || !modal.meshId || !modal.originalMeshRot) return;
      const orig = modal.originalMeshRot;
      // Free rotation has no meaningful single Euler component on screen; default
      // to the Z (view-facing) axis until the user locks an axis with X/Y/Z.
      const newRot = { ...orig };
      if (modal.axis === 'x') newRot.x = orig.x + angleDeg;
      else if (modal.axis === 'y') newRot.y = orig.y + angleDeg;
      else if (modal.axis === 'z' || modal.axis === 'free') newRot.z = orig.z + angleDeg;
      else if (modal.axis === 'yz') { newRot.y = orig.y + angleDeg; newRot.z = orig.z + angleDeg; }
      else if (modal.axis === 'xz') { newRot.x = orig.x + angleDeg; newRot.z = orig.z + angleDeg; }
      else if (modal.axis === 'xy') { newRot.x = orig.x + angleDeg; newRot.y = orig.y + angleDeg; }
      meshRotationsRef.current.set(modal.meshId, newRot);
      setMeshRotations(prev => new Map(prev).set(modal.meshId!, newRot));
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
      } else if (modal.op === 'rotate') {
        // Typed value is degrees about the locked axis (or Z when free).
        applyRotate(modal, value);
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
      } else if (modal.op === 'rotate') {
        const angle = computeRotationAngle(camera, canvas, modal.axis, modal.pivot, modal.startScreen, cur);
        applyRotate(modal, angle);
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
        if (modal.originalMeshRot) {
          const orig = modal.originalMeshRot;
          meshRotationsRef.current.set(modal.meshId, orig);
          setMeshRotations(prev => new Map(prev).set(modal.meshId!, orig));
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

    const startModal = (op: 'translate' | 'scale' | 'rotate') => {
      if (transformModalRef.current) return;
      if (!mainCameraRef.current) return;
      if (!lastMouse.set) return;
      const worldPivot = computePivot();
      if (!worldPivot) return;
      // The keyboard transform modal projects `pivot` through the DISPLAY camera
      // (mainCameraRef) in computeTranslateDelta/RotationAngle/ScaleFactor, and
      // those only consume pivot for screen math (the apply* fns use deltas +
      // originals, never pivot). So store the pivot in DISPLAY space.
      const off = displayOffsetRef.current;
      const pivot = { x: worldPivot.x - off.x, y: worldPivot.y - off.y, z: worldPivot.z - off.z };

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
          originalMeshRot: { ...(meshRotationsRef.current.get(selectedMesh.id) || { x: 0, y: 0, z: 0 }) },
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
        else if (k === 'r') { e.preventDefault(); startModal('rotate'); }
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

  // Center/size a voxel box needs to wrap the currently-selected data-bearing
  // scans (plus an epsilon buffer; see fitGridToBounds). Translations are baked
  // in the same way the camera-fit bounds do it (data.bounds +
  // editState.translation), so the fitted box lines up with where the points
  // actually render. Returns null when no selected scan has geometry.
  const computeSelectedScansFitGrid = useCallback(() => {
    const boxes = clouds
      .filter(c => selectedIds.has(c.id))
      .map(c => {
        const t = getEditState(c.id).translation;
        const b = c.data.bounds;
        return {
          min: { x: b.min.x + t.x, y: b.min.y + t.y, z: b.min.z + t.z },
          max: { x: b.max.x + t.x, y: b.max.y + t.y, z: b.max.z + t.z },
        };
      });
    return fitGridToBounds(boxes);
  }, [clouds, selectedIds, getEditState]);

  // Handle creating a new shape - takes type, auto-selects, shows resize panel
  const handleCreateShape = useCallback((shapeType: ShapeType) => {
    const meshData = generateShapeMesh(shapeType);

    const shapeColors: Record<ShapeType, string> = {
      voxel: '#60a5fa', // blue
      cylinder: '#4ade80', // green
      sphere: '#f472b6', // pink
      cone: '#fbbf24', // amber
      plane: '#a78bfa', // violet
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

    // Every shape (including the voxel grid) starts as a unit box at the origin.
    // The voxel grid is fitted to scans on demand via the "Fit to selected
    // scan(s)" button in the resize panel — we don't auto-fit on creation, so
    // that button stays meaningful and nothing resizes "on its own". One undoable
    // add seeds those identity transforms via the reducer.
    addMesh(newMesh, undefined, 'Create shape');
    setShapeCounter(prev => prev + 1);

    // Auto-select the new mesh and show resize panel.
    setSelectedMeshIds(new Set([newMeshId]));
    setSelectedSkeletonIds(new Set());
    // For a voxel grid, keep any scan selection so the resize panel's "Fit to
    // selected scan(s)" button is immediately usable (it fits the box to the
    // selected scans). Other shapes clear the point-cloud selection as before.
    if (shapeType !== 'voxel') onDeselectAll();
    setShowResizePanel(true);

    // Reset camera to fit new bounds after state updates
    setTimeout(() => {
      (window as any).__resetPointCloudCamera?.();
    }, 50);
  }, [shapeCounter, onDeselectAll]);

  // Create a plane mesh from the dialog's center / size / Euler-rotation values.
  // Mirrors handleCreateShape but seeds the transform maps from the supplied
  // params instead of the origin/unit/identity defaults. The base geometry is a
  // unit quad; width/length map to X/Y scale, rotation is in degrees.
  const handleCreatePlane = useCallback((params: CreatePlaneParams) => {
    const meshData = generateShapeMesh('plane');
    const newMeshId = crypto.randomUUID();
    const newMesh: MeshEntry = {
      id: newMeshId,
      sourceCloudId: `shape-plane-${shapeCounter}`,
      data: meshData,
      visible: true,
      color: '#a78bfa', // violet — distinct from the other primitives
      method: 'delaunay', // placeholder; planes aren't from triangulation
      isPlane: true, // apply ground-grid polygon offset (avoids z-fighting at z=0)
    };

    // One undoable add carrying the plane's dialog-chosen transform.
    addMesh(newMesh, {
      position: { ...params.center },
      rotation: { ...params.rotation },
      scale: { ...params.scale },
    }, 'Create plane');
    setShapeCounter(prev => prev + 1);

    // Auto-select the new plane. The transform was set in the creation dialog,
    // so we don't open the Transform panel — the ⤢ button on the row reveals it
    // if the user wants to tweak it afterward.
    setSelectedMeshIds(new Set([newMeshId]));
    setSelectedSkeletonIds(new Set());
    onDeselectAll();

    setTimeout(() => {
      (window as any).__resetPointCloudCamera?.();
    }, 50);
  }, [shapeCounter, onDeselectAll]);

  // Voxel boxes the user can pick as the Helios triangulation grid. A voxel
  // mesh carries `gridSubdivisions`; its world center/size come from the
  // mesh's position/scale transforms. Other shapes (sphere, cylinder…) and
  // triangulated meshes are excluded.
  const heliosGridOptions = useMemo<GridOption[]>(() => {
    const options: GridOption[] = [];
    for (const m of meshes) {
      if (!m.gridSubdivisions) continue;
      const grid = voxelMeshToHeliosGrid(
        meshPositions.get(m.id),
        meshScales.get(m.id),
        m.gridSubdivisions,
        meshRotations.get(m.id)?.z,
      );
      if (!grid) continue;
      const sx = grid.size[0], sy = grid.size[1], sz = grid.size[2];
      const fmt = (n: number) => Number(n.toFixed(2)).toString();
      const name = displayNameOfMesh(m);
      options.push({
        id: m.id,
        label: `${name} (${fmt(sx)}×${fmt(sy)}×${fmt(sz)} m, ${grid.nx}×${grid.ny}×${grid.nz})`,
        grid,
      });
    }
    return options;
  }, [meshes, meshPositions, meshScales, meshRotations, displayNameOfMesh]);
  useEffect(() => { heliosGridOptionsRef.current = heliosGridOptions; }, [heliosGridOptions]);

  // Existing Helios triangulations the LAD tool can REUSE. The backend always
  // re-triangulates internally, so "reuse" means locking the inversion to the
  // exact scans + grid + lmax/aspect that produced the mesh — reproducing its
  // G-function. Only meshes that carry their grid AND their source scan ids
  // qualify (older meshes predating that provenance are skipped).
  const ladTriangulationOptions = useMemo<LADTriangulationOption[]>(() => {
    const options: LADTriangulationOption[] = [];
    for (const m of meshes) {
      // Helios meshes carry per-triangle scan provenance directly. A per-scan
      // ball-pivot mesh is LAD-reusable too when it was PINNED to a grid (the
      // grid drop-down) — it has exactly one source scan, so every triangle maps
      // to scan index 0 (synthesized in extractReuseMeshPayload). A MERGED
      // ball-pivot mesh has no single source scan and never gets `grid`/
      // `sourceScanIds`, so it's excluded here (and explained in the LAD popup).
      const isHelios = m.method === 'helios';
      const isPinnedBallPivot =
        m.method === 'ball_pivoting' &&
        !!m.data.grid &&
        m.triangulationParams?.sourceScanIds?.length === 1 &&
        !!m.data.triangleCellIds;
      if (!isHelios && !isPinnedBallPivot) continue;
      const grid = m.data.grid;
      const scanIds = m.triangulationParams?.sourceScanIds;
      if (!grid || !scanIds || scanIds.length === 0) continue;
      // The source scan must still have position info (params): LAD traces beams
      // from the scanner origin, so a position-less scan can't be inverted even if
      // its mesh is pinned. A missing scan also disqualifies (reuse needs it).
      if (!scanIds.every(id => { const s = scans.find(x => x.id === id); return s && hasParams(s); })) continue;
      // The current filter is what feeds the inversion (triangleFilter), falling
      // back to the build-time params if no live filter is recorded. Ball-pivot
      // meshes have no edge/aspect metrics, so the filter is a no-op for them and
      // these defaults simply pass every (in-grid) triangle through.
      const lmax = m.triangleFilter?.lmax ?? m.triangulationParams?.lmax ?? 0.1;
      const maxAspectRatio = m.triangleFilter?.maxAspectRatio ?? m.triangulationParams?.maxAspectRatio ?? 4.0;
      // The voxel box this mesh was triangulated in (recorded at build time), but
      // only if it's still in the scene — so the LAD run can hide it to avoid
      // z-fighting. Drops to undefined if the box was deleted.
      const gridMeshId = m.triangulationParams?.gridMeshId;
      const gridBoxPresent = gridMeshId != null && meshes.some(x => x.id === gridMeshId);
      options.push({
        id: m.id,
        label: displayNameOfMesh(m),
        grid,
        scanIds,
        lmax,
        maxAspectRatio,
        // The unfiltered mesh carries triEdgeMax/triAspect so the reuse path can
        // re-apply the current filter and inject the exact triangle set shown.
        // Ball-pivot has no unfiltered set; its `data` already carries the grid +
        // per-triangle cell ids the reuse path needs.
        meshData: m.unfilteredMesh?.data ?? m.data,
        gridMeshId: gridBoxPresent ? gridMeshId : undefined,
      });
    }
    return options;
  }, [meshes, scans, displayNameOfMesh]);

  // Why a ball-pivot mesh can't be re-used for the leaf-area (LAD) inversion, or
  // null if it can (or it isn't a ball-pivot mesh). The eligibility rule: built
  // PER-SCAN (not merged) + PINNED to a grid + the source scan still has a scanner
  // position. Used both for the disabled LAD-dropdown entries and the Meshes-panel
  // note, so the reason text is one source of truth.
  const ladIneligibilityReason = useCallback((m: MeshEntry): string | null => {
    if (m.method !== 'ball_pivoting') return null;
    // Merged: the merged path fuses multiple scans and records scanCount but no
    // per-scan provenance, so there's no single source scan to drive G(theta).
    if (!m.data.grid && (m.triangulationParams?.scanCount ?? 0) > 1) {
      return 'merged — re-triangulate each scan separately';
    }
    // Per-scan but not pinned to a grid: no grid recorded.
    if (!m.data.grid || !m.data.triangleCellIds) {
      return 'not pinned to a grid — re-triangulate with a grid selected';
    }
    // Pinned per-scan, but the source scan lacks position info (or is gone).
    const scanIds = m.triangulationParams?.sourceScanIds;
    if (scanIds && scanIds.length >= 1 &&
        !scanIds.every(id => { const s = scans.find(x => x.id === id); return s && hasParams(s); })) {
      return 'source scan has no scanner position';
    }
    return null; // eligible (already in ladTriangulationOptions)
  }, [scans]);

  // Ball-pivot meshes that EXIST but can't be reused for LAD, each with the reason
  // and the fix. Surfaced as disabled entries in the LAD triangulation dropdown so
  // a user who triangulated with ball pivot sees why their mesh is missing rather
  // than it silently not appearing.
  const ineligibleLadTriangulations = useMemo(() => {
    const out: { id: string; label: string; reason: string }[] = [];
    for (const m of meshes) {
      const reason = ladIneligibilityReason(m);
      if (reason) out.push({ id: m.id, label: displayNameOfMesh(m), reason });
    }
    return out;
  }, [meshes, ladIneligibilityReason, displayNameOfMesh]);

  // Opt-in cross-check of a Helios mesh's current Lmax against the real in-grid
  // point spacing — offered by the filter panel when the Otsu indicators aren't
  // both High (the case where the edge-based auto-Lmax can silently bridge a
  // sparse surface and wreck G(theta)). Rebuilds the SAME scans + grid the LAD
  // reuse path uses, runs them through the request builder, and stores the
  // verdict (or error) back on the mesh. The backend KD-tree pass can be slow on
  // huge clouds, so the mesh carries a 'running' status the panel reflects.
  const handleCheckSpacing = useCallback(async (meshId: string) => {
    const mesh = meshes.find(m => m.id === meshId);
    if (!mesh || mesh.method !== 'helios') return;
    const grid = mesh.data.grid;
    const scanIds = mesh.triangulationParams?.sourceScanIds;
    if (!grid || !scanIds || scanIds.length === 0) return;
    const lmax = mesh.triangleFilter?.lmax ?? mesh.triangulationParams?.lmax ?? 0.1;
    const maxAspectRatio =
      mesh.triangleFilter?.maxAspectRatio ?? mesh.triangulationParams?.maxAspectRatio ?? 4.0;

    const scanObjs = scanIds
      .map(id => scans.find(s => s.id === id))
      .filter((s): s is Scan => !!s && hasParams(s));
    if (scanObjs.length === 0) {
      setMeshes(prev => prev.map(m => m.id === meshId ? { ...m, heliosSpacingCheck: {
        status: 'error',
        message: 'The triangulation’s source scans are no longer available to measure spacing.',
      } } : m));
      return;
    }

    const request = buildLADRequest(scanObjs, grid, { lmax, maxAspectRatio, minVoxelHits: 5 });
    setMeshes(prev => prev.map(m => m.id === meshId
      ? { ...m, heliosSpacingCheck: { status: 'running' } } : m));
    try {
      const r = await checkTriangulationSpacing(request);
      setMeshes(prev => prev.map(m => m.id === meshId ? { ...m, heliosSpacingCheck: r.success
        ? { status: 'done', medianSpacing: r.medianSpacing, ratio: r.ratio,
            likelyBridging: r.likelyBridging, message: r.message }
        : { status: 'error', message: r.error || 'Spacing check failed' } } : m));
    } catch (err) {
      setMeshes(prev => prev.map(m => m.id === meshId ? { ...m, heliosSpacingCheck: {
        status: 'error', message: err instanceof Error ? err.message : 'Spacing check failed',
      } } : m));
    }
  }, [meshes, scans]);

  // Cache of the non-indexed POSITIONS buffer per mesh, keyed by mesh id and
  // pinned to the mesh's data identity. Positions are mode-independent, so we
  // build them once and reuse the same Float32Array across every color-mode /
  // colormap switch. Keeping a stable positions reference also lets TriangleMesh
  // recolor in place (it keys its geometry on positions identity) instead of
  // rebuilding + re-uploading the whole geometry — the key to fast recolors and
  // to not OOM'ing on multi-million-triangle meshes.
  // Cache of the fully-built per-mesh pseudocolor result, keyed by mesh id and
  // pinned to (data, mode, colormap). When none of those changed we return the
  // EXACT SAME result object (same positions AND colors Float32Arrays) so a
  // re-render — even a burst of them — reuses the existing buffers instead of
  // reallocating ~150 MB and forcing the geometry to re-upload. This is what
  // keeps a re-render storm from marching the heap to the ~4 GB cap.
  const meshColorCache = useRef<Map<string, {
    data: MeshData;
    mode: MeshColorMode;
    colormap: ColormapName;
    result: { positions: Float32Array; colors: Float32Array; min?: number; max?: number };
  }>>(new Map());

  // Per-triangle pseudocolor buffers for any mesh with a non-solid color mode.
  // Keyed by mesh id; entry carries the (cached, stable) non-indexed positions
  // and a freshly-built color buffer fed to TriangleMesh, plus the scalar range
  // (reused by the colorbar so it doesn't re-run the scalar pass). Recomputed
  // when the mesh set, its modes, or the shared colormap change — only the
  // O(triangles) COLOR pass re-runs; positions come from the cache.
  const meshTriangleColors = useMemo(() => {
    const out = new Map<string, { positions: Float32Array; colors: Float32Array; min?: number; max?: number }>();
    const cache = meshColorCache.current;
    const liveIds = new Set<string>();
    for (const mesh of meshes) {
      const mode = meshColorModes.get(mesh.id);
      if (!mode || mode === 'solid') continue;
      liveIds.add(mesh.id);

      // Full cache hit: same geometry, mode, and colormap → return the exact
      // same result object. No allocation, and downstream identity is stable so
      // the geometry/color buffers are not rebuilt or re-uploaded.
      const cached = cache.get(mesh.id);
      if (cached && cached.data === mesh.data && cached.mode === mode && cached.colormap === colormap) {
        out.set(mesh.id, cached.result);
        continue;
      }

      // Reuse positions when only the mode/colormap changed (data unchanged).
      const positions = cached && cached.data === mesh.data
        ? cached.result.positions
        : buildMeshNonIndexedPositions(mesh.data);

      let result: { positions: Float32Array; colors: Float32Array; min?: number; max?: number } | null = null;
      if (mode === 'scan') {
        const colors = buildMeshScanColors(mesh.data);
        if (colors) result = { positions, colors };
      } else {
        const built = buildMeshTriangleColors(mesh.data, mode, colormap);
        if (built) result = { positions, colors: built.colors, min: built.min, max: built.max };
      }

      if (result) {
        cache.set(mesh.id, { data: mesh.data, mode, colormap, result });
        out.set(mesh.id, result);
      }
    }
    // Evict cache entries for meshes that no longer carry a color mode (deleted,
    // or reverted to solid) so the cache doesn't pin freed geometry buffers.
    for (const id of Array.from(cache.keys())) {
      if (!liveIds.has(id)) cache.delete(id);
    }
    return out;
  }, [meshes, meshColorModes, colormap]);

  // Gradient colorbar range for the selected mesh's scalar pseudocolor mode
  // (inclination/azimuth/area). Null for 'solid' and the categorical 'scan'
  // mode (which gets a legend instead).
  // The mesh whose pseudocolor readout (colorbar or scan legend) is shown. A
  // legend should be visible whenever a mesh is being pseudocolored, not only
  // while it's selected — so prefer the selected mesh if it has an active mode,
  // otherwise fall back to any mesh that does (typically just one at a time).
  const activeColorMesh = useMemo(() => {
    const hasMode = (m: MeshEntry) => {
      const mode = meshColorModes.get(m.id);
      return !!mode && mode !== 'solid';
    };
    if (selectedMesh && hasMode(selectedMesh)) return selectedMesh;
    return meshes.find(hasMode) ?? null;
  }, [selectedMesh, meshes, meshColorModes]);

  // Gradient colorbar range for the active mesh's scalar mode
  // (inclination/azimuth/area). Null for 'solid' and the categorical 'scan'
  // mode (which gets a legend instead).
  const activeMeshColorInfo = useMemo(() => {
    if (!activeColorMesh) return null;
    const mode = meshColorModes.get(activeColorMesh.id);
    if (!mode || mode === 'solid' || mode === 'scan') return null;
    // Reuse the range already computed while building the color buffer, rather
    // than running the O(triangles) scalar pass a second time just for the
    // colorbar (a needless full pass that doubled the freeze on large meshes).
    const built = meshTriangleColors.get(activeColorMesh.id);
    if (!built || built.min === undefined || built.max === undefined) return null;
    return { mode, min: built.min, max: built.max, label: meshColorModeLabel(mode) };
  }, [activeColorMesh, meshColorModes, meshTriangleColors]);

  // The LAD result whose colorbar is shown: the explicitly-selected one, else
  // the most recent visible result. Its LAD range (override-aware) drives the
  // colorbar domain.
  const activeLadInfo = useMemo(() => {
    if (ladResults.length === 0) return null;
    const result =
      ladResults.find(r => r.id === selectedLadId && r.visible) ??
      [...ladResults].reverse().find(r => r.visible);
    if (!result) return null;
    const auto = ladRange(result.voxels);
    const min = result.ladMinOverride ?? auto.min;
    const max = result.ladMaxOverride ?? auto.max;
    return { result, min, max };
  }, [ladResults, selectedLadId]);

  // Per-scan legend entries (color + count) when the active mesh is colored by
  // source scan. Null otherwise.
  const activeMeshScanLegend = useMemo(() => {
    if (!activeColorMesh) return null;
    if (meshColorModes.get(activeColorMesh.id) !== 'scan') return null;
    const { triangleScanIds, scanColors } = activeColorMesh.data;
    if (!triangleScanIds || !scanColors) return null;
    const counts = new Array(scanColors.length).fill(0);
    for (let i = 0; i < triangleScanIds.length; i++) {
      const sid = triangleScanIds[i];
      if (sid >= 0 && sid < counts.length) counts[sid]++;
    }
    return scanColors.map((color, i) => ({ color, count: counts[i], index: i }))
      .filter(e => e.count > 0);
  }, [activeColorMesh, meshColorModes]);

  // Handle Helios triangulation as a background task with cancel support.
  // `scanColors` is aligned 1:1 with request.scans so we can stash per-triangle
  // scan provenance (and the matching colors) on the resulting mesh.
  const handleHeliosTriangulate = useCallback(async (request: HeliosTriangulationRequest, scanColors: string[] = [], sourceScanIds: string[] = [], gridMeshId?: string) => {
    if (isHeliosRunning) return;

    const abort = new AbortController();
    heliosAbortRef.current = abort;
    setIsHeliosRunning(true);
    setTriProgress({ label: 'Helios triangulating…', value: null });

    try {
      const response = await heliosTriangulate(request, abort.signal, (p, msg) =>
        setTriProgress({ label: msg, value: p }), (runId) => { triRunIdRef.current = runId; });

      if (abort.signal.aborted) return;

      if (!response.success) {
        showToast({ type: 'error', title: 'Helios Triangulation Failed', message: response.error || 'Unknown error' });
        return;
      }

      // The big arrays arrive as zero-copy typed-array views over the binary
      // frame — used directly (no .flat()/JSON.parse). Helios sends no per-vertex
      // colors or normals, so colors are absent and normals are computed here.
      const vertices = response.vertices;
      const indices = response.triangles;
      const vertexColors: Float32Array | undefined = undefined;

      // Compute per-vertex normals from indexed mesh geometry.
      const normals = new Float32Array(response.numVertices * 3);
      {
        for (let t = 0; t < response.numTriangles; t++) {
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
        for (let i = 0; i < response.numVertices; i++) {
          const vi = i * 3;
          const len = Math.sqrt(normals[vi] ** 2 + normals[vi + 1] ** 2 + normals[vi + 2] ** 2);
          if (len > 1e-10) { normals[vi] /= len; normals[vi + 1] /= len; normals[vi + 2] /= len; }
        }
      }

      // Per-triangle scan provenance (already a typed-array view from the frame).
      const triangleScanIds = response.triangleScanIds
        && response.triangleScanIds.length === response.numTriangles
        ? response.triangleScanIds
        : undefined;

      // Per-scan sensor origins, keyed by scan index (same order as
      // request.scans / scanColors). Lets the azimuth pseudocolor orient each
      // facet normal toward the scanner that saw it, so closed scanned surfaces
      // read a continuous outward bearing instead of a 180° hemisphere seam.
      const scanOrigins = triangleScanIds
        ? Float32Array.from(request.scans.flatMap(s => [s.origin[0], s.origin[1], s.origin[2]]))
        : undefined;

      // Per-triangle grid cell + the grid it was binned in, so the leaf-angle
      // plot can split the distribution per voxel. The backend bins centroids
      // into the request grid (or, when none was supplied, an auto 1×1×1 grid).
      const triangleCellIds = response.triangleCellIds
        && response.triangleCellIds.length === response.numTriangles
        ? response.triangleCellIds
        : undefined;
      const grid = request.grid
        ? {
            center: request.grid.center as [number, number, number],
            size: request.grid.size as [number, number, number],
            nx: request.grid.nx,
            ny: request.grid.ny,
            nz: request.grid.nz,
          }
        : undefined;

      // The backend returns a bounded mesh (auto-estimated default; small
      // candidate sets whole) WITHOUT per-triangle metrics — recompute those
      // from the returned geometry so the filter can run client-side. This
      // "returned" mesh is the baseline the interactive filter narrows from.
      const returnedData: MeshData = {
        vertices,
        indices,
        normals,
        vertexColors,
        vertexCount: response.numVertices,
        triangleCount: response.numTriangles,
        surfaceArea: response.surfaceArea,
        triangleScanIds,
        scanColors: triangleScanIds && scanColors.length > 0 ? scanColors : undefined,
        scanOrigins,
        triangleCellIds,
        grid,
      };
      const metrics = computeTriangleMetrics(returnedData);
      returnedData.triEdgeMax = metrics.triEdgeMax;
      returnedData.triAspect = metrics.triAspect;

      // The backend auto-estimate (Otsu separability + merged-cloud guard),
      // computed over the FULL candidate distribution. Seeds the default filter.
      const dto = response.estimate;
      const estimate: TriangleFilterEstimate = {
        lmax: dto?.lmax ?? null,
        eta: dto?.eta ?? 0,
        label: (dto?.label as TriangleFilterEstimate['label']) ?? 'n/a',
        sepRatio: dto?.sep_ratio ?? null,
        sepLabel: (dto?.sep_label as TriangleFilterEstimate['sepLabel']) ?? 'n/a',
        merged: dto?.merged ?? false,
        mergedMessage: dto?.merged_message ?? null,
      };
      // Loosening limits of the returned set (filter can narrow to these, not
      // past them, without a re-run).
      let capLmax = response.capLmax;
      if (capLmax === undefined || !Number.isFinite(capLmax)) {
        let m = 0;
        for (let i = 0; i < metrics.triEdgeMax.length; i++) if (metrics.triEdgeMax[i] > m) m = metrics.triEdgeMax[i];
        capLmax = m || 1.0;
      }
      const capAspect = (response.capAspect !== undefined && Number.isFinite(response.capAspect))
        ? response.capAspect : 1.0e9;

      // Seed the default filter at the auto-estimate, clamped to the returned
      // set's cap (so a tighter-than-estimate cap on huge meshes still shows the
      // full returned mesh). Fall back to the cap when no estimate.
      const seedLmax = (estimate.lmax != null && Number.isFinite(estimate.lmax))
        ? Math.min(estimate.lmax, capLmax) : capLmax;
      const seedAspect = Math.min(4.0, capAspect);

      // The displayed mesh is the filtered view; all consumers of `mesh.data`
      // (rendering, leaf angles, exports, LAD) see the chosen filter.
      const filteredData = applyTriangleFilter(returnedData, seedLmax, seedAspect);

      const meshEntry: MeshEntry = {
        id: crypto.randomUUID(),
        sourceCloudId: 'helios',
        data: filteredData,
        visible: true,
        color: '#22c55e',
        method: 'helios',
        unfilteredMesh: {
          data: returnedData,
          estimate,
          cap: { lmax: capLmax, maxAspectRatio: capAspect },
        },
        triangleFilter: { lmax: seedLmax, maxAspectRatio: seedAspect },
        // Provenance for the mesh list — the filter breakdown updates live as the
        // user adjusts Lmax/aspect (counts derived from the returned set).
        // sourceScanIds + gridMeshId let the LAD tool reuse this triangulation
        // (and hide its grid box to avoid z-fighting the LAD result).
        triangulationParams: buildHeliosTriParams(
          returnedData, seedLmax, seedAspect, request.scans.length, 0, sourceScanIds, gridMeshId),
      };

      // One undoable add (seeds identity transforms so transform shortcuts read
      // a real origin).
      addMesh(meshEntry, undefined, 'Triangulate');
      setShowTriangulationPopup(false);
      // Hide the contributing scans so their points don't obscure the new mesh
      // (mirrors the QSM build). The scans stay in the list and can be re-shown.
      for (const id of sourceScanIds) onHideScan(id);
      // Report the kept count at the seeded auto-estimate; the user refines the
      // filter live in the Meshes panel without re-triangulating.
      const lmaxNote = ` (kept at auto Lmax ${(seedLmax * 100).toFixed(1)} cm — adjust in the Meshes panel)`;
      showToast({
        type: 'success',
        title: 'Helios Triangulation Complete',
        message: `Created mesh with ${filteredData.triangleCount.toLocaleString()} triangles${lmaxNote}`,
      });
      // Large datasets are bounded server-side: the returned set is capped, so
      // the filter can be tightened but not loosened past the cap without a re-run.
      if (response.candidateCount && response.candidateCount > returnedData.triangleCount) {
        showToast({
          type: 'info',
          title: 'Large mesh — filter bounded',
          message: `Returned the densest ${returnedData.triangleCount.toLocaleString()} of ${response.candidateCount.toLocaleString()} candidate triangles. You can tighten the filter in the Meshes panel; loosening beyond this needs a re-run.`,
        });
      }
      // Low separation between the intra-leaf and inter-leaf edge scales → the
      // filter result is sensitive to Lmax; nudge the user to review the mesh.
      if (estimate.label === 'Low') {
        showToast({
          type: 'warning',
          title: 'Low edge-length separation',
          message: 'The leaf and gap edge scales overlap, so the mesh is sensitive to Lmax — review it and adjust the filter in the Meshes panel.',
        });
      }
      // The points look like a merged multi-scan cloud (single-origin Delaunay
      // bridges surfaces seen from different scanner positions).
      if (estimate.merged && estimate.mergedMessage) {
        showToast({
          type: 'warning',
          title: 'Possible merged multi-scan cloud',
          message: estimate.mergedMessage,
        });
      }
      // No grid box was supplied: the backend fit one to all points. Warn so
      // the user knows ground/trunk should already be segmented or cropped.
      if (response.gridWarning) {
        showToast({
          type: 'warning',
          title: 'No grid box specified',
          message: response.gridMessage
            || 'Triangulated all points within their bounding box. This assumes ground and trunk are already segmented or cropped.',
        });
      }
    } catch (err) {
      if (abort.signal.aborted || err instanceof ScanCancelledError) return;
      showToast({
        type: 'error',
        title: 'Helios Triangulation Failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsHeliosRunning(false);
      heliosAbortRef.current = null;
      triRunIdRef.current = null;
      setTriProgress(null);
    }
  }, [isHeliosRunning, onHideScan]);

  // Dispatcher wired to the unified TriangulationPopup. Branches on the result
  // kind: Helios goes to the (multi-scan, grid-aware) Helios handler; everything
  // else to the Open3D handler. The modal closes itself on submit.
  const handleStartTriangulate = useCallback((r: TriangulationStartArgs) => {
    if (r.kind === 'helios') {
      handleHeliosTriangulate(r.request, r.scanColors, r.sourceScanIds, r.gridMeshId);
    } else {
      handleTriangulateOpen3D({
        method: r.method,
        scanIds: r.scanIds,
        merge: r.merge,
        depth: r.depth,
        alpha: r.alpha,
        radii: r.radii,
        cropBox: r.cropBox,
        grid: r.grid,
        gridMeshId: r.gridMeshId,
      });
    }
  }, [handleHeliosTriangulate, handleTriangulateOpen3D]);

  const cancelHeliosTriangulation = useCallback(() => {
    if (triRunIdRef.current) void cancelRun(triRunIdRef.current);
    heliosAbortRef.current?.abort();
    setIsHeliosRunning(false);
    heliosAbortRef.current = null;
    triRunIdRef.current = null;
    setTriProgress(null);
  }, []);

  // Re-apply the interactive Helios filter (Lmax / aspect) to a mesh, deriving a
  // fresh filtered view from its stored unfiltered candidate set. Cheap — it only
  // rebuilds the index + per-triangle arrays (vertices are shared) — so it runs
  // synchronously per change. Updates the provenance breakdown so the mesh list
  // reflects the new filter, and the chosen values flow into the LAD inversion.
  const handleHeliosFilterChange = useCallback(
    (meshId: string, next: { lmax: number; maxAspectRatio: number }) => {
      setMeshes(prev => prev.map(m => {
        if (m.id !== meshId || !m.unfilteredMesh) return m;
        // Clamp to the returned set's loosening cap — triangles past it weren't
        // returned (would need a re-run), so a larger Lmax/aspect can't add them.
        const cap = m.unfilteredMesh.cap;
        const lmax = Math.min(next.lmax, cap.lmax);
        const maxAspectRatio = Math.min(next.maxAspectRatio, cap.maxAspectRatio);
        const data = applyTriangleFilter(m.unfilteredMesh.data, lmax, maxAspectRatio);
        return {
          ...m,
          data,
          triangleFilter: { lmax, maxAspectRatio },
          // Spread the existing params first so method-specific provenance
          // (depth / alpha / radii / normalRadius / pointsUsed on Open3D meshes)
          // survives a filter edit; the filter-breakdown fields are overlaid on top.
          triangulationParams: {
            ...m.triangulationParams,
            ...buildHeliosTriParams(
              m.unfilteredMesh.data, lmax, maxAspectRatio,
              m.triangulationParams?.scanCount ?? 0,
              m.triangulationParams?.droppedDegenerate ?? 0,
              // Preserve the recorded source scans + grid box across live filter
              // edits so the mesh stays reusable by the LAD tool.
              m.triangulationParams?.sourceScanIds ?? [],
              m.triangulationParams?.gridMeshId),
          },
        };
      }));
    },
    [],
  );

  // Compute per-voxel leaf area density. Mirrors handleHeliosTriangulate: run
  // against the live backend, then add the result as an LADResultEntry the
  // viewer renders as colored voxel cells.
  const handleComputeLAD = useCallback(async (request: LADRequest, _scanColors: string[] = [], gridMeshId?: string, reuseMesh: ReuseMeshPayload | null = null) => {
    if (isLadRunning) return;

    const abort = new AbortController();
    ladAbortRef.current = abort;
    setIsLadRunning(true);
    setLadProgress(null);

    try {
      const response = await computeLAD(request, abort.signal, (p, msg) =>
        setLadProgress({ label: msg, value: p }), (runId) => { ladRunIdRef.current = runId; }, reuseMesh);
      if (abort.signal.aborted) return;

      if (!response.success) {
        showToast({ type: 'error', title: 'Leaf Area Density Failed', message: response.error || 'Unknown error' });
        return;
      }

      const voxels: LADVoxel[] = response.cells.map(c => ({
        index: c.index,
        center: c.center as [number, number, number],
        size: c.size as [number, number, number],
        leafArea: c.leaf_area,
        lad: c.lad,
        gtheta: c.gtheta,
        hitCount: c.hit_count,
        // Per-voxel Pimont uncertainty — carried through only when present, so
        // non-uncertainty voxels stay lean.
        ...(c.lad_std != null ? { ladStd: c.lad_std } : {}),
        ...(c.lad_variance != null ? { ladVariance: c.lad_variance } : {}),
        ...(c.beam_count != null ? { beamCount: c.beam_count } : {}),
        ...(c.relative_density_index != null ? { relativeDensityIndex: c.relative_density_index } : {}),
        ...(c.mean_path_length != null ? { meanPathLength: c.mean_path_length } : {}),
        ...(c.ci_valid != null ? { ciValid: c.ci_valid } : {}),
        ...(c.leaf_area_ci_lower != null ? { leafAreaCiLower: c.leaf_area_ci_lower } : {}),
        ...(c.leaf_area_ci_upper != null ? { leafAreaCiUpper: c.leaf_area_ci_upper } : {}),
      }));

      const entry: LADResultEntry = {
        id: crypto.randomUUID(),
        sourceScanIds: [],
        voxels,
        nx: response.nx,
        ny: response.ny,
        nz: response.nz,
        bounds: {
          min: (response.bounds?.[0] ?? [0, 0, 0]) as [number, number, number],
          max: (response.bounds?.[1] ?? [0, 0, 0]) as [number, number, number],
        },
        returnMode: response.return_mode === 'multi' ? 'multi' : 'single',
        visible: true,
        color: '#22c55e',
        hideEmpty: true,
        // Default to fully opaque: the voxel cells then read cleanly without the
        // order-dependent see-through artifacts of alpha blending. The user can
        // dial opacity down in the LAD row to peer inside the canopy.
        opacity: 1,
        // Group-scale Pimont CI summary — attached when the backend reported a
        // width (i.e. uncertainty was computed). Old responses lack these keys.
        ...(response.element_width != null ? {
          uncertainty: {
            elementWidth: response.element_width,
            confidenceLevel: response.confidence_level ?? 0.95,
            groupCiValid: response.group_ci_valid ?? false,
            groupLadMean: response.group_lad_mean ?? undefined,
            groupLadCiLower: response.group_lad_ci_lower ?? undefined,
            groupLadCiUpper: response.group_lad_ci_upper ?? undefined,
          },
        } : {}),
      };

      addLad(entry, 'Compute LAD');
      setSelectedLadId(entry.id);

      // Auto-hide the voxel-box grid mesh the result was computed on: the LAD
      // cells occupy the exact same volume, so leaving the box visible causes
      // z-fighting on the shared faces. The user can re-show it from the Meshes
      // panel if they want the wireframe back.
      if (gridMeshId) {
        setMeshes(prev => prev.map(m => m.id === gridMeshId ? { ...m, visible: false } : m));
      }

      const { max } = ladRange(voxels);
      // Surface backend fallbacks (e.g. multi-return columns missing).
      for (const w of response.warnings ?? []) {
        showToast({ type: 'warning', title: 'Leaf Area Density', message: w });
      }
      showToast({
        type: 'success',
        title: 'Leaf Area Density Complete',
        message: `Computed LAD for ${voxels.length.toLocaleString()} voxels (max ${max.toFixed(2)} m²/m³)`,
      });
    } catch (err) {
      if (abort.signal.aborted || err instanceof ScanCancelledError) return;
      showToast({
        type: 'error',
        title: 'Leaf Area Density Failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsLadRunning(false);
      setLadProgress(null);
      ladAbortRef.current = null;
      ladRunIdRef.current = null;
    }
  }, [isLadRunning]);

  const cancelLAD = useCallback(() => {
    // Stop the backend (frees the inversion's C++/numpy memory), then abort.
    if (ladRunIdRef.current) void cancelRun(ladRunIdRef.current);
    ladAbortRef.current?.abort();
    setIsLadRunning(false);
    setLadProgress(null);
    ladAbortRef.current = null;
    ladRunIdRef.current = null;
  }, []);

  const removeLadResult = useCallback((id: string) => {
    removeObjects('lad', [id]);
    setSelectedLadId(prev => (prev === id ? null : prev));
  }, [removeObjects]);

  const toggleLadVisible = useCallback((id: string) => {
    setLadResults(prev => prev.map(r => r.id === id ? { ...r, visible: !r.visible } : r));
  }, []);

  const updateLadResult = useCallback((id: string, patch: Partial<LADResultEntry>) => {
    setLadResults(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
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
        (runId) => { plantRunIdRef.current = runId; },
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

      // One undoable add (seeds identity transforms via the reducer).
      addMesh(newMesh, undefined, 'Generate plant');
      setShapeCounter(prev => prev + 1);
      console.log('[Plant] Mesh added to state');

      // Mesh is in the scene — close the popup now.
      setShowPlantPopup(false);

      // Auto-select the new mesh
      setSelectedMeshIds(new Set([newMeshId]));
      setSelectedSkeletonIds(new Set());
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
      // A user-initiated cancel — fetch abort OR the backend's cancelled event —
      // is not an error.
      if (abort.signal.aborted || error instanceof ScanCancelledError) {
        console.log('[Plant] Generation cancelled by user');
      } else {
        console.error('Plant generation failed:', error);
        showToast({ title: `Plant generation failed: ${error}`, type: 'error' });
      }
    } finally {
      if (plantAbortRef.current === abort) plantAbortRef.current = null;
      plantRunIdRef.current = null;
      setIsGeneratingPlant(false);
      setPlantProgress(null);
      setPlantProgressMsg('');
    }
  }, [isGeneratingPlant, shapeCounter, onDeselectAll]);

  // Cancel an in-flight plant/canopy build: tell the backend to stop (frees the
  // C++ build's memory by bailing the canopy/growth loops), then abort the SSE.
  const handleCancelPlantGenerate = useCallback(() => {
    if (plantRunIdRef.current) void cancelRun(plantRunIdRef.current);
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

      // Destructive boundary: morph replaced the mesh geometry and recreated the
      // backend plant session, so any prior undo history for this mesh would
      // restore stale geometry pointing at a freed session. Clear it.
      scene.boundary([selectedMeshId]);

      console.log(`[Morph] Plant morphed: ${response.vertex_count} vertices, session ${response.session_id}`);
      showToast({ title: `Plant morphed successfully (${response.vertex_count} vertices)`, type: 'success' });

    } catch (error) {
      console.error('Plant morph failed:', error);
      showToast({ title: `Plant morph failed: ${error}`, type: 'error' });
    } finally {
      setIsMorphing(false);
    }
  }, [meshes, selectedMeshIds, scene]);

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
    // Destructive boundary: advancing age replaces the mesh geometry (and may
    // recreate the backend session), so clear this mesh's undo history up front.
    scene.boundary([meshId]);

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
  }, [meshes, isAdvancingAge, scene]);

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

    // Resources that must be released on ANY exit (success, user abort, early
    // return, or a throw mid-loop). Declared outside the try so the catch can
    // reach them — a thrown error after the WebGLRenderer is created would
    // otherwise strand an offscreen GL context (browsers cap them at ~16, so a
    // few failed exports break all WebGL until reload). `cleanup` is idempotent.
    let renderer: THREE.WebGLRenderer | null = null;
    let plantMesh: THREE.Mesh | null = null;
    let sessionId: string | null = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (plantMesh) {
        plantMesh.geometry.dispose();
        (plantMesh.material as THREE.Material).dispose();
        plantMesh = null;
      }
      if (renderer) {
        renderer.dispose();
        renderer = null;
      }
      // Free the backend plant session so a failed export doesn't orphan it
      // (now also bounded by backend session eviction, but explicit is cleaner).
      if (sessionId) {
        void deletePlantSession(sessionId).catch(() => {});
        sessionId = null;
      }
    };

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

      renderer = new THREE.WebGLRenderer({
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
      scene.add(new THREE.AmbientLight(0xffffff, lightIntensity * LIGHT_INTENSITY_SCALE));
      const dirLight = new THREE.DirectionalLight(0xffffff, lightIntensity * LIGHT_INTENSITY_SCALE);
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
        cleanup();
        return;
      }

      sessionId = sessionResponse.session_id;
      const sid = sessionId;  // non-null alias for the API calls below
      console.log(`[GIF] Created session ${sid} at age ${startAge}`);

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
      let advanceResponse = await advancePlantSession(sid, 0);
      if (!advanceResponse.success) {
        showToast({ title: 'Failed to get initial geometry', type: 'error' });
        setIsGeneratingGif(false);
        setGifProgress(null);
        cleanup();
        return;
      }

      // Frame collection loop
      let currentAge = startAge;
      let frameCount = 0;
      const totalFrames = endAge - startAge + 1;

      // Process first frame
      plantMesh = createMeshFromResponse(advanceResponse);
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
          cleanup();
          setIsGeneratingGif(false);
          setGifProgress(null);
          return;
        }

        // Advance by 1 day
        advanceResponse = await advancePlantSession(sid, 1);
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

      // Remove the last frame's mesh from the scene; final disposal happens in
      // cleanup() (called from the 'finished' callback) so the renderer and the
      // mesh are released together along exactly one path.
      scene.remove(plantMesh);

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

        cleanup();
        setIsGeneratingGif(false);
        setGifProgress(null);
      });

      gif.render();

    } catch (error) {
      console.error('[GIF] Error:', error);
      showToast({ title: `GIF generation failed: ${error}`, type: 'error' });
      cleanup();
      setIsGeneratingGif(false);
      setGifProgress(null);
    }
  }, [meshes, animationStartAge, animationEndAge, gifBackground, gifCameraView, lightIntensity]);

  // Get first selected cloud for gizmo positioning
  const firstSelectedCloud = useMemo(() => {
    const id = Array.from(selectedIds)[0];
    return clouds.find(c => c.id === id);
  }, [selectedIds, clouds]);

  // Auto-size the erase brush to the selected cloud. The brush radius is a
  // world-space value, so a fixed default (e.g. 0.1m) is invisible on a
  // meter-to-tens-of-meters scan and far too big on a centimeter-scale one.
  // When the erase tool is activated for a cloud, initialize the radius to a
  // small fraction of that cloud's bounding-box diagonal (matching how the
  // translation gizmo and grid scale to bounds.size.length()). We only seed
  // it once per (cloud, activation) so user slider adjustments aren't clobbered.
  const eraseBrushInitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (editMode !== 'erase' || !firstSelectedCloud) {
      eraseBrushInitKeyRef.current = null;
      // Drop the live brush indicator + painted preview and turn erase mode off
      // when the tool closes so nothing lingers into the next mode.
      setEraseBrushPosition(null);
      setEraseBrushMatrix(null);
      setEraseFrame(null);
      setErasePreviewBoxes([]);
      setIsErasing(false);
      setEraseActive(false);
      return;
    }
    if (eraseBrushInitKeyRef.current === firstSelectedCloud.id) return;
    eraseBrushInitKeyRef.current = firstSelectedCloud.id;
    // Flat clouds use a world-space brush; seed it to a fraction of the cloud
    // diagonal. Octree clouds use a screen-pixel brush (no cloud-scaling needed).
    const diag = firstSelectedCloud.data.bounds.size.length();
    if (diag > 0) setEraseBrushSize(diag / 50);
    // Start each activation with a clean preview and erase mode OFF, so the user
    // can frame the view before toggling erase on.
    setEraseFrame(null);
    setErasePreviewBoxes([]);
    setEraseActive(false);
  }, [editMode, firstSelectedCloud]);

  // Viewport mesh click-to-select is live only in the default viewport state —
  // when an edit tool owns the click (crop/erase/translate gizmo), tree-seed
  // placement is active, or a gizmo drag is in flight, those clicks belong to
  // the tool, not selection.
  const meshSelectionEnabled = editMode === 'none' && !treeSeedMode && !gizmoDragging;

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

  // Guard against a stale 'scalar' selection surviving across cloud changes.
  // colorMode/selectedScalarField are GLOBAL across all clouds, but a scalar
  // field (e.g. wood_class from a segmentation) only exists on the cloud that
  // produced it. When that cloud is deleted — or a different cloud without the
  // field becomes the representative — the dropdown drops the option but the
  // mode stays 'scalar', so the renderer falls back to a flat gray ramp (and
  // the dropdown shows a non-existent value). This is the recurring "imports
  // gray / wrong color mode after delete" bug. Rather than reset color mode in
  // every delete/import/segment path (the patch that keeps regressing), we
  // validate the selection here against the SAME available-fields computation
  // the dropdown uses, and fall back to the default when it's orphaned.
  useEffect(() => {
    if (colorMode !== 'scalar' || !selectedScalarField) return;
    const cloud = colorbarSourceCloud;
    // No visible cloud at all → nothing to validate against; leave state as-is
    // so re-selecting the source cloud restores the mode.
    if (!cloud) return;
    const available = cloud.data.octree
      ? octreeScalarFieldOptions(
          cloud.data.octree.attributeRanges,
          cloud.data.octree.attributeLabels,
        ).map(o => o.value)
      : Object.keys(cloud.data.scalarFields ?? {});
    if (!available.includes(selectedScalarField)) {
      setColorMode('per-scan');
      setSelectedScalarField(undefined);
    }
  }, [colorMode, selectedScalarField, colorbarSourceCloud]);

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
    <div
      className={`relative bg-neutral-900 ${className}`}
      // Debug/test hook: the diagonal extent of the scene bounds the camera
      // frames. Lets tests assert a scans-only scene (e.g. a moving-platform
      // trajectory) actually expands the bounds instead of falling back to the
      // default ±5 origin box (size ≈ 17.3), which would blank the viewport.
      data-scene-bounds-size={combinedBounds.size.length().toFixed(2)}
      data-scene-center={`${combinedBounds.center.x.toFixed(1)},${combinedBounds.center.y.toFixed(1)},${combinedBounds.center.z.toFixed(1)}`}
      // Record the press location so onPointerMissed can reject orbit-drags
      // (native event has no R3F `delta`). Bubbles up from the canvas.
      onPointerDown={(e) => { viewportPointerDownRef.current = { x: e.clientX, y: e.clientY }; }}
    >
      {/* 3D Canvas */}
      <Canvas
        camera={{ fov: 60, near: 0.01, far: 10000, position: [0, 0, 10] }}
        gl={{ antialias: true, alpha: false }}
        onCreated={({ gl }) => { gl.setClearColor('#171717'); }}
        // Left-click on empty space clears the mesh selection (single-focus,
        // matching a plain panel click). Gated so it never fires mid-tool, and
        // a drag guard (vs. the press position) keeps a camera orbit that ends
        // on nothing from deselecting.
        onPointerMissed={(e) => {
          if (!meshSelectionEnabled) return;
          if (e.button !== 0) return;
          const down = viewportPointerDownRef.current;
          if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
          setSelectedMeshIds(new Set());
        }}
      >
        <ambientLight intensity={lightIntensity * LIGHT_INTENSITY_SCALE} />
        <directionalLight position={[10, 10, 10]} intensity={lightIntensity * LIGHT_INTENSITY_SCALE} />

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
              // Render-only precision safety net: flat clouds render at
              // (translation − displayOffset) so large UTM coords land near the
              // origin (small net modelView translation; buffer stays shared in
              // world space — flat positions are already float32 so re-centering
              // the buffer can't recover precision, and this avoids a copy). The
              // octree branch ignores this group (it attaches to the scene root)
              // and applies the offset on pco.position itself. The resample
              // preview renders at the origin, so it gets no offset.
              position={hasResamplePreview
                ? [0, 0, 0]
                : [
                    editState.translation.x - displayOffset.x,
                    editState.translation.y - displayOffset.y,
                    editState.translation.z - displayOffset.z,
                  ]}
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
                  // The octree attaches to the scene root, NOT inside the parent
                  // <group position> above, so the group's translation never
                  // reaches it. Pass the offset explicitly so the Translate tool
                  // (gizmo + T-modal) actually moves an octree cloud. The resample
                  // preview renders at the origin (group position [0,0,0]), so it
                  // gets no offset either.
                  translation={hasResamplePreview ? undefined : editState.translation}
                  // Render-only precision safety net: the resample preview lives
                  // at the origin already (group [0,0,0]), so it gets no offset;
                  // the live cloud renders at world − displayOffset.
                  displayOffset={hasResamplePreview ? undefined : displayOffset}
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
                  // GPU clip-volume union (CLIP_INSIDE) combining:
                  //  - committed but unbaked deletes for THIS cloud (the
                  //    persistent instant-delete preview — points stay hidden
                  //    after apply, across multiple deletes, until bake), and
                  //  - the live erase-brush preview (the in-progress stamps)
                  //    while the erase tool is active on this selected cloud.
                  clipBoxes={(() => {
                    // Committed-delete preview boxes are built in WORLD space
                    // (box min/max or frozen V_world unprojection). The octree
                    // renders at world − displayOffset, so shift each box by
                    // T(−offset) into the display frame. The live erase preview
                    // boxes already come from the display-positioned octree pick,
                    // so they need no shift.
                    const committedWorld = pendingDeletesToClipBoxes(
                      getEditState(cloud.id).pendingDeletes ?? [],
                    );
                    const off = displayOffset;
                    const committed =
                      off.x === 0 && off.y === 0 && off.z === 0
                        ? committedWorld
                        : committedWorld.map(m =>
                            new THREE.Matrix4()
                              .makeTranslation(-off.x, -off.y, -off.z)
                              .multiply(m),
                          );
                    const live = isSelected && editMode === 'erase' && erasePreviewBoxes.length > 0
                      ? erasePreviewBoxes
                      : [];
                    const all = [...committed, ...live];
                    return all.length > 0 ? all.map(matrix => ({ matrix })) : null;
                  })()}
                  // Hand the live octree up so the erase brush can pick the
                  // hovered surface point. Only the selected cloud needs it.
                  onOctreeReady={
                    isSelected
                      ? (oct) => { eraseOctreeRef.current = oct as any; }
                      : undefined
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

        {/* Sky/miss octrees. Misses live in their OWN projected octree (not the
            hits octree, whose bbox they'd poison), streamed flat-orange with full
            LOD. Attached to the scene root and offset by prop (matching the hits
            octree), so the two line up under the Translate tool. Shown only when
            the user toggles "Show misses" on a scan that has placeable misses. */}
        {clouds.map(cloud => {
          if (!cloud.visible || !cloud.showMisses) return null;
          const oct = cloud.data?.octree;
          if (!oct?.hasMisses) return null;
          // Misses flagged but no octree → none were placeable (all sat at the
          // scanner origin with no recovered beam direction). The toggle would
          // otherwise be a silent no-op; the toast fired at toggle time explains
          // why (see onToggleMisses). Render nothing here.
          if (!oct.missOctreeCacheId) return null;
          const editState = getEditState(cloud.id);
          return (
            <MissOctree
              key={`miss-${cloud.id}-${oct.missOctreeCacheId}`}
              missCacheId={oct.missOctreeCacheId}
              pointSize={pointSize}
              translation={editState.translation}
              displayOffset={displayOffset}
            />
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
              // Render-only precision safety net: subtract displayOffset so the
              // mesh renders near the origin (secondary fix — mesh vertices are a
              // packed Float32Array, like flat clouds). Rotation/scale unaffected.
              position={[
                meshPos.x + cloudOffset.x - displayOffset.x,
                meshPos.y + cloudOffset.y - displayOffset.y,
                meshPos.z + cloudOffset.z - displayOffset.z,
              ]}
              rotation={[meshRot.x * Math.PI / 180, meshRot.y * Math.PI / 180, meshRot.z * Math.PI / 180]}
              scale={[meshScale.x, meshScale.y, meshScale.z]}
              // Viewport mesh picking via R3F's built-in raycaster (clicks bubble
              // up from the child mesh). e.delta is the pointer's pixel travel
              // since pointerdown — filtering on it lets an orbit-drag that
              // started over a mesh rotate the camera without selecting it.
              // stopPropagation keeps the click from reaching onPointerMissed.
              onClick={(e) => {
                if (!meshSelectionEnabled) return;
                if (e.delta > 4) return;
                e.stopPropagation();
                handleSelectMesh(mesh.id, e.ctrlKey || e.metaKey, e.shiftKey);
              }}
            >
              {/* Wrap the rendered mesh in <OutlineSelect> so the JFA outline
                  pass (below) draws a screen-space silhouette outline when this
                  mesh is selected. Screen-space distance-field edge detection
                  works for ANY topology — including multi-surface plant meshes —
                  with uniform width, unlike a per-mesh inverted hull. The voxel
                  overlay below stays outside so it isn't outlined. */}
              <OutlineSelect enabled={selectedMeshIds.has(mesh.id)}>
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
                  opacity={1}
                  wireframe={meshWireframe}
                />
              ) : (
                <TriangleMesh
                  key={`mesh-${mesh.id}-${mesh.regenerationKey ?? 0}`}
                  data={mesh.data}
                  color={mesh.color}
                  opacity={meshOpacities.get(mesh.id) ?? defaultMeshOpacity(mesh)}
                  wireframe={meshWireframe}
                  useVertexColors={mesh.data.vertexColors !== undefined && mesh.data.vertexColors.length > 0}
                  triangleColors={meshTriangleColors.get(mesh.id) ?? null}
                  // Transparent-pass draw order (three.js sorts by renderOrder,
                  // then camera distance):
                  //  • voxel box (+1): always blend LAST over the surface mesh it
                  //    encloses, not camera-distance-sorted against it, so its
                  //    volume tint survives every view angle (the +X-view "full
                  //    green" fix).
                  //  • ground plane (-0.5): draw FIRST, just after the ground grid
                  //    (-1) and before all real geometry (0). The plane is coplanar
                  //    at z=0 with any triangulated surface / second scan sitting on
                  //    it; at equal camera distance the sort ties and the tie-break
                  //    falls to scene-graph order, which the octree LOD streamer
                  //    reshuffles every frame as it adds/drops tiles — so the plane
                  //    and that coplanar surface race and flicker even with a frozen
                  //    camera. A fixed lower renderOrder makes the plane
                  //    deterministically composite UNDER them instead of racing.
                  //  • everything else (0): normal distance sorting.
                  renderOrder={mesh.gridSubdivisions ? 1 : mesh.isPlane ? -0.5 : 0}
                  // A ground plane usually sits at z=0, coplanar with the ground
                  // grid; bias its depth so it doesn't z-fight the grid.
                  polygonOffset={mesh.isPlane}
                  // ...and keep it writing depth even at its default 0.7 opacity,
                  // so it stays the stable z=0 occluder the grid fix assumes and
                  // doesn't flicker against the coplanar grid/scan points.
                  forceDepthWrite={mesh.isPlane}
                />
              )}
              </OutlineSelect>
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
              // Render-only precision safety net: subtract displayOffset so the
              // skeleton renders near the origin (secondary fix — skeleton points
              // are a packed Float32Array).
              position={[
                skelPos.x - displayOffset.x,
                skelPos.y - displayOffset.y,
                skelPos.z - displayOffset.z,
              ]}
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

        {/* QSM results — connected cylinders at their fitted radii, colored by
            shoot rank or shoot id. The backend builds the QSM from the points it
            was given, which already carry the source cloud's translation (the
            inline path bakes editState.translation into getDisplayData; the octree
            path forwards translation to the backend). So the QSM lands in the same
            world frame the cloud renders in. The render-only displayOffset is applied
            INSIDE QSM3D's float64 vertex build (precision-correct) rather than via a
            group transform. */}
        {qsms.map(qsm => {
          if (!qsm.visible) return null;
          return (
            <group key={qsm.id}>
              {/* QSM3D subtracts displayOffset in its own float64 vertex build
                  (recovers precision), so its group stays at the origin. The
                  leaves mesh is built at world coords, so it gets the offset via
                  a wrapping group (secondary fix). */}
              <QSM3D
                cylinders={qsm.cylinders}
                shoots={qsm.shoots}
                colorMode={qsmColorMode}
                displayOffset={displayOffset}
              />
              {qsm.leaves && qsm.leavesVisible !== false && (
                <group position={[-displayOffset.x, -displayOffset.y, -displayOffset.z]}>
                  <TexturedPlantMesh
                    data={qsm.leaves.data}
                    plantMaterials={qsm.leaves.plantMaterials ?? []}
                  />
                </group>
              )}
            </group>
          );
        })}

        {/* Leaf area density results — instanced translucent voxel cells colored
            by LAD through the shared colormap. */}
        {ladResults.map(result => {
          if (!result.visible) return null;
          const auto = ladRange(result.voxels);
          const min = result.ladMinOverride ?? auto.min;
          const max = result.ladMaxOverride ?? auto.max;
          return (
            // Render-only precision safety net: LAD voxel centers are world
            // coords, so render them near the origin via a wrapping group.
            <group key={result.id} position={[-displayOffset.x, -displayOffset.y, -displayOffset.z]}>
              <LADVoxelGrid
                voxels={result.voxels}
                colormap={colormap}
                min={min}
                max={max}
                opacity={result.opacity}
                hideEmpty={result.hideEmpty}
                onHoverVoxel={setHoveredLadVoxel}
              />
            </group>
          );
        })}

        {/* Scanner markers for every scan that carries scan parameters.
            Each model renders at its real-world height (a Velodyne puck is
            ~0.14 m; a Leica P40 ~0.40 m), so the marker is to scale with the
            cloud rather than a one-size placeholder. The whole layer can be
            hidden via the Display panel, and a global scale multiplier from
            settings sizes every marker up or down together. */}
        {showScanMarkers && scansWithParams.map(scan => {
          if (!scan.visible) return null;
          // Glow follows the Scans-pane selection — single source of truth, so
          // the marker can never drift out of sync with the row highlight.
          const isMarkerSelected = selectedScanIds.has(scan.id);
          return (
            // Render-only precision safety net: the marker's origin is a world
            // coord, so render it near the origin via a wrapping group. Markers go
            // through ScanMarkerEntry so the trajectory-derived arrays are
            // memoized (a fresh array per render would rebuild the marker's GPU
            // geometry every frame — a leak that OOM-crashed the renderer).
            <group key={scan.id} position={[-displayOffset.x, -displayOffset.y, -displayOffset.z]}>
              <ScanMarkerEntry
                params={scan.params}
                color={scan.color}
                selected={isMarkerSelected}
                markerScale={scanMarkerScale}
              />
            </group>
          );
        })}

        {/* Scan-pattern wireframe shells (View-menu toggle, off by default). Same
            display-offset wrapper as the markers; ScanWireframeEntry memoizes its
            geometry on the stable params reference to avoid a per-frame GPU rebuild. */}
        {showScanWireframes && scansWithParams.map(scan => {
          if (!scan.visible) return null;
          return (
            <group key={`wf-${scan.id}`} position={[-displayOffset.x, -displayOffset.y, -displayOffset.z]}>
              <ScanWireframeEntry
                params={scan.params}
                color={scan.color}
                markerScale={scanMarkerScale}
              />
            </group>
          );
        })}

        <CameraController
          bounds={combinedBounds}
          hasContent={clouds.length > 0 || meshes.length > 0 || skeletons.length > 0 || qsms.length > 0 || scansWithParams.some(s => s.visible)}
          enabled={!gizmoDragging && cropDrawState !== 'drawing-polygon' && cropDrawState !== 'drawing-rect' && !eraseActive}
          displayOffset={displayOffset}
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
            // center in DISPLAY space (world − displayOffset): the gizmo's
            // DragHandler projects the center through the display-space camera, so
            // it must match. Emitted deltas are offset-invariant (handlers unchanged).
            center={new THREE.Vector3(
              firstSelectedCloud.data.bounds.center.x + getEditState(firstSelectedCloud.id).translation.x - displayOffset.x,
              firstSelectedCloud.data.bounds.center.y + getEditState(firstSelectedCloud.id).translation.y - displayOffset.y,
              firstSelectedCloud.data.bounds.center.z + getEditState(firstSelectedCloud.id).translation.z - displayOffset.z
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
              // center in DISPLAY space (world − displayOffset) — see cloud gizmo.
              center={new THREE.Vector3(
                meshPos.x - displayOffset.x,
                meshPos.y - displayOffset.y,
                meshPos.z - displayOffset.z,
              )}
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
          // center in DISPLAY space (world − displayOffset) — see cloud gizmo.
          const center = new THREE.Vector3(
            skelPos.x + (minX + maxX) / 2 - displayOffset.x,
            skelPos.y + (minY + maxY) / 2 - displayOffset.y,
            skelPos.z + (minZ + maxZ) / 2 - displayOffset.z
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
          // Render-only precision safety net: cropBox.min/max state stays WORLD
          // (it's sent to the backend as-is); only the rendered gizmo shifts into
          // display space via a wrapping group.
          <group position={[-displayOffset.x, -displayOffset.y, -displayOffset.z]}>
            <CropBox
              min={cropBox.min}
              max={cropBox.max}
              keepInside={!cropInvert}
            />
          </group>
        )}

        {/* Two-click ground-plane box-draw raycaster. Active only while
            the user has clicked "Draw box" in the panel. */}
        {editMode === 'crop' &&
          (cropDrawState === 'awaiting-box-corner-1' || cropDrawState === 'awaiting-box-corner-2') && (
          <BoxDrawRaycaster
            // The raycaster lives in the scene (now DISPLAY space), so its ground
            // plane is at the display z. The hit (x,y) is display-space; the
            // corner refs + cropBox below store WORLD coords (offset added back),
            // since cropBox is sent to the backend in world space.
            groundZ={combinedBounds.min.z - displayOffset.z}
            onMove={(x, y) => {
              boxDrawCursorRef.current = { x: x + displayOffset.x, y: y + displayOffset.y };
              // Re-render so the corner-1 marker / preview box follows the
              // cursor. Cheap — the preview is a single wireframe box.
              setBoxDrawCursorTick(t => t + 1);
            }}
            onPick={(x, y) => {
              const wx = x + displayOffset.x;
              const wy = y + displayOffset.y;
              if (cropDrawState === 'awaiting-box-corner-1') {
                boxDrawFirstCornerRef.current = { x: wx, y: wy };
                setCropDrawState('awaiting-box-corner-2');
                return;
              }
              const first = boxDrawFirstCornerRef.current;
              if (!first) { setCropDrawState('idle'); return; }
              const minX = Math.min(first.x, wx);
              const minY = Math.min(first.y, wy);
              const maxX = Math.max(first.x, wx);
              const maxY = Math.max(first.y, wy);
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
            // first/cursor are stored in WORLD coords; this preview group renders
            // them in DISPLAY space via the −displayOffset transform.
            <group position={[-displayOffset.x, -displayOffset.y, -displayOffset.z]}>
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

        {/* Erase Brush (flat clouds) — iterates data.positions directly, so it
            only applies to the rare non-octree (Blob/no-path) cloud. Octree
            clouds use the sphere-paint brush below instead. */}
        {editMode === 'erase' && firstSelectedCloud && !firstSelectedCloud.data.octree && (() => {
          const editState = getEditState(firstSelectedCloud.id);
          return (
            <EraseBrush
              brushSize={eraseBrushSize}
              brushPosition={eraseBrushPosition}
              isErasing={isErasing}
              cloudData={firstSelectedCloud.data}
              cloudTranslation={editState.translation}
              displayOffset={displayOffset}
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
                          ids: [firstSelectedCloud.id],
                          label: firstSelectedCloud.data.fileName || 'Unnamed'
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

        {/* Erase Brush (octree clouds) — paints screen-space square stamps that
            extrude through the cloud along the view direction. Mounted only while
            erase MODE is active (eraseActive): the tool can be open with the view
            interactive, and the user toggles mode on to stamp. The live preview
            clips the camera-aligned boxes (OctreePointCloud.clipBoxes); Apply
            removes the screen-space squares on the backend (squares_union). The
            square indicator is rendered below. */}
        {/* While erase mode is active, flatten the projection to orthographic
            (the trick the Rect crop uses). Under perspective a screen-space
            square clips a frustum — its footprint is a center-biased trapezoid
            that doesn't match the square outline. Ortho makes the square extrude
            as a straight prism, so the cleared region matches the brush exactly.
            EraseBrushOctree builds its pick ray from the (now ortho) projection
            matrix directly, so surface picking keeps working under the override. */}
        {editMode === 'erase' && eraseActive && firstSelectedCloud?.data.octree && (
          <OrthoProjectionOverride />
        )}

        {editMode === 'erase' && eraseActive && firstSelectedCloud && firstSelectedCloud.data.octree && (() => {
          const b = firstSelectedCloud.data.bounds;
          return (
            <EraseBrushOctree
              octree={eraseOctreeRef.current as any}
              brushHalfPx={eraseBrushPx}
              // cloudCenter in DISPLAY space: it's the fallback anchor plane for
              // anchorAt(), which runs against the display-positioned octree and
              // the display camera. The emitted frame's view is converted back to
              // world at the backend-payload boundary (see handleApplyErase).
              cloudCenter={{
                x: b.center.x - displayOffset.x,
                y: b.center.y - displayOffset.y,
                z: b.center.z - displayOffset.z,
              }}
              cloudDiagonal={b.size.length()}
              initialFrame={eraseFrame}
              onFrameChange={(frame, previewBoxes) => {
                setEraseFrame(frame);
                setErasePreviewBoxes(previewBoxes);
              }}
              onBrushTransformChange={setEraseBrushMatrix}
              onErasingChange={setIsErasing}
            />
          );
        })()}

        {/* Erase brush indicator (octree path): a camera-facing square outline
            at the cursor (the cross-section of the view-extruded erase volume),
            red while actively erasing. Shown only while erase mode is active. */}
        {editMode === 'erase' && eraseActive && firstSelectedCloud?.data.octree && eraseBrushMatrix && (
          <group matrixAutoUpdate={false} matrix={eraseBrushMatrix}>
            {/* Unit plane (the box matrix already scales X/Y to the square). A
                thin box edge reads as a square ring facing the camera. */}
            <lineSegments>
              <edgesGeometry args={[new THREE.PlaneGeometry(1, 1)]} />
              <lineBasicMaterial
                color={isErasing ? '#ef4444' : '#f97316'}
                transparent
                opacity={0.9}
                depthTest={false}
              />
            </lineSegments>
            <mesh>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial
                color={isErasing ? '#ef4444' : '#f97316'}
                transparent
                opacity={isErasing ? 0.25 : 0.12}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          </group>
        )}

        {/* Grid - uses staticBounds so it stays fixed when objects are moved.
            Render-only precision safety net: positioned at world − displayOffset
            so the drei geometry renders near the origin (it kinked/vanished at
            UTM magnitudes). fadeDistance tracks the camera each frame inside
            GroundGrid so the grid reads as an infinite ground plane at any zoom. */}
        {showGrid && (
          <GroundGrid
            cellSize={staticBounds.size.length() / 20}
            sectionSize={staticBounds.size.length() / 4}
            position={
              gridPlane === 'z-up'
                ? [
                    staticBounds.center.x - displayOffset.x,
                    staticBounds.center.y - displayOffset.y,
                    gridFloor - displayOffset.z,
                  ]
                : [
                    staticBounds.center.x - displayOffset.x,
                    gridFloor - displayOffset.y,
                    staticBounds.center.z - displayOffset.z,
                  ]
            }
            rotation={gridPlane === 'z-up' ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}
          />
        )}

        {showAxes && <ViewportAxesGizmo />}

        {/* Screen-space (jump-flood) selection outline. Owns the render loop at
            priority 1 (like the EffectComposer did) to render the scene then
            composite a uniform-width silhouette outline of the selected meshes.
            When nothing is selected it just renders the scene and returns. */}
        <JFAOutline active={selectedMeshIds.size > 0} color="#a3e635" width={4} />
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
        // treeSeedPoints are stored in WORLD coords (sent to the backend for
        // segmentation), but `cam` renders in DISPLAY space (world − offset). So
        // project world→display before .project(cam), and add the offset back on
        // a fresh ray·plane hit before storing.
        const off = displayOffset;
        const project = (p: [number, number, number]) => {
          if (!cam) return null;
          const v = new THREE.Vector3(p[0] - off.x, p[1] - off.y, p[2] - off.z).project(cam);
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
          // Plane at the DISPLAY ground z (the ray is in display/scene space).
          const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(groundZ - off.z));
          const hit = new THREE.Vector3();
          if (rc.ray.intersectPlane(plane, hit)) {
            // Convert the display hit back to WORLD before storing.
            setTreeSeedPoints(prev => [...prev, [hit.x + off.x, hit.y + off.y, hit.z + off.z]]);
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
              displayOffsetRef.current,
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
      {isApplyingCrop && <StatusPill label="Cropping…" />}

      {/* Open3D triangulation status indicator (ball pivoting / poisson / etc.) */}
      {triangulationInProgress && !isHeliosRunning && (
        <StatusPill
          testId="triangulation-running"
          label={triProgress?.label ?? 'Triangulating…'}
          progress={triProgress?.value ?? null}
          onCancel={() => {
            if (triRunIdRef.current) void cancelRun(triRunIdRef.current);
            triAbortRef.current?.abort();
            triRunIdRef.current = null;
          }}
        />
      )}

      {/* Helios triangulation status indicator */}
      {isHeliosRunning && (
        <StatusPill
          testId="helios-running"
          label={triProgress?.label ?? 'Helios triangulating…'}
          progress={triProgress?.value ?? null}
          onCancel={cancelHeliosTriangulation}
        />
      )}

      {isLadRunning && (
        <StatusPill
          testId="lad-running"
          label={ladProgress?.label ?? 'Computing leaf area density…'}
          progress={ladProgress?.value ?? null}
          onCancel={cancelLAD}
        />
      )}

      {isBackfillRunning && (
        <StatusPill
          testId="backfill-running"
          label={backfillProgress?.label ?? 'Backfilling misses…'}
          progress={backfillProgress?.value ?? null}
          onCancel={cancelBackfill}
        />
      )}

      {qsmInProgress && (
        <StatusPill
          testId="qsm-running"
          label={qsmProgress?.label ?? 'Building QSM…'}
          progress={qsmProgress?.value ?? null}
          onCancel={cancelQSM}
        />
      )}

      {/* Synthetic LiDAR scan status indicator — the central pill every other
          long op shows. The ray-trace stage streams a null fraction, which
          StatusPill renders as a label-only pulse (no bar/percent). */}
      {isScanning && (
        <StatusPill
          testId="synthetic-scan-status"
          label={scanProgress?.label ?? 'Scanning…'}
          progress={scanProgress?.value ?? null}
          onCancel={cancelScan}
        />
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
        const opLabel = transformModal.op === 'translate' ? 'Translate'
          : transformModal.op === 'rotate' ? 'Rotate' : 'Scale';
        const color = transformModal.op === 'translate' ? 'bg-blue-500'
          : transformModal.op === 'rotate' ? 'bg-violet-500' : 'bg-amber-500';
        return (
          <div data-testid="transform-hud" data-transform-op={transformModal.op} data-transform-axis={transformModal.axis} className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-neutral-800/90 backdrop-blur-sm rounded-full border border-neutral-700/50 z-30 shadow-lg">
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

      {/* Mesh color popover, rendered at the viewport root as a fixed overlay so
          it escapes the Meshes panel's overflow clip and backdrop-blur stacking
          context (which otherwise hid it behind the crop wireframe box). */}
      {colorPopoverMeshId && colorPopoverAnchor && (() => {
        const popoverMesh = meshes.find(m => m.id === colorPopoverMeshId);
        if (!popoverMesh) return null;
        return (
          <>
            {/* Click-catcher: dismiss on any outside click. */}
            <div
              className="fixed inset-0 z-[59]"
              onClick={() => setColorPopoverMeshId(null)}
            />
            <div
              data-testid="mesh-color-popover"
              onClick={(e) => e.stopPropagation()}
              style={{ top: colorPopoverAnchor.top, left: colorPopoverAnchor.left }}
              className="fixed z-[60] flex items-center gap-2 p-2 bg-neutral-900 border border-neutral-700 rounded shadow-lg"
            >
              <input
                type="color"
                value={popoverMesh.color}
                onChange={(e) => handleSetMeshColor(popoverMesh.id, e.target.value)}
                className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0"
                title="Pick color"
              />
              <input
                type="text"
                value={popoverMesh.color}
                onChange={(e) => {
                  const v = e.target.value;
                  // Only commit a complete, valid hex so the render path
                  // (TriangleMesh) never receives a partial value.
                  if (/^#[0-9a-fA-F]{6}$/.test(v)) handleSetMeshColor(popoverMesh.id, v);
                }}
                className="w-20 px-1.5 py-1 text-[11px] bg-neutral-800 border border-neutral-600 rounded text-neutral-200 font-mono"
                maxLength={7}
              />
              <button
                onClick={() => setColorPopoverMeshId(null)}
                className="text-[10px] text-neutral-400 hover:text-neutral-200 px-1"
                title="Close"
              >
                Done
              </button>
            </div>
          </>
        );
      })()}

      {/* Per-scan color popover — same fixed-overlay pattern as the mesh popover. */}
      {colorPopoverScanId && scanColorPopoverAnchor && onUpdateScanColor && (() => {
        const popoverScan = scans.find(s => s.id === colorPopoverScanId);
        if (!popoverScan) return null;
        return (
          <>
            {/* Click-catcher: dismiss on any outside click. */}
            <div
              className="fixed inset-0 z-[59]"
              onClick={() => setColorPopoverScanId(null)}
            />
            <div
              data-testid="scan-color-popover"
              onClick={(e) => e.stopPropagation()}
              style={{ top: scanColorPopoverAnchor.top, left: scanColorPopoverAnchor.left }}
              className="fixed z-[60] flex items-center gap-2 p-2 bg-neutral-900 border border-neutral-700 rounded shadow-lg"
            >
              <input
                type="color"
                value={popoverScan.color}
                onChange={(e) => onUpdateScanColor(popoverScan.id, e.target.value)}
                className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0"
                title="Pick color"
              />
              <input
                type="text"
                value={popoverScan.color}
                onChange={(e) => {
                  const v = e.target.value;
                  // Only commit a complete, valid hex so the render path
                  // never receives a partial value.
                  if (/^#[0-9a-fA-F]{6}$/.test(v)) onUpdateScanColor(popoverScan.id, v);
                }}
                className="w-20 px-1.5 py-1 text-[11px] bg-neutral-800 border border-neutral-600 rounded text-neutral-200 font-mono"
                maxLength={7}
              />
              <button
                onClick={() => setColorPopoverScanId(null)}
                className="text-[10px] text-neutral-400 hover:text-neutral-200 px-1"
                title="Close"
              >
                Done
              </button>
            </div>
          </>
        );
      })()}

      {/* Right Side Panels Container. z-30 keeps the whole panel stack above the
          viewport SVG overlays (crop/seed boxes at z-10) so panel controls and
          their popovers aren't obstructed by the wireframe crop box. */}
      <div className="absolute top-4 right-4 z-30 flex flex-col gap-2 max-h-[calc(100vh-100px)]">
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
            <button
              data-testid="scans-bulk-hide"
              onClick={onToggleScansVisibility}
              className="p-1 hover:bg-neutral-700 rounded"
              title={selectedScanIds.size > 0 ? `Show/hide ${selectedScanIds.size} selected` : 'Show/hide all'}
            >
              {anyTargetVisible(scans, selectedScanIds)
                ? <Eye className="w-3 h-3 text-neutral-400" />
                : <EyeOff className="w-3 h-3 text-neutral-600" />}
            </button>
            <button
              data-testid="scans-bulk-delete"
              onClick={handleDeleteScans}
              className="p-1 hover:bg-red-600/30 rounded"
              title={selectedScanIds.size > 0 ? `Delete ${selectedScanIds.size} selected` : 'Delete all'}
            >
              <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
            </button>
          </div>
          {/* Run a synthetic LiDAR scan from a chosen subset of scan positions
              (picked in the options popup, visible or not) against all visible
              plant/imported geometry. Shown whenever any scanner exists so the
              action is discoverable right where scanners are placed. */}
          {scansWithParams.length > 0 && (
            <div className="px-2 pt-2">
              {isScanning ? (
                // While a scan is running the panel shows a "Scanning…" spinner
                // alongside an explicit Cancel button. The per-stage label and
                // progress bar still live in the central StatusPill, but a bare
                // "x" on the pill reads as "dismiss" rather than "kill the run",
                // so the discoverable Cancel lives here next to the indicator.
                <div className="flex items-center gap-1.5">
                  <div
                    data-testid="synthetic-scan-running"
                    className="flex-1 px-2 py-1.5 bg-neutral-600 rounded text-xs text-white flex items-center justify-center gap-1.5 cursor-default"
                  >
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Scanning…
                  </div>
                  <button
                    data-testid="cancel-synthetic-scan"
                    onClick={cancelScan}
                    className="px-2 py-1.5 bg-red-600 hover:bg-red-500 rounded text-xs text-white flex items-center justify-center gap-1.5"
                    title="Cancel the running scan"
                  >
                    <X className="w-3 h-3" />
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  data-testid="run-synthetic-scan"
                  onClick={() => handleRunScan()}
                  className="w-full px-2 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white flex items-center justify-center gap-1.5"
                  title="Ray-trace the chosen scan positions against the visible plant/imported geometry"
                >
                  <Radio className="w-3 h-3" />
                  Run Synthetic LiDAR Scan
                </button>
              )}
            </div>
          )}
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
                ? scan.data.pointCount - editState.erasedIndices.size - (editState.pendingDeletedCount ?? 0)
                : 0;
              const displayName = scanDisplayName(scan);
              const isExpanded = expandedScanIds.has(scan.id);

              // Build subtitle text based on which fields the scan carries. A
              // moving-platform scan (params.trajectory set) shows a "moving"
              // badge + pose/time-span summary INSTEAD of a single origin —
              // origin is only a fallback anchor there and showing it is
              // misleading.
              const isMovingScanRow = scanHasParams && scan.params.trajectory != null;
              const originText = scanHasParams && !isMovingScanRow
                ? `(${scan.params.origin.x.toFixed(2)}, ${scan.params.origin.y.toFixed(2)}, ${scan.params.origin.z.toFixed(2)})`
                : null;
              const movingBadge = isMovingScanRow ? (
                <span data-testid="scan-row-moving"
                  className="px-1 rounded bg-lime-500/20 text-lime-300 text-[10px] font-medium">
                  moving
                </span>
              ) : null;
              const trajText = isMovingScanRow
                ? `${scan.params.trajectory!.poses.length} poses`
                : null;
              let subtitle: React.ReactNode;
              if (scanHasData && scanHasParams) {
                subtitle = (<>
                  {effectivePointCount.toLocaleString()} pts
                  {hasCloudEdits && <span className="ml-1 text-amber-400">*</span>}
                  <span className="mx-1">·</span>
                  {isMovingScanRow
                    ? <>{movingBadge} <span className="ml-1 font-mono">{trajText}</span></>
                    : <span className="font-mono">origin {originText}</span>}
                </>);
              } else if (scanHasData) {
                subtitle = (<>
                  {effectivePointCount.toLocaleString()} pts
                  {hasCloudEdits && <span className="ml-1 text-amber-400">*</span>}
                </>);
              } else {
                subtitle = (<>
                  params <span className="mx-1">·</span>
                  {isMovingScanRow
                    ? <>{movingBadge} <span className="ml-1 font-mono">{trajText}</span></>
                    : <span className="font-mono">origin {originText}</span>}
                </>);
              }

              return (
                <div key={scan.id} className="mb-0.5">
                  <div
                    data-testid="scan-row"
                    data-scan-id={scan.id}
                    data-scan-name={displayName}
                    data-scan-color={scan.color}
                    data-point-count={scanHasData ? effectivePointCount : 0}
                    data-has-data={scanHasData ? 'true' : 'false'}
                    data-has-params={scanHasParams ? 'true' : 'false'}
                    data-moving={isMovingScanRow ? 'true' : 'false'}
                    data-octree={scanHasData && scan.data?.octree ? 'true' : 'false'}
                    data-selected={isSelected ? 'true' : 'false'}
                    data-visible={scan.visible ? 'true' : 'false'}
                    onClick={(e) => {
                      // Only allow toggle-off when this scan is the WHOLE
                      // selection. If a mesh/skeleton is also selected (mixed
                      // mode, e.g. after creating a voxel box), the click should
                      // refocus this scan and clear the mesh — not deselect.
                      const allowDeselect = selectedMeshIds.size === 0 && selectedSkeletonIds.size === 0;
                      onToggleSelection(scan.id, e.ctrlKey || e.metaKey, e.shiftKey, allowDeselect);
                    }}
                    className={`flex items-center gap-1.5 p-2 rounded cursor-pointer select-none transition-colors ${
                      isSelected ? 'bg-blue-600/30 border border-blue-500/50' : 'hover:bg-neutral-700/50'
                    }`}
                  >
                    {onUpdateScanColor ? (
                      <button
                        data-testid="scan-color-swatch"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (colorPopoverScanId === scan.id) {
                            setColorPopoverScanId(null);
                            return;
                          }
                          // Anchor the fixed popover just below the swatch.
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setScanColorPopoverAnchor({ top: r.bottom + 4, left: r.left });
                          setColorPopoverScanId(scan.id);
                        }}
                        className="w-3 h-3 rounded-full flex-shrink-0 ring-1 ring-white/20 hover:ring-white/60 transition-shadow"
                        style={{ backgroundColor: scan.color }}
                        title="Set color"
                      />
                    ) : (
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: scan.color }} />
                    )}
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
                    {scan.data?.octree?.hasMisses && onToggleMisses && (() => {
                      // The misses live in their own projected octree (built at
                      // create/bake/backfill) — the projection is baked in, so the
                      // toggle works whenever that octree exists, regardless of
                      // whether a live scanner origin is still attached. The toggle
                      // is disabled only when the misses are flagged but NO octree
                      // was built (all unplaceable: zeroed coords, no recovered beam
                      // direction — run Backfill Misses to recover them).
                      const canShow = scan.data?.octree?.missOctreeCacheId != null;
                      return (
                        <button
                          data-testid={`scan-toggle-misses-${scan.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!canShow) return;
                            onToggleMisses(scan.id);
                          }}
                          disabled={!canShow}
                          className={`p-1 rounded ${canShow ? 'hover:bg-neutral-600 cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                          title={canShow
                            ? (scan.showMisses ? 'Hide sky/miss points' : 'Show sky/miss points')
                            : 'Sky/miss points are flagged but have no recovered beam direction yet. Run Backfill Misses to reconstruct them from the scan grid.'}
                        >
                          <CircleDot
                            className={`w-3 h-3 ${scan.showMisses && canShow ? 'text-amber-500' : 'text-neutral-600'}`}
                          />
                        </button>
                      );
                    })()}
                    {!scanHasData && (
                      <button
                        data-testid={`scan-attach-data-${scan.id}`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          const picked = await window.electronAPI.dialog.open({
                            title: 'Attach point cloud data',
                            filters: [{ name: 'Point cloud', extensions: ['las', 'laz', 'e57', 'ply', 'pcd', 'xyz', 'txt', 'csv', 'pts', 'asc'] }],
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
                            // A file carrying reconstructed scan params (e.g. a LAS
                            // with per-pulse beam-origin ExtraBytes → a moving-platform
                            // trajectory) auto-populates the scan's parameters, so it
                            // becomes a moving scan with its path drawn rather than a
                            // plain static cloud.
                            const sp = data.octree?.scanParams;
                            if (sp && !scan.params) {
                              onUpdateScanParams(scan.id, scanParametersFromFile(sp));
                            }
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
                    {onAddScan && (
                      <button
                        data-testid={`scan-duplicate-${scan.id}`}
                        onClick={(e) => { e.stopPropagation(); handleDuplicateScan(scan.id); }}
                        className="p-1 hover:bg-neutral-600 rounded"
                        title="Duplicate scan"
                      >
                        <Copy className="w-3 h-3 text-neutral-400" />
                      </button>
                    )}
                    <button
                      data-testid={`scan-delete-${scan.id}`}
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ type: 'cloud', ids: [scan.id], label: displayName }); }}
                      className="p-1 hover:bg-red-600/30 rounded"
                      title="Remove"
                    >
                      <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
                    </button>
                  </div>
                  {/* Expanded parameters block. */}
                  {isExpanded && scanHasParams && (
                    <div data-testid={`scan-expanded-${scan.id}`} className="pl-6 pr-2 pb-2 pt-1 text-[10px] text-neutral-400 space-y-0.5">
                      {scan.params.scannerModel && scan.params.scannerModel !== 'generic' && (
                        <div>
                          model: <span className="text-neutral-300">{getScannerModel(scan.params.scannerModel).label}</span>
                        </div>
                      )}
                      {isMovingScanRow ? (
                        // A moving scan has no single position — each return's beam
                        // origin comes from the trajectory. Show the path summary
                        // instead of the (misleading) first-pose anchor coordinate.
                        <div>
                          trajectory: <span className="font-mono text-neutral-300">{scan.params.trajectory!.poses.length} poses</span>
                          <span className="mx-1">·</span>
                          <span className="font-mono text-neutral-300">{trajectoryDurationS(scan.params.trajectory!).toFixed(1)} s</span>
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 gap-x-2">
                          <div>x: <span className="font-mono text-neutral-300">{scan.params.origin.x.toFixed(3)}</span></div>
                          <div>y: <span className="font-mono text-neutral-300">{scan.params.origin.y.toFixed(3)}</span></div>
                          <div>z: <span className="font-mono text-neutral-300">{scan.params.origin.z.toFixed(3)}</span></div>
                        </div>
                      )}
                      {scan.params.pattern === 'spinning_multibeam' ? (
                        <>
                          <div>
                            pattern: <span className="text-neutral-300">spinning multibeam</span>
                            <span className="mx-1">·</span>
                            size: <span className="font-mono text-neutral-300">{scan.params.beamElevationAnglesDeg.length} ch × {scan.params.azimuthPoints}</span>
                            <span className="mx-1">·</span>
                            sweep: <span className="font-mono text-neutral-300">φ {scan.params.azimuthMinDeg.toFixed(0)}–{scan.params.azimuthMaxDeg.toFixed(0)}°</span>
                          </div>
                          <div>
                            beam elev: <span className="font-mono text-neutral-300">{scan.params.beamElevationAnglesDeg.map((a) => a.toFixed(0)).join(', ')}°</span>
                          </div>
                        </>
                      ) : (
                        <div>
                          pattern: <span className="text-neutral-300">raster</span>
                          <span className="mx-1">·</span>
                          size: <span className="font-mono text-neutral-300">{scan.params.zenithPoints} × {scan.params.azimuthPoints}</span>
                          <span className="mx-1">·</span>
                          sweep: <span className="font-mono text-neutral-300">θ {scan.params.zenithMinDeg.toFixed(0)}–{scan.params.zenithMaxDeg.toFixed(0)}° · φ {scan.params.azimuthMinDeg.toFixed(0)}–{scan.params.azimuthMaxDeg.toFixed(0)}°</span>
                        </div>
                      )}
                      <div>
                        return: <span className="text-neutral-300">{scan.params.returnMode}</span>
                        {scan.params.returnMode === 'multi' && (
                          <span> (≤{scan.params.maxReturns})</span>
                        )}
                        {scan.params.returnMode === 'single' && (
                          <span> ({scan.params.returnSelection})</span>
                        )}
                        <span className="mx-1">·</span>
                        beam Ø <span className="font-mono text-neutral-300">{scan.params.beamExitDiameterM} m</span>
                        <span className="mx-1">·</span>
                        div <span className="font-mono text-neutral-300">{scan.params.beamDivergenceMrad} mrad</span>
                      </div>
                      {(scan.params.tiltRollDeg !== 0 || scan.params.tiltPitchDeg !== 0) && (
                        <div>
                          tilt: <span className="font-mono text-neutral-300">roll {scan.params.tiltRollDeg}° · pitch {scan.params.tiltPitchDeg}°</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Meshes Panel */}
        {meshes.length > 0 && (
          <MeshesListPanel
            meshes={meshes}
            clouds={clouds}
            selectedMeshIds={selectedMeshIds}
            expandedMeshIds={expandedMeshIds}
            renamingMeshId={renamingMeshId}
            renamingMeshValue={renamingMeshValue}
            colorPopoverMeshId={colorPopoverMeshId}
            meshColorModes={meshColorModes}
            meshOpacities={meshOpacities}
            meshRotations={meshRotations}
            meshPositions={meshPositions}
            meshScales={meshScales}
            colormap={colormap}
            meshWireframe={meshWireframe}
            defaultOpacityFor={defaultMeshOpacity}
            isTextured={isTexturedMesh}
            isTriangulated={isTriangulatedMesh}
            supportsOpacity={meshSupportsOpacity}
            selectedCount={selectedMeshIds.size}
            anyTargetVisible={anyTargetVisible(meshes, selectedMeshIds)}
            onToggleVisibilityAll={handleToggleMeshesVisibility}
            onDeleteAll={handleDeleteMeshes}
            onSelect={handleSelectMesh}
            onToggleVisibility={handleToggleMeshVisibility}
            onRequestDelete={(id, name) => setDeleteConfirm({ type: 'mesh', ids: [id], label: name })}
            onToggleExpanded={(id) => setExpandedMeshIds(prev => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            })}
            // The floating Transform panel acts on the (first) selected mesh, so
            // tie the row's transform button to selection: highlight it only
            // when the panel is open AND this is the mesh it's editing.
            transformMeshId={showResizePanel ? selectedMeshId : null}
            onToggleTransform={(id) => {
              if (showResizePanel && selectedMeshId === id) {
                setShowResizePanel(false);
                return;
              }
              setSelectedMeshIds(new Set([id]));
              setSelectedSkeletonIds(new Set());
              setShowResizePanel(true);
            }}
            onRename={handleRenameMesh}
            onRenamingChange={(id, value) => { setRenamingMeshId(id); setRenamingMeshValue(value); }}
            onOpenColorPopover={(id, anchor) => { setColorPopoverAnchor(anchor); setColorPopoverMeshId(id); }}
            onCloseColorPopover={() => setColorPopoverMeshId(null)}
            onColorModeChange={(id, mode) => setMeshColorModes(prev => {
              const next = new Map(prev);
              if (mode === 'solid') next.delete(id);
              else next.set(id, mode);
              return next;
            })}
            onColormapChange={setColormap}
            onOpacityChange={(id, value) => setMeshOpacities(prev => new Map(prev).set(id, value))}
            onWireframeChange={setMeshWireframe}
            onOpenLeafAngles={setShowLeafAngleMeshId}
            onHeliosFilterChange={handleHeliosFilterChange}
            onCheckSpacing={handleCheckSpacing}
            ladIneligibilityReason={ladIneligibilityReason}
          />
        )}

        {/* Skeletons Panel */}
        {skeletons.length > 0 && (
          <SkeletonsListPanel
            skeletons={skeletons}
            clouds={clouds}
            selectedSkeletonIds={selectedSkeletonIds}
            selectedCount={selectedSkeletonIds.size}
            anyTargetVisible={anyTargetVisible(skeletons, selectedSkeletonIds)}
            showAsCylinders={skeletonShowAsCylinders}
            tubeRadius={skeletonTubeRadius}
            colorByBranchOrder={skeletonColorByBranchOrder}
            onSelect={handleSelectSkeleton}
            onToggleVisibility={handleToggleSkeletonVisibility}
            onToggleVisibilityAll={handleToggleSkeletonsVisibility}
            onDeleteAll={handleDeleteSkeletons}
            onRequestDelete={(id, name) => setDeleteConfirm({ type: 'skeleton', ids: [id], label: name })}
            onShowAsCylindersChange={setSkeletonShowAsCylinders}
            onTubeRadiusChange={setSkeletonTubeRadius}
            onColorByBranchOrderChange={setSkeletonColorByBranchOrder}
          />
        )}

        {/* QSM Results Panel */}
        {qsms.length > 0 && (
          <div data-testid="qsm-results-panel" className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-64 max-h-[50vh] flex flex-col">
            <div className="p-2 border-b border-neutral-700 flex items-center gap-2">
              <QsmIcon className="w-4 h-4 text-neutral-400" />
              <span className="text-xs font-medium text-neutral-300 flex-1">QSM</span>
              <button
                data-testid="qsm-export-open"
                onClick={() => setShowQSMExportPanel(true)}
                title="Export QSMs"
                className="p-1 hover:bg-neutral-700 rounded"
              >
                <Download className="w-3.5 h-3.5 text-neutral-400" />
              </button>
              <button
                data-testid="qsm-bulk-hide"
                onClick={handleToggleQSMsVisibility}
                className="p-1 hover:bg-neutral-700 rounded"
                title={selectedQSMIds.size > 0 ? `Show/hide ${selectedQSMIds.size} selected` : 'Show/hide all'}
              >
                {anyTargetVisible(qsms, selectedQSMIds)
                  ? <Eye className="w-3 h-3 text-neutral-400" />
                  : <EyeOff className="w-3 h-3 text-neutral-600" />}
              </button>
              <button
                data-testid="qsm-bulk-delete"
                onClick={handleDeleteQSMs}
                className="p-1 hover:bg-red-600/30 rounded"
                title={selectedQSMIds.size > 0 ? `Delete ${selectedQSMIds.size} selected` : 'Delete all'}
              >
                <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-1">
              {qsms.map(qsm => {
                const sourceCloud = clouds.find(c => c.id === qsm.sourceCloudId);
                const m = qsm.metrics;
                return (
                  <div
                    key={qsm.id}
                    data-testid="qsm-row"
                    data-cylinder-count={qsm.cylinders.length}
                    data-shoot-count={qsm.shoots.length}
                    data-trunk-count={qsm.shoots.filter(s => s.rank === 0).length}
                    data-scaffold-count={qsm.shoots.filter(s => s.rank === 1).length}
                    data-max-rank={m ? m.max_rank : 0}
                    data-min-radius={qsm.cylinders.length ? Math.min(...qsm.cylinders.map(c => c.radius)) : 0}
                    data-max-radius={qsm.cylinders.length ? Math.max(...qsm.cylinders.map(c => c.radius)) : 0}
                    data-selected={selectedQSMIds.has(qsm.id) ? 'true' : 'false'}
                    data-visible={qsm.visible ? 'true' : 'false'}
                    onClick={(e) => handleToggleQSMSelection(qsm.id, e.ctrlKey || e.metaKey, e.shiftKey)}
                    className={`p-2 rounded cursor-pointer select-none transition-colors ${
                      selectedQSMIds.has(qsm.id) ? 'bg-amber-600/30 border border-amber-500/50' : 'hover:bg-neutral-700/40'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-neutral-200 truncate" data-testid="qsm-row-name">
                          {qsm.sourceLabel || sourceCloud?.data.fileName || 'QSM'}
                        </div>
                        <div className="text-[10px] text-neutral-500" data-testid="qsm-row-stats">
                          {qsm.cylinders.length} cyl · {qsm.shoots.length} shoots
                          {m ? ` · ${m.n_scaffolds} scaffolds` : ''}
                          {qsm.leaves ? (
                            <span
                              data-testid={`qsm-leaf-count-${qsm.id}`}
                              data-leaf-count={qsm.leaves.leafCount}
                              data-leaf-incl-mean={meanLeafInclination(qsm.leaves.data).toFixed(1)}
                            >
                              {` · ${qsm.leaves.leafCount.toLocaleString()} leaves`}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {qsm.leaves && (
                        <button
                          data-testid={`qsm-leaves-toggle-${qsm.id}`}
                          onClick={(e) => { e.stopPropagation(); handleToggleLeavesVisibility(qsm.id); }}
                          className="p-1 hover:bg-neutral-600 rounded"
                          title={qsm.leavesVisible === false ? 'Show leaves' : 'Hide leaves'}
                        >
                          {qsm.leavesVisible === false
                            ? <Sprout className="w-3 h-3 text-neutral-500" />
                            : <Sprout className="w-3 h-3 text-green-400" />}
                        </button>
                      )}
                      {qsm.leaves?.request && eligibleLeafAngleMeshes(meshes, qsm).length > 0 && (
                        <button
                          data-testid={`qsm-adjust-leaves-${qsm.id}`}
                          onClick={(e) => { e.stopPropagation(); setAdjustLeavesQSMId(qsm.id); }}
                          className="p-1 hover:bg-neutral-600 rounded"
                          title="Adjust leaf angles to a measured distribution"
                        >
                          <Compass className="w-3 h-3 text-green-400" />
                        </button>
                      )}
                      <button
                        data-testid={`qsm-add-leaves-${qsm.id}`}
                        onClick={(e) => { e.stopPropagation(); setAddLeavesQSMId(qsm.id); }}
                        className="p-1 hover:bg-neutral-600 rounded"
                        title="Add leaves"
                      >
                        <Plus className="w-3 h-3 text-green-400" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggleQSMVisibility(qsm.id); }}
                        className="p-1 hover:bg-neutral-600 rounded"
                        title={qsm.visible ? 'Hide' : 'Show'}
                      >
                        {qsm.visible ? <Eye className="w-3 h-3 text-neutral-300" /> : <EyeOff className="w-3 h-3 text-neutral-500" />}
                      </button>
                      <button
                        data-testid={`qsm-results-${qsm.id}`}
                        onClick={(e) => { e.stopPropagation(); setShowQSMResultsId(qsm.id); }}
                        className="p-1 hover:bg-neutral-600 rounded"
                        title="View results"
                      >
                        <ChartColumn className="w-3 h-3 text-neutral-300" />
                      </button>
                      <button
                        data-testid={`qsm-delete-${qsm.id}`}
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ type: 'qsm', ids: [qsm.id], label: qsm.sourceLabel || sourceCloud?.data.fileName || 'QSM' }); }}
                        className="p-1 hover:bg-neutral-600 rounded"
                        title="Delete"
                      >
                        <Trash2 className="w-3 h-3 text-neutral-400" />
                      </button>
                    </div>

                    {/* Whole-tree metrics */}
                    {m && (
                      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-neutral-400" data-testid="qsm-metrics">
                        <span>Trunk Ø</span><span className="text-neutral-200 text-right">{m.trunk_diameter_mm.toFixed(1)} mm</span>
                        <span>Height</span><span className="text-neutral-200 text-right">{m.tree_height_m.toFixed(2)} m</span>
                        <span>Woody vol</span><span className="text-neutral-200 text-right">{(m.total_woody_volume_m3 * 1e6).toFixed(0)} cm³</span>
                        <span>Max rank</span><span className="text-neutral-200 text-right">{m.max_rank}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Display settings: color mode. */}
            <div className="p-2 border-t border-neutral-700 flex items-center gap-2">
              <span className="text-[10px] text-neutral-400">Color by</span>
              <select
                data-testid="qsm-color-mode"
                value={qsmColorMode}
                onChange={(e) => setQSMColorMode(e.target.value as QSMColorMode)}
                className="flex-1 bg-neutral-700 text-neutral-200 text-[10px] rounded px-1 py-0.5 border border-neutral-600"
              >
                <option value="rank">Shoot rank</option>
                <option value="shoot">Shoot id</option>
              </select>
            </div>
          </div>
        )}

        {/* Leaf Area Density results */}
        {ladResults.length > 0 && (
          <LADResultsPanel
            ladResults={ladResults}
            selectedLadId={selectedLadId}
            colormap={colormap}
            onSelect={setSelectedLadId}
            onToggleVisible={toggleLadVisible}
            onRemove={removeLadResult}
            onUpdate={updateLadResult}
            onColormapChange={setColormap}
          />
        )}

        {/* The standalone Scan Locations panel was unified into the Scans
            panel above — every entry there can hold data, params, or both. */}
      </div>

      {/* Left Control Panel. Capped to the viewport height (less room for the
          bottom-left status readout) and scrollable, so the now-taller toolbar
          stack — View, Snap, Create, Simulate, Tools — never overlaps the status
          bar on short windows. `pr-1` keeps the scrollbar off the buttons. */}
      <div className="absolute top-4 left-4 bottom-16 flex flex-col gap-2 overflow-y-auto overflow-x-hidden pr-1">
        {/* View Controls */}
        <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg p-2 shadow-lg flex gap-1">
          <button onClick={() => (window as any).__resetPointCloudCamera?.()} className="p-2 hover:bg-neutral-700 rounded transition-colors flex items-center justify-center" title="Reset View — frame all content from the default isometric angle">
            <Home className="w-4 h-4 text-neutral-300" />
          </button>
          <button onClick={() => { setShowCommandPalette(true); setCommandSearch(''); setCommandSelectedIndex(0); }} className="p-2 hover:bg-neutral-700 rounded transition-colors flex items-center justify-center" title="Search Commands (Cmd+K)">
            <Search className="w-4 h-4 text-neutral-300" />
          </button>
        </div>

        {/* Snap to View */}
        <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg p-2 shadow-lg">
          <div className="text-[10px] text-neutral-500 mb-1.5 text-center">Snap View</div>
          {/* Named-view buttons REORIENT only — they rotate the camera to look down
              the requested axis while preserving the current orbit target and zoom
              (CAD/DCC convention). Use the Reset View (Home) button above or Zoom to
              Selection below to reframe. Axes are the camera-to-target direction in
              world space (Z-up): top +z, front −y, right +x, iso the default 3/4 view. */}
          <div className="grid grid-cols-3 gap-0.5">
            <div />
            <button onClick={() => (window as any).__orientToAxis?.({ x: 0, y: 1, z: 0 })} className="p-1.5 hover:bg-neutral-700 rounded" title="Back View"><ArrowUp className="w-3 h-3 text-neutral-300" /></button>
            <div />
            <button onClick={() => (window as any).__orientToAxis?.({ x: -1, y: 0, z: 0 })} className="p-1.5 hover:bg-neutral-700 rounded" title="Left View"><ArrowLeft className="w-3 h-3 text-neutral-300" /></button>
            <button onClick={() => (window as any).__orientToAxis?.({ x: 0, y: 0, z: 1 })} className="p-1.5 hover:bg-neutral-700 rounded" title="Top View"><Circle className="w-3 h-3 text-neutral-300" /></button>
            <button onClick={() => (window as any).__orientToAxis?.({ x: 1, y: 0, z: 0 })} className="p-1.5 hover:bg-neutral-700 rounded" title="Right View"><ArrowRight className="w-3 h-3 text-neutral-300" /></button>
            <button onClick={() => (window as any).__orientToAxis?.({ x: 0.6, y: -0.6, z: 0.5 })} className="p-1.5 hover:bg-neutral-700 rounded" title="Isometric"><Square className="w-3 h-3 text-neutral-300 rotate-45" /></button>
            <button onClick={() => (window as any).__orientToAxis?.({ x: 0, y: -1, z: 0 })} className="p-1.5 hover:bg-neutral-700 rounded" title="Front View"><ArrowDown className="w-3 h-3 text-neutral-300" /></button>
            <button onClick={() => (window as any).__orientToAxis?.({ x: 0, y: 0, z: -1 })} className="p-1.5 hover:bg-neutral-700 rounded" title="Bottom View"><Circle className="w-2.5 h-2.5 text-neutral-500" /></button>
          </div>
          <button
            data-testid="zoom-to-selection"
            onClick={() => zoomToSelectionRef.current()}
            disabled={!hasAnySelection}
            className="mt-1 w-full flex items-center justify-center gap-1 px-1.5 py-1 rounded bg-neutral-700/60 hover:bg-neutral-700 text-[10px] text-neutral-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-neutral-700/60"
            title="Zoom to Selection — fit selected geometry in the viewport, keeping the current angle (F)"
          >
            <Maximize2 className="w-3 h-3" /> Zoom to Selection
          </button>
        </div>

        {/* Create — geometry generation (scene-building, not analysis). */}
        <Toolbar commands={commands} selection={toolSelection} title="Create" groups={CREATE_GROUPS} />

        {/* Tools — analysis operations on existing data. Renders from the single
            command registry; unavailable single-input tools grey out, multi-input
            tools stay enabled. (See lib/toolCommands.ts.)
            Note: synthetic scanning (Simulate) is reached from the Simulate menu
            and the Scans panel, so it has no dedicated left-toolbar block.
            Undo/redo are Ctrl+Z / Ctrl+Y and the Edit menu; per-item delete lives
            in the Meshes / Skeletons list panels. */}
        <Toolbar commands={commands} selection={toolSelection} />
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
        // Projection kind of a committed screen-space region (rect / polygon). An
        // orthographic projection matrix has m[15]=1, m[11]=0; a perspective one
        // has m[15]=0, m[11]=-1. The Rect tool draws orthographically so its
        // extrusion is a true prism — exposed for the trapezoid-regression test.
        const cropProjectionKind = cropPolygon
          ? (Math.abs(cropPolygon.projection[15] - 1) < 1e-6 &&
             Math.abs(cropPolygon.projection[11]) < 1e-6
              ? 'orthographic' as const
              : 'perspective' as const)
          : '' as const;

        return (
          <CropPanel
            selectionCount={selectedIds.size}
            cropMode={cropMode}
            cropDrawState={cropDrawState}
            cropBox={cropBox}
            hasCropPolygon={!!cropPolygon}
            polygonVertexCount={polygonInProgress.length}
            cropPolygonPointCount={cropPolygon?.points.length ?? 0}
            cropInvert={cropInvert}
            cropSegment={cropSegment}
            applyDisabled={
              (cropMode === 'box' && !cropBox) ||
              ((cropMode === 'polygon' || cropMode === 'rect') && !cropPolygon)
            }
            cropBoxMinStr={cropBoxMinStr}
            cropBoxMaxStr={cropBoxMaxStr}
            cropProjectionKind={cropProjectionKind}
            onClose={closeCropPanel}
            onSelectShape={(mode) => {
              setCropMode(mode);
              setPolygonInProgress([]);
              setCropPolygon(null);
              setRectDragStart(null);
              rectDragCurrentRef.current = null;
              if (mode === 'box') {
                setCropDrawState('idle');
                if (!cropBox) resetWorldBox();
              } else if (mode === 'rect') {
                setCropDrawState('drawing-rect');
              } else {
                setCropDrawState('drawing-polygon');
              }
            }}
            onKeepInside={() => { setCropInvert(false); setCropSegment(false); }}
            onKeepOutside={() => { setCropInvert(true); setCropSegment(false); }}
            onSegment={() => { setCropInvert(false); setCropSegment(true); }}
            onSetBoxSize={(axisKey, newSize) => setCropBox(prev => {
              if (!prev) return prev;
              const center = (prev.min[axisKey] + prev.max[axisKey]) / 2;
              return {
                min: { ...prev.min, [axisKey]: center - newSize / 2 },
                max: { ...prev.max, [axisKey]: center + newSize / 2 },
              };
            })}
            onSetBoxCenter={(axisKey, newCenter) => setCropBox(prev => {
              if (!prev) return prev;
              const halfSize = (prev.max[axisKey] - prev.min[axisKey]) / 2;
              return {
                min: { ...prev.min, [axisKey]: newCenter - halfSize },
                max: { ...prev.max, [axisKey]: newCenter + halfSize },
              };
            })}
            onDrawBox={() => {
              boxDrawFirstCornerRef.current = null;
              boxDrawCursorRef.current = null;
              setCropDrawState('awaiting-box-corner-1');
            }}
            onResetBox={resetWorldBox}
            onRedrawPolygon={() => { setCropPolygon(null); setPolygonInProgress([]); setCropDrawState('drawing-polygon'); }}
            onStartPolygon={() => { setPolygonInProgress([]); setCropDrawState('drawing-polygon'); }}
            onRedrawRect={() => { setCropPolygon(null); setRectDragStart(null); rectDragCurrentRef.current = null; setCropDrawState('drawing-rect'); }}
            onStartRect={() => { setRectDragStart(null); rectDragCurrentRef.current = null; setCropDrawState('drawing-rect'); }}
            onApply={handleApplyCrop}
          />
        );
      })()}

      {/* Erase Brush Panel */}
      {editMode === 'erase' && firstSelectedCloud && (() => {
        const editState = getEditState(firstSelectedCloud.id);
        const isOctree = !!firstSelectedCloud.data.octree;
        const erasedCount = editState.erasedIndices?.size || 0;
        const stampCount = eraseFrame?.centers.length ?? 0;
        // What the panel shows as "pending erase" and whether Apply is enabled:
        // octree clouds count painted square stamps; flat clouds count erased
        // indices.
        const pendingCount = isOctree ? stampCount : erasedCount;

        // Flat-cloud brush is world-space (scaled to the cloud diagonal); octree
        // brush is screen-space pixels (constant on-screen, independent of scale).
        const diag = firstSelectedCloud.data.bounds.size.length();
        const flatMin = diag > 0 ? diag / 500 : 0.01;
        const flatMax = diag > 0 ? diag / 5 : 1;
        const flatStep = (flatMax - flatMin) / 100;

        // Projection kind of the painted frame. Erase runs under an orthographic
        // override so the square cuts a straight prism whose footprint matches the
        // brush outline (ortho ⇒ m[15]=1, m[11]=0). Asserted by the regression
        // test guarding against the center-biased perspective trapezoid.
        const eraseProjectionKind = eraseFrame
          ? (Math.abs(eraseFrame.projection[15] - 1) < 1e-6 &&
             Math.abs(eraseFrame.projection[11]) < 1e-6
              ? 'orthographic' as const
              : 'perspective' as const)
          : '' as const;
        const cloud = firstSelectedCloud;

        return (
          <ErasePanel
            isOctree={isOctree}
            eraseActive={eraseActive}
            erasedCount={erasedCount}
            stampCount={stampCount}
            pendingCount={pendingCount}
            eraseBrushPx={eraseBrushPx}
            eraseBrushSize={eraseBrushSize}
            flatMin={flatMin}
            flatMax={flatMax}
            flatStep={flatStep}
            eraseProjectionKind={eraseProjectionKind}
            hasPendingDeletes={(getEditState(cloud.id).pendingDeletes?.length ?? 0) > 0}
            onToggleEraseActive={() => setEraseActive(a => !a)}
            onBrushPxChange={setEraseBrushPx}
            onBrushSizeChange={setEraseBrushSize}
            onApply={handleApplyErase}
            onRestore={() => {
              if (isOctree) {
                // Discard painted squares without touching the cloud — the preview
                // clears with the frame.
                setEraseFrame(null);
                setErasePreviewBoxes([]);
              } else {
                saveToHistory();
                updateSelectedEditStates(s => ({ ...s, erasedIndices: new Set<number>() }));
                setTimeout(saveToHistory, 0);
              }
            }}
            onBake={() => handleBakeEdits(cloud.id)}
            onUndoPending={async () => {
              const oct = cloud.data.octree;
              if (!oct?.sessionId) return;
              const stack = getEditState(cloud.id).pendingDeletes ?? [];
              if (stack.length === 0) return;
              // Undo the most recent committed delete: recompute the backend mask
              // from the shortened stack, and drop it from the local stack so the
              // GPU preview updates.
              try {
                const r = await resetCloudEdits(oct.sessionId, stack.length - 1);
                setEditStates(prev => {
                  const next = new Map(prev);
                  const cur = next.get(cloud.id);
                  if (cur) next.set(cloud.id, {
                    ...cur,
                    pendingDeletes: stack.slice(0, -1),
                    pendingDeletedCount: r.deleted_count,
                  });
                  return next;
                });
              } catch (err) {
                showToast({ title: `Undo failed: ${err instanceof Error ? err.message : String(err)}`, type: 'error' });
              }
            }}
            onClose={() => setEditMode('none')}
          />
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

        // Commit a categorical scalar filter's selected class set. Only valid for
        // `scalar:<slug>` fields. An empty set leaves the filter enabled (it keeps
        // nothing) — the commit buttons surface that as a 0-point result.
        const commitClasses = (classes: number[]) => {
          if (!selectedFilterField || !selectedFilterField.startsWith('scalar:')) return;
          const name = selectedFilterField.substring(7);
          const existing = filters.scalarFields[name];
          const newFilters = { ...filters };
          newFilters.scalarFields = {
            ...newFilters.scalarFields,
            [name]: {
              min: existing?.min ?? 0,
              max: existing?.max ?? 0,
              enabled: true,
              selectedClasses: classes,
            },
          };
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
          // For a categorical field with no committed filter yet, seed the filter
          // with all classes selected (a visible no-op) so unchecking a class
          // immediately narrows the kept set — no "nothing happens" first toggle.
          const slug = fieldValue.startsWith('scalar:') ? fieldValue.substring(7) : null;
          if (slug && field && isCategoricalAttribute(slug) && !currentFilter?.selectedClasses) {
            const scheme = categoricalSchemeForRange(slug, [field.bounds.min, field.bounds.max]);
            if (scheme) {
              const existing = filters.scalarFields[slug];
              const newFilters = { ...filters };
              newFilters.scalarFields = {
                ...newFilters.scalarFields,
                [slug]: {
                  min: existing?.min ?? field.bounds.min,
                  max: existing?.max ?? field.bounds.max,
                  enabled: true,
                  selectedClasses: scheme.classes.map(c => c.value),
                },
              };
              setCloudFilters(new Map(cloudFilters).set(cloud.id, newFilters));
            }
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

        // Categorical fields (ground_class / tree_instance) get a class-checkbox
        // UI instead of min/max inputs. The slug is the dropdown value minus the
        // `scalar:` prefix; the class list comes from the registered scheme
        // (ground_class) or is generated from the field's [min,max] (tree_instance).
        const selectedSlug = selectedFilterField?.startsWith('scalar:')
          ? selectedFilterField.substring(7)
          : null;
        const categoricalScheme = selectedSlug && selectedField && isCategoricalAttribute(selectedSlug)
          ? categoricalSchemeForRange(selectedSlug, [selectedField.bounds.min, selectedField.bounds.max])
          : null;
        // Default selection when first opening a categorical field: all classes.
        const selectedClasses = currentFilter?.selectedClasses
          ?? categoricalScheme?.classes.map(c => c.value)
          ?? [];

        return (
          <FilterPanel
            availableFields={availableFields}
            selectedFilterField={selectedFilterField}
            selectedField={selectedField}
            currentFilter={currentFilter}
            categoricalScheme={categoricalScheme}
            selectedClasses={selectedClasses}
            pendingFilterMin={pendingFilterMin}
            pendingFilterMax={pendingFilterMax}
            activeFilters={activeFilters}
            hasAnyFilter={!!hasAnyFilter}
            getFieldFilter={getFieldFilter}
            onClose={() => setShowFilterPanel(false)}
            onFieldChange={handleFieldChange}
            onCommitClasses={commitClasses}
            onPendingMinChange={(value) => { setPendingFilterMin(value); commitFilter(value, pendingFilterMax); }}
            onPendingMaxChange={(value) => { setPendingFilterMax(value); commitFilter(pendingFilterMin, value); }}
            onRemoveFilter={removeFilter}
            onClearAllFilters={clearAllFilters}
            onApplyFilter={handleApplyFilterPermanently}
            onSegmentFilter={handleSegmentFilter}
          />
        );
      })()}

      {/* Resample Panel */}
      {showResamplePanel && firstSelectedCloud && (() => {
        const cloud = firstSelectedCloud;
        // When a preview is active, resample against the pristine point total it
        // captured; otherwise against the cloud's current count.
        const isPreviewActive = resamplePreview?.cloudId === cloud.id;
        const originalCount = isPreviewActive ? resamplePreview.originalPointCount : cloud.data.pointCount;

        return (
          <ResamplePanel
            originalCount={originalCount}
            fraction={resampleFraction}
            isPreviewActive={isPreviewActive}
            previewCount={isPreviewActive ? resamplePreview.previewData.pointCount : null}
            onClose={() => { setResamplePreview(null); setShowResamplePanel(false); }}
            onFractionChange={(f) => { setResampleFraction(f); setResamplePreview(null); }}
            onPreview={() => {
              if (resampleFraction >= 1.0) return;
              const previewData = resampleCloud(cloud.data, resampleFraction, originalCount);
              setResamplePreview({ cloudId: cloud.id, previewData, originalPointCount: originalCount });
              showToast({
                type: 'info',
                title: 'Preview Active',
                message: `Showing ${previewData.pointCount.toLocaleString()} points (temporary)`,
              });
            }}
            onApply={() => {
              if (resampleFraction >= 1.0) return;
              const finalData = isPreviewActive ? resamplePreview.previewData : resampleCloud(cloud.data, resampleFraction, originalCount);
              onUpdateCloud(cloud.id, finalData);
              showToast({
                type: 'success',
                title: 'Resampled',
                message: `Reduced from ${originalCount.toLocaleString()} to ${finalData.pointCount.toLocaleString()} points`,
              });
              setResamplePreview(null);
              setShowResamplePanel(false);
            }}
            onCancelPreview={() => setResamplePreview(null)}
          />
        );
      })()}

      {/* Unified Triangulation Setup modal (Open3D methods + Helios). */}
      <TriangulationPopup
        isOpen={showTriangulationPopup}
        onClose={() => setShowTriangulationPopup(false)}
        onStartTriangulate={handleStartTriangulate}
        scans={scans}
        gridOptions={heliosGridOptions}
        initialSelectedIds={selectedScanIds}
        inProgress={triangulationInProgress || isHeliosRunning}
        error={triangulationError}
      />

      {/* Ground Segmentation Panel */}
      {showGroundSegmentPanel && selectedIds.size === 1 && (
        <GroundSegmentPanel
          clothResolution={groundClothResolution}
          classThreshold={groundClassThreshold}
          rigidness={groundRigidness}
          splitClouds={groundSplitClouds}
          inProgress={groundSegmentInProgress}
          error={groundSegmentError}
          onClose={() => setShowGroundSegmentPanel(false)}
          onClothResolutionChange={setGroundClothResolution}
          onClassThresholdChange={setGroundClassThreshold}
          onRigidnessChange={setGroundRigidness}
          onSplitCloudsChange={setGroundSplitClouds}
          onSegment={handleGroundSegment}
        />
      )}

      {/* Wood/Leaf Segmentation Panel */}
      {showWoodSegmentPanel && selectedIds.size >= 1 && (
        <WoodSegmentPanel
          woodBias={woodBias}
          kMax={woodKMax}
          regIters={woodRegIters}
          mode={woodMode}
          multiMode={woodMultiMode}
          method={woodMethod}
          selectedCount={selectedIds.size}
          inProgress={woodSegmentInProgress}
          error={woodSegmentError}
          reflectanceAvailable={woodReflectanceAvailable}
          useReflectance={woodUseReflectance}
          onClose={() => setShowWoodSegmentPanel(false)}
          onWoodBiasChange={setWoodBias}
          onKMaxChange={setWoodKMax}
          onRegItersChange={setWoodRegIters}
          onModeChange={setWoodMode}
          onMultiModeChange={setWoodMultiMode}
          onMethodChange={setWoodMethod}
          onUseReflectanceChange={setWoodUseReflectance}
          onSegment={handleWoodSegment}
        />
      )}

      {/* Tree Segmentation Panel (TreeIso) */}
      {showTreeSegmentPanel && selectedIds.size === 1 && (
        <TreeSegmentPanel
          regStrength1={treeRegStrength1}
          regStrength2={treeRegStrength2}
          maxGap={treeMaxGap}
          seedMode={treeSeedMode}
          seedCount={treeSeedPoints.length}
          splitClouds={treeSplitClouds}
          inProgress={treeSegmentInProgress}
          error={treeSegmentError}
          hasTrees={!!clouds.find(cl => selectedIds.has(cl.id))?.data.scalarFields?.[TREE_INSTANCE_ATTRIBUTE]}
          mergeA={treeMergeA}
          mergeB={treeMergeB}
          splitId={treeSplitId}
          onClose={() => { setShowTreeSegmentPanel(false); setTreeSeedMode(false); }}
          onRegStrength1Change={setTreeRegStrength1}
          onRegStrength2Change={setTreeRegStrength2}
          onMaxGapChange={setTreeMaxGap}
          onSeedModeChange={setTreeSeedMode}
          onClearSeeds={() => setTreeSeedPoints([])}
          onSplitCloudsChange={setTreeSplitClouds}
          onSegment={handleSegmentTrees}
          onMergeAChange={setTreeMergeA}
          onMergeBChange={setTreeMergeB}
          onSplitIdChange={setTreeSplitId}
          onMerge={handleMergeTrees}
          onSplit={handleSplitTree}
        />
      )}

      {/* Skeleton Extraction Panel */}
      {showSkeletonPanel && selectedIds.size === 1 && (
        <SkeletonExtractionPanel
          removeOutliers={skeletonRemoveOutliers}
          smooth={skeletonSmooth}
          searchRadius={skeletonSearchRadius}
          thresholdFilter={skeletonThresholdFilter}
          showAdvanced={skeletonShowAdvanced}
          rootThreshold={skeletonRootThreshold}
          quantizationLevels={skeletonQuantizationLevels}
          useNonlinearQuant={skeletonUseNonlinearQuant}
          useProportionFilter={skeletonUseProportionFilter}
          smoothIterations={skeletonSmoothIterations}
          inProgress={skeletonInProgress}
          error={skeletonError}
          onClose={() => setShowSkeletonPanel(false)}
          onRemoveOutliersChange={setSkeletonRemoveOutliers}
          onSmoothChange={setSkeletonSmooth}
          onSearchRadiusChange={setSkeletonSearchRadius}
          onThresholdFilterChange={setSkeletonThresholdFilter}
          onShowAdvancedChange={setSkeletonShowAdvanced}
          onRootThresholdChange={setSkeletonRootThreshold}
          onQuantizationLevelsChange={setSkeletonQuantizationLevels}
          onUseNonlinearQuantChange={setSkeletonUseNonlinearQuant}
          onUseProportionFilterChange={setSkeletonUseProportionFilter}
          onSmoothIterationsChange={setSkeletonSmoothIterations}
          onExtract={handleExtractSkeleton}
        />
      )}

      {/* QSM Build modal — scan picker (auto-seeded from the Scans-panel
          selection) + multi-scan mode + twig radius. Mirrors BackfillMissesPopup;
          progress shows in the shared StatusPill (qsm-running) while it runs. */}
      <QSMPopup
        isOpen={showQSMPopup}
        onClose={() => setShowQSMPopup(false)}
        scans={scans}
        initialSelectedIds={selectedIds}
        inProgress={qsmInProgress}
        error={qsmError}
        onStart={(ids, opts) => { setShowQSMPopup(false); void handleBuildQSM(ids, opts); }}
      />

      {/* Transform Panel - shows when a mesh is selected and the Transform button is toggled */}
      {showResizePanel && selectedMesh && (() => {
        const mesh = selectedMesh;
        const scale = meshScales.get(mesh.id) || { x: 1, y: 1, z: 1 };
        // A voxel-grid mesh is identified by carrying gridSubdivisions —
        // covers both "Create Voxel" boxes and grids imported from a Helios
        // <grid> block (whose synthetic sourceCloudId doesn't contain "voxel").
        const isVoxel = !!mesh.gridSubdivisions;
        const fit = isVoxel ? computeSelectedScansFitGrid() : null;
        return (
          <TransformPanel
            isShape={mesh.sourceCloudId.startsWith('shape-')}
            isVoxel={isVoxel}
            position={meshPositions.get(mesh.id) || { x: 0, y: 0, z: 0 }}
            rotation={meshRotations.get(mesh.id) || { x: 0, y: 0, z: 0 }}
            scale={scale}
            grid={mesh.gridSubdivisions || { x: 1, y: 1, z: 1 }}
            scaleLocked={scaleLocked}
            translateActive={editMode === 'translate'}
            rotateActive={editMode === 'rotate'}
            fitAvailable={!!fit}
            onClose={() => setShowResizePanel(false)}
            onScaleLockedChange={setScaleLocked}
            onToggleTranslate={() => setEditMode(editMode === 'translate' ? 'none' : 'translate')}
            onToggleRotate={() => setEditMode(editMode === 'rotate' ? 'none' : 'rotate')}
            onMoveToOrigin={handleMoveToOrigin}
            onFitToScans={() => {
              if (!fit) return;
              setMeshPositions(prev => new Map(prev).set(mesh.id, fit.center));
              setMeshScales(prev => new Map(prev).set(mesh.id, fit.size));
            }}
            onSetPosition={(axis, v) => setMeshPositions(prev => {
              const next = new Map(prev);
              next.set(mesh.id, { ...(next.get(mesh.id) || { x: 0, y: 0, z: 0 }), [axis]: v });
              return next;
            })}
            onResetPosition={() => setMeshPositions(prev => new Map(prev).set(mesh.id, { x: 0, y: 0, z: 0 }))}
            onSetRotation={(axis, v) => setMeshRotations(prev => {
              const next = new Map(prev);
              next.set(mesh.id, { ...(next.get(mesh.id) || { x: 0, y: 0, z: 0 }), [axis]: v });
              return next;
            })}
            onResetRotation={() => setMeshRotations(prev => new Map(prev).set(mesh.id, { x: 0, y: 0, z: 0 }))}
            onSetScale={(axis, v) => setMeshScales(prev => {
              const next = new Map(prev);
              next.set(mesh.id, scaleLocked ? { x: v, y: v, z: v } : { ...scale, [axis]: v });
              return next;
            })}
            onResetScale={() => setMeshScales(prev => new Map(prev).set(mesh.id, { x: 1, y: 1, z: 1 }))}
            onSetGrid={(axis, value) => {
              const v = Math.max(1, Math.floor(value));
              if (!Number.isFinite(v)) return;
              setMeshes(prev => prev.map(m => {
                if (m.id !== mesh.id) return m;
                const cur = m.gridSubdivisions || { x: 1, y: 1, z: 1 };
                return { ...m, gridSubdivisions: { ...cur, [axis]: v } };
              }));
            }}
            onResetGrid={() => setMeshes(prev => prev.map(m => m.id === mesh.id ? { ...m, gridSubdivisions: { x: 1, y: 1, z: 1 } } : m))}
          />
        );
      })()}

      {/* Translate Coordinates Panel - shown for clouds/skeletons. Meshes use the Transform panel instead. */}
      {editMode === 'translate' && !selectedMesh && (selectedSkeletonId || selectedIds.size > 0) && (() => {
        // Resolve current translation + display name from the active selection.
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
          objectName = clouds.find(c => c.id === firstCloudId)?.data.fileName || 'Point Cloud';
        }

        return (
          <TranslatePanel
            position={currentPos}
            objectName={objectName}
            onCoordChange={(axis, numValue) => {
              if (selectedSkeletonId) {
                setSkeletonPositions(prev => {
                  const next = new Map(prev);
                  const pos = next.get(selectedSkeletonId) || { x: 0, y: 0, z: 0 };
                  next.set(selectedSkeletonId, { ...pos, [axis]: numValue });
                  return next;
                });
              } else if (selectedIds.size > 0) {
                setEditStates(prev => {
                  const next = new Map(prev);
                  for (const cloudId of selectedIds) {
                    const state = next.get(cloudId) || { translation: { x: 0, y: 0, z: 0 }, erasedIndices: new Set<number>() };
                    next.set(cloudId, { ...state, translation: { ...state.translation, [axis]: numValue } });
                  }
                  return next;
                });
              }
            }}
            onReset={() => {
              if (selectedSkeletonId) {
                setSkeletonPositions(prev => new Map(prev).set(selectedSkeletonId, { x: 0, y: 0, z: 0 }));
              } else if (selectedIds.size > 0) {
                setEditStates(prev => {
                  const next = new Map(prev);
                  for (const cloudId of selectedIds) {
                    const state = next.get(cloudId);
                    if (state) next.set(cloudId, { ...state, translation: { x: 0, y: 0, z: 0 } });
                  }
                  return next;
                });
              }
            }}
            onClose={() => setEditMode('none')}
          />
        );
      })()}

      {/* Plant Growth Panel - shows when plant mesh is selected and growth panel is open */}
      {/* Positioned to the left of the main right panel to avoid overlap */}
      {showPlantGrowthPanel && selectedMesh?.isPlant && (
        <PlantGrowthPanel
          currentAge={selectedMesh.plantAge ?? 0}
          ageStep={ageStep}
          targetAge={targetAge}
          animationStartAge={animationStartAge}
          animationEndAge={animationEndAge}
          gifBackground={gifBackground}
          gifCameraView={gifCameraView}
          isAdvancingAge={isAdvancingAge}
          isAnimating={isAnimating}
          isGeneratingGif={isGeneratingGif}
          animationProgress={animationProgress}
          gifProgress={gifProgress}
          onClose={() => setShowPlantGrowthPanel(false)}
          onAdvanceAge={(delta) => handleAdvancePlantAge(selectedMesh.id, delta)}
          onAgeStepChange={setAgeStep}
          onTargetAgeChange={setTargetAge}
          onAnimationStartAgeChange={setAnimationStartAge}
          onAnimationEndAgeChange={setAnimationEndAge}
          onGifBackgroundChange={setGifBackground}
          onGifCameraViewChange={setGifCameraView}
          onStartAnimation={() => handleStartGrowthAnimation(selectedMesh.id)}
          onMakeGif={() => handleMakeGIF(selectedMesh.id)}
          onStopAnimation={handleStopGrowthAnimation}
          onStopMakeGif={handleStopMakeGIF}
        />
      )}

      {/* Alignment Results Panel */}
      {showAlignmentPanel && alignmentResults && (
        <AlignmentPanel
          results={alignmentResults}
          snapEnabled={selectionType === 'mixed'}
          isRunningICP={isRunningICP}
          onClose={() => setShowAlignmentPanel(false)}
          onSnapToFit={handleICPSnapToFit}
        />
      )}

      {/* Export modal - context-sensitive based on selection */}
      {showExportPanel && (
        <ExportModal
          selectionType={selectionType}
          singleCloudSelected={selectedIds.size === 1}
          cloudIsScan={selectedIds.size === 1 && !!clouds.find(c => c.id === Array.from(selectedIds)[0])?.params}
          cloudName={clouds.find(c => c.id === Array.from(selectedIds)[0])?.data.fileName || ''}
          // Available ASCII export columns, in default order. For a single
          // selected cloud, from that cloud; otherwise from a representative
          // selected scan (so the column picker works for multi-scan export too).
          cloudColumns={(() => {
            const ids = Array.from(selectedIds);
            const c = ids.length === 1
              ? clouds.find(c => c.id === ids[0])
              : clouds.find(c => selectedIds.has(c.id) && !!c.params)
                ?? clouds.find(c => !!c.params);
            if (!c) return [];
            return defaultExportColumns(c.data, {
              isLabel: (slug) => isCategoricalAttribute(slug),
              labelFor: (slug) => c.data.octree?.attributeLabels?.[slug] ?? slug,
              // Octree/session clouds keep their points (and scalar columns) on
              // disk, so recover the available columns from the ASCII_format hint.
              asciiFormat: c.data.octree?.asciiFormat ?? c.asciiFormat ?? null,
            });
          })()}
          // Every scan that carries scanner parameters (so it can be written as a
          // scan XML), with whether it currently holds misses and is selected. The
          // modal renders these as a checkbox list, pre-checked to the selection.
          scanExportList={clouds
            .filter(c => !!c.params)
            .map(c => {
              // Show the scan's user-configurable label (falling back to filename),
              // matching how the Scans panel names the row.
              const scan = scans.find(s => s.id === c.id);
              return {
                id: c.id,
                name: scan ? scanDisplayName(scan) : (c.data.fileName || c.id),
                hasMisses: !!(c.data.octree?.hasMisses || c.data.scalarFields?.[MISS_ATTRIBUTE]),
                selected: selectedIds.has(c.id),
              };
            })}
          // Scene voxel-box grids the user can add to a scan XML export (id +
          // label; geometry is resolved in exportScanXmlBundle via the same list).
          gridOptions={heliosGridOptions.map(g => ({ id: g.id, label: g.label }))}
          onExportScanXml={exportScanXmlBundle}
          meshSelected={!!selectedMesh}
          meshName={selectedMesh ? displayNameOfMesh(selectedMesh) : ''}
          meshTriangleCount={selectedMesh?.data.triangleCount ?? 0}
          isScanning={isScanning}
          skeletonSelected={!!selectedSkeleton}
          skeletonName={selectedSkeleton ? (clouds.find(c => c.id === selectedSkeleton.sourceCloudId)?.data.fileName || '') : ''}
          skeletonNodeCount={selectedSkeleton?.data.pointCount ?? 0}
          skeletonTotalLength={selectedSkeleton?.data.totalLength ?? 0}
          onClose={() => setShowExportPanel(false)}
          onExportCloud={exportPointCloud}
          onExportMesh={(format) => { if (selectedMesh) exportMesh(selectedMesh.id, format); }}
          onExportSkeleton={(format) => { if (selectedSkeleton) exportSkeleton(selectedSkeleton.id, format); }}
          onRunScan={() => handleRunScan()}
        />
      )}

      {/* Scalar overlay — categorical attributes (e.g. ground_class) show a
          discrete class legend; continuous scalars show the gradient colorbar.
          Both require `dataRange`, which is null unless a visible cloud
          actually carries the active field — so the overlay disappears when the
          segmented scan is deleted. */}
      {/* Colorbars / legends — point cloud, mesh, and LAD. Anchored bottom-
          right but in the `right-[280px]` gutter, i.e. just LEFT of the
          object-panel column (`top-4 right-4`, w-64 → occupies the rightmost
          ~260px). That column can grow all the way to the bottom of the
          window, so we clear it horizontally rather than vertically: the
          colorbar sits to its left no matter how tall the panels get. The
          296px offset is just past the lane the tool panels use (`right-
          [280px]`), leaving a small buffer so the panel column doesn't sit
          flush against the colorbar when it grows to the bottom. Laid out in
          one bottom-aligned flex row so any combination of colorbars coexists
          without overlapping each other. */}
      <div className="absolute bottom-4 right-[296px] z-20 flex flex-row items-end gap-3 pointer-events-none">
        {isScalarColorMode && colorMode === 'scalar' && selectedScalarField &&
         dataRange && categoricalSchemeForRange(selectedScalarField, [dataRange.min, dataRange.max]) ? (
          <div
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

        {/* Mesh pseudocolor colorbar — when a mesh is colored by
            inclination/azimuth/area. */}
        {activeMeshColorInfo && (
          <div
            data-testid="mesh-colorbar"
            data-colorbar-label={activeMeshColorInfo.label}
            data-colorbar-min={activeMeshColorInfo.min}
            data-colorbar-max={activeMeshColorInfo.max}
          >
            <Colorbar
              colormap={colormap}
              min={activeMeshColorInfo.min}
              max={activeMeshColorInfo.max}
              label={activeMeshColorInfo.label}
            />
          </div>
        )}

        {/* Source-scan legend — when a mesh is colored by scan. */}
        {activeMeshScanLegend && activeMeshScanLegend.length > 0 && (
          <div
            data-testid="mesh-scan-legend"
            data-scan-count={activeMeshScanLegend.length}
          >
            <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg px-2.5 py-2 border border-neutral-700/50 select-none max-w-[200px]">
              <div className="text-[10px] text-neutral-300 mb-1.5">Source scan</div>
              <div className="space-y-1 max-h-[200px] overflow-y-auto">
                {activeMeshScanLegend.map(entry => (
                  <div key={entry.index} className="flex items-center gap-2 text-[10px] text-neutral-300">
                    <span
                      className="w-3 h-3 rounded-sm border border-neutral-600 flex-shrink-0"
                      style={{ backgroundColor: entry.color }}
                    />
                    <span className="flex-1 truncate">Scan {entry.index + 1}</span>
                    <span className="text-neutral-500">{entry.count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Leaf area density colorbar — when an LAD result is visible. */}
        {activeLadInfo && (
          <div
            data-testid="lad-colorbar"
            data-colorbar-label="LAD"
            data-colorbar-min={activeLadInfo.min}
            data-colorbar-max={activeLadInfo.max}
          >
            <Colorbar
              colormap={colormap}
              min={activeLadInfo.min}
              max={activeLadInfo.max}
              label="LAD [m²/m³]"
            />
          </div>
        )}
      </div>

      {/* LAD voxel hover readout — the value of the cell under the cursor. */}
      {hoveredLadVoxel && (
        <div
          data-testid="lad-voxel-tooltip"
          className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-neutral-800/95 backdrop-blur-sm rounded-lg shadow-lg px-3 py-2 border border-neutral-700/50 pointer-events-none select-none text-[11px] text-neutral-200"
        >
          <span className="font-semibold">LAD {hoveredLadVoxel.lad.toFixed(3)} m²/m³</span>
          <span className="text-neutral-500"> · </span>
          G(θ) {hoveredLadVoxel.gtheta.toFixed(3)}
          <span className="text-neutral-500"> · </span>
          {hoveredLadVoxel.hitCount.toLocaleString()} hits
          <span className="text-neutral-500"> · </span>
          cell {hoveredLadVoxel.index}
        </div>
      )}

      {/* Display Settings Panel — z-[55] keeps it (and its minimize header)
          above the workflow side panels (scan/LAD/QSM, z-40/z-50), which can
          extend far enough down the right edge to otherwise occlude it. */}
      <div className="absolute bottom-4 right-4 z-[55] bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-48 overflow-hidden">
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
                <input type="range" min="0.5" max="10" step="0.5" value={pointSize} onChange={(e) => setPointSize(parseFloat(e.target.value))} className="flex-1 h-1 bg-neutral-700 rounded appearance-none cursor-pointer" />
                <button
                  onClick={() => setPointSize(prev => Math.min(prev + 0.5, 10))}
                  className="p-1 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
                  title="Increase Point Size"
                >
                  <Plus className="w-3 h-3 text-neutral-300" />
                </button>
              </div>
            </div>

            {/* Mesh Lighting — scene light intensity for lit meshes (plants,
                scanner models). Point clouds are unlit and unaffected. */}
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">Mesh Lighting: {lightIntensity.toFixed(2)}</label>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setLightIntensity(prev => Math.max(Math.round((prev - 0.05) * 100) / 100, 0))}
                  className="p-1 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
                  title="Decrease Mesh Lighting"
                >
                  <Minus className="w-3 h-3 text-neutral-300" />
                </button>
                <input
                  type="range"
                  data-testid="display-light-intensity"
                  min="0"
                  max="2"
                  step="0.05"
                  value={lightIntensity}
                  onChange={(e) => setLightIntensity(parseFloat(e.target.value))}
                  className="flex-1 h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
                />
                <button
                  onClick={() => setLightIntensity(prev => Math.min(Math.round((prev + 0.05) * 100) / 100, 2))}
                  className="p-1 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
                  title="Increase Mesh Lighting"
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
              <label className="flex items-center gap-2 text-neutral-300 cursor-pointer">
                <input data-testid="display-scan-markers" type="checkbox" checked={showScanMarkers} onChange={(e) => setShowScanMarkers(e.target.checked)} className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500" />
                Scan markers
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      {showQSMExportPanel && (
        <QSMExportPanel
          qsms={qsms.map(q => ({ id: q.id, label: qsmDisplayLabel(q), cylinderCount: q.cylinders.length }))}
          exporting={qsmExporting}
          onClose={() => setShowQSMExportPanel(false)}
          onExport={handleExportQSMs}
        />
      )}

      {deleteConfirm && (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-neutral-800 rounded-lg p-4 shadow-xl max-w-sm mx-4">
            <div className="text-sm font-medium text-neutral-200 mb-2" data-testid="delete-confirm-title">
              Delete {deleteConfirm.ids.length > 1 ? deleteConfirm.label : (deleteConfirm.type === 'qsm' ? 'QSM' : deleteConfirm.type)}?
            </div>
            <div className="text-xs text-neutral-400 mb-4">
              {deleteConfirm.ids.length > 1
                ? <>Are you sure you want to delete {deleteConfirm.label}? This action cannot be undone.</>
                : <>Are you sure you want to delete "{deleteConfirm.label}"? This action cannot be undone.</>}
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

      {/* Create Plane Popup */}
      <CreatePlanePopup
        isOpen={showPlanePopup}
        onClose={() => setShowPlanePopup(false)}
        onCreate={handleCreatePlane}
      />

      {/* Leaf Angle Distribution Popup */}
      {(() => {
        const lapMesh = showLeafAngleMeshId
          ? meshes.find(m => m.id === showLeafAngleMeshId) ?? null
          : null;
        return (
          <LeafAnglePlotPopup
            isOpen={lapMesh !== null}
            onClose={() => setShowLeafAngleMeshId(null)}
            mesh={lapMesh}
            meshName={lapMesh ? displayNameOfMesh(lapMesh) : ''}
          />
        );
      })()}

      {/* QSM detailed-results Popup */}
      {(() => {
        const rqsm = showQSMResultsId
          ? qsms.find(q => q.id === showQSMResultsId) ?? null
          : null;
        const name = rqsm
          ? (rqsm.sourceLabel || clouds.find(c => c.id === rqsm.sourceCloudId)?.data.fileName || 'QSM')
          : '';
        return (
          <QSMResultsPopup
            isOpen={rqsm !== null}
            onClose={() => setShowQSMResultsId(null)}
            qsm={rqsm}
            qsmName={name}
          />
        );
      })()}

      {/* Add Leaves to QSM (Phase-1 procedural leaf reconstruction) */}
      <AddLeavesPopup
        isOpen={addLeavesQSMId !== null}
        onClose={() => setAddLeavesQSMId(null)}
        qsm={addLeavesQSMId ? qsms.find(q => q.id === addLeavesQSMId) ?? null : null}
        onAddLeaves={handleAddLeaves}
      />

      {/* Adjust Leaf Angles to a measured distribution (Phase-2) */}
      <AdjustLeafAnglesPopup
        isOpen={adjustLeavesQSMId !== null}
        onClose={() => setAdjustLeavesQSMId(null)}
        qsm={adjustLeavesQSMId ? qsms.find(q => q.id === adjustLeavesQSMId) ?? null : null}
        meshes={meshes}
        onAdjust={handleAdjustLeafAngles}
        meshLabel={displayNameOfMesh}
      />

      {/* Leaf Area Density Popup. Pre-fill Lmax/aspect from the most-recently
          adjusted Helios triangulation mesh, so the inversion bakes in the
          filtering the user dialed in on the mesh (still editable here). */}
      <LADPopup
        isOpen={showLADPopup}
        onClose={() => setShowLADPopup(false)}
        scans={scans}
        gridOptions={heliosGridOptions}
        triangulationOptions={ladTriangulationOptions}
        ineligibleTriangulations={ineligibleLadTriangulations}
        onStartLAD={handleComputeLAD}
        initialSelectedIds={selectedScanIds}
        defaultLmax={[...meshes].reverse().find(m => m.triangleFilter)?.triangleFilter?.lmax}
        defaultMaxAspectRatio={[...meshes].reverse().find(m => m.triangleFilter)?.triangleFilter?.maxAspectRatio}
        onBackfill={(ids) => { void handleBackfillMisses(ids, /* showAfter */ false); }}
      />
      <BackfillMissesPopup
        isOpen={showBackfillPopup}
        onClose={() => setShowBackfillPopup(false)}
        scans={scans}
        initialSelectedIds={selectedIds}
        inProgress={isBackfillRunning}
        onStart={(ids, showAfter) => { void handleBackfillMisses(ids, showAfter); }}
      />

      {/* Multi-input tool dialogs — pick their own inputs, seeded from the
          current selection. Launched from the static Toolbar / Tools menu. */}
      <StitchDialog
        isOpen={showStitchDialog}
        onClose={() => setShowStitchDialog(false)}
        clouds={clouds.map(c => ({ id: c.id, label: scanDisplayName(scans.find(s => s.id === c.id)!), color: c.color, pointCount: c.data.pointCount }))}
        initialSelectedIds={selectedIds}
        onStitch={(ids) => { if (ids.length >= 2) onStitchClouds?.(ids); }}
      />
      <AlignDialog
        isOpen={showAlignDialog}
        onClose={() => setShowAlignDialog(false)}
        clouds={clouds.map(c => ({ id: c.id, label: scanDisplayName(scans.find(s => s.id === c.id)!), color: c.color, isOctree: !!c.data.octree }))}
        initialSelectedIds={selectedIds}
        isRunning={isRunningICP}
        onAlign={(targetId, sourceId) => { void handleCloudToCloudICP(targetId, sourceId); }}
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
            const nextColor = allocateScanColor(new Set(scans.map(s => s.color)));
            const id = crypto.randomUUID();
            onAddScan?.({
              id,
              label,
              visible: true,
              color: nextColor,
              params,
            });
          }
          setScanPopupState({ kind: 'closed' });
        }}
        onBulkImport={bulkImportScans}
      />

      {/* Synthetic Scan Options — shown after the user clicks "Run Synthetic
          LiDAR Scan" and the targets validate, before the scan runs. Picks
          per-run noise / misses / full-waveform tuning / crop-to-grid; the
          chosen options are remembered for next time. */}
      <SyntheticScanOptionsPopup
        isOpen={pendingScan !== null}
        onClose={() => setPendingScan(null)}
        onRun={(options, scannerIds) => { void handleScanOptionsRun(options, scannerIds); }}
        scanners={pendingScan?.activeScanners ?? []}
        initialSelectedIds={selectedScanIds}
        hasGeometry={(pendingScan?.targetMeshes.length ?? 0) > 0}
        gridAvailable={pendingGridAvailable}
      />

      <BulkImportProgress progress={bulkImportProgress} />
      <BulkImportProgress
        progress={duplicateProgress}
        title="Duplicating scan…"
        hint="Copying points in memory — no file is re-read"
      />

      {/* Overwrite / duplicate / cancel prompt when a scan already has point data (#3) */}
      {scanOverwriteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setScanOverwriteConfirm(null)}
          />
          <div className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-700">
              <Radio className="w-5 h-5 text-neutral-400" />
              <h2 className="text-base font-semibold text-white">Scanner already has point data</h2>
            </div>
            <div className="p-4 space-y-4">
              <p className="text-sm text-neutral-300">
                {scanOverwriteConfirm.count} of the scanners being used already
                {scanOverwriteConfirm.count === 1 ? ' has' : ' have'} point data
                (e.g. imported scans). How should the synthetic scan handle
                {scanOverwriteConfirm.count === 1 ? ' it' : ' them'}?
              </p>
              <div className="flex flex-col gap-2">
                <button
                  data-testid="scan-overwrite-duplicate"
                  onClick={() => {
                    const c = scanOverwriteConfirm;
                    setScanOverwriteConfirm(null);
                    void executeScan(c.targetMeshes, c.activeScanners, 'duplicate', c.options);
                  }}
                  className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white text-left"
                >
                  <div className="font-medium">Keep originals, add duplicates</div>
                  <div className="text-xs text-blue-100/80">Existing data is preserved; new scans hold the synthetic points.</div>
                </button>
                <button
                  data-testid="scan-overwrite-replace"
                  onClick={() => {
                    const c = scanOverwriteConfirm;
                    setScanOverwriteConfirm(null);
                    void executeScan(c.targetMeshes, c.activeScanners, 'overwrite', c.options);
                  }}
                  className="w-full px-3 py-2 bg-neutral-700 hover:bg-neutral-600 rounded text-sm text-white text-left"
                >
                  <div className="font-medium">Overwrite existing data</div>
                  <div className="text-xs text-neutral-400">Replaces the scanners' current point data with the synthetic scan.</div>
                </button>
                <button
                  data-testid="scan-overwrite-cancel"
                  onClick={() => setScanOverwriteConfirm(null)}
                  className="w-full px-3 py-2 bg-transparent hover:bg-neutral-700/50 rounded text-sm text-neutral-300 text-center"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
