import { Box, Leaf, Eye, EyeOff, Trash2, ChevronRight, ChevronDown, Palette } from 'lucide-react';
import type { MeshEntry, MeshColorMode, PointCloudEntry } from '../../../lib/pointCloudTypes';
import { meshDisplayName } from '../../../lib/pointCloudTypes';
import { meshHasScanColors } from '../../../lib/pointCloudHelpers';
import { ColormapName, COLORMAP_NAMES } from '../../../lib/colormaps';

interface Vec3 { x: number; y: number; z: number }

// Presentational right-side list of meshes with per-mesh inline options
// (color-by, opacity), rename, color swatch, and the global wireframe toggle.
// All state, the mesh-classification predicates, and the handlers live in
// PointCloudViewer and are passed in; the predicates are forwarded as props
// because they're defined as component callbacks there. Parent gates on
// `meshes.length > 0`.
interface MeshesListPanelProps {
  meshes: MeshEntry[];
  clouds: PointCloudEntry[];
  selectedMeshIds: Set<string>;
  expandedMeshIds: Set<string>;
  renamingMeshId: string | null;
  renamingMeshValue: string;
  colorPopoverMeshId: string | null;
  meshColorModes: Map<string, MeshColorMode>;
  meshOpacities: Map<string, number>;
  meshRotations: Map<string, Vec3>;
  meshPositions: Map<string, Vec3>;
  meshScales: Map<string, Vec3>;
  colormap: ColormapName;
  meshWireframe: boolean;
  // Default opacity to surface for a mesh with no explicit per-mesh override.
  defaultOpacityFor: (mesh: MeshEntry) => number;
  // Mesh-classification predicates (defined as callbacks in the parent).
  isTextured: (mesh: MeshEntry) => boolean;
  isTriangulated: (mesh: MeshEntry) => boolean;
  supportsOpacity: (mesh: MeshEntry) => boolean;
  onSelect: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onRequestDelete: (id: string, name: string) => void;
  onToggleExpanded: (id: string) => void;
  onRename: (id: string, value: string) => void;
  onRenamingChange: (id: string | null, value: string) => void;
  // Opens the color popover for a mesh, anchored to the swatch's screen rect.
  onOpenColorPopover: (id: string, anchor: { top: number; left: number }) => void;
  onCloseColorPopover: () => void;
  onColorModeChange: (id: string, mode: MeshColorMode) => void;
  onColormapChange: (name: ColormapName) => void;
  onOpacityChange: (id: string, value: number) => void;
  onWireframeChange: (v: boolean) => void;
}

