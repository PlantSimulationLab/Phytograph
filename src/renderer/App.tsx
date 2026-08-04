import { useState, useCallback, useRef, useEffect } from "react";
import { Box, FileUp, Bug, Lightbulb } from "lucide-react";
import * as THREE from 'three';
import { useDropzone } from "react-dropzone";
import { ToastContainer, showToast } from "./components/Toast";
import { BulkImportProgress, type BulkImportProgressState } from "./components/BulkImportProgress";
import PointCloudViewer, { type PointCloudData, type ImportRefs } from "./components/PointCloudViewer";
import { scanDisplayName, type Scan } from "./lib/scan";
import { scanParametersFromFile, applyTrajectoryToParams, type ScanParameters } from "./lib/scanParameters";
import { shiftPoseStream } from "./lib/poseStream";
import { parsePointCloud, parsePointCloudFromPath, parseMesh, parseSkeleton, isMeshFile, isSkeletonFile, plyHasFaces, POINT_CLOUD_FORMATS, MESH_FORMATS, SKELETON_FORMATS, buildPointCloudFromOctree, type ImportProgressOptions } from "./lib/pointCloudParsers";
import { importTexturedMesh, type MeshImportResponse, deleteCloudSession, deletePlantSession, sessionMerge, createCloudSession, cancelRun, ScanCancelledError } from "./utils/backendApi";

// A user cancel is not a failure: it must never land in the per-file `errors[]`
// list or raise an error toast. Covers all three shapes the abort can take — the
// backend's terminal `cancelled` marker, an already-aborted signal, and the
// DOMException fetch throws when the request is torn down mid-flight.
function isImportCancel(err: unknown, signal?: AbortSignal): boolean {
  return err instanceof ScanCancelledError
    || signal?.aborted === true
    || (err instanceof Error && err.name === 'AbortError');
}
import { useScene } from "./state/sceneStore";
import { plantResponseToMeshData } from "./lib/plantMeshData";
import { PointCloudImportWizard, type WizardScanInput, type WizardResult } from "./components/PointCloudImportWizard";
import { registerCategoricalSlug, registerContinuousSlug } from "./lib/classification";
import { parseHeliosScanXml, HeliosXmlParseError } from "./lib/heliosScanXml";
import { resolveTargets } from "./lib/bulkActions";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { AboutDialog } from "./components/AboutDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import StatusPill from "./components/StatusPill";
import { getSettings } from "./lib/store";
import type { FeedbackMode } from "./lib/feedback";

// Extensions that go through the backend's Potree 2.0 octree pipeline when
// we have a disk path. Every supported point-cloud format is here; only inputs
// without an on-disk path (Blob/test fixtures) fall back to the in-renderer
// flat-array parsers.
const OCTREE_DROP_EXTENSIONS = new Set(['xyz', 'txt', 'csv', 'pts', 'asc', 'ply', 'pcd', 'las', 'laz', 'e57']);
import logoImage from "./assets/logo.png";

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

