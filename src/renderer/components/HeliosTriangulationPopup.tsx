import { useState, useCallback, useMemo, useEffect } from 'react';
import { X, Triangle, FileText, Upload } from 'lucide-react';
// File open + read helpers, backed by preload's window.electronAPI.
const open = async (opts: { multiple?: boolean; filters?: { name: string; extensions: string[] }[] }) => {
  return window.electronAPI.dialog.open({ multi: opts.multiple, filters: opts.filters });
};
const readTextFile = (path: string) => window.electronAPI.fs.readText(path);
import { HeliosTriangulationRequest } from '../utils/backendApi';
import type { PointCloudEntry } from './PointCloudViewer';

interface ScanPosition {
  x: number;
  y: number;
  z: number;
}

interface HeliosTriangulationPopupProps {
  isOpen: boolean;
  onClose: () => void;
  onStartTriangulate: (request: HeliosTriangulationRequest) => void;
  clouds: PointCloudEntry[];
  initialSelectedIds?: Set<string>;
}

export function HeliosTriangulationPopup({ isOpen, onClose, onStartTriangulate, clouds, initialSelectedIds }: HeliosTriangulationPopupProps) {
  const [positions, setPositions] = useState<Record<string, ScanPosition>>({});
  const [selectedCloudIds, setSelectedCloudIds] = useState<Set<string>>(new Set());

  // Sync selection from viewer when popup opens
  useEffect(() => {
    if (isOpen && initialSelectedIds && initialSelectedIds.size > 0) {
      setSelectedCloudIds(new Set(initialSelectedIds));
    }
  }, [isOpen]);
  const [lmaxStr, setLmaxStr] = useState('0.1');
  const [maxAspectRatioStr, setMaxAspectRatioStr] = useState('4.0');
  const [thetaMinStr, setThetaMinStr] = useState('30');
  const [thetaMaxStr, setThetaMaxStr] = useState('130');
  const [phiMinStr, setPhiMinStr] = useState('0');
  const [phiMaxStr, setPhiMaxStr] = useState('360');
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [scanDirectory, setScanDirectory] = useState<string | null>(null);

  const getPosition = useCallback((cloudId: string): ScanPosition => {
    return positions[cloudId] || { x: 0, y: 0, z: 0 };
  }, [positions]);

  const updatePosition = useCallback((cloudId: string, axis: 'x' | 'y' | 'z', value: number) => {
    setPositions(prev => ({
      ...prev,
      [cloudId]: { ...prev[cloudId] || { x: 0, y: 0, z: 0 }, [axis]: value },
    }));
  }, []);

  const toggleCloud = useCallback((cloudId: string) => {
    setSelectedCloudIds(prev => {
      const next = new Set(prev);
      if (next.has(cloudId)) {
        next.delete(cloudId);
      } else {
        next.add(cloudId);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedCloudIds(new Set(clouds.map(c => c.id)));
  }, [clouds]);

  const deselectAll = useCallback(() => {
    setSelectedCloudIds(new Set());
  }, []);

  // Strip extension from filename for matching
  const stripExtension = (filename: string): string => {
    const lastDot = filename.lastIndexOf('.');
    return lastDot > 0 ? filename.substring(0, lastDot) : filename;
  };

  const parsePositionsContent = useCallback((content: string) => {
    const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));

    // Build a lookup from cloud filename (without extension) to cloud id
    const nameToCloudId: Record<string, string> = {};
    for (const cloud of clouds) {
      const name = cloud.data.fileName || cloud.id;
      nameToCloudId[stripExtension(name).toLowerCase()] = cloud.id;
    }

    let matchCount = 0;
    const newPositions = { ...positions };
    const matchedIds: string[] = [];

    for (const line of lines) {
      // Support tab, comma, or multi-space delimiters
      const parts = line.trim().split(/[\t,]+|\s{2,}|\s+/);
      if (parts.length < 4) continue;

      const scanName = parts[0].toLowerCase();
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      const z = parseFloat(parts[3]);

      if (isNaN(x) || isNaN(y) || isNaN(z)) continue;

      // Try exact match first, then without extension
      const cloudId = nameToCloudId[scanName] || nameToCloudId[stripExtension(scanName)];
      if (cloudId) {
        newPositions[cloudId] = { x, y, z };
        matchedIds.push(cloudId);
        matchCount++;
      }
    }

    setPositions(newPositions);
    if (matchedIds.length > 0) {
      setSelectedCloudIds(prev => new Set([...prev, ...matchedIds]));
    }

    if (matchCount === 0) {
      setError('No scan names in the file matched loaded point clouds');
    } else {
      setError(null);
    }
  }, [clouds, positions]);

  const importPositionsFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{
        name: 'Position Files',
        extensions: ['txt', 'csv', 'tsv', 'pos'],
      }],
    });
    if (!selected) return;

    try {
      const filePath = selected as string;
      const content = await readTextFile(filePath);
      parsePositionsContent(content);

      // Remember the CSV's directory so we can construct scan file paths later.
      // Scan files are assumed to live alongside the CSV (typical for scanner exports).
      const lastSlash = filePath.lastIndexOf('/');
      const lastBackslash = filePath.lastIndexOf('\\');
      const sepIdx = Math.max(lastSlash, lastBackslash);
      if (sepIdx > 0) {
        setScanDirectory(filePath.substring(0, sepIdx));
      }
    } catch (err) {
      setError(`Failed to read positions file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [parsePositionsContent]);

  // Browser-level drag handlers on the popup container.
  // stopPropagation prevents the root react-dropzone from seeing the events.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    // Only clear when leaving the popup entirely (not moving between children)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const reader = new FileReader();
      reader.onload = () => {
        parsePositionsContent(reader.result as string);
      };
      reader.onerror = () => {
        setError('Failed to read dropped file');
      };
      reader.readAsText(files[0]);
    }
  }, [parsePositionsContent]);

  const selectedClouds = useMemo(() =>
    clouds.filter(c => selectedCloudIds.has(c.id)),
    [clouds, selectedCloudIds]
  );

  const handleTriangulate = useCallback(() => {
    setError(null);

    if (selectedClouds.length === 0) {
      setError('Select at least one point cloud');
      return;
    }

    // File-path mode: when scanDirectory is set and all selected clouds have fileNames,
    // send file paths so the backend reads scan files directly from disk.
    const useFilePaths = scanDirectory != null &&
      selectedClouds.every(c => c.data.fileName);

    const scans = selectedClouds.map(cloud => {
      const pos = getPosition(cloud.id);
      const origin = [pos.x, pos.y, pos.z];

      if (useFilePaths) {
        return {
          file_path: `${scanDirectory}/${cloud.data.fileName}`,
          origin,
        };
      } else {
        // Fallback: serialize all points into the request (slow for large scans)
        const points: number[][] = [];
        for (let i = 0; i < cloud.data.pointCount; i++) {
          const idx = i * 3;
          points.push([
            cloud.data.positions[idx],
            cloud.data.positions[idx + 1],
            cloud.data.positions[idx + 2],
          ]);
        }
        return { points, origin };
      }
    });

    const lmax = parseFloat(lmaxStr) || 0.1;
    const maxAspectRatio = parseFloat(maxAspectRatioStr) || 4.0;
    const thetaMin = parseFloat(thetaMinStr) || 0;
    const thetaMax = parseFloat(thetaMaxStr) || 130;
    const phiMin = parseFloat(phiMinStr) || 0;
    const phiMax = parseFloat(phiMaxStr) || 360;

    const request: HeliosTriangulationRequest = {
      scans,
      lmax,
      max_aspect_ratio: maxAspectRatio,
      theta_min: thetaMin,
      theta_max: thetaMax,
      phi_min: phiMin,
      phi_max: phiMax,
    };

    // Emit request to parent and close popup immediately
    onStartTriangulate(request);
    onClose();
  }, [selectedClouds, getPosition, scanDirectory, lmaxStr, maxAspectRatioStr, thetaMinStr, thetaMaxStr, phiMinStr, phiMaxStr, onStartTriangulate, onClose]);

  if (!isOpen) return null;

  const totalPoints = selectedClouds.reduce((sum, c) => sum + c.data.pointCount, 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleFileDrop}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div data-testid="helios-triangulation-popup" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-2xl mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Triangle className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">Helios Triangulation Setup</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 transition-colors"
          >
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Scan positions drop zone */}
          <div
            onClick={importPositionsFile}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed cursor-pointer transition-all ${
              isDragging
                ? 'border-green-500 bg-green-500/10'
                : 'border-neutral-600 hover:border-neutral-500 bg-neutral-900/30'
            }`}
          >
            <Upload className={`w-4 h-4 flex-shrink-0 ${isDragging ? 'text-green-400' : 'text-neutral-500'}`} />
            <div className="flex-1 min-w-0">
              <p className={`text-[11px] ${isDragging ? 'text-green-300' : 'text-neutral-400'}`}>
                {isDragging ? 'Drop positions file here' : 'Drop or click to import scan positions file'}
              </p>
              <p className="text-[9px] text-neutral-600 truncate">
                Format: ScanName  X  Y  Z (tab/space/comma separated)
              </p>
            </div>
            <FileText className="w-3.5 h-3.5 text-neutral-600 flex-shrink-0" />
          </div>

          {/* Select controls + count */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-neutral-300">Point Clouds</label>
              <span className="text-[10px] text-neutral-500">
                ({selectedCloudIds.size}/{clouds.length} selected)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={selectAll}
                className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                All
              </button>
              <span className="text-neutral-600 text-[10px]">|</span>
              <button
                onClick={deselectAll}
                className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                None
              </button>
            </div>
          </div>

          {/* Cloud list with scan positions */}
          {clouds.length === 0 ? (
            <div className="p-4 text-center text-xs text-neutral-500">
              No point clouds loaded. Import scans first.
            </div>
          ) : (
            <div className="border border-neutral-700 rounded-lg overflow-hidden">
              {/* Column headers */}
              <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 px-3 py-2 bg-neutral-900/80 border-b border-neutral-700 items-center">
                <div className="w-4" />
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider">Cloud</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-20 text-center">X</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-20 text-center">Y</span>
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider w-20 text-center">Z</span>
              </div>

              {/* Cloud rows */}
              <div className="max-h-[35vh] overflow-y-auto">
                {clouds.map((cloud) => {
                  const isSelected = selectedCloudIds.has(cloud.id);
                  const pos = getPosition(cloud.id);
                  const fileName = cloud.data.fileName || 'Unnamed';

                  return (
                    <div
                      key={cloud.id}
                      className={`grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 px-3 py-2 items-center border-b border-neutral-700/50 transition-colors ${
                        isSelected ? 'bg-neutral-700/30' : 'bg-neutral-800/50 opacity-60'
                      }`}
                    >
                      {/* Checkbox */}
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleCloud(cloud.id)}
                        className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-green-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                      />

                      {/* Cloud name + point count */}
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: cloud.color }}
                        />
                        <span className="text-xs text-white truncate" title={fileName}>
                          {fileName}
                        </span>
                        <span className="text-[9px] text-neutral-500 flex-shrink-0">
                          {cloud.data.pointCount.toLocaleString()} pts
                        </span>
                      </div>

                      {/* X, Y, Z position inputs */}
                      <input
                        type="number"
                        value={pos.x}
                        onChange={(e) => updatePosition(cloud.id, 'x', parseFloat(e.target.value) || 0)}
                        step="any"
                        className="w-20 px-1.5 py-1 bg-neutral-700 border border-neutral-600 rounded text-[11px] text-white text-center focus:outline-none focus:ring-1 focus:ring-green-500/50"
                        disabled={!isSelected}
                      />
                      <input
                        type="number"
                        value={pos.y}
                        onChange={(e) => updatePosition(cloud.id, 'y', parseFloat(e.target.value) || 0)}
                        step="any"
                        className="w-20 px-1.5 py-1 bg-neutral-700 border border-neutral-600 rounded text-[11px] text-white text-center focus:outline-none focus:ring-1 focus:ring-green-500/50"
                        disabled={!isSelected}
                      />
                      <input
                        type="number"
                        value={pos.z}
                        onChange={(e) => updatePosition(cloud.id, 'z', parseFloat(e.target.value) || 0)}
                        step="any"
                        className="w-20 px-1.5 py-1 bg-neutral-700 border border-neutral-600 rounded text-[11px] text-white text-center focus:outline-none focus:ring-1 focus:ring-green-500/50"
                        disabled={!isSelected}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Algorithm Parameters */}
          <div className="border-t border-neutral-700 pt-4">
            <label className="text-xs font-medium text-neutral-300 block mb-3">Parameters</label>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Max Edge Length (Lmax)
                </label>
                <input
                  data-testid="helios-input-lmax"
                  type="number"
                  value={lmaxStr}
                  onChange={(e) => setLmaxStr(e.target.value)}
                  step="0.01"
                  min="0.001"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Filters large triangles</p>
              </div>

              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Max Aspect Ratio
                </label>
                <input
                  data-testid="helios-input-aspect"
                  type="number"
                  value={maxAspectRatioStr}
                  onChange={(e) => setMaxAspectRatioStr(e.target.value)}
                  step="0.5"
                  min="1"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Filters skinny triangles</p>
              </div>
            </div>

            {/* Scan Angular Bounds */}
            <label className="text-xs font-medium text-neutral-300 block mt-4 mb-3">Scan Angular Bounds</label>

            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Theta Min
                </label>
                <input
                  type="number"
                  value={thetaMinStr}
                  onChange={(e) => setThetaMinStr(e.target.value)}
                  step="1"
                  min="0"
                  max="180"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Zenith min (deg)</p>
              </div>

              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Theta Max
                </label>
                <input
                  type="number"
                  value={thetaMaxStr}
                  onChange={(e) => setThetaMaxStr(e.target.value)}
                  step="1"
                  min="0"
                  max="180"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Zenith max (deg)</p>
              </div>

              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Phi Min
                </label>
                <input
                  type="number"
                  value={phiMinStr}
                  onChange={(e) => setPhiMinStr(e.target.value)}
                  step="1"
                  min="0"
                  max="360"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Azimuth min (deg)</p>
              </div>

              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">
                  Phi Max
                </label>
                <input
                  type="number"
                  value={phiMaxStr}
                  onChange={(e) => setPhiMaxStr(e.target.value)}
                  step="1"
                  min="0"
                  max="360"
                  className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                />
                <p className="text-[9px] text-neutral-500 mt-0.5">Azimuth max (deg)</p>
              </div>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-neutral-700 bg-neutral-800/90 flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-neutral-500">
              {selectedClouds.length > 0
                ? `${selectedClouds.length} cloud${selectedClouds.length > 1 ? 's' : ''}, ${totalPoints.toLocaleString()} total points`
                : 'No clouds selected'}
            </span>
            {scanDirectory && selectedClouds.length > 0 && (
              <span className="text-[9px] text-green-400">
                File-path mode ({selectedClouds.filter(c => c.data.fileName).length} scans from {scanDirectory.split('/').pop()})
              </span>
            )}
          </div>
          <button
            data-testid="helios-triangulate-button"
            onClick={handleTriangulate}
            disabled={selectedClouds.length === 0}
            className={`px-4 py-2 text-xs rounded font-medium flex items-center gap-2 ${
              selectedClouds.length === 0
                ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-500 text-white'
            }`}
          >
            <Triangle className="w-3.5 h-3.5" />
            Triangulate
          </button>
        </div>
      </div>
    </div>
  );
}
