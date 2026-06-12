import { useEffect, useMemo, useState } from 'react';
import { Download, FileCode, Loader2, Radio, X } from 'lucide-react';

export type ExportSelectionType =
  | 'cloud'
  | 'multiCloud'
  | 'mesh'
  | 'multiMesh'
  | 'skeleton'
  | 'mixed'
  | 'none';

// One scan that can be written to a Helios scan XML (it carries scanner params).
export interface ScanExportListItem {
  id: string;
  name: string;
  hasMisses: boolean;
  selected: boolean;   // selected in the Scans panel (pre-checks the export row)
}

// Presentational, context-sensitive export panel. The parent (PointCloudViewer)
// resolves the selected object's display name + secondary line and passes them
// in, so this component never reaches into the clouds/meshes/skeletons arrays.
// Export handlers are wired through the on*Export callbacks.
interface ExportPanelProps {
  selectionType: ExportSelectionType;
  // Whether a single cloud is selected (drives the point-cloud export block).
  singleCloudSelected: boolean;
  cloudName: string;
  // Every scan (cloud with scanner params) that can be written to a Helios scan
  // XML, with its current miss/selection state. The panel shows these as a
  // checkbox list so the user can export one, several, or all scans into one
  // bundle — independent of which clouds are selected in the viewport.
  scanExportList: ScanExportListItem[];
  // Mesh export block (rendered when selectionType === 'mesh' && a mesh is set).
  meshSelected: boolean;
  meshName: string;
  meshTriangleCount: number;
  isScanning: boolean;
  // Skeleton export block (rendered when selectionType === 'skeleton' && set).
  skeletonSelected: boolean;
  skeletonName: string;
  skeletonNodeCount: number;
  skeletonTotalLength: number;
  onClose: () => void;
  onExportCloud: (format: 'xyz' | 'txt' | 'csv' | 'ply' | 'obj' | 'las' | 'laz') => void;
  // Export the chosen scans as a single Helios XML + per-scan ASCII bundle.
  // `scanIds` are the checked scans; `includeMisses` whether sky/miss points
  // are written.
  onExportScanXml: (scanIds: string[], includeMisses: boolean) => void;
  onExportMesh: (format: 'obj' | 'ply' | 'stl') => void;
  onExportSkeleton: (format: 'obj' | 'ply' | 'json') => void;
  onRunScan: () => void;
}