// In-RAM concatenation of genuinely FLAT clouds (real `positions`, no backend
// session — e.g. skeleton/mesh-derived overlays). Only valid when every input is
// flat; octree-backed clouds have empty `positions` and must go through the
// backend merge instead (see handleStitchScans). Returns the combined
// PointCloudData with recomputed bounds.
function stitchFlatClouds(scansToStitch: Scan[], fileName: string): PointCloudData {
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
        for (let i = 0; i < data.pointCount; i++) intensities[offset + i] = 1;
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

  return { positions, colors, intensities, pointCount: totalPoints, bounds: { min, max, center, size }, fileName };
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

// `onResetScene` remounts the whole App + SceneProvider subtree (see Root in
// main.tsx) — File → New calls it for a launch-fresh reset without a window
// reload.
function App({ onResetScene }: { onResetScene: () => void }) {
  // Settings live in a modal dialog (SettingsDialog), opened from the app/File
  // menu (⌘,/Ctrl+,). The viewer is the only "page", always mounted.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bumped each time the settings dialog closes so the always-mounted viewer can
  // re-read persisted settings (e.g. scan-marker scale) and apply them live.
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  // Scans are now owned by the scene store so add/remove are undoable and the
  // stitch undo folds into the unified history (Phase D). Reads keep array
  // syntax; non-history .map mutations (visibility/label/color/params/misses)
  // keep setScans(prev => ...) via the adapter; add/remove/stitch commit
  // transactions. selectedScanIds stays local (selection is out of undo scope).
  const scene = useScene();
  const scans = scene.state.scans;
  const setScans = useCallback(
    (update: Scan[] | ((prev: Scan[]) => Scan[])) => {
      scene.dispatch({
        c: 'replaceCollection',
        apply: (s) => ({ scans: typeof update === 'function' ? (update as (p: Scan[]) => Scan[])(s.scans) : update }),
      });
    },
    [scene],
  );
  // Undoable scan add/remove. A scan's octree session is NOT freed here — both
  // actions carry `sessionId` and the store frees it only when the action is
  // EVICTED off the history tail, dropped with the redo stack, or purged by a
  // boundary, AND the scan is no longer in the scene (see freeSession wiring in
  // main.tsx / the SceneProvider). This lets undo resurrect the scan with its
  // backend session (and unbaked edits) intact.
  // `sessionId` rides on the add for the same reason it rides on the remove: so
  // the store can free the backend session once the action is unreachable. An
  // UNDONE add owns a live session that nothing on screen references — without
  // this the store's free check (which matched `remove` only) never saw it and a
  // multi-GB cloud stayed resident in the sidecar until quit. The store frees it
  // only when the scan is also absent from the scene, so an add that merely
  // scrolls off the history tail while its cloud is still displayed is untouched.
  const addScanTx = useCallback((scan: Scan, label = 'Add scan') => {
    scene.commit({ label, actions: [{
      t: 'add', kind: 'scan', id: scan.id, object: scan,
      sessionId: scan.data?.octree?.sessionId ?? null,
    }] });
  }, [scene]);
  const addScansTx = useCallback((newScans: Scan[], label = 'Add scans') => {
    if (newScans.length === 0) return;
    scene.commit({ label, actions: newScans.map(s => ({
      t: 'add' as const, kind: 'scan' as const, id: s.id, object: s,
      sessionId: s.data?.octree?.sessionId ?? null,
    })) });
  }, [scene]);
  const removeScanTx = useCallback((id: string) => {
    const s = scene.state;
    const index = s.scans.findIndex(sc => sc.id === id);
    if (index < 0) return;
    const scan = s.scans[index];
    scene.commit({
      label: 'Delete scan',
      actions: [{
        t: 'remove', kind: 'scan', id, index, object: scan,
        editState: s.editStates.get(id),
        filters: s.cloudFilters.get(id),
        sessionId: scan.data?.octree?.sessionId ?? null,
      }],
    });
  }, [scene]);
  const [selectedScanIds, setSelectedScanIds] = useState<Set<string>>(new Set());
  // Progress shown over the viewer while an import (drag-drop or the
  // File → Import menu) is in flight. Reuses BulkImportProgress so every
  // import pathway shows the same spinner + bar + filename modal.
  const [importProgress, setImportProgress] = useState<BulkImportProgressState | null>(null);
  // Cancellation for the in-flight import. The abort tears down the fetch; the
  // run id is what /api/cancel/{id} targets so the BACKEND actually stops (and
  // kills its PotreeConverter child) instead of finishing the work into a
  // dismissed dialog. `importCancelledRef` stops the sequential multi-file loop
  // between files — aborting one file's fetch says nothing about the next.
  const importAbortRef = useRef<AbortController | null>(null);
  const importRunIdRef = useRef<string | null>(null);
  const importCancelledRef = useRef(false);
  const cancelImport = useCallback(() => {
    importCancelledRef.current = true;
    // Order matters (mirrors cancelScan in PointCloudViewer): tell the backend to
    // stop and free its memory FIRST, then tear down the fetch. Aborting first
    // can drop the connection before the cancel POST lands; the backend's own
    // disconnect detection is the backstop either way.
    if (importRunIdRef.current) void cancelRun(importRunIdRef.current);
    importAbortRef.current?.abort();
  }, []);
  // Progress shown over the viewer while a Stitch Clouds merge runs in the
  // backend (concatenate sessions + rebuild octree). Reuses the same modal.
  const [stitchProgress, setStitchProgress] = useState<BulkImportProgressState | null>(null);
  // null = closed; otherwise the open feedback dialog's mode.
  const [feedbackMode, setFeedbackMode] = useState<FeedbackMode | null>(null);
  // Whether the About dialog is open (opened from the app / Help menu).
  const [aboutOpen, setAboutOpen] = useState(false);
  // Whether the "New" (reset to a fresh app) confirmation is open. File → New
  // clears everything; we confirm first because it's unrecoverable.
  const [newConfirmOpen, setNewConfirmOpen] = useState(false);
  // In-flight auto-update download, shown as a top-center StatusPill. null when
  // no download is running. `percent` is null until the first progress event.
  const [updateDownload, setUpdateDownload] = useState<
    { version: string; percent: number | null } | null
  >(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const pendingImportTypeRef = useRef<ImportType>('auto');

  // Maps a dropped File's identity → its resolved on-disk path. react-dropzone
  // re-wraps the File objects it hands to `onDrop`, which severs the binding
  // `webUtils.getPathForFile` relies on (it returns '' for the wrapped File even
  // though the raw `dataTransfer` File resolves fine). We therefore resolve the
  // path in `onDropCapture` — which sees the un-wrapped `dataTransfer.files` —
  // and look it up in `onDrop` by a name+size+lastModified composite key. This
  // is what lets a dropped point cloud take the same backend/octree import path
  // as File → Import instead of silently falling back to the in-renderer parser
  // (which can't handle large scans — the "No data found" bug).
  const droppedPathsRef = useRef<Map<string, string>>(new Map());
  // NUL separates the parts because it's the one byte that can't occur in a
  // filename, so the composite key is unambiguous. Written as a `\u0000` escape
  // rather than a literal NUL: a raw NUL in the source makes grep/ripgrep class
  // the whole file as binary and silently return no matches without `-a`.
  const fileKey = (f: File): string => `${f.name}\u0000${f.size}\u0000${f.lastModified}`;

  // Last resort for an octree-eligible drop whose on-disk path couldn't be
  // resolved (cloud-storage placeholder, drag from a non-file source): write the
  // File's bytes to a private temp file via the main process and return that
  // path, so the import still goes through the backend/octree pipeline instead
  // of silently degrading to the in-renderer flat parser (which has no LOD and
  // makes large scans slow — e.g. the crop tool freezing on a 15M-point cloud).
  // Returns undefined on failure; the caller then falls back (with a warning).
  const materializeDroppedFile = useCallback(async (file: File): Promise<string | undefined> => {
    try {
      const buf = await file.arrayBuffer();
      const path = await window.electronAPI?.fs?.writeTempBinary?.(file.name, buf);
      return path || undefined;
    } catch (err) {
      console.warn(`Could not stage dropped file "${file.name}" for octree import:`, err);
      return undefined;
    }
  }, []);

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
    // Cancellation + per-stage progress for this one file's import. Optional so
    // callers that don't offer a cancel (none, currently) still work.
    opts?: ImportProgressOptions,
  ): Promise<Scan> => {
    const { input, asciiFormat, columnPlan, categoricalSlugs, continuousSlugs, worldShift } = result;
    // Far-field miss-detection threshold is a user setting; thread it into the
    // import so the backend's distance fallback honours it (the primary
    // target_index==99 signal ignores it).
    const missDistanceThreshold = (await getSettings()).missDistanceThreshold;
    const data = await parsePointCloudFromPath(
      input.path, asciiFormat, columnPlan, categoricalSlugs, worldShift, continuousSlugs,
      missDistanceThreshold, null, opts,
    );
    for (const slug of categoricalSlugs) registerCategoricalSlug(slug);
    for (const slug of continuousSlugs) registerContinuousSlug(slug);
    // Scan params precedence: an explicit XML <scan> (input.params) wins; else,
    // if the file itself carried scan-pattern metadata (E57 pose + angular sweep
    // + grid, or a PCD VIEWPOINT origin), auto-populate from it so a lone-file
    // import creates a Scan with as much of ScanParameters filled as the format
    // recorded — fields the file omitted stay at their default. Plain formats
    // (XYZ/LAS/PLY/...) carry nothing, so params stays undefined as before.
    const fileScanParams = data.octree?.scanParams ?? null;
    const baseParams = input.params
      ?? (fileScanParams ? scanParametersFromFile(fileScanParams) : undefined);
    // A trajectory chosen in the wizard marks this a moving-platform scan: attach
    // it to the params (creating defaults if the file carried none), which anchors
    // origin to the first pose and zeros static tilt/heading. Wins over a file's
    // own reconstructed trajectory — it's the user's explicit choice. The import's
    // global shift is subtracted from the cloud's stored points, so subtract the
    // SAME offset from the trajectory poses — otherwise it'd render far from the
    // shifted cloud and the LAD origin join would be in the wrong frame.
    const params = result.trajectory
      ? applyTrajectoryToParams(baseParams, shiftPoseStream(result.trajectory, worldShift))
      : baseParams;
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
    setSettingsOpen(false);
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
        // The default hint talks about "large scans" — wrong for a mesh. Swap
        // in mesh wording while keeping the same in-flight label.
        setImportProgress({ current: 1, total: 1, label: `Loading ${file.name}`, hint: 'Reading mesh from disk…' });
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
            setSettingsOpen(false);
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
            setSettingsOpen(false);
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
        // Mesh-style hint; "large scans" wording is wrong for a skeleton too.
        setImportProgress({ current: 1, total: 1, label: `Loading ${file.name}`, hint: 'Reading skeleton from disk…' });
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
          setSettingsOpen(false);
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
        // Octree-eligible drop with no resolvable OS path → stage to a temp file
        // so it still takes the octree import instead of the flat fallback.
        if (!sourcePath && OCTREE_DROP_EXTENSIONS.has(ext)) {
          setImportProgress({ current: 1, total: 1, label: `Preparing ${file.name}…` });
          sourcePath = await materializeDroppedFile(file);
        }
        if (sourcePath && OCTREE_DROP_EXTENSIONS.has(ext)) {
          // Path-backed: walk the user through the import wizard (preview +
          // column mapping), then run the real import with their choices. Clear
          // the progress modal first so it doesn't sit behind the wizard.
          setImportProgress(null);
          const results = await openImportWizard([{ path: sourcePath, fileName: file.name }]);
          if (!results || results.length === 0) return; // user cancelled
          importCancelledRef.current = false;
          const controller = new AbortController();
          importAbortRef.current = controller;
          setImportProgress({ current: 1, total: 1, label: `Loading ${file.name}`, fraction: null });
          let newScan: Scan;
          try {
            newScan = await buildScanFromWizardResult(results[0], getNextColor(), {
              signal: controller.signal,
              onProgress: (fraction, message) =>
                setImportProgress(p => (p ? { ...p, fraction, hint: message || undefined } : p)),
              onRunId: (runId) => { importRunIdRef.current = runId; },
            });
          } catch (err) {
            // The user asked for this — no error toast. The modal closing (in
            // the `finally` below) is the feedback.
            if (isImportCancel(err, controller.signal)) return;
            throw err;
          }
          addScanTx(newScan, 'Import scan');
          setSelectedScanIds(new Set([newScan.id]));
          setSettingsOpen(false);
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
          addScanTx(newScan, 'Import scan');
          setSelectedScanIds(new Set([newScan.id]));
          setSettingsOpen(false);
          // For an octree-eligible file we only land here if both path
          // resolution AND temp-file staging failed — the cloud loaded, but as a
          // flat (no-LOD) cloud that will be slow on large scans. Say so instead
          // of failing silently; suggest File → Import as the reliable route.
          if (OCTREE_DROP_EXTENSIONS.has(ext)) {
            showToast({
              title: `Loaded ${data.pointCount.toLocaleString()} points from ${file.name} without LOD — ` +
                `couldn't access the file on disk, so large-scan tools (crop, filter) may be slow. ` +
                `Use File → Import to load it with full performance.`,
              type: 'warning',
              duration: 0,
            });
          } else {
            showToast({ title: `Loaded ${data.pointCount.toLocaleString()} points from ${file.name}`, type: 'success' });
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse file';
      showToast({ title: message, type: 'error' });
    } finally {
      setImportProgress(null);
      importAbortRef.current = null;
      importRunIdRef.current = null;
      // Reset import type to auto after import
      pendingImportTypeRef.current = 'auto';
    }
  }, [getNextColor, openImportWizard, buildScanFromWizardResult, importScanXml, materializeDroppedFile]);

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
          // Octree-eligible drop with no resolvable OS path → stage to a temp
          // file so it still takes the octree import instead of the flat fallback.
          if (!sourcePath && OCTREE_DROP_EXTENSIONS.has(ext)) {
            sourcePath = await materializeDroppedFile(file);
          }
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
            // Octree-eligible but neither path resolution nor temp staging worked:
            // it loaded flat (no LOD), which is slow on large scans. Don't fail
            // silently — flag it and point at File → Import.
            if (OCTREE_DROP_EXTENSIONS.has(ext)) {
              showToast({
                title: `Loaded ${file.name} without LOD — couldn't access it on disk, so large-scan ` +
                  `tools (crop, filter) may be slow. Use File → Import to load it with full performance.`,
                type: 'warning',
                duration: 0,
              });
            }
          }
        }
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : 'Failed to parse'}`);
      }
    }

    // Walk path-backed point clouds through the wizard, then import each with
    // the user's choices. Clear the progress modal so it doesn't sit behind the
    // wizard; re-show per-scan during the actual import.
    let cancelledAfter = -1;   // index of the file the user cancelled on, if any
    if (wizardFiles.length > 0) {
      setImportProgress(null);
      const results = await openImportWizard(wizardFiles);
      if (results) {
        importCancelledRef.current = false;
        for (let i = 0; i < results.length; i++) {
          // A cancel during file i must also stop files i+1.. — aborting one
          // fetch says nothing about the next.
          if (importCancelledRef.current) { cancelledAfter = i; break; }
          // A FRESH controller per file: reusing one would leave every
          // subsequent file's fetch born already-aborted after any cancel.
          const controller = new AbortController();
          importAbortRef.current = controller;
          setImportProgress({
            current: i + 1, total: results.length,
            label: `Loading ${results[i].input.fileName}`, fraction: null,
          });
          try {
            newScans.push(await buildScanFromWizardResult(results[i], getColorForFile(), {
              signal: controller.signal,
              onProgress: (fraction, message) =>
                setImportProgress(p => (p ? { ...p, fraction, hint: message || undefined } : p)),
              onRunId: (runId) => { importRunIdRef.current = runId; },
            }));
          } catch (err) {
            if (isImportCancel(err, controller.signal)) { cancelledAfter = i; break; }
            errors.push(`${results[i].input.fileName}: ${err instanceof Error ? err.message : 'Failed to import'}`);
          }
        }
      }
    }

    if (newScans.length > 0) {
      addScansTx(newScans, newScans.length > 1 ? 'Import scans' : 'Import scan');
      setSelectedScanIds(new Set(newScans.map(e => e.id)));
    }

    const loadedCount = newScans.length + meshCount + skeletonCount;
    if (cancelledAfter >= 0) {
      // Scans imported before the cancel are KEPT — they're complete and correct,
      // and their backend sessions/octrees are already built. Say so explicitly:
      // "the modal vanished and 3 of 8 scans appeared" is otherwise
      // indistinguishable from a partial failure.
      if (loadedCount > 0) setSettingsOpen(false);
      showToast({
        title: newScans.length > 0
          ? `Import cancelled — kept ${newScans.length} of ${wizardFiles.length} scan(s)`
          : 'Import cancelled',
        type: 'info',
      });
    } else if (loadedCount > 0) {
      setSettingsOpen(false);
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
    importAbortRef.current = null;
    importRunIdRef.current = null;
    // Reset import type to auto after import
    pendingImportTypeRef.current = 'auto';
  }, [scans, openImportWizard, buildScanFromWizardResult, importScanXml, materializeDroppedFile]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setIsDragOver(false);
    // Recover the on-disk paths captured in onDropCapture (keyed by File
    // identity) — react-dropzone's re-wrapped Files can't resolve them
    // themselves. Passing an explicit path routes path-backed point clouds
    // through the backend/octree import (and the import wizard), matching
    // File → Import, instead of the in-renderer parser that chokes on large
    // scans. Files without a recovered path (e.g. test Blobs) fall back as before.
    const paths = acceptedFiles.map(f => droppedPathsRef.current.get(fileKey(f)));
    droppedPathsRef.current.clear();
    // Drops always auto-detect. Pass it explicitly rather than trusting the
    // ref: menu imports no longer touch pendingImportTypeRef, but a cancelled
    // import in older flows could leave it stale, which previously routed a
    // dropped .ply through the wrong parser ("Unsupported skeleton format").
    if (acceptedFiles.length === 1) {
      handleFileUpload(acceptedFiles[0], { importType: 'auto', path: paths[0] });
    } else if (acceptedFiles.length > 1) {
      handleMultipleFiles(acceptedFiles, { importType: 'auto', paths });
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
    // Undoable remove. The octree backend session is NOT freed here — it's freed
    // by the store when this remove is evicted/purged (deferred-free), so undo
    // can resurrect the scan with its session + unbaked edits intact.
    removeScanTx(id);
    setSelectedScanIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [removeScanTx]);

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

  // Replace the selection outright. Used by tools that finish by handing the
  // user a different set of scans than they started with — a retained crop
  // selects the new "(cropped)" clouds so the hidden originals aren't left
  // selected (a hidden-but-selected cloud would be silently re-cropped by the
  // next apply, since handleApplyCrop gates on selection, not visibility).
  const handleSetScanSelection = useCallback((ids: Set<string>) => {
    setSelectedScanIds(new Set(ids));
  }, []);

  const handleUpdateScanData = useCallback((id: string, data: PointCloudData) => {
    // Replacing the in-RAM data makes any prior `sourcePath` stale: it points at
    // the file the OLD data came from, not the new `data`. Downstream ops
    // (triangulate, LAD) prefer `file_path` and would silently re-read that
    // stale file — e.g. a synthetic scan overwriting a coarse imported cloud
    // would still triangulate the coarse on-disk points. The new `data` is the
    // source of truth, so drop the path (and its column hint) and let consumers
    // send points in-RAM.
    // Same reasoning for the OCTREE's own `sourceXyzPath`: octree recovery
    // rebuilds a missing cache from that file, which after an overwrite holds
    // entirely different points. Mark the replacement as diverged so recovery
    // refuses rather than resurrecting the pre-overwrite cloud.
    const next: PointCloudData = data.octree
      ? { ...data, octree: { ...data.octree, divergedFromSource: true } }
      : data;
    setScans(prev => prev.map(s =>
      s.id === id ? { ...s, data: next, sourcePath: undefined, asciiFormat: undefined } : s
    ));
  }, []);

  const handleUpdateScanParams = useCallback((id: string, params: ScanParameters | undefined) => {
    setScans(prev => prev.map(s =>
      s.id === id ? { ...s, params } : s
    ));
  }, []);

  const handleUpdateScanLabel = useCallback((id: string, label: string) => {
    const before = scene.state.scans.find(s => s.id === id)?.label;
    if (before === label) return;
    scene.commit({ label: 'Rename scan', actions: [{ t: 'property', kind: 'scan', id, key: 'label', before, after: label }] });
  }, [scene]);

  const handleUpdateScanColor = useCallback((id: string, color: string) => {
    const before = scene.state.scans.find(s => s.id === id)?.color;
    if (before === color) return;
    scene.commit({ label: 'Change scan color', actions: [{ t: 'property', kind: 'scan', id, key: 'color', before, after: color }] });
  }, [scene]);

  const handleAddScan = useCallback((scan: Scan) => {
    addScanTx(scan, 'Add scan');
    setSelectedScanIds(new Set([scan.id]));
  }, [addScanTx]);

  const handleAddScans = useCallback((newOnes: Scan[]) => {
    if (newOnes.length === 0) return;
    addScansTx(newOnes, newOnes.length > 1 ? 'Add scans' : 'Add scan');
    setSelectedScanIds(new Set(newOnes.map(s => s.id)));
  }, [addScansTx]);

  // Stitch multiple data-bearing scans into one. The result is data-only —
  // a merged cloud has no single defined origin, so any source params are
  // dropped. By default the sources are REMOVED from the scene and undo
  // restores them (params included) from the snapshot; with
  // `opts.retainOriginals` they stay in the scene, hidden, and undo removes
  // only the merged cloud (visibility is outside the undo model).
  //
  // The merge itself runs in the BACKEND (POST /api/cloud/session/merge): real
  // clouds are octree-backed and their points live in the backend session, NOT
  // in `data.positions` (which is an empty Float32Array — see pointCloudTypes).
  // The old renderer-side concatenation of `data.positions` therefore collapsed
  // every octree cloud to the origin (issue #3: green dot, un-framable camera).
  // The backend reads the in-RAM arrays, reconciles differing global shifts, and
  // unions scalar columns, returning a new session + octree we wrap as a Scan.
  const handleStitchScans = useCallback(async (ids: string[], opts?: { retainOriginals?: boolean }) => {
    if (ids.length < 2) return;
    // Retain mode: the sources stay in the scene (hidden) rather than being
    // removed. The backend merge already leaves the input sessions untouched,
    // so this is purely a matter of which actions the transaction carries.
    const retain = opts?.retainOriginals ?? false;

    const scansToStitch = scans.filter(s => ids.includes(s.id) && s.data);
    if (scansToStitch.length < 2) return;

    const fileNames = scansToStitch.map(s => s.data!.fileName?.replace(/\.[^.]+$/, '') || 'cloud');
    const newFileName = `${fileNames.join('_')}_stitched`;
    const newScanId = crypto.randomUUID();

    // Build the ONE unified-history transaction that removes each original scan
    // (carrying its session for deferred-free, so undo can restore it intact) and
    // adds the stitched scan. A single Cmd+Z reverses the whole stitch.
    const commitStitch = (newData: PointCloudData) => {
      const newScan: Scan = {
        id: newScanId,
        label: newFileName,
        visible: true,
        color: scansToStitch[0].color,
        data: newData,
        // No params on the merged scan — origin is no longer meaningful.
      };
      const cur = scene.state.scans;
      const removeActions = retain ? [] : scansToStitch.map((s) => {
        const index = cur.findIndex((x) => x.id === s.id);
        return {
          t: 'remove' as const, kind: 'scan' as const, id: s.id, index, object: s,
          editState: scene.state.editStates.get(s.id),
          filters: scene.state.cloudFilters.get(s.id),
          sessionId: s.data?.octree?.sessionId ?? null,
        };
      });
      scene.commit({
        label: retain
          ? `Stitch ${scansToStitch.length} scans (kept originals)`
          : `Stitch ${scansToStitch.length} scans`,
        actions: [
          ...removeActions,
          // `sessionId` rides on the add for the same reason addScanTx carries it:
          // undo pushes this transaction onto the redo stack, where the merged
          // scan is off screen but its backend session is still resident. Without
          // the id, the store's free check never sees that session and a stitch
          // that's undone and then superseded by another edit leaks it into the
          // sidecar until quit. (Deleting the merged scan normally is already
          // covered — removeScanTx reads the id off the scan itself.)
          {
            t: 'add', kind: 'scan', id: newScan.id, object: newScan,
            sessionId: newData.octree?.sessionId ?? null,
          },
        ],
      });
      // Hide the retained sources rather than removing them, so the viewport
      // looks the same as a destructive stitch. Deliberately OUTSIDE the
      // transaction: SceneAction's `property` kind covers label/color/opacity/
      // colorMode only — visibility is intentionally not undoable — and
      // extending the action model for a cosmetic flag isn't worth it. The
      // documented consequence: undoing a retained stitch removes the merged
      // cloud but leaves the originals hidden until the user unhides them.
      if (retain) for (const s of scansToStitch) handleHideScan(s.id);
      setSelectedScanIds(new Set([newScan.id]));
      showToast({
        type: 'success',
        title: 'Scans Stitched',
        message: retain
          ? `Combined ${scansToStitch.length} scans into ${newData.pointCount.toLocaleString()} points — originals kept and hidden`
          : `Combined ${scansToStitch.length} scans into ${newData.pointCount.toLocaleString()} points`,
      });
    };

    // Partition into octree/session-backed (points in the backend) vs genuinely
    // flat (real in-RAM positions, no session — synthetic overlays). A flat cloud
    // that still has a source path can be re-sessioned; one with neither can't be
    // merged server-side (there's no inline-points session-create path).
    const isOctreeBacked = (s: Scan) =>
      Boolean(s.data?.octree?.sessionId || s.data?.octree?.sourceXyzPath);
    const flatOnly = scansToStitch.filter(s => !isOctreeBacked(s));

    // All genuinely flat → the old in-RAM concatenation is correct (these clouds
    // DO carry real positions). Kept for synthetic (skeleton/mesh-derived) clouds.
    if (flatOnly.length === scansToStitch.length) {
      commitStitch(stitchFlatClouds(scansToStitch, newFileName));
      return;
    }
    // Mixed flat + octree can't be unified without an inline-session path — fail
    // loudly rather than silently drop the flat cloud or collapse it.
    if (flatOnly.length > 0) {
      showToast({
        type: 'error',
        title: 'Cannot stitch these clouds together',
        message: `${flatOnly.map(s => scanDisplayName(s)).join(', ')} ${flatOnly.length === 1 ? 'is' : 'are'} not backed by a source file, so they can't be merged with imported clouds. Export them first, then stitch.`,
        duration: 0,
      });
      return;
    }

    // All octree/session-backed → merge in the backend.
    setStitchProgress({ current: 0, total: scansToStitch.length, label: `Merging ${scansToStitch.length} clouds into one`, hint: 'Combining points and rebuilding the octree — large scans can take a moment.' });
    try {
      // Ensure every input has a live session id. A cloud whose session was
      // evicted (backend restart / idle) but still has a source path is
      // re-created from that path (deterministic — same cache id), mirroring
      // handleOctreeMissing.
      const sessionIds: string[] = [];
      for (const s of scansToStitch) {
        const octree = s.data!.octree!;
        if (octree.sessionId) {
          sessionIds.push(octree.sessionId);
        } else {
          // No live session: the only way to get points is to re-read the source
          // file. That is only valid while the cloud still matches that file —
          // an edited cloud (baked transform, applied crop, filter, split) would
          // silently merge its PRE-EDIT geometry. Refuse instead.
          if (octree.divergedFromSource) {
            throw new Error(
              `"${s.data!.fileName ?? s.label}" has been edited since import and its cached data ` +
              `is no longer loaded, so stitching it would use the original unedited file. ` +
              `Re-import and redo the edits, then stitch.`,
            );
          }
          const rebuilt = await createCloudSession(
            octree.sourceXyzPath,
            octree.asciiFormat ?? null,
            octree.columnPlan ?? null,
            octree.worldShift ?? null,
          );
          sessionIds.push(rebuilt.session_id);
        }
      }

      const { merged } = await sessionMerge(sessionIds);

      // Wrap the merged session's octree as a PointCloudData. Carry column
      // plan / ascii / categoricals from the FIRST input for provenance; the new
      // session id routes the merged cloud's own edits. scanOrigin/scanParams are
      // intentionally dropped (a merged multi-scan cloud has no single origin).
      const firstOctree = scansToStitch[0].data!.octree!;
      const newData = buildPointCloudFromOctree(
        { ...merged, cache_dir: merged.cache_dir ?? '', cached: false },
        firstOctree.sourceXyzPath,
        newFileName,
        firstOctree.asciiFormat ?? null,
        firstOctree.columnPlan ?? null,
        firstOctree.categoricalAttributes,
        merged.session_id,
        merged.world_shift ?? null,
        firstOctree.continuousAttributes,
      );
      if (newData.octree) {
        newData.octree.hasMisses = merged.has_misses;
        newData.octree.missOctreeCacheId = merged.miss_octree_cache_id ?? null;
        // A merged cloud is many clouds' points; `sourceXyzPath` (carried from
        // the first input for provenance) does NOT describe it, so it must never
        // be rebuilt from that file.
        newData.octree.divergedFromSource = true;
      }
      commitStitch(newData);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to stitch clouds';
      showToast({ type: 'error', title: 'Stitch failed', message: msg, duration: 0 });
    } finally {
      setStitchProgress(null);
    }
  }, [scans, scene, handleHideScan]);

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
  // Read on-disk paths into real File objects and route them through the import
  // pipeline. Shared by the native File→Import dialog (handleMenuImport) and the
  // OS "Open With" / file-association flow (onOpenFiles). Synthetic Files carry
  // no webUtils path, so the explicit on-disk path drives the backend importers
  // + the import wizard.
  const importPathsByType = useCallback(async (paths: string[], importType: ImportType) => {
    if (paths.length === 0) return;
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

    setSettingsOpen(false);
    let selected: string | string[] | null;
    try {
      selected = await window.electronAPI.dialog.open({ multi: true, filters: filtersFor(importType) });
    } catch (err) {
      showToast({ title: err instanceof Error ? err.message : 'Failed to open file dialog', type: 'error' });
      return;
    }
    if (!selected) return; // user cancelled
    const paths = Array.isArray(selected) ? selected : [selected];
    await importPathsByType(paths, importType);
  }, [importPathsByType]);

  // Expose mesh import to the viewer's Tools toolbar / Tools menu "Import Model"
  // command. App owns the native import dialog (handleMenuImport), so the viewer
  // reaches it through this global — same bridge pattern as __handleUndo.
  useEffect(() => {
    (window as any).__importMesh = () => { void handleMenuImport('mesh'); };
    return () => { delete (window as any).__importMesh; };
  }, [handleMenuImport]);

  // OS "Open With" / file-association: main hands us the paths the OS asked
  // Phytograph to open. Auto-detect each by extension (point cloud / mesh /
  // skeleton / Helios XML) and route through the same importer as a manual
  // import. We also tell main the renderer is ready so it flushes any paths it
  // queued while the window/backend were still coming up (cold "Open With").
  useEffect(() => {
    const unsubscribe = window.electronAPI.onOpenFiles(({ paths }) => {
      void importPathsByType(paths, 'auto');
    });
    window.electronAPI.notifyRendererReady();
    return unsubscribe;
  }, [importPathsByType]);

  // File → New: reset to a fresh app, exactly as if it had just launched. Rather
  // than hand-reset the hundreds of useState/refs scattered across App and the
  // viewer (fragile, and prone to drift as features are added), we remount the
  // App + SceneProvider subtree via a key bump in Root (onResetScene) — React
  // tears down the old tree and mounts a fresh empty one. Unlike the old window
  // reload this stays inside the renderer: the Python sidecar and its resolved
  // port survive, and the backend splash never reappears. Before remounting we
  // still free every backend session the renderer was holding (octree clouds +
  // plant sessions), since the remount discards those scans without going
  // through the history-eviction path that normally frees their sessions, so the
  // long-lived sidecar would otherwise leak that RAM. Best-effort — each delete
  // swallows its own errors — then remount regardless.
  const handleResetToNew = useCallback(async () => {
    const s = scene.state;
    const deletions: Promise<unknown>[] = [];
    for (const scan of s.scans) {
      const sessionId = scan.data?.octree?.sessionId;
      if (sessionId) deletions.push(deleteCloudSession(sessionId));
    }
    for (const mesh of s.meshes) {
      if (mesh.plantSessionId) deletions.push(deletePlantSession(mesh.plantSessionId));
    }
    await Promise.allSettled(deletions);
    onResetScene();
  }, [scene, onResetScene]);

  // Subscribe to application-menu commands dispatched from main (src/main/menu.ts).
  // Most menu items map to existing handlers; File → Import routes through the
  // native file dialog (handleMenuImport) rather than the renderer dropzone.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onMenuCommand((payload) => {
      switch (payload.kind) {
        case 'new':
          setNewConfirmOpen(true);
          break;
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
          setSettingsOpen(false);
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
        case 'fit-selection':
          (window as any).__zoomToSelection?.();
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
          // 'options' opens the Settings modal; 'viewer' just ensures it's closed.
          setSettingsOpen(payload.target === 'options');
          break;
        case 'tool':
          // Native Tools menu → run a tool by registry id. The viewer exposes
          // __runToolCommand; ensure we're on the viewer (not Settings) first.
          setSettingsOpen(false);
          (window as any).__runToolCommand?.(payload.toolId);
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
        // The native crash dialog (src/main/crashDialog.ts) is the actionable
        // surface here — it offers Reload / View Logs / Report. This toast is
        // just the non-blocking breadcrumb in case the dialog was dismissed.
        showToast({
          title: 'The compute backend could not be restarted — see the dialog to reload, view logs, or report.',
          type: 'error',
          duration: 0,
        });
      }
    });
    return unsubscribe;
  }, []);

  // Subscribe to auto-updater download progress pushed by src/main/updater.ts.
  // The installer is a few hundred MB, so without this the download is a silent
  // multi-minute stretch ending in an out-of-nowhere "restart to install"
  // dialog. `onUpdaterStatus` may be absent in older preload builds, so guard.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onUpdaterStatus?.((payload) => {
      if (payload.status === 'downloading') {
        setUpdateDownload({ version: payload.version, percent: payload.percent });
      } else {
        // 'downloaded' hands off to the native restart prompt; 'error' is
        // reported in the log. Either way the pill's job is done.
        setUpdateDownload(null);
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
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
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

      {/* 3D Viewer. min-h-0/min-w-0 (here and on the ancestors up to the
          absolute inset-0 anchor) let the flex chain shrink below the canvas's
          current pixel size when the window shrinks — without them the canvas's
          intrinsic height props up every ancestor's min-content height, so the
          viewer ratchets to its largest-ever size and window shrinks crop the
          bottom overlays (axes gizmo, toolbar column) instead of reflowing. */}
      <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
        {/* Auto-update download progress. Same top-center pill the viewer's own
            long operations use, so a background download reads as "the app is
            busy with something" rather than nothing at all. Not cancelable —
            electron-updater has no cancel once downloadUpdate() is underway. */}
        {updateDownload && (
          <StatusPill
            testId="update-downloading"
            label={
              updateDownload.version
                ? `Downloading update v${updateDownload.version}…`
                : 'Downloading update…'
            }
            progress={updateDownload.percent != null ? updateDownload.percent / 100 : null}
          />
        )}
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
          onSetScanSelection={handleSetScanSelection}
          onUpdateScanData={handleUpdateScanData}
          onUpdateScanParams={handleUpdateScanParams}
          onUpdateScanLabel={handleUpdateScanLabel}
          onUpdateScanColor={handleUpdateScanColor}
          onSave={handleSavePointCloud}
          onAddScan={handleAddScan}
          onAddScans={handleAddScans}
          onStitchScans={handleStitchScans}
          importRefsCallback={handleImportRefsCallback}
          onPendingDeletesChange={handlePendingDeletesChange}
          onViewerContentChange={setViewerHasContent}
          onRequestImportWizard={openImportWizard}
          onOpenSettings={() => setSettingsOpen(true)}
          settingsEpoch={settingsEpoch}
          className="flex-1"
        />
        {scans.length === 0 && !viewerHasContent && renderEmptyHint()}
      </div>
    </div>
  );


  return (
    <div
      {...getRootProps()}
      // Resolve each dropped file's on-disk path from the raw `dataTransfer`
      // BEFORE react-dropzone re-wraps the File objects (the wrapped copies it
      // passes to `onDrop` return '' from webUtils.getPathForFile). Stash them by
      // identity for `onDrop` to thread through as explicit paths. Capture phase
      // so this runs before react-dropzone's own drop handler.
      onDropCapture={(e) => {
        try {
          const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
          for (const f of files) {
            let p: string | undefined;
            try { p = window.electronAPI?.getPathForFile?.(f) || undefined; } catch { p = undefined; }
            if (p) droppedPathsRef.current.set(fileKey(f), p);
          }
        } catch { /* best-effort; onDrop falls back to in-renderer parse */ }
      }}
      data-testid="app-root"
      className="flex h-screen flex-col bg-slate-50 select-none"
    >
      {/* Wrap the dropzone input so we can attach data-testid without fighting react-dropzone's prop spread. */}
      <span data-testid="app-dropzone-input-wrap">
        <input {...getInputProps()} data-testid="app-dropzone-input" />
      </span>

      <div className="flex flex-1 min-h-0">

      {/* Main Content — the viewer is the only page; Settings is a modal overlay. */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        <div className="absolute inset-0 flex flex-col">
          {renderViewer()}
        </div>
      </div>

      {/* Import progress modal for imports (drag-drop or File → Import).
          Reuses the same BulkImportProgress
          component as the Helios XML and per-scan attach pathways so every
          import shows an identical modal. Cancel really stops the backend work
          (kills the PotreeConverter child) — it does not just hide the dialog. */}
      <BulkImportProgress progress={importProgress} onCancel={cancelImport} />

      {/* Stitch Clouds merge progress — reuses the same modal as imports, but
          with its own header (the default reads "Importing scans…"). */}
      <BulkImportProgress progress={stitchProgress} title="Stitching clouds…" />

      {/* Feedback dialog — opened from the toolbar buttons or Help menu. */}
      <FeedbackDialog
        isOpen={feedbackMode !== null}
        mode={feedbackMode ?? 'bug'}
        onClose={() => setFeedbackMode(null)}
      />

      {/* About dialog — opened from the app menu (macOS) or Help menu (Win/Linux). */}
      <AboutDialog isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* "New" confirmation — File → New resets the app to a fresh, empty state
          (the same as a relaunch). Unrecoverable, so confirm first. */}
      {newConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.stopPropagation()}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setNewConfirmOpen(false)} />
          <div
            data-testid="new-confirm-dialog"
            className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-sm mx-4 p-6"
          >
            <h2 className="text-lg font-semibold text-white mb-2">New project</h2>
            <p className="text-sm text-neutral-300 mb-6">
              This clears everything — all point clouds, meshes, skeletons, plant
              models, scans, and analysis results — and resets the app to a fresh
              start. This can&rsquo;t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setNewConfirmOpen(false)}
                className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-100 rounded-lg transition-colors text-sm"
              >
                Cancel
              </button>
              <button
                data-testid="new-confirm-clear"
                onClick={() => { setNewConfirmOpen(false); void handleResetToNew(); }}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors text-sm"
              >
                Clear everything
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings dialog — opened from the app menu (macOS) or File menu (Win/Linux) via ⌘,/Ctrl+,. */}
      <SettingsDialog
        isOpen={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSettingsEpoch((n) => n + 1); }}
      />

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
