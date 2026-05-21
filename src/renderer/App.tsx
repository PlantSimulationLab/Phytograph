import { useState, useCallback, useRef, useEffect } from "react";
import { Upload, Home, Box, Cog, Layers, FileUp, X, AlertCircle, Loader2, ChevronDown, Sparkles, GitBranch } from "lucide-react";
import * as THREE from 'three';
import { useDropzone } from "react-dropzone";
import { ToastContainer, showToast } from "./components/Toast";
import { BackendStatusBanner } from "./components/BackendStatusBanner";
import PointCloudViewer, { type PointCloudData, type PointCloudEntry, type ImportRefs } from "./components/PointCloudViewer";
import { parsePointCloud, parseMesh, parseSkeleton, isMeshFile, isSkeletonFile, POINT_CLOUD_FORMATS, MESH_FORMATS, SKELETON_FORMATS } from "./lib/pointCloudParsers";
import logoImage from "./assets/logo.png";

type NavItem = 'home' | 'viewer' | 'options';
type ImportType = 'auto' | 'pointcloud' | 'mesh' | 'skeleton';

// Predefined colors for point clouds (for labels/identification)
const CLOUD_COLORS = [
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
  const [activeNav, setActiveNav] = useState<NavItem>('home');
  const [pointClouds, setPointClouds] = useState<PointCloudEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const pendingImportTypeRef = useRef<ImportType>('auto');
  const importMenuRef = useRef<HTMLDivElement>(null);

  // Import refs from PointCloudViewer for mesh/skeleton imports
  const importRefsRef = useRef<ImportRefs | null>(null);
  const handleImportRefsCallback = useCallback((refs: ImportRefs) => {
    importRefsRef.current = refs;
  }, []);

  // Stitch history for undo
  interface StitchHistoryEntry {
    originalClouds: PointCloudEntry[];
    stitchedCloudId: string;
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

  // Get next available color
  const getNextColor = useCallback(() => {
    const usedColors = new Set(pointClouds.map(pc => pc.color));
    return CLOUD_COLORS.find(c => !usedColors.has(c)) || CLOUD_COLORS[pointClouds.length % CLOUD_COLORS.length];
  }, [pointClouds]);

  const handleFileUpload = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);

    const importType = pendingImportTypeRef.current;

    try {
      // Determine how to import based on user selection or auto-detect
      let shouldImportAsMesh = false;
      let shouldImportAsSkeleton = false;
      let shouldImportAsPointCloud = false;

      if (importType === 'mesh') {
        shouldImportAsMesh = true;
      } else if (importType === 'skeleton') {
        shouldImportAsSkeleton = true;
      } else if (importType === 'pointcloud') {
        shouldImportAsPointCloud = true;
      } else {
        // Auto-detect based on file extension
        if (isMeshFile(file.name)) {
          shouldImportAsMesh = true;
        } else if (isSkeletonFile(file.name)) {
          shouldImportAsSkeleton = true;
        } else {
          shouldImportAsPointCloud = true;
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
        // Parse as point cloud (default)
        const data = await parsePointCloud(file);
        const newEntry: PointCloudEntry = {
          id: crypto.randomUUID(),
          data,
          visible: true,
          color: getNextColor(),
        };

        setPointClouds(prev => [...prev, newEntry]);
        setSelectedIds(new Set([newEntry.id])); // Select the newly added cloud
        setActiveNav('viewer');
        showToast({ title: `Loaded ${data.pointCount.toLocaleString()} points from ${file.name}`, type: 'success' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse file';
      setError(message);
      showToast({ title: message, type: 'error' });
    } finally {
      setLoading(false);
      // Reset import type to auto after import
      pendingImportTypeRef.current = 'auto';
    }
  }, [getNextColor]);

  // Handle multiple files
  const handleMultipleFiles = useCallback(async (files: File[]) => {
    setLoading(true);
    setError(null);
    const newEntries: PointCloudEntry[] = [];
    const errors: string[] = [];
    let meshCount = 0;
    let skeletonCount = 0;
    let colorIndex = 0;

    const importType = pendingImportTypeRef.current;

    const getColorForFile = () => {
      const usedColors = new Set([...pointClouds.map(pc => pc.color), ...newEntries.map(e => e.color)]);
      // Skip colors that are already used
      while (usedColors.has(CLOUD_COLORS[colorIndex % CLOUD_COLORS.length]) && colorIndex < CLOUD_COLORS.length * 2) {
        colorIndex++;
      }
      const color = CLOUD_COLORS[colorIndex % CLOUD_COLORS.length];
      colorIndex++;
      return color;
    };

    for (const file of files) {
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
          // Parse as point cloud (default)
          const data = await parsePointCloud(file);
          newEntries.push({
            id: crypto.randomUUID(),
            data,
            visible: true,
            color: getColorForFile(),
          });
        }
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : 'Failed to parse'}`);
      }
    }

    if (newEntries.length > 0) {
      setPointClouds(prev => [...prev, ...newEntries]);
      setSelectedIds(new Set(newEntries.map(e => e.id)));
    }

    const loadedCount = newEntries.length + meshCount + skeletonCount;
    if (loadedCount > 0) {
      setActiveNav('viewer');
      const parts = [];
      if (newEntries.length > 0) parts.push(`${newEntries.length} point cloud(s)`);
      if (meshCount > 0) parts.push(`${meshCount} mesh(es)`);
      if (skeletonCount > 0) parts.push(`${skeletonCount} skeleton(s)`);
      showToast({ title: `Loaded ${parts.join(', ')}`, type: 'success' });
    }

    if (errors.length > 0) {
      setError(errors.join('\n'));
      showToast({ title: `Failed to load ${errors.length} file(s)`, type: 'error' });
    }

    setLoading(false);
    // Reset import type to auto after import
    pendingImportTypeRef.current = 'auto';
  }, [pointClouds]);

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

  const handleClearAllClouds = () => {
    setPointClouds([]);
    setSelectedIds(new Set());
    setActiveNav('home');
  };

  const handleRemoveCloud = useCallback((id: string) => {
    setPointClouds(prev => prev.filter(pc => pc.id !== id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleToggleVisibility = useCallback((id: string) => {
    setPointClouds(prev => prev.map(pc =>
      pc.id === id ? { ...pc, visible: !pc.visible } : pc
    ));
  }, []);

  const handleToggleSelection = useCallback((id: string, multiSelect: boolean) => {
    setSelectedIds(prev => {
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
    setSelectedIds(new Set(pointClouds.map(pc => pc.id)));
  }, [pointClouds]);

  const handleDeselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleUpdateCloud = useCallback((id: string, data: PointCloudData) => {
    setPointClouds(prev => prev.map(pc =>
      pc.id === id ? { ...pc, data } : pc
    ));
  }, []);

  const handleAddCloud = useCallback((cloud: PointCloudEntry) => {
    setPointClouds(prev => [...prev, cloud]);
    setSelectedIds(new Set([cloud.id]));
  }, []);

  // Stitch multiple clouds into one
  const handleStitchClouds = useCallback((ids: string[]) => {
    if (ids.length < 2) return;

    // Get the clouds to stitch
    const cloudsToStitch = pointClouds.filter(pc => ids.includes(pc.id));
    if (cloudsToStitch.length < 2) return;

    // Calculate total points
    const totalPoints = cloudsToStitch.reduce((sum, pc) => sum + pc.data.pointCount, 0);

    // Check if any cloud has colors or intensities
    const hasColors = cloudsToStitch.some(pc => pc.data.colors);
    const hasIntensities = cloudsToStitch.some(pc => pc.data.intensities);

    // Allocate arrays for combined data
    const positions = new Float32Array(totalPoints * 3);
    const colors = hasColors ? new Float32Array(totalPoints * 3) : undefined;
    const intensities = hasIntensities ? new Float32Array(totalPoints) : undefined;

    // Copy data from each cloud
    let offset = 0;
    for (const cloud of cloudsToStitch) {
      const { data } = cloud;
      // Copy positions
      positions.set(data.positions, offset * 3);

      // Copy colors (default to white if not present)
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

      // Copy intensities (default to 1 if not present)
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

    // Calculate bounds
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

    // Create file name from source names
    const fileNames = cloudsToStitch.map(c => c.data.fileName?.replace(/\.[^.]+$/, '') || 'cloud');
    const newFileName = `${fileNames.join('_')}_stitched`;

    // Create the combined cloud data
    const combinedData: PointCloudData = {
      positions,
      colors,
      intensities,
      pointCount: totalPoints,
      bounds: { min, max, center, size },
      fileName: newFileName,
    };

    // Create the new cloud entry
    const newCloud: PointCloudEntry = {
      id: crypto.randomUUID(),
      data: combinedData,
      visible: true,
      color: cloudsToStitch[0].color, // Use first cloud's color
    };

    // Save to stitch history for undo
    stitchHistoryRef.current.push({
      originalClouds: cloudsToStitch.map(c => ({ ...c })), // Deep copy entries
      stitchedCloudId: newCloud.id,
    });

    // Remove old clouds and add new one
    setPointClouds(prev => {
      const filtered = prev.filter(pc => !ids.includes(pc.id));
      return [...filtered, newCloud];
    });

    // Select the new stitched cloud
    setSelectedIds(new Set([newCloud.id]));

    showToast({
      type: 'success',
      title: 'Clouds Stitched',
      message: `Combined ${cloudsToStitch.length} clouds into ${totalPoints.toLocaleString()} points`,
    });
  }, [pointClouds]);

  // Undo stitch operation
  const handleUndoStitch = useCallback(() => {
    const lastStitch = stitchHistoryRef.current.pop();
    if (!lastStitch) return false;

    // Remove the stitched cloud and restore original clouds
    setPointClouds(prev => {
      const filtered = prev.filter(pc => pc.id !== lastStitch.stitchedCloudId);
      return [...filtered, ...lastStitch.originalClouds];
    });

    // Select the restored clouds
    setSelectedIds(new Set(lastStitch.originalClouds.map(c => c.id)));

    showToast({
      type: 'info',
      title: 'Stitch Undone',
      message: `Restored ${lastStitch.originalClouds.length} original clouds`,
    });

    return true;
  }, []);

  // Check if there's a stitch to undo
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

  // Calculate total points
  const totalPoints = pointClouds.reduce((sum, pc) => sum + pc.data.pointCount, 0);

  // Render the home screen
  const renderHome = () => (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-2xl">
        <div className="flex items-center justify-center gap-3 mb-6">
          <img src={logoImage} alt="Phytograph" className="w-12 h-12 object-contain" />
          <h1 className="text-4xl font-bold text-slate-800">Phytograph</h1>
        </div>
        <p className="text-slate-600 mb-8 text-lg">
          Point cloud processing for plant science research.
        </p>

        {/* Upload area */}
        <div
          onClick={open}
          className={`
            border-2 border-dashed rounded-2xl p-12 cursor-pointer transition-all
            ${isDragOver
              ? 'border-slate-500 bg-slate-100'
              : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50'
            }
          `}
        >
          {loading ? (
            <div className="flex flex-col items-center">
              <Loader2 className="w-12 h-12 text-slate-600 animate-spin mb-4" />
              <p className="text-slate-600">Loading point cloud...</p>
            </div>
          ) : (
            <>
              <FileUp className={`w-12 h-12 mx-auto mb-4 ${isDragOver ? 'text-slate-600' : 'text-slate-400'}`} />
              <p className="text-lg font-medium text-slate-700 mb-2">
                Drop point cloud files here
              </p>
              <p className="text-slate-500 mb-4">or click to browse (multiple files supported)</p>
              <div className="flex flex-wrap justify-center gap-2">
                {POINT_CLOUD_FORMATS.map(f => (
                  <span key={f.ext} className="px-2 py-1 bg-blue-50 rounded text-xs text-blue-600">
                    {f.ext}
                  </span>
                ))}
                {MESH_FORMATS.map(f => (
                  <span key={f.ext} className="px-2 py-1 bg-green-50 rounded text-xs text-green-600">
                    {f.ext}
                  </span>
                ))}
                {SKELETON_FORMATS.map(f => (
                  <span key={f.ext} className="px-2 py-1 bg-amber-50 rounded text-xs text-amber-600">
                    {f.ext}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Error display */}
        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="text-left">
              <p className="text-red-800 font-medium">Error loading file</p>
              <p className="text-red-600 text-sm whitespace-pre-wrap">{error}</p>
            </div>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-red-400 hover:text-red-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

      </div>
    </div>
  );

  // Render the 3D viewer
  const renderViewer = () => (
    <div className="flex-1 flex flex-col">
      {/* Toolbar */}
      <div className="bg-neutral-800 border-b border-neutral-700 px-4 py-2 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Box className="w-4 h-4 text-neutral-400" />
          <span className="text-sm font-medium text-neutral-200">
            {pointClouds.length} Cloud{pointClouds.length !== 1 ? 's' : ''}
          </span>
          <span className="text-xs text-neutral-500">
            ({totalPoints.toLocaleString()} total points)
          </span>
        </div>
        <div className="flex-1" />
        <div className="relative" ref={importMenuRef}>
          <button
            onClick={() => setShowImportMenu(!showImportMenu)}
            className="px-3 py-1.5 text-sm bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 transition-colors flex items-center gap-1"
          >
            <Upload className="w-4 h-4" />
            Import
            <ChevronDown className="w-3 h-3" />
          </button>
          {showImportMenu && (
            <div className="absolute top-full right-0 mt-1 bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg py-1 min-w-[180px] z-50">
              <button
                onClick={() => { pendingImportTypeRef.current = 'auto'; setShowImportMenu(false); open(); }}
                className="w-full px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700 flex items-center gap-2 text-left"
              >
                <Sparkles className="w-4 h-4 text-neutral-400" />
                Auto-detect
              </button>
              <div className="border-t border-neutral-700 my-1" />
              <button
                onClick={() => { pendingImportTypeRef.current = 'pointcloud'; setShowImportMenu(false); open(); }}
                className="w-full px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700 flex items-center gap-2 text-left"
              >
                <Layers className="w-4 h-4 text-blue-400" />
                Point Cloud
              </button>
              <button
                onClick={() => { pendingImportTypeRef.current = 'mesh'; setShowImportMenu(false); open(); }}
                className="w-full px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700 flex items-center gap-2 text-left"
              >
                <Box className="w-4 h-4 text-green-400" />
                Mesh
              </button>
              <button
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
          onClick={handleClearAllClouds}
          className="px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 rounded transition-colors"
        >
          Close All
        </button>
      </div>

      {/* 3D Viewer */}
      <PointCloudViewer
        clouds={pointClouds}
        selectedIds={selectedIds}
        onToggleVisibility={handleToggleVisibility}
        onToggleSelection={handleToggleSelection}
        onRemoveCloud={handleRemoveCloud}
        onSelectAll={handleSelectAll}
        onDeselectAll={handleDeselectAll}
        onUpdateCloud={handleUpdateCloud}
        onSave={handleSavePointCloud}
        onAddCloud={handleAddCloud}
        onStitchClouds={handleStitchClouds}
        onUndoStitch={handleUndoStitch}
        canUndoStitch={canUndoStitch}
        importRefsCallback={handleImportRefsCallback}
        className="flex-1"
      />
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
    <div {...getRootProps()} className="flex h-screen flex-col bg-slate-50 select-none">
      <input {...getInputProps()} />

      <BackendStatusBanner />

      <div className="flex flex-1 min-h-0">

      {/* Sidebar */}
      <div className="w-16 bg-neutral-900 flex flex-col items-center py-4 gap-2">
        {/* Logo */}
        <div className="mb-4">
          <img
            src={logoImage}
            alt="Phytograph"
            className="w-8 h-8 object-contain"
          />
        </div>

        {/* Navigation */}
        <button
          onClick={() => setActiveNav('home')}
          className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
            activeNav === 'home'
              ? 'bg-white text-neutral-900'
              : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
          }`}
          title="Home"
        >
          <Home className="w-5 h-5" />
        </button>

        <button
          onClick={() => setActiveNav('viewer')}
          className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
            activeNav === 'viewer'
              ? 'bg-white text-neutral-900'
              : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
          }`}
          title="3D Viewer"
        >
          <Box className="w-5 h-5" />
        </button>

        <div className="flex-1" />

        <button
          onClick={() => setActiveNav('options')}
          className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
            activeNav === 'options'
              ? 'bg-white text-neutral-900'
              : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
          }`}
          title="Settings"
        >
          <Cog className="w-5 h-5" />
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Home and Options pages - conditionally rendered */}
        {activeNav === 'home' && renderHome()}
        {activeNav === 'options' && renderOptions()}

        {/* Viewer - always mounted but hidden when not active to preserve state */}
        <div className={`absolute inset-0 flex flex-col ${activeNav === 'viewer' ? '' : 'invisible pointer-events-none'}`}>
          {renderViewer()}
        </div>
      </div>

      {/* Drag overlay */}
      {isDragOver && (
        <div className="fixed inset-0 bg-slate-500/20 backdrop-blur-sm flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-white rounded-2xl p-8 shadow-2xl">
            <FileUp className="w-16 h-16 text-slate-600 mx-auto mb-4" />
            <p className="text-xl font-medium text-slate-800">Drop to load point clouds</p>
          </div>
        </div>
      )}

      <ToastContainer />
      </div>
    </div>
  );
}

export default App;