export function ExportPanel({
  selectionType,
  singleCloudSelected,
  cloudName,
  scanExportList,
  meshSelected,
  meshName,
  meshTriangleCount,
  isScanning,
  skeletonSelected,
  skeletonName,
  skeletonNodeCount,
  skeletonTotalLength,
  onClose,
  onExportCloud,
  onExportScanXml,
  onExportMesh,
  onExportSkeleton,
  onRunScan,
}: ExportPanelProps) {
  // "Include miss points" is meaningful only when a checked scan has misses;
  // default it on so a round-trip export is lossless by default.
  const [includeMisses, setIncludeMisses] = useState(true);
  // Which scans are checked for XML export. Seeded from the Scans-panel
  // selection; the user can change it without affecting the viewport selection.
  const [checkedScanIds, setCheckedScanIds] = useState<Set<string>>(new Set());
  const scanListKey = useMemo(
    () => scanExportList.map(s => `${s.id}:${s.selected}`).join(','),
    [scanExportList]);
  useEffect(() => {
    // Re-seed when the available scans / selection change (e.g. a new import).
    const seeded = scanExportList.filter(s => s.selected).map(s => s.id);
    // If nothing is selected but scans exist, default to all (so the panel is
    // never accidentally a no-op).
    setCheckedScanIds(new Set(seeded.length ? seeded : scanExportList.map(s => s.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanListKey]);

  const checkedScans = scanExportList.filter(s => checkedScanIds.has(s.id));
  const anyCheckedHasMisses = checkedScans.some(s => s.hasMisses);
  const toggleScan = (id: string) => setCheckedScanIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div data-testid="export-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Download className="w-3 h-3" />
          Export {selectionType === 'cloud' ? 'Point Cloud'
            : selectionType === 'mesh' ? 'Mesh'
            : selectionType === 'skeleton' ? 'Skeleton'
            : scanExportList.length > 0 ? 'Scans'
            : ''}
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      {/* Point Cloud Export */}
      {selectionType === 'cloud' && singleCloudSelected && (
        <div className="mb-4">
          <div className="text-[10px] font-medium text-neutral-400 mb-2">
            {cloudName || 'Point Cloud'}
          </div>
          <div className="grid grid-cols-3 gap-1">
            <button
              data-testid="export-cloud-las"
              onClick={() => onExportCloud('las')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              LAS
            </button>
            <button
              data-testid="export-cloud-laz"
              onClick={() => onExportCloud('laz')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
              title="Compressed LAS (requires backend)"
            >
              LAZ
            </button>
            <button
              data-testid="export-cloud-ply"
              onClick={() => onExportCloud('ply')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              PLY
            </button>
            <button
              data-testid="export-cloud-xyz"
              onClick={() => onExportCloud('xyz')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              XYZ
            </button>
            <button
              data-testid="export-cloud-csv"
              onClick={() => onExportCloud('csv')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              CSV
            </button>
            <button
              data-testid="export-cloud-txt"
              onClick={() => onExportCloud('txt')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
              title="Space-delimited with header and scalar fields"
            >
              TXT
            </button>
            <button
              data-testid="export-cloud-obj"
              onClick={() => onExportCloud('obj')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              OBJ
            </button>
          </div>
        </div>
      )}

      {/* Scan export: a Helios XML + one ASCII data file per scan, re-loadable
          back into Phytograph/Helios (preserves scanner params + is_miss). Shown
          whenever any scan (cloud with scanner params) exists, regardless of how
          many clouds are selected — the checkbox list below drives what's written
          (seeded from the Scans-panel selection). */}
      {scanExportList.length > 0 && (
        <div className="mb-4" data-testid="export-scan-section">
          <div className="text-[10px] font-medium text-neutral-400 mb-2 flex items-center gap-1.5">
            <FileCode className="w-3 h-3" />
            Scan info (XML + per-scan data)
          </div>
          <div className="text-[10px] text-neutral-500 mb-2">
            Choose which scan(s) to write into one XML bundle (one data file per
            scan).
          </div>
          <div className="max-h-32 overflow-y-auto mb-2 rounded border border-neutral-700/60 divide-y divide-neutral-700/40">
            {scanExportList.map(s => (
              <label
                key={s.id}
                data-testid="export-scan-row"
                data-scan-name={s.name}
                data-checked={checkedScanIds.has(s.id) ? 'true' : 'false'}
                className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-neutral-200 cursor-pointer hover:bg-neutral-700/40"
              >
                <input
                  type="checkbox"
                  checked={checkedScanIds.has(s.id)}
                  onChange={() => toggleScan(s.id)}
                  className="accent-green-600"
                />
                <span className="truncate flex-1" title={s.name}>{s.name}</span>
                {s.hasMisses && (
                  <span className="text-[9px] text-neutral-500" title="Carries sky/miss points">misses</span>
                )}
              </label>
            ))}
          </div>
          <label
            className={`flex items-center gap-2 text-[11px] mb-2 ${
              anyCheckedHasMisses ? 'text-neutral-200 cursor-pointer' : 'text-neutral-500 cursor-not-allowed'
            }`}
            title={anyCheckedHasMisses
              ? 'Write the sky/miss points (and the is_miss column) into the export.'
              : 'None of the checked scans carry sky/miss points.'}
          >
            <input
              type="checkbox"
              data-testid="export-scan-include-misses"
              checked={includeMisses && anyCheckedHasMisses}
              disabled={!anyCheckedHasMisses}
              onChange={(e) => setIncludeMisses(e.target.checked)}
              className="accent-green-600"
            />
            Include miss points
          </label>
          <button
            data-testid="export-scan-xml"
            onClick={() => onExportScanXml([...checkedScanIds], includeMisses && anyCheckedHasMisses)}
            disabled={checkedScans.length === 0}
            className={`w-full px-2 py-1.5 rounded text-xs flex items-center justify-center gap-1.5 ${
              checkedScans.length > 0
                ? 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
                : 'bg-neutral-700/50 text-neutral-500 cursor-not-allowed'
            }`}
          >
            <FileCode className="w-3 h-3" />
            Write scan XML{checkedScans.length > 1 ? ` (${checkedScans.length})` : ''}
          </button>
        </div>
      )}

      {/* Selected Mesh Export */}
      {selectionType === 'mesh' && meshSelected && (
        <div className="mb-4">
          <div className="text-[10px] font-medium text-neutral-400 mb-2">
            {meshName}
          </div>
          <div className="text-[10px] text-neutral-500 mb-2">
            {meshTriangleCount.toLocaleString()} triangles
          </div>
          <div className="grid grid-cols-3 gap-1">
            <button
              data-testid="export-mesh-obj"
              onClick={() => onExportMesh('obj')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              OBJ
            </button>
            <button
              data-testid="export-mesh-ply"
              onClick={() => onExportMesh('ply')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              PLY
            </button>
            <button
              data-testid="export-mesh-stl"
              onClick={() => onExportMesh('stl')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              STL
            </button>
          </div>
          {/* Synthetic LiDAR Scan button */}
          <button
            onClick={onRunScan}
            disabled={isScanning}
            className="mt-2 w-full px-2 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:cursor-not-allowed rounded text-xs text-white flex items-center justify-center gap-1.5"
          >
            {isScanning ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <Radio className="w-3 h-3" />
                Synthetic LiDAR Scan
              </>
            )}
          </button>
        </div>
      )}

      {/* Selected Skeleton Export */}
      {selectionType === 'skeleton' && skeletonSelected && (
        <div className="mb-4">
          <div className="text-[10px] font-medium text-neutral-400 mb-2">
            {skeletonName || 'Skeleton'}
          </div>
          <div className="text-[10px] text-neutral-500 mb-2">
            {skeletonNodeCount} nodes · {skeletonTotalLength.toFixed(2)}m
          </div>
          <div className="grid grid-cols-3 gap-1">
            <button
              onClick={() => onExportSkeleton('obj')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              OBJ
            </button>
            <button
              onClick={() => onExportSkeleton('ply')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              PLY
            </button>
            <button
              onClick={() => onExportSkeleton('json')}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs text-neutral-200"
            >
              JSON
            </button>
          </div>
        </div>
      )}

      {/* Fallback message: nothing exportable in this selection. Shown when no
          per-type block rendered AND there are no scans to write — e.g. a
          multi-cloud selection of clouds that carry no scanner parameters, or an
          empty selection. */}
      {!(selectionType === 'cloud' && singleCloudSelected)
        && selectionType !== 'mesh'
        && selectionType !== 'skeleton'
        && scanExportList.length === 0 && (
        <div className="text-[10px] text-neutral-500 text-center py-2">
          {selectionType === 'none'
            ? 'Select an object to export'
            : 'Nothing in this selection can be exported here. Select a single cloud, mesh, or skeleton — or a scan with parameters.'}
        </div>
      )}
    </div>
  );
}
