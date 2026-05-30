import { useState, useCallback, useRef, useEffect } from "react";
import { Upload, Box, Layers, FileUp, ChevronDown, Sparkles, GitBranch } from "lucide-react";
import * as THREE from 'three';
import { useDropzone } from "react-dropzone";
import { ToastContainer, showToast } from "./components/Toast";
import { BackendSplash } from "./components/BackendSplash";
import { BulkImportProgress, type BulkImportProgressState } from "./components/BulkImportProgress";
import PointCloudViewer, { type PointCloudData, type ImportRefs } from "./components/PointCloudViewer";
import type { Scan } from "./lib/scan";
import type { ScanParameters } from "./lib/scanParameters";
import { parsePointCloud, parsePointCloudFromPath, parseMesh, parseSkeleton, isMeshFile, isSkeletonFile, POINT_CLOUD_FORMATS, MESH_FORMATS, SKELETON_FORMATS } from "./lib/pointCloudParsers";

// Extensions that go through the backend's Potree 2.0 octree pipeline when
// we have a disk path. Anything outside this set (PLY/PCD/LAS/LAZ/OBJ) stays
// on the in-renderer flat-array path for now.
const OCTREE_DROP_EXTENSIONS = new Set(['xyz', 'txt', 'csv', 'pts', 'asc']);
import logoImage from "./assets/logo.png";

