import { Download, Loader2, Radio, X } from 'lucide-react';

export type ExportSelectionType =
  | 'cloud'
  | 'multiCloud'
  | 'mesh'
  | 'multiMesh'
  | 'skeleton'
  | 'mixed'
  | 'none';

// Presentational, context-sensitive export panel. The parent (PointCloudViewer)
// resolves the selected object's display name + secondary line and passes them
// in, so this component never reaches into the clouds/meshes/skeletons arrays.
// Export handlers are wired through the on*Export callbacks.
interface ExportPanelProps {
  selectionType: ExportSelectionType;
  // Whether a single cloud is selected (drives the point-cloud export block).
  singleCloudSelected: boolean;
  cloudName: string;
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
  onExportMesh: (format: 'obj' | 'ply' | 'stl') => void;
  onExportSkeleton: (format: 'obj' | 'ply' | 'json') => void;
  onRunScan: () => void;
}

export function ExportPanel({
  selectionType,
  singleCloudSelected,
  cloudName,
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
  onExportMesh,
  onExportSkeleton,
  onRunScan,
}: ExportPanelProps) {
  return (
    <div data-testid="export-panel" className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64 max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Download className="w-3 h-3" />
          Export {selectionType === 'cloud' ? 'Point Cloud' : selectionType === 'mesh' ? 'Mesh' : selectionType === 'skeleton' ? 'Skeleton' : ''}
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

      {/* No selection message */}
      {selectionType === 'none' && (
        <div className="text-[10px] text-neutral-500 text-center py-2">
          Select an object to export
        </div>
      )}
    </div>
  );
}