export function MeshesListPanel({
  meshes,
  clouds,
  selectedMeshIds,
  expandedMeshIds,
  renamingMeshId,
  renamingMeshValue,
  colorPopoverMeshId,
  meshColorModes,
  meshOpacities,
  meshRotations,
  meshPositions,
  meshScales,
  colormap,
  meshWireframe,
  defaultOpacityFor,
  isTextured,
  isTriangulated,
  supportsOpacity,
  onSelect,
  onToggleVisibility,
  onRequestDelete,
  onToggleExpanded,
  onRename,
  onRenamingChange,
  onOpenColorPopover,
  onCloseColorPopover,
  onColorModeChange,
  onColormapChange,
  onOpacityChange,
  onWireframeChange,
}: MeshesListPanelProps) {
  return (
    <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-64 max-h-[40vh] flex flex-col">
      <div className="p-2 border-b border-neutral-700 flex items-center gap-2">
        <Box className="w-4 h-4 text-neutral-400" />
        <span className="text-xs font-medium text-neutral-300 flex-1">Meshes</span>
      </div>
      <div className="overflow-y-auto flex-1 p-1">
        {meshes.map(mesh => {
          const sourceCloud = clouds.find(c => c.id === mesh.sourceCloudId);
          const isSelected = selectedMeshIds.has(mesh.id);
          const displayName = meshDisplayName(mesh, sourceCloud?.data.fileName);
          const isRenaming = renamingMeshId === mesh.id;
          const isColorOpen = colorPopoverMeshId === mesh.id;
          const meshTextured = isTextured(mesh);
          const showColorSwatch = !mesh.isPlant && !meshTextured;
          const canColorByTriangle = isTriangulated(mesh);
          const canSetOpacity = supportsOpacity(mesh);
          const canExpand = canColorByTriangle || canSetOpacity;
          const isExpanded = expandedMeshIds.has(mesh.id);
          const colorMode = meshColorModes.get(mesh.id) ?? 'solid';
          const meshOpacity = meshOpacities.get(mesh.id) ?? defaultOpacityFor(mesh);
          return (
            <div key={mesh.id}>
            <div
              data-testid="mesh-row"
              data-mesh-name={displayName}
              data-triangle-count={mesh.data.triangleCount}
              data-is-plant={mesh.isPlant ? 'true' : 'false'}
              data-textured-materials={mesh.plantMaterials?.filter(m => m.textureData).length ?? 0}
              data-selected={isSelected ? 'true' : 'false'}
              data-mesh-color={mesh.color}
              data-mesh-rotation={(() => { const r = meshRotations.get(mesh.id) || { x: 0, y: 0, z: 0 }; return `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.z.toFixed(1)}`; })()}
              data-mesh-position={(() => { const p = meshPositions.get(mesh.id) || { x: 0, y: 0, z: 0 }; return `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`; })()}
              data-mesh-scale={(() => { const s = meshScales.get(mesh.id) || { x: 1, y: 1, z: 1 }; return `${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)}`; })()}
              onClick={() => onSelect(mesh.id)}
              className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                isSelected ? 'bg-green-600/30 border border-green-500/50' : 'hover:bg-neutral-700/50'
              }`}
            >
              {/* Expander for the per-mesh inline options; a spacer keeps other
                  rows aligned. */}
              {canExpand ? (
                <button
                  data-testid="mesh-color-expand"
                  onClick={(e) => { e.stopPropagation(); onToggleExpanded(mesh.id); }}
                  className="p-0.5 hover:bg-neutral-600 rounded flex-shrink-0"
                  title="Mesh options"
                >
                  {isExpanded
                    ? <ChevronDown className="w-3 h-3 text-neutral-400" />
                    : <ChevronRight className="w-3 h-3 text-neutral-400" />}
                </button>
              ) : (
                <div className="w-4 flex-shrink-0" />
              )}
              {mesh.isPlant ? (
                <Leaf className="w-3 h-3 flex-shrink-0 text-green-400" />
              ) : !showColorSwatch ? (
                // Textured (non-plant) mesh: texture drives the look and mesh.color
                // is ignored, so show a neutral icon, not a misleading swatch.
                <Box className="w-3 h-3 flex-shrink-0 text-neutral-400" />
              ) : (
                // Color swatch doubles as the trigger for a small color popover.
                <div className="flex-shrink-0">
                  <button
                    data-testid="mesh-color-swatch"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isColorOpen) {
                        onCloseColorPopover();
                        return;
                      }
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      onOpenColorPopover(mesh.id, { top: r.bottom + 4, left: r.left });
                    }}
                    className="w-3 h-3 rounded ring-1 ring-white/20 hover:ring-white/60 transition-shadow"
                    style={{ backgroundColor: mesh.color }}
                    title="Set color"
                  />
                </div>
              )}
              <div className="flex-1 min-w-0">
                {isRenaming ? (
                  <input
                    data-testid="mesh-row-name-input"
                    autoFocus
                    value={renamingMeshValue}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onRenamingChange(mesh.id, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => { onRename(mesh.id, renamingMeshValue); onRenamingChange(null, ''); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onRename(mesh.id, renamingMeshValue);
                        onRenamingChange(null, '');
                      } else if (e.key === 'Escape') {
                        onRenamingChange(null, '');
                      }
                    }}
                    className="w-full text-xs bg-neutral-900 border border-green-500/50 rounded px-1 py-0.5 text-neutral-100 outline-none"
                  />
                ) : (
                  <div
                    className="text-xs text-neutral-200 truncate cursor-text"
                    data-testid="mesh-row-name"
                    title="Double-click to rename"
                    onDoubleClick={(e) => { e.stopPropagation(); onRenamingChange(mesh.id, displayName); }}
                  >
                    {displayName}
                  </div>
                )}
                <div className="text-[10px] text-neutral-500" data-testid="mesh-row-count">
                  {mesh.data.triangleCount.toLocaleString()} triangles
                  {mesh.data.surfaceArea && ` · ${mesh.data.surfaceArea.toFixed(2)} m²`}
                  {mesh.isPlant && ' · Helios Plant'}
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onToggleVisibility(mesh.id); }}
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
                onClick={(e) => { e.stopPropagation(); onRequestDelete(mesh.id, displayName); }}
                className="p-1 hover:bg-red-600/30 rounded"
                title="Remove"
              >
                <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
              </button>
            </div>

            {/* Inline per-mesh options, expanded from the chevron. */}
            {isExpanded && (
              <div className="ml-7 mr-2 mb-1 p-2 bg-neutral-900/50 rounded space-y-1.5">
                {canColorByTriangle && (
                <div className="space-y-1.5">
                <div className="text-[10px] text-neutral-400 flex items-center gap-1">
                  <Palette className="w-3 h-3" />
                  Color by
                </div>
                <select
                  data-testid="mesh-color-mode"
                  value={colorMode}
                  onChange={(e) => onColorModeChange(mesh.id, e.target.value as MeshColorMode)}
                  className="w-full bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                >
                  <option value="solid">Solid color</option>
                  <option value="inclination">Inclination (zenith of normal)</option>
                  <option value="azimuth">Azimuth (of normal)</option>
                  <option value="area">Triangle area</option>
                  {meshHasScanColors(mesh.data) && (
                    <option value="scan">Source scan</option>
                  )}
                </select>
                {/* Colormap picker applies only to the scalar gradient modes. */}
                {!['solid', 'scan'].includes(colorMode) && (
                  <select
                    data-testid="mesh-color-colormap"
                    value={colormap}
                    onChange={(e) => onColormapChange(e.target.value as ColormapName)}
                    className="w-full bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                  >
                    {COLORMAP_NAMES.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                )}
                </div>
                )}
                {/* Per-mesh opacity — only for surfaces where blending is
                    meaningful (not textured plants). */}
                {canSetOpacity && (
                  <div>
                    <label className="text-[10px] text-neutral-400 block mb-1">
                      Opacity: {(meshOpacity * 100).toFixed(0)}%
                    </label>
                    <input
                      data-testid="mesh-opacity"
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.1"
                      value={meshOpacity}
                      onChange={(e) => onOpacityChange(mesh.id, parseFloat(e.target.value))}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
                    />
                  </div>
                )}
              </div>
            )}
            </div>
          );
        })}
      </div>
      {/* Mesh Settings (global toggles that apply to all meshes). */}
      <div className="p-2 border-t border-neutral-700">
        <label className="flex items-center gap-2 text-neutral-300 cursor-pointer text-xs">
          <input
            type="checkbox"
            checked={meshWireframe}
            onChange={(e) => onWireframeChange(e.target.checked)}
            className="rounded bg-neutral-700 border-neutral-600 accent-neutral-500"
          />
          Wireframe
        </label>
      </div>
    </div>
  );
}
