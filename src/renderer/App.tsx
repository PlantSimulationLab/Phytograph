import { useState, useCallback, useRef, useEffect } from "react";
import { Box, FileUp, Bug, Lightbulb } from "lucide-react";
import * as THREE from 'three';
import { useDropzone } from "react-dropzone";
import { ToastContainer, showToast } from "./components/Toast";
import { BackendSplash } from "./components/BackendSplash";
import { BulkImportProgress, type BulkImportProgressState } from "./components/BulkImportProgress";
import PointCloudViewer, { type PointCloudData, type ImportRefs } from "./components/PointCloudViewer";
import type { Scan } from "./lib/scan";
import { scanParametersFromFile, type ScanParameters } from "./lib/scanParameters";
import { parsePointCloud, parsePointCloudFromPath, parseMesh, parseSkeleton, isMeshFile, isSkeletonFile, plyHasFaces, POINT_CLOUD_FORMATS, MESH_FORMATS, SKELETON_FORMATS } from "./lib/pointCloudParsers";
import { importTexturedMesh, deleteCloudSession, type MeshImportResponse } from "./utils/backendApi";
import { plantResponseToMeshData } from "./lib/plantMeshData";
import { PointCloudImportWizard, type WizardScanInput, type WizardResult } from "./components/PointCloudImportWizard";
import { registerCategoricalSlug } from "./lib/classification";
import { parseHeliosScanXml, HeliosXmlParseError } from "./lib/heliosScanXml";
import { resolveTargets } from "./lib/bulkActions";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { AboutDialog } from "./components/AboutDialog";
import type { FeedbackMode } from "./lib/feedback";

// Extensions that go through the backend's Potree 2.0 octree pipeline when
// we have a disk path. Every supported point-cloud format is here; only inputs
// without an on-disk path (Blob/test fixtures) fall back to the in-renderer
// flat-array parsers.
const OCTREE_DROP_EXTENSIONS = new Set(['xyz', 'txt', 'csv', 'pts', 'asc', 'ply', 'pcd', 'las', 'laz', 'e57']);
import logoImage from "./assets/logo.png";

type NavItem = 'viewer' | 'options';
type ImportType = 'auto' | 'pointcloud' | 'mesh' | 'skeleton' | 'scanxml';

// Optional overrides for an import. Menu-driven imports (which go through the
// native Electron dialog, not the renderer dropzone) pass the import type and
// resolved on-disk paths explicitly — synthetic Files built from dialog paths
// carry no webUtils path and there is no pendingImportTypeRef to read.
interface ImportOptions {
  importType?: ImportType;
  path?: string;       // single-file (handleFileUpload)
  paths?: (string | undefined)[]; // multi-file, parallel to files (handleMultipleFiles)
}

// Strip the directory and trailing extension from a file name for use as a
// default display label (e.g. "tree_scan.ply" → "tree_scan"). Falls back to the
// full name when there's no extension.
function baseNameForLabel(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// Predefined colors for scans (for labels/identification)
const SCAN_COLORS = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
];