type NavItem = 'viewer' | 'options';
type ImportType = 'auto' | 'pointcloud' | 'mesh' | 'skeleton';

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
  // Progress shown over the viewer while an import triggered from the viewer
  // header (Import menu / File menu) is in flight. Reuses BulkImportProgress
  // so every import pathway shows the same spinner + bar + filename modal.
  const [importProgress, setImportProgress] = useState<BulkImportProgressState | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const pendingImportTypeRef = useRef<ImportType>('auto');
  const importMenuRef = useRef<HTMLDivElement>(null);

  // Import refs from PointCloudViewer for mesh/skeleton imports
  const importRefsRef = useRef<ImportRefs | null>(null);
  const handleImportRefsCallback = useCallback((refs: ImportRefs) => {
    importRefsRef.current = refs;
  }, []);

  // Whether the viewer holds non-scan content (meshes/skeletons). Generated
  // plants are meshes, so this — not just scans — must gate the empty-state hint.
  const [viewerHasContent, setViewerHasContent] = useState(false);

  // Stitch history for undo. We snapshot the full Scan objects (including any
  // params) so undo restores the original scans exactly as they were.
  interface StitchHistoryEntry {
    originalScans: Scan[];
    stitchedScanId: string;
  }
  const stitchHistoryRef = useRef<StitchHistoryEntry[]>([]);

  // Close import menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(e.target as Node)) {
        setShowImportMenu(false);
      }
    };
    if (showImportMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showImportMenu]);

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

  const handleFileUpload = useCallback(async (file: File) => {
    setImportProgress({ current: 1, total: 1, label: `Loading ${file.name}` });

    const importType = pendingImportTypeRef.current;

    try {
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
        } else {
          // fall through to point cloud import
        }
      }

      if (shouldImportAsMesh) {
        // Parse as mesh
        const meshData = await parseMesh(file);
        if (importRefsRef.current) {
          importRefsRef.current.importMesh({
            sourceCloudId: 'imported',
            data: {
              vertices: meshData.vertices,
              indices: meshData.indices,
              normals: meshData.normals,
              vertexCount: meshData.vertexCount,
              triangleCount: meshData.triangleCount,
            },
            visible: true,
            color: getNextColor(),
            method: 'delaunay', // Default for imported meshes
          });
          setActiveNav('viewer');
          showToast({ title: `Loaded mesh with ${meshData.triangleCount.toLocaleString()} triangles from ${file.name}`, type: 'success' });
        } else {
          showToast({ title: 'Viewer not ready for mesh import', type: 'error' });
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
        // Parse as point cloud (default) → produces a Scan with data only.
        // Params can be attached later via the row's "Add scan parameters"
        // button. We try to record the on-disk source path when the file
        // came from a native dialog/dropzone so the backend can read it
        // directly instead of receiving the full point payload over HTTP.
        let sourcePath: string | undefined;
        try {
          sourcePath = window.electronAPI?.getPathForFile?.(file) || undefined;
        } catch {
          sourcePath = undefined;
        }

        // Octree path: when we have a real on-disk path and the file is an
        // XYZ-family extension, route through the backend converter so the
        // renderer streams tiles instead of holding the full cloud in V8.
        // Falls back to the in-renderer parser when no path is available
        // (e.g. fixtures-as-Blob in tests) or the format isn't supported by
        // PotreeConverter (PLY / PCD / LAS / LAZ).
        const ext = file.name.toLowerCase().split('.').pop() ?? '';
        const useOctree = !!sourcePath && OCTREE_DROP_EXTENSIONS.has(ext);
        const data = useOctree
          ? await parsePointCloudFromPath(sourcePath!)
          : await parsePointCloud(file);
        const newScan: Scan = {
          id: crypto.randomUUID(),
          label: data.fileName ?? 'Scan',
          visible: true,
          color: getNextColor(),
          data,
          sourcePath,
        };

        setScans(prev => [...prev, newScan]);
        setSelectedScanIds(new Set([newScan.id])); // Select the newly added scan
        setActiveNav('viewer');
        showToast({ title: `Loaded ${data.pointCount.toLocaleString()} points from ${file.name}`, type: 'success' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse file';
      showToast({ title: message, type: 'error' });
    } finally {
      setImportProgress(null);
      // Reset import type to auto after import
      pendingImportTypeRef.current = 'auto';
    }
  }, [getNextColor]);

  // Handle multiple files
  const handleMultipleFiles = useCallback(async (files: File[]) => {
    setImportProgress({ current: 0, total: files.length, label: 'Preparing…' });
    const newScans: Scan[] = [];
    const errors: string[] = [];
    let meshCount = 0;
    let skeletonCount = 0;
    let colorIndex = 0;

    const importType = pendingImportTypeRef.current;

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

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx];
      setImportProgress({ current: fileIdx + 1, total: files.length, label: `Loading ${file.name}` });
      try {
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
          }
        }

        if (shouldImportAsMesh) {
          // Parse as mesh
          const meshData = await parseMesh(file);
          if (importRefsRef.current) {
            importRefsRef.current.importMesh({
              sourceCloudId: 'imported',
              data: {
                vertices: meshData.vertices,
                indices: meshData.indices,
                normals: meshData.normals,
                vertexCount: meshData.vertexCount,
                triangleCount: meshData.triangleCount,
              },
              visible: true,
              color: getColorForFile(),
              method: 'delaunay',
            });
            meshCount++;
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
          // Parse as point cloud (default) → produces a data-only Scan.
          // Resolve the on-disk path FIRST so XYZ-family files route through
          // the backend octree converter (streams tiles) instead of the
          // in-renderer parser, which holds the whole cloud in V8 and throws
          // on 100MB+ files. This mirrors the single-file path in
          // handleFileUpload — without it, multi-select fails on large scans
          // that import fine one at a time.
          let sourcePath: string | undefined;
          try {
            sourcePath = window.electronAPI?.getPathForFile?.(file) || undefined;
          } catch {
            sourcePath = undefined;
          }
          const ext = file.name.toLowerCase().split('.').pop() ?? '';
          const useOctree = !!sourcePath && OCTREE_DROP_EXTENSIONS.has(ext);
          const data = useOctree
            ? await parsePointCloudFromPath(sourcePath!)
            : await parsePointCloud(file);
          newScans.push({
            id: crypto.randomUUID(),
            label: data.fileName ?? 'Scan',
            visible: true,
            color: getColorForFile(),
            data,
            sourcePath,
          });
        }
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : 'Failed to parse'}`);
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

    if (errors.length > 0) {
      showToast({ title: `Failed to load ${errors.length} file(s)`, type: 'error' });
    }

    setImportProgress(null);
    // Reset import type to auto after import
    pendingImportTypeRef.current = 'auto';
  }, [scans]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setIsDragOver(false);
    if (acceptedFiles.length === 1) {
      handleFileUpload(acceptedFiles[0]);
    } else if (acceptedFiles.length > 1) {
      handleMultipleFiles(acceptedFiles);
    }
  }, [handleFileUpload, handleMultipleFiles]);

  const { getRootProps, getInputProps, open } = useDropzone({
    onDrop,
    onDragEnter: () => setIsDragOver(true),
    onDragLeave: () => setIsDragOver(false),
    noClick: true,
    noKeyboard: true,
    multiple: true, // Allow multiple files
  });

  const handleClearAllScans = () => {
    setScans([]);
    setSelectedScanIds(new Set());
  };

  const handleRemoveScan = useCallback((id: string) => {
    setScans(prev => prev.filter(s => s.id !== id));
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

  const handleToggleScanSelection = useCallback((id: string, multiSelect: boolean) => {
    setSelectedScanIds(prev => {
      const next = new Set(multiSelect ? prev : []);
      if (prev.has(id) && multiSelect) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedScanIds(new Set(scans.map(s => s.id)));
  }, [scans]);

  const handleDeselectAll = useCallback(() => {
    setSelectedScanIds(new Set());
  }, []);

  const handleUpdateScanData = useCallback((id: string, data: PointCloudData) => {
    setScans(prev => prev.map(s =>
      s.id === id ? { ...s, data } : s
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

  // Subscribe to application-menu commands dispatched from main (src/main/menu.ts).
  // Most menu items map to existing handlers; import re-uses the dropzone's
  // open() with pendingImportTypeRef set, exactly like the in-window import menu.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onMenuCommand((payload) => {
      switch (payload.kind) {
        case 'import-point-cloud':
          pendingImportTypeRef.current = 'pointcloud';
          setActiveNav('viewer');
          open();
          break;
        case 'import-mesh':
          pendingImportTypeRef.current = 'mesh';
          setActiveNav('viewer');
          open();
          break;
        case 'import-skeleton':
          pendingImportTypeRef.current = 'skeleton';
          setActiveNav('viewer');
          open();
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
        case 'nav':
          setActiveNav(payload.target);
          break;
      }
    });
    return unsubscribe;
  }, [open, handleSelectAll, handleDeselectAll]);

  // Calculate total points across data-bearing scans only.
  const totalPoints = scans.reduce((sum, s) => sum + (s.data?.pointCount ?? 0), 0);

  // Empty-state hint shown over the viewer canvas when no scans are loaded
  // (fresh launch or after Close All). Faint and click-through so it never
  // blocks canvas interaction or the drag-drop overlay; the global dropzone
  // and the toolbar Import menu remain the actual entry points.
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
        <div className="relative" ref={importMenuRef}>
          <button
            data-testid="import-menu-button"
            onClick={() => setShowImportMenu(!showImportMenu)}
            className="px-3 py-1.5 text-sm bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 transition-colors flex items-center gap-1"
          >
            <Upload className="w-4 h-4" />
            Import
            <ChevronDown className="w-3 h-3" />
          </button>
          {showImportMenu && (
            <div data-testid="import-menu" className="absolute top-full right-0 mt-1 bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg py-1 min-w-[180px] z-50">
              <button
                data-testid="import-menu-auto"
                onClick={() => { pendingImportTypeRef.current = 'auto'; setShowImportMenu(false); open(); }}
                className="w-full px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700 flex items-center gap-2 text-left"
              >
                <Sparkles className="w-4 h-4 text-neutral-400" />
                Auto-detect
              </button>
              <div className="border-t border-neutral-700 my-1" />
              <button
                data-testid="import-menu-pointcloud"
                onClick={() => { pendingImportTypeRef.current = 'pointcloud'; setShowImportMenu(false); open(); }}
                className="w-full px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700 flex items-center gap-2 text-left"
              >
                <Layers className="w-4 h-4 text-blue-400" />
                Point Cloud
              </button>
              <button
                data-testid="import-menu-mesh"
                onClick={() => { pendingImportTypeRef.current = 'mesh'; setShowImportMenu(false); open(); }}
                className="w-full px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700 flex items-center gap-2 text-left"
              >
                <Box className="w-4 h-4 text-green-400" />
                Mesh
              </button>
              <button
                data-testid="import-menu-skeleton"
                onClick={() => { pendingImportTypeRef.current = 'skeleton'; setShowImportMenu(false); open(); }}
                className="w-full px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700 flex items-center gap-2 text-left"
              >
                <GitBranch className="w-4 h-4 text-amber-400" />
                Skeleton
              </button>
            </div>
          )}
        </div>
        <button
          data-testid="close-all-scans"
          onClick={handleClearAllScans}
          className="px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 rounded transition-colors"
        >
          Close All
        </button>
      </div>

      {/* 3D Viewer */}
      <div className="relative flex-1 flex flex-col">
        <PointCloudViewer
          scans={scans}
          selectedScanIds={selectedScanIds}
          onToggleVisibility={handleToggleScanVisibility}
          onToggleSelection={handleToggleScanSelection}
          onRemoveScan={handleRemoveScan}
          onSelectAll={handleSelectAll}
          onDeselectAll={handleDeselectAll}
          onUpdateScanData={handleUpdateScanData}
          onUpdateScanParams={handleUpdateScanParams}
          onUpdateScanLabel={handleUpdateScanLabel}
          onSave={handleSavePointCloud}
          onAddScan={handleAddScan}
          onAddScans={handleAddScans}
          onStitchScans={handleStitchScans}
          onUndoStitch={handleUndoStitch}
          canUndoStitch={canUndoStitch}
          importRefsCallback={handleImportRefsCallback}
          onViewerContentChange={setViewerHasContent}
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

      {/* Import progress modal for imports triggered from the viewer header
          (Import menu / File menu). Reuses the same BulkImportProgress
          component as the Helios XML and per-scan attach pathways so every
          import shows an identical modal. */}
      <BulkImportProgress progress={importProgress} />

      {/* Drag overlay */}
      {isDragOver && (
        <div className="fixed inset-0 bg-slate-500/20 backdrop-blur-sm flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-white rounded-2xl p-8 shadow-2xl">
            <FileUp className="w-16 h-16 text-slate-600 mx-auto mb-4" />
            <p className="text-xl font-medium text-slate-800">Drop to load scans</p>
          </div>
        </div>
      )}

      <ToastContainer />
      </div>
    </div>
  );
}

export default App;