function App() {
  const [activeNav, setActiveNav] = useState<NavItem>('viewer');
  const [scans, setScans] = useState<Scan[]>([]);
  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());
  // Progress shown over the viewer while an import (drag-drop or the
  // File → Import menu) is in flight. Reuses BulkImportProgress so every
  // import pathway shows the same spinner + bar + filename modal.
  const [importProgress, setImportProgress] = useState<BulkImportProgressState | null>(null);
  // null = closed; otherwise the open feedback dialog's mode.
  const [feedbackMode, setFeedbackMode] = useState<FeedbackMode | null>(null);
  // Whether the About dialog is open (opened from the app / Help menu).
  const [aboutOpen, setAboutOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const pendingImportTypeRef = useRef<ImportType>('auto');

  // Import refs from PointCloudViewer for mesh/skeleton imports
  const importRefsRef = useRef<ImportRefs | null>(null);
  const handleImportRefsCallback = useCallback((refs: ImportRefs) => {
    importRefsRef.current = refs;
  }, []);

  // Whether the viewer holds non-scan content (meshes/skeletons). Generated
  // plants are meshes, so this — not just scans — must gate the empty-state hint.
  const [viewerHasContent, setViewerHasContent] = useState(false);

  // Count of clouds with unbaked deletions (session in-RAM mask not yet baked).
  // Held in a ref so the beforeunload handler reads the latest value without
  // re-binding the listener on every change.
  const pendingDeletesRef = useRef(0);
  const handlePendingDeletesChange = useCallback((count: number) => {
    pendingDeletesRef.current = count;
  }, []);

  // Warn before quit when deletions are unbaked — closing discards them (they
  // live only in the backend session's in-RAM mask until "Permanently apply").
  // Suppressed under automation (navigator.webdriver) so the E2E harness's
  // app.close() isn't blocked by a native dialog it can't dismiss.
  useEffect(() => {
    if (navigator.webdriver) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingDeletesRef.current > 0) {
        e.preventDefault();
        e.returnValue = '';  // triggers the native confirm
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Stitch history for undo. We snapshot the full Scan objects (including any
  // params) so undo restores the original scans exactly as they were.
  interface StitchHistoryEntry {
    originalScans: Scan[];
    stitchedScanId: string;
  }
  const stitchHistoryRef = useRef<StitchHistoryEntry[]>([]);

  // Auto-select the current value when any numeric input gains focus so
  // the user can type to replace it. Paired with the
  // `input[type="number"]` spinner-removal CSS in App.css.
  //
  // A capture-phase document listener covers every input mounted anywhere
  // in the tree (raw `<input type="number">` plus DebouncedNumberInput,
  // which renders as text+inputMode=decimal). select() runs on the next
  // task to win the race against the click that triggered the focus —
  // calling it synchronously inside focusin lets WebKit's click handler
  // collapse the selection afterwards.
  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      const t = target.type;
      const isNumeric =
        t === 'number' ||
        (t === 'text' && target.inputMode === 'decimal');
      if (!isNumeric) return;
      setTimeout(() => {
        if (document.activeElement === target) target.select();
      }, 0);
    };
    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, []);

  // Get next available color (skips colors currently used by existing scans).
  const getNextColor = useCallback(() => {
    const usedColors = new Set(scans.map(s => s.color));
    return SCAN_COLORS.find(c => !usedColors.has(c)) || SCAN_COLORS[scans.length % SCAN_COLORS.length];
  }, [scans]);

  // Import wizard: shown for every point-cloud import that has an on-disk path.
  // We model it imperatively — openImportWizard returns a promise that resolves
  // with the user's per-scan choices (WizardResult[]) on Import, or null on
  // Cancel. The resolver is stashed in a ref so the modal's callbacks can settle
  // the promise. Meshes/skeletons never go through here.
  const [wizardInputs, setWizardInputs] = useState<WizardScanInput[] | null>(null);
  const wizardResolveRef = useRef<((r: WizardResult[] | null) => void) | null>(null);
  const openImportWizard = useCallback((inputs: WizardScanInput[]): Promise<WizardResult[] | null> => {
    return new Promise((resolve) => {
      wizardResolveRef.current = resolve;
      setWizardInputs(inputs);
    });
  }, []);
  const settleWizard = useCallback((results: WizardResult[] | null) => {
    setWizardInputs(null);
    const resolve = wizardResolveRef.current;
    wizardResolveRef.current = null;
    resolve?.(results);
  }, []);

  // Build a Scan from a finished wizard result: run the real import with the
  // chosen column plan, register any categorical slugs, and return the Scan.
  // Shared by the single-file, multi-file, and XML import paths.
  const buildScanFromWizardResult = useCallback(async (
    result: WizardResult,
    color: string,
  ): Promise<Scan> => {
    const { input, asciiFormat, columnPlan, categoricalSlugs } = result;
    const data = await parsePointCloudFromPath(
      input.path, asciiFormat, columnPlan, categoricalSlugs,
    );
    for (const slug of categoricalSlugs) registerCategoricalSlug(slug);
    // Scan params precedence: an explicit XML <scan> (input.params) wins; else,
    // if the file itself carried scan-pattern metadata (E57 pose + angular sweep
    // + grid, or a PCD VIEWPOINT origin), auto-populate from it so a lone-file
    // import creates a Scan with as much of ScanParameters filled as the format
    // recorded — fields the file omitted stay at their default. Plain formats
    // (XYZ/LAS/PLY/...) carry nothing, so params stays undefined as before.
    const fileScanParams = data.octree?.scanParams ?? null;
    const params = input.params
      ?? (fileScanParams ? scanParametersFromFile(fileScanParams) : undefined);
    return {
      id: crypto.randomUUID(),
      label: input.label ?? data.fileName ?? 'Scan',
      visible: true,
      color: input.color ?? color,
      data,
      params,
      sourcePath: input.path,
      asciiFormat,
    };
  }, []);

  // Import a Helios scan XML (scans + grids) from disk, routing into the same
  // bulk-import flow the Add-Scan popup uses (PointCloudViewer owns the progress
  // modal + success/failure toasts). Needs the on-disk `path` so the XML's
  // relative <filename> references can be resolved; a path-less Blob/fixture
  // can't be resolved, so we surface a clear error instead of importing scans
  // that would all fail file resolution.
  const importScanXml = useCallback(async (file: File, path: string | undefined) => {
    if (!importRefsRef.current) {
      showToast({ title: 'Viewer not ready for scan XML import', type: 'error' });
      return;
    }
    if (!path) {
      showToast({
        title: `Can't import ${file.name}: no file path available. Scan XML must be ` +
          `opened from disk so its referenced point-cloud files can be located.`,
        type: 'error',
        duration: 0,
      });
      return;
    }
    // Parse first so XML errors surface clearly (the popup shows them inline; we
    // have no popup, so toast a persistent error). Mirrors ScanParametersPopup.
    let parsed;
    try {
      const text = await window.electronAPI.fs.readText(path);
      parsed = parseHeliosScanXml(text);
    } catch (err) {
      const msg = err instanceof HeliosXmlParseError
        ? err.message
        : err instanceof Error ? err.message : String(err);
      showToast({ title: `Import failed: ${msg}`, type: 'error', duration: 0 });
      return;
    }
    // Clear App's progress modal before handing off — bulkImportScans drives its
    // own (the same BulkImportProgress component), so they'd otherwise stack.
    setImportProgress(null);
    setActiveNav('viewer');
    await importRefsRef.current.bulkImportScans(parsed.scans, parsed.grids, path);
  }, []);

  const handleFileUpload = useCallback(async (file: File, opts?: ImportOptions) => {
    setImportProgress({ current: 1, total: 1, label: `Loading ${file.name}` });

    const importType = opts?.importType ?? pendingImportTypeRef.current;
    // Menu-driven imports pass the on-disk path explicitly (resolved by the
    // native dialog) since synthetic Files have no webUtils path.
    const explicitPath = opts?.path;

    try {
      // Helios scan XML short-circuit: a forced 'scanxml' import, or an
      // auto-detected `.xml`, routes into the shared bulk-import flow (which
      // owns its own progress modal + toasts) rather than the cloud/mesh/skeleton
      // parsers. Get the on-disk path from the explicit dialog path or the
      // dropped File's webUtils path.
      const xmlExt = file.name.toLowerCase().split('.').pop() ?? '';
      if (importType === 'scanxml' || (importType === 'auto' && xmlExt === 'xml')) {
        setImportProgress(null);
        let xmlPath: string | undefined = explicitPath;
        if (!xmlPath) {
          try { xmlPath = window.electronAPI?.getPathForFile?.(file) || undefined; }
          catch { xmlPath = undefined; }
        }
        await importScanXml(file, xmlPath);
        return; // handled — the finally{} below still resets pendingImportTypeRef
      }

      // Determine how to import based on user selection or auto-detect
      let shouldImportAsMesh = false;
      let shouldImportAsSkeleton = false;

      if (importType === 'mesh') {
        shouldImportAsMesh = true;
      } else if (importType === 'skeleton') {
        shouldImportAsSkeleton = true;
      } else if (importType === 'pointcloud') {
        // fall through to point cloud import (the implicit else branch below)
      } else {
        // Auto-detect based on file extension
        if (isMeshFile(file.name)) {
          shouldImportAsMesh = true;
        } else if (isSkeletonFile(file.name)) {
          shouldImportAsSkeleton = true;
        } else if (file.name.toLowerCase().endsWith('.ply') && (await plyHasFaces(file))) {
          // PLY is an ambiguous container: faces ⇒ polygon mesh, otherwise a
          // point cloud. Only a face-bearing PLY routes to the mesh path.
          shouldImportAsMesh = true;
        } else {
          // fall through to point cloud import
        }
      }

      if (shouldImportAsMesh) {
        if (!importRefsRef.current) {
          showToast({ title: 'Viewer not ready for mesh import', type: 'error' });
        } else {
          // When we have an on-disk path, prefer the backend importer. For OBJ it
          // parses the sibling MTL + texture images and returns real UVs + base64
          // textures; for PLY (which has no MTL/textures) it reads ASCII *and*
          // binary geometry + per-vertex color. Fall back to the in-renderer
          // parser when there's no path, the format isn't backend-handled, or the
          // backend import fails / yields nothing usable.
          const ext = file.name.toLowerCase().split('.').pop() ?? '';
          let objPath: string | undefined = explicitPath;
          if (!objPath) {
            try {
              objPath = window.electronAPI?.getPathForFile?.(file) || undefined;
            } catch {
              objPath = undefined;
            }
          }

          let backendMesh: MeshImportResponse | null = null;
          // True when the backend importer was attempted for a materials-capable
          // file (OBJ/PLY with a disk path) but threw, so the local fallback
          // below will produce geometry without the embedded materials.
          let materialsDropped = false;
          if ((ext === 'obj' || ext === 'ply') && objPath) {
            try {
              const resp = await importTexturedMesh(objPath);
              // The backend is the only path that applies a mesh's embedded
              // materials: MTL `Kd` → per-vertex colors and textures for OBJ,
              // and per-vertex color + binary support for PLY. The local
              // parser ignores the MTL entirely, so prefer the backend result
              // whenever it succeeds; fall back locally only on error.
              if (resp.success) backendMesh = resp;
            } catch (e) {
              console.warn('Backend mesh import failed, falling back to local parse:', e);
              materialsDropped = true;
            }
          }

          if (backendMesh) {
            const { data, plantMaterials } = plantResponseToMeshData(backendMesh);
            importRefsRef.current.importMesh({
              sourceCloudId: 'imported',
              data,
              plantMaterials,
              visible: true,
              color: getNextColor(),
              method: 'delaunay',
              name: baseNameForLabel(file.name),
            });
            setActiveNav('viewer');
            const texturedLabel = backendMesh.has_textures ? 'textured mesh' : 'mesh';
            showToast({ title: `Loaded ${texturedLabel} with ${backendMesh.triangle_count.toLocaleString()} triangles from ${file.name}`, type: 'success' });
          } else {
            const meshData = await parseMesh(file);
            importRefsRef.current.importMesh({
              sourceCloudId: 'imported',
              data: {
                vertices: meshData.vertices,
                indices: meshData.indices,
                normals: meshData.normals,
                vertexColors: meshData.vertexColors,
                vertexCount: meshData.vertexCount,
                triangleCount: meshData.triangleCount,
              },
              visible: true,
              color: getNextColor(),
              method: 'delaunay', // Default for imported meshes
              name: baseNameForLabel(file.name),
            });
            setActiveNav('viewer');
            if (materialsDropped) {
              showToast({
                title: `Imported geometry from ${file.name}, but couldn't load its materials — the backend was unavailable. Re-import to apply colors/textures.`,
                type: 'warning',
                duration: 0,
              });
            } else {
              showToast({ title: `Loaded mesh with ${meshData.triangleCount.toLocaleString()} triangles from ${file.name}`, type: 'success' });
            }
          }
        }
      } else if (shouldImportAsSkeleton) {
        // Parse as skeleton
        const skeletonData = await parseSkeleton(file);
        if (importRefsRef.current) {
          importRefsRef.current.importSkeleton({
            sourceCloudId: 'imported',
            data: {
              points: skeletonData.points,
              edges: skeletonData.edges,
              branchOrders: skeletonData.branchOrders,
              maxBranchOrder: skeletonData.maxBranchOrder,
              diameters: null,
              pointCount: skeletonData.pointCount,
              totalLength: skeletonData.totalLength,
            },
            visible: true,
            color: getNextColor(),
          });
          setActiveNav('viewer');
          showToast({ title: `Loaded skeleton with ${skeletonData.pointCount.toLocaleString()} nodes from ${file.name}`, type: 'success' });
        } else {
          showToast({ title: 'Viewer not ready for skeleton import', type: 'error' });
        }
      } else {
        // Parse as point cloud (default). We record the on-disk source path
        // when the file came from a native dialog/dropzone so the backend can
        // read it directly (and so the import wizard can preview it).
        let sourcePath: string | undefined = explicitPath;
        if (!sourcePath) {
          try {
            sourcePath = window.electronAPI?.getPathForFile?.(file) || undefined;
          } catch {
            sourcePath = undefined;
          }
        }

        const ext = file.name.toLowerCase().split('.').pop() ?? '';
        if (sourcePath && OCTREE_DROP_EXTENSIONS.has(ext)) {
          // Path-backed: walk the user through the import wizard (preview +
          // column mapping), then run the real import with their choices. Clear
          // the progress modal first so it doesn't sit behind the wizard.
          setImportProgress(null);
          const results = await openImportWizard([{ path: sourcePath, fileName: file.name }]);
          if (!results || results.length === 0) return; // user cancelled
          setImportProgress({ current: 1, total: 1, label: `Loading ${file.name}` });
          const newScan = await buildScanFromWizardResult(results[0], getNextColor());
          setScans(prev => [...prev, newScan]);
          setSelectedScanIds(new Set([newScan.id]));
          setActiveNav('viewer');
          showToast({ title: `Loaded ${newScan.data!.pointCount.toLocaleString()} points from ${file.name}`, type: 'success' });
        } else {
          // No on-disk path (Blob/test fixture): the wizard can't preview, so
          // fall back to the in-renderer flat parser with auto-detection.
          const data = await parsePointCloud(file);
          const newScan: Scan = {
            id: crypto.randomUUID(),
            label: data.fileName ?? 'Scan',
            visible: true,
            color: getNextColor(),
            data,
            sourcePath,
          };
          setScans(prev => [...prev, newScan]);
          setSelectedScanIds(new Set([newScan.id]));
          setActiveNav('viewer');
          showToast({ title: `Loaded ${data.pointCount.toLocaleString()} points from ${file.name}`, type: 'success' });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse file';
      showToast({ title: message, type: 'error' });
    } finally {
      setImportProgress(null);
      // Reset import type to auto after import
      pendingImportTypeRef.current = 'auto';
    }
  }, [getNextColor, openImportWizard, buildScanFromWizardResult, importScanXml]);

  // Handle multiple files
  const handleMultipleFiles = useCallback(async (files: File[], opts?: ImportOptions) => {
    setImportProgress({ current: 0, total: files.length, label: 'Preparing…' });
    const newScans: Scan[] = [];
    const errors: string[] = [];
    // Names of OBJ/PLY files whose embedded materials were dropped because the
    // backend importer threw and the local fallback (geometry only) was used.
    const materialsDroppedFiles: string[] = [];
    let meshCount = 0;
    let skeletonCount = 0;
    let colorIndex = 0;

    const importType = opts?.importType ?? pendingImportTypeRef.current;
    // Menu-driven imports supply on-disk paths parallel to `files` (resolved by
    // the native dialog); synthetic Files have no webUtils path otherwise.
    const explicitPaths = opts?.paths;

    const getColorForFile = () => {
      const usedColors = new Set([...scans.map(s => s.color), ...newScans.map(e => e.color)]);
      // Skip colors that are already used
      while (usedColors.has(SCAN_COLORS[colorIndex % SCAN_COLORS.length]) && colorIndex < SCAN_COLORS.length * 2) {
        colorIndex++;
      }
      const color = SCAN_COLORS[colorIndex % SCAN_COLORS.length];
      colorIndex++;
      return color;
    };

    // Point-cloud files with an on-disk path are collected and run through the
    // wizard together (one stepper) AFTER mesh/skeleton files import inline.
    const wizardFiles: WizardScanInput[] = [];

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx];
      setImportProgress({ current: fileIdx + 1, total: files.length, label: `Loading ${file.name}` });
      try {
        // Helios scan XML (forced 'scanxml' or auto-detected `.xml`) is imported
        // immediately via the shared bulk-import flow, which owns its own progress
        // modal + toasts and is NOT counted in this loop's tally. A mixed drop
        // (XML + clouds) therefore shows two sequential wizards — PointCloudViewer's
        // for the XML's referenced clouds, then App's for the loose clouds below.
        const xmlExt = file.name.toLowerCase().split('.').pop() ?? '';
        if (importType === 'scanxml' || (importType === 'auto' && xmlExt === 'xml')) {
          setImportProgress(null); // hand the modal off to bulkImportScans
          let xmlPath: string | undefined = explicitPaths?.[fileIdx];
          if (!xmlPath) {
            try { xmlPath = window.electronAPI?.getPathForFile?.(file) || undefined; }
            catch { xmlPath = undefined; }
          }
          await importScanXml(file, xmlPath);
          continue;
        }

        // Determine how to import based on user selection or auto-detect
        let shouldImportAsMesh = false;
        let shouldImportAsSkeleton = false;

        if (importType === 'mesh') {
          shouldImportAsMesh = true;
        } else if (importType === 'skeleton') {
          shouldImportAsSkeleton = true;
        } else if (importType === 'pointcloud') {
          // Force point cloud
        } else {
          // Auto-detect
          if (isMeshFile(file.name)) {
            shouldImportAsMesh = true;
          } else if (isSkeletonFile(file.name)) {
            shouldImportAsSkeleton = true;
          } else if (file.name.toLowerCase().endsWith('.ply') && (await plyHasFaces(file))) {
            // Face-bearing PLY ⇒ polygon mesh; vertices-only PLY stays a cloud.
            shouldImportAsMesh = true;
          }
        }

        if (shouldImportAsMesh) {
          // Path-backed PLY/OBJ prefer the backend importer (binary PLY + per-vertex
          // color for PLY; MTL/textures for OBJ); everything else parses locally.
          const ext = file.name.toLowerCase().split('.').pop() ?? '';
          let meshPath: string | undefined = explicitPaths?.[fileIdx];
          if (!meshPath) {
            try {
              meshPath = window.electronAPI?.getPathForFile?.(file) || undefined;
            } catch {
              meshPath = undefined;
            }
          }

          let backendMesh: MeshImportResponse | null = null;
          if ((ext === 'obj' || ext === 'ply') && meshPath) {
            try {
              const resp = await importTexturedMesh(meshPath);
              // Prefer the backend result whenever it succeeds — it's the only
              // path that applies embedded materials (MTL Kd → per-vertex
              // colors, textures, binary PLY). Local parse is the fallback.
              if (resp.success) backendMesh = resp;
            } catch (e) {
              console.warn('Backend mesh import failed, falling back to local parse:', e);
              materialsDroppedFiles.push(file.name);
            }
          }

          if (backendMesh && importRefsRef.current) {
            const { data, plantMaterials } = plantResponseToMeshData(backendMesh);
            importRefsRef.current.importMesh({
              sourceCloudId: 'imported',
              data,
              plantMaterials,
              visible: true,
              color: getColorForFile(),
              method: 'delaunay',
              name: baseNameForLabel(file.name),
            });
            meshCount++;
          } else {
            const meshData = await parseMesh(file);
            if (importRefsRef.current) {
              importRefsRef.current.importMesh({
                sourceCloudId: 'imported',
                data: {
                  vertices: meshData.vertices,
                  indices: meshData.indices,
                  normals: meshData.normals,
                  vertexColors: meshData.vertexColors,
                  vertexCount: meshData.vertexCount,
                  triangleCount: meshData.triangleCount,
                },
                visible: true,
                color: getColorForFile(),
                method: 'delaunay',
                name: baseNameForLabel(file.name),
              });
              meshCount++;
            }
          }
        } else if (shouldImportAsSkeleton) {
          // Parse as skeleton
          const skeletonData = await parseSkeleton(file);
          if (importRefsRef.current) {
            importRefsRef.current.importSkeleton({
              sourceCloudId: 'imported',
              data: {
                points: skeletonData.points,
                edges: skeletonData.edges,
                branchOrders: skeletonData.branchOrders,
                maxBranchOrder: skeletonData.maxBranchOrder,
                diameters: null,
                pointCount: skeletonData.pointCount,
                totalLength: skeletonData.totalLength,
              },
              visible: true,
              color: getColorForFile(),
            });
            skeletonCount++;
          }
        } else {
          // Point cloud. Resolve the on-disk path; path-backed files go to the
          // wizard (collected below), path-less Blobs/fixtures fall back to the
          // in-renderer flat parser (the wizard can't preview without a path).
          let sourcePath: string | undefined = explicitPaths?.[fileIdx];
          if (!sourcePath) {
            try {
              sourcePath = window.electronAPI?.getPathForFile?.(file) || undefined;
            } catch {
              sourcePath = undefined;
            }
          }
          const ext = file.name.toLowerCase().split('.').pop() ?? '';
          if (sourcePath && OCTREE_DROP_EXTENSIONS.has(ext)) {
            wizardFiles.push({ path: sourcePath, fileName: file.name });
          } else {
            const data = await parsePointCloud(file);
            newScans.push({
              id: crypto.randomUUID(),
              label: data.fileName ?? 'Scan',
              visible: true,
              color: getColorForFile(),
              data,
              sourcePath,
            });
          }
        }
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : 'Failed to parse'}`);
      }
    }

    // Walk path-backed point clouds through the wizard, then import each with
    // the user's choices. Clear the progress modal so it doesn't sit behind the
    // wizard; re-show per-scan during the actual import.
    if (wizardFiles.length > 0) {
      setImportProgress(null);
      const results = await openImportWizard(wizardFiles);
      if (results) {
        for (let i = 0; i < results.length; i++) {
          setImportProgress({ current: i + 1, total: results.length, label: `Loading ${results[i].input.fileName}` });
          try {
            newScans.push(await buildScanFromWizardResult(results[i], getColorForFile()));
          } catch (err) {
            errors.push(`${results[i].input.fileName}: ${err instanceof Error ? err.message : 'Failed to import'}`);
          }
        }
      }
    }

    if (newScans.length > 0) {
      setScans(prev => [...prev, ...newScans]);
      setSelectedScanIds(new Set(newScans.map(e => e.id)));
    }

    const loadedCount = newScans.length + meshCount + skeletonCount;
    if (loadedCount > 0) {
      setActiveNav('viewer');
      const parts = [];
      if (newScans.length > 0) parts.push(`${newScans.length} scan(s)`);
      if (meshCount > 0) parts.push(`${meshCount} mesh(es)`);
      if (skeletonCount > 0) parts.push(`${skeletonCount} skeleton(s)`);
      showToast({ title: `Loaded ${parts.join(', ')}`, type: 'success' });
    }

    if (materialsDroppedFiles.length > 0) {
      // The geometry imported, but the backend (the only path that reads MTL
      // colors/textures and per-vertex PLY color) was unavailable, so these
      // came in without their materials. Warn so the user knows to re-import.
      showToast({
        title: `Imported ${materialsDroppedFiles.length} mesh(es) without materials — the backend was unavailable. Re-import to apply colors/textures.`,
        message: materialsDroppedFiles.join('\n'),
        type: 'warning',
        duration: 0,
      });
    }

    if (errors.length > 0) {
      // Surface the actual per-file reasons, not just a count. Each entry is
      // `filename: reason` (the reason is the backend's error detail). The
      // toast body is selectable + copyable and error toasts persist, so the
      // user can read why each file failed and act on it (e.g. re-run those
      // files with a column format that matches their layout).
      showToast({
        title: `Failed to load ${errors.length} file(s)`,
        message: errors.join('\n'),
        type: 'error',
      });
    }

    setImportProgress(null);
    // Reset import type to auto after import
    pendingImportTypeRef.current = 'auto';
  }, [scans, openImportWizard, buildScanFromWizardResult, importScanXml]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setIsDragOver(false);
    // Drops always auto-detect. Pass it explicitly rather than trusting the
    // ref: menu imports no longer touch pendingImportTypeRef, but a cancelled
    // import in older flows could leave it stale, which previously routed a
    // dropped .ply through the wrong parser ("Unsupported skeleton format").
    if (acceptedFiles.length === 1) {
      handleFileUpload(acceptedFiles[0], { importType: 'auto' });
    } else if (acceptedFiles.length > 1) {
      handleMultipleFiles(acceptedFiles, { importType: 'auto' });
    }
  }, [handleFileUpload, handleMultipleFiles]);

  const { getRootProps, getInputProps } = useDropzone({
    onDrop,
    onDragEnter: () => setIsDragOver(true),
    onDragLeave: () => setIsDragOver(false),
    noClick: true,
    noKeyboard: true,
    multiple: true, // Allow multiple files
  });

  const handleRemoveScan = useCallback((id: string) => {
    setScans(prev => {
      // Free the cloud's backend session (release its in-RAM array) when it's
      // removed from the scene. Best-effort — deleteCloudSession never throws.
      const removed = prev.find(s => s.id === id);
      const sessionId = removed?.data?.octree?.sessionId;
      if (sessionId) void deleteCloudSession(sessionId);
      return prev.filter(s => s.id !== id);
    });
    setSelectedScanIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleToggleScanVisibility = useCallback((id: string) => {
    setScans(prev => prev.map(s =>
      s.id === id ? { ...s, visible: !s.visible } : s
    ));
  }, []);

  // Bulk show/hide for the Scans panel header. Acts on the current selection
  // when one exists, otherwise on every scan. A single press lands on a uniform
  // state: hide all targets if any is visible, else show all. See resolveTargets.
  const handleToggleScansVisibility = useCallback(() => {
    const { targetIds, nextVisible } = resolveTargets(scans, selectedScanIds);
    const target = new Set(targetIds);
    setScans(prev => prev.map(s => target.has(s.id) ? { ...s, visible: nextVisible } : s));
  }, [scans, selectedScanIds]);

  // Force a scan hidden (idempotent). Used after a QSM build so the source
  // scan's points don't obscure the newly created QSM.
  const handleHideScan = useCallback((id: string) => {
    setScans(prev => prev.map(s =>
      s.id === id ? { ...s, visible: false } : s
    ));
  }, []);

  // Toggle the sky/miss overlay for a scan. Misses are hidden by default; this
  // lets the user reveal them (in a distinct colour, on the bounding sphere) to
  // verify a scan actually carries miss information for the LAD inversion.
  const handleToggleScanMisses = useCallback((id: string) => {
    setScans(prev => prev.map(s =>
      s.id === id ? { ...s, showMisses: !s.showMisses } : s
    ));
  }, []);

  // Anchor for shift+click range selection — the last scan that was clicked
  // without shift (a plain click or a ctrl/cmd toggle). Shift+click selects
  // everything between this anchor and the clicked scan, in list order.
  const lastSelectedScanIdRef = useRef<string | null>(null);

  const handleToggleScanSelection = useCallback((id: string, additive: boolean, range: boolean, allowDeselect: boolean = true) => {
    if (range && lastSelectedScanIdRef.current) {
      const anchorId = lastSelectedScanIdRef.current;
      const ids = scans.map(s => s.id);
      const anchorIdx = ids.indexOf(anchorId);
      const clickedIdx = ids.indexOf(id);
      if (anchorIdx !== -1 && clickedIdx !== -1) {
        const [lo, hi] = anchorIdx < clickedIdx ? [anchorIdx, clickedIdx] : [clickedIdx, anchorIdx];
        const rangeIds = ids.slice(lo, hi + 1);
        // Additive shift (shift+ctrl/cmd) extends the current selection;
        // plain shift replaces it with just the range.
        setSelectedScanIds(prev => new Set(additive ? [...prev, ...rangeIds] : rangeIds));
        // Anchor stays put so the range can be re-dragged from the same origin.
        return;
      }
    }

    lastSelectedScanIdRef.current = id;
    setSelectedScanIds(prev => {
      // Plain click on the row that is *already the sole selection* toggles it
      // off — clicking a scan a second time deselects it. Clicking a different
      // row replaces the selection. Ctrl/cmd-click adds/removes from the set.
      // allowDeselect is false in mixed mode (a mesh/skeleton is also selected):
      // there the click should refocus this scan and let the mesh-clear effect
      // run, rather than emptying the selection.
      const isSoleSelection = !additive && allowDeselect && prev.size === 1 && prev.has(id);
      if (isSoleSelection) {
        return new Set();
      }
      const next = new Set(additive ? prev : []);
      if (prev.has(id) && additive) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, [scans]);

  const handleSelectAll = useCallback(() => {
    setSelectedScanIds(new Set(scans.map(s => s.id)));
  }, [scans]);

  const handleDeselectAll = useCallback(() => {
    setSelectedScanIds(new Set());
  }, []);

  const handleUpdateScanData = useCallback((id: string, data: PointCloudData) => {
    // Replacing the in-RAM data makes any prior `sourcePath` stale: it points at
    // the file the OLD data came from, not the new `data`. Downstream ops
    // (triangulate, LAD) prefer `file_path` and would silently re-read that
    // stale file — e.g. a synthetic scan overwriting a coarse imported cloud
    // would still triangulate the coarse on-disk points. The new `data` is the
    // source of truth, so drop the path (and its column hint) and let consumers
    // send points in-RAM.
    setScans(prev => prev.map(s =>
      s.id === id ? { ...s, data, sourcePath: undefined, asciiFormat: undefined } : s
    ));
  }, []);

  const handleUpdateScanParams = useCallback((id: string, params: ScanParameters | undefined) => {
    setScans(prev => prev.map(s =>
      s.id === id ? { ...s, params } : s
    ));
  }, []);

  const handleUpdateScanLabel = useCallback((id: string, label: string) => {
    setScans(prev => prev.map(s =>
      s.id === id ? { ...s, label } : s
    ));
  }, []);

  const handleUpdateScanColor = useCallback((id: string, color: string) => {
    setScans(prev => prev.map(s =>
      s.id === id ? { ...s, color } : s
    ));
  }, []);

  const handleAddScan = useCallback((scan: Scan) => {
    setScans(prev => [...prev, scan]);
    setSelectedScanIds(new Set([scan.id]));
  }, []);

  const handleAddScans = useCallback((newOnes: Scan[]) => {
    if (newOnes.length === 0) return;
    setScans(prev => [...prev, ...newOnes]);
    setSelectedScanIds(new Set(newOnes.map(s => s.id)));
  }, []);

  // Stitch multiple data-bearing scans into one. The result is data-only —
  // a merged cloud has no single defined origin, so any source params are
  // dropped. Undo restores the originals (params included) from the snapshot.
  const handleStitchScans = useCallback((ids: string[]) => {
    if (ids.length < 2) return;

    const scansToStitch = scans.filter(s => ids.includes(s.id) && s.data);
    if (scansToStitch.length < 2) return;

    const totalPoints = scansToStitch.reduce((sum, s) => sum + (s.data?.pointCount ?? 0), 0);

    const hasColors = scansToStitch.some(s => s.data!.colors);
    const hasIntensities = scansToStitch.some(s => s.data!.intensities);

    const positions = new Float32Array(totalPoints * 3);
    const colors = hasColors ? new Float32Array(totalPoints * 3) : undefined;
    const intensities = hasIntensities ? new Float32Array(totalPoints) : undefined;

    let offset = 0;
    for (const scan of scansToStitch) {
      const data = scan.data!;
      positions.set(data.positions, offset * 3);

      if (colors) {
        if (data.colors) {
          colors.set(data.colors, offset * 3);
        } else {
          for (let i = 0; i < data.pointCount; i++) {
            colors[(offset + i) * 3] = 1;
            colors[(offset + i) * 3 + 1] = 1;
            colors[(offset + i) * 3 + 2] = 1;
          }
        }
      }

      if (intensities) {
        if (data.intensities) {
          intensities.set(data.intensities, offset);
        } else {
          for (let i = 0; i < data.pointCount; i++) {
            intensities[offset + i] = 1;
          }
        }
      }

      offset += data.pointCount;
    }

    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < totalPoints; i++) {
      min.x = Math.min(min.x, positions[i * 3]);
      min.y = Math.min(min.y, positions[i * 3 + 1]);
      min.z = Math.min(min.z, positions[i * 3 + 2]);
      max.x = Math.max(max.x, positions[i * 3]);
      max.y = Math.max(max.y, positions[i * 3 + 1]);
      max.z = Math.max(max.z, positions[i * 3 + 2]);
    }
    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(max, min);

    const fileNames = scansToStitch.map(s => s.data!.fileName?.replace(/\.[^.]+$/, '') || 'cloud');
    const newFileName = `${fileNames.join('_')}_stitched`;

    const combinedData: PointCloudData = {
      positions,
      colors,
      intensities,
      pointCount: totalPoints,
      bounds: { min, max, center, size },
      fileName: newFileName,
    };

    const newScan: Scan = {
      id: crypto.randomUUID(),
      label: newFileName,
      visible: true,
      color: scansToStitch[0].color,
      data: combinedData,
      // No params on the merged scan — origin is no longer meaningful.
    };

    stitchHistoryRef.current.push({
      originalScans: scansToStitch.map(s => ({ ...s })),
      stitchedScanId: newScan.id,
    });

    setScans(prev => {
      const filtered = prev.filter(s => !ids.includes(s.id));
      return [...filtered, newScan];
    });

    setSelectedScanIds(new Set([newScan.id]));

    showToast({
      type: 'success',
      title: 'Scans Stitched',
      message: `Combined ${scansToStitch.length} scans into ${totalPoints.toLocaleString()} points`,
    });
  }, [scans]);

  const handleUndoStitch = useCallback(() => {
    const lastStitch = stitchHistoryRef.current.pop();
    if (!lastStitch) return false;

    setScans(prev => {
      const filtered = prev.filter(s => s.id !== lastStitch.stitchedScanId);
      return [...filtered, ...lastStitch.originalScans];
    });

    setSelectedScanIds(new Set(lastStitch.originalScans.map(s => s.id)));

    showToast({
      type: 'info',
      title: 'Stitch Undone',
      message: `Restored ${lastStitch.originalScans.length} original scans`,
    });

    return true;
  }, []);

  const canUndoStitch = useCallback(() => {
    return stitchHistoryRef.current.length > 0;
  }, []);

  const handleSavePointCloud = useCallback((data: PointCloudData, fileName: string) => {
    // Convert point cloud data to XYZ format
    const lines: string[] = [];

    // Add header with column names
    let header = 'X,Y,Z';
    if (data.colors) header += ',R,G,B';
    if (data.intensities) header += ',Intensity';
    lines.push(header);

    // Add data rows
    for (let i = 0; i < data.pointCount; i++) {
      const x = data.positions[i * 3].toFixed(6);
      const y = data.positions[i * 3 + 1].toFixed(6);
      const z = data.positions[i * 3 + 2].toFixed(6);

      let line = `${x},${y},${z}`;

      if (data.colors) {
        const r = Math.round(data.colors[i * 3] * 255);
        const g = Math.round(data.colors[i * 3 + 1] * 255);
        const b = Math.round(data.colors[i * 3 + 2] * 255);
        line += `,${r},${g},${b}`;
      }

      if (data.intensities) {
        line += `,${data.intensities[i].toFixed(4)}`;
      }

      lines.push(line);
    }

    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast({ title: `Saved ${data.pointCount.toLocaleString()} points to ${fileName}`, type: 'success' });
  }, []);

  // File → Import menu entry point. The renderer dropzone's open() relies on a
  // programmatic <input>.click(), which Chromium gates on a transient user
  // gesture — a native-menu → IPC callback carries none, so the picker silently
  // failed to appear (the bug this replaces). The native Electron dialog is
  // shown by the main process and needs no renderer gesture; it also returns
  // absolute paths directly, which the backend importers and wizard want. We
  // read each chosen file's bytes (fs.readBinary) into a real File so the
  // existing File-based parsers work, and thread the path through explicitly.
  const handleMenuImport = useCallback(async (importType: ImportType) => {
    const filtersFor = (t: ImportType): { name: string; extensions: string[] }[] => {
      const strip = (fmts: { ext: string }[]) => fmts.map(f => f.ext.replace(/^\./, ''));
      const pc = strip(POINT_CLOUD_FORMATS);
      const mesh = strip(MESH_FORMATS);
      const skel = strip(SKELETON_FORMATS);
      switch (t) {
        case 'pointcloud':
          return [{ name: 'Point Clouds', extensions: pc }];
        case 'mesh':
          return [{ name: 'Meshes', extensions: mesh }];
        case 'skeleton':
          return [{ name: 'Skeletons', extensions: skel }];
        case 'scanxml':
          return [{ name: 'Helios Scan XML', extensions: ['xml'] }];
        default:
          return [{ name: 'Supported Files', extensions: [...new Set([...pc, ...mesh, ...skel, 'xml'])] }];
      }
    };

    setActiveNav('viewer');
    let selected: string | string[] | null;
    try {
      selected = await window.electronAPI.dialog.open({ multi: true, filters: filtersFor(importType) });
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : 'Failed to open file dialog', type: 'error' });
      return;
    }
    if (!selected) return; // user cancelled
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;

    // Build real File objects from the chosen paths so the File-based parsers
    // (parseMesh/parseSkeleton/parsePointCloud) work; the explicit paths drive
    // the backend importers + import wizard.
    setImportProgress({ current: 0, total: paths.length, label: 'Reading files…' });
    const files: File[] = [];
    const okPaths: string[] = [];
    for (const p of paths) {
      try {
        const bytes = await window.electronAPI.fs.readBinary(p);
        const name = p.split(/[\\/]/).pop() ?? 'file';
        files.push(new File([bytes], name));
        okPaths.push(p);
      } catch (err) {
        showToast({ title: `Failed to read ${p}: ${err instanceof Error ? err.message : err}`, type: 'error' });
      }
    }
    if (files.length === 0) {
      setImportProgress(null);
      return;
    }

    if (files.length === 1) {
      await handleFileUpload(files[0], { importType, path: okPaths[0] });
    } else {
      await handleMultipleFiles(files, { importType, paths: okPaths });
    }
  }, [handleFileUpload, handleMultipleFiles]);

  // Subscribe to application-menu commands dispatched from main (src/main/menu.ts).
  // Most menu items map to existing handlers; File → Import routes through the
  // native file dialog (handleMenuImport) rather than the renderer dropzone.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onMenuCommand((payload) => {
      switch (payload.kind) {
        case 'import-auto':
          void handleMenuImport('auto');
          break;
        case 'import-point-cloud':
          void handleMenuImport('pointcloud');
          break;
        case 'import-mesh':
          void handleMenuImport('mesh');
          break;
        case 'import-skeleton':
          void handleMenuImport('skeleton');
          break;
        case 'import-scan-xml':
          void handleMenuImport('scanxml');
          break;
        case 'save':
        case 'export':
          setActiveNav('viewer');
          (window as any).__openExportPanel?.();
          break;
        case 'undo':
          (window as any).__handleUndo?.();
          break;
        case 'redo':
          (window as any).__handleRedo?.();
          break;
        case 'select-all':
          handleSelectAll();
          break;
        case 'deselect-all':
          handleDeselectAll();
          break;
        case 'reset-camera':
          (window as any).__resetPointCloudCamera?.();
          break;
        case 'snap-view':
          (window as any).__snapToView?.(payload.direction);
          break;
        case 'feedback':
          setFeedbackMode(payload.mode);
          break;
        case 'about':
          setAboutOpen(true);
          break;
        case 'nav':
          setActiveNav(payload.target);
          break;
      }
    });
    return unsubscribe;
  }, [handleMenuImport, handleSelectAll, handleDeselectAll]);

  // Subscribe to backend crash/restart status pushed by the supervisor
  // (src/main/backend.ts). The sidecar holds imported clouds/plant sessions in
  // RAM, so a crash loses them even though the supervisor respawns it on the
  // same port — tell the user to re-import. `onBackendStatus` may be absent in
  // older preload builds, so guard the optional call.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onBackendStatus?.((payload) => {
      if (payload.status === 'restarting') {
        showToast({
          title: 'The compute backend stopped unexpectedly — restarting…',
          type: 'error',
          duration: 0,
        });
      } else if (payload.status === 'ready') {
        showToast({
          title: 'The backend restarted. Re-import your data to continue.',
          type: 'info',
          duration: 0,
        });
      } else if (payload.status === 'failed') {
        showToast({
          title: 'The compute backend could not be restarted. Please relaunch Phytograph.',
          type: 'error',
          duration: 0,
        });
      }
    });
    return unsubscribe;
  }, []);

  // Calculate total points across data-bearing scans only.
  const totalPoints = scans.reduce((sum, s) => sum + (s.data?.pointCount ?? 0), 0);

  // Empty-state hint shown over the viewer canvas when no scans are loaded
  // (fresh launch, or after the scans are removed). Faint and click-through so
  // it never blocks canvas interaction or the drag-drop overlay; the global
  // dropzone and the File → Import menu remain the actual entry points.
  const renderEmptyHint = () => (
    <div data-testid="empty-viewer-hint" className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <div className="text-center px-8">
        <FileUp className="w-12 h-12 mx-auto mb-4 text-neutral-600" />
        <p className="text-lg font-medium text-neutral-300 mb-2">
          Drag scan files here or use Import
        </p>
        <p className="text-neutral-500 mb-4 text-sm">multiple files supported</p>
        <div className="flex flex-wrap justify-center gap-2 max-w-xl">
          {POINT_CLOUD_FORMATS.map(f => (
            <span key={f.ext} className="px-2 py-1 bg-blue-500/10 rounded text-xs text-blue-400">
              {f.ext}
            </span>
          ))}
          {MESH_FORMATS.map(f => (
            <span key={f.ext} className="px-2 py-1 bg-green-500/10 rounded text-xs text-green-400">
              {f.ext}
            </span>
          ))}
          {SKELETON_FORMATS.map(f => (
            <span key={f.ext} className="px-2 py-1 bg-amber-500/10 rounded text-xs text-amber-400">
              {f.ext}
            </span>
          ))}
        </div>
      </div>
    </div>
  );

  // Render the 3D viewer
  const renderViewer = () => (
    <div className="flex-1 flex flex-col">
      {/* Toolbar */}
      <div className="bg-neutral-800 border-b border-neutral-700 px-4 py-2 flex items-center gap-4">
        <img src={logoImage} alt="Phytograph" className="w-6 h-6 object-contain" />
        <div className="flex items-center gap-2">
          <Box className="w-4 h-4 text-neutral-400" />
          <span className="text-sm font-medium text-neutral-200">
            {scans.length} Scan{scans.length !== 1 ? 's' : ''}
          </span>
          <span className="text-xs text-neutral-500">
            ({totalPoints.toLocaleString()} total points)
          </span>
        </div>

        <div className="flex-1" />

        <button
          data-testid="report-bug-btn"
          onClick={() => setFeedbackMode('bug')}
          title="Report a bug"
          className="px-3 py-1.5 text-sm bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 transition-colors flex items-center gap-1"
        >
          <Bug className="w-4 h-4" />
          Report a Bug
        </button>
        <button
          data-testid="request-feature-btn"
          onClick={() => setFeedbackMode('feature')}
          title="Request a feature"
          className="px-3 py-1.5 text-sm bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 transition-colors flex items-center gap-1"
        >
          <Lightbulb className="w-4 h-4" />
          Request a Feature
        </button>
      </div>

      {/* 3D Viewer */}
      <div className="relative flex-1 flex flex-col">
        <PointCloudViewer
          scans={scans}
          selectedScanIds={selectedScanIds}
          onToggleVisibility={handleToggleScanVisibility}
          onToggleScansVisibility={handleToggleScansVisibility}
          onHideScan={handleHideScan}
          onToggleMisses={handleToggleScanMisses}
          onToggleSelection={handleToggleScanSelection}
          onRemoveScan={handleRemoveScan}
          onSelectAll={handleSelectAll}
          onDeselectAll={handleDeselectAll}
          onUpdateScanData={handleUpdateScanData}
          onUpdateScanParams={handleUpdateScanParams}
          onUpdateScanLabel={handleUpdateScanLabel}
          onUpdateScanColor={handleUpdateScanColor}
          onSave={handleSavePointCloud}
          onAddScan={handleAddScan}
          onAddScans={handleAddScans}
          onStitchScans={handleStitchScans}
          onUndoStitch={handleUndoStitch}
          canUndoStitch={canUndoStitch}
          importRefsCallback={handleImportRefsCallback}
          onPendingDeletesChange={handlePendingDeletesChange}
          onViewerContentChange={setViewerHasContent}
          onRequestImportWizard={openImportWizard}
          className="flex-1"
        />
        {scans.length === 0 && !viewerHasContent && renderEmptyHint()}
      </div>
    </div>
  );

  // Render options page
  const renderOptions = () => (
    <div className="flex-1 p-8">
      <h2 className="text-2xl font-bold text-slate-800 mb-6">Settings</h2>
      <div className="max-w-2xl space-y-6">
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-lg font-medium text-slate-800 mb-4">Application</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Version
              </label>
              <p className="text-sm text-slate-500">Phytograph 0.1.0</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-lg font-medium text-slate-800 mb-4">Supported Formats</h3>

          <div className="mb-4">
            <h4 className="text-sm font-medium text-blue-700 mb-2">Point Clouds</h4>
            <div className="grid grid-cols-2 gap-2">
              {POINT_CLOUD_FORMATS.map(f => (
                <div key={f.ext} className="flex items-start gap-2 text-sm">
                  <span className="font-mono bg-blue-50 px-1.5 py-0.5 rounded text-blue-700">
                    {f.ext}
                  </span>
                  <span className="text-slate-600">{f.desc}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <h4 className="text-sm font-medium text-green-700 mb-2">Meshes</h4>
            <div className="grid grid-cols-2 gap-2">
              {MESH_FORMATS.map(f => (
                <div key={f.ext} className="flex items-start gap-2 text-sm">
                  <span className="font-mono bg-green-50 px-1.5 py-0.5 rounded text-green-700">
                    {f.ext}
                  </span>
                  <span className="text-slate-600">{f.desc}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-sm font-medium text-amber-700 mb-2">Skeletons</h4>
            <div className="grid grid-cols-2 gap-2">
              {SKELETON_FORMATS.map(f => (
                <div key={f.ext} className="flex items-start gap-2 text-sm">
                  <span className="font-mono bg-amber-50 px-1.5 py-0.5 rounded text-amber-700">
                    {f.ext}
                  </span>
                  <span className="text-slate-600">{f.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div {...getRootProps()} data-testid="app-root" className="flex h-screen flex-col bg-slate-50 select-none">
      {/* Wrap the dropzone input so we can attach data-testid without fighting react-dropzone's prop spread. */}
      <span data-testid="app-dropzone-input-wrap">
        <input {...getInputProps()} data-testid="app-dropzone-input" />
      </span>

      <BackendSplash />

      <div className="flex flex-1 min-h-0">

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Settings page - conditionally rendered over the viewer */}
        {activeNav === 'options' && renderOptions()}

        {/* Viewer - always mounted but hidden when not active to preserve state */}
        <div className={`absolute inset-0 flex flex-col ${activeNav === 'viewer' ? '' : 'invisible pointer-events-none'}`}>
          {renderViewer()}
        </div>
      </div>

      {/* Import progress modal for imports (drag-drop or File → Import).
          Reuses the same BulkImportProgress
          component as the Helios XML and per-scan attach pathways so every
          import shows an identical modal. */}
      <BulkImportProgress progress={importProgress} />

      {/* Feedback dialog — opened from the toolbar buttons or Help menu. */}
      <FeedbackDialog
        isOpen={feedbackMode !== null}
        mode={feedbackMode ?? 'bug'}
        onClose={() => setFeedbackMode(null)}
      />

      {/* About dialog — opened from the app menu (macOS) or Help menu (Win/Linux). */}
      <AboutDialog isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* Drag overlay */}
      {isDragOver && (
        <div className="fixed inset-0 bg-slate-500/20 backdrop-blur-sm flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-white rounded-2xl p-8 shadow-2xl">
            <FileUp className="w-16 h-16 text-slate-600 mx-auto mb-4" />
            <p className="text-xl font-medium text-slate-800">Drop to load scans</p>
          </div>
        </div>
      )}

      {/* Import wizard — shown for every path-backed point-cloud import
          (drag-drop, file picker, and Helios XML). Settles the pending
          openImportWizard promise on Import (results) or Cancel (null). */}
      {wizardInputs && (
        <PointCloudImportWizard
          inputs={wizardInputs}
          onCancel={() => settleWizard(null)}
          onComplete={(results) => settleWizard(results)}
        />
      )}

      <ToastContainer />
      </div>
    </div>
  );
}

export default App;
