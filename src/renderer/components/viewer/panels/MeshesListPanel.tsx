import { useState, useEffect, useRef } from 'react';
import { Box, Leaf, Eye, EyeOff, Trash2, ChevronRight, ChevronDown, Palette, ChartPie, Wand2, AlertTriangle, Filter, HelpCircle, Maximize2 } from 'lucide-react';
import type { MeshEntry, MeshColorMode, PointCloudEntry } from '../../../lib/pointCloudTypes';
import { meshDisplayNameFor, TRIANGULATION_METHOD_LABELS } from '../../../lib/pointCloudTypes';
import { meshHasScanColors } from '../../../lib/pointCloudHelpers';
import type { TriangleFilterEstimate } from '../../../lib/triangleFilter';
import { ColormapName, COLORMAP_NAMES } from '../../../lib/colormaps';

// How long to wait after the last keystroke before re-deriving the filtered
// mesh. Re-filtering walks every candidate triangle, so firing on each
// keystroke janks while typing "0.15"; debouncing lets the user finish.
const FILTER_DEBOUNCE_MS = 350;

// Interactive Lmax / aspect filter for an unfiltered Helios triangulation mesh.
// Holds its own input state so typing partial numbers doesn't jank, committing
// each valid change up to the parent (which re-derives the filtered view from
// the stored candidate set). Commits are debounced so the re-filter only runs
// once the user pauses typing; Enter/blur commit immediately. The "Auto" button
// re-applies the Otsu estimate.
function TriangleFilterControls({
  mesh,
  onChange,
  onCheckSpacing,
}: {
  mesh: MeshEntry;
  onChange: (id: string, next: { lmax: number; maxAspectRatio: number }) => void;
  onCheckSpacing: (id: string) => void;
}) {
  const filter = mesh.triangleFilter!;
  const estimate = mesh.unfilteredMesh!.estimate;
  const cap = mesh.unfilteredMesh!.cap;
  const estLmax = estimate.lmax;
  const hasEst = estLmax != null && Number.isFinite(estLmax);
  const [lmaxStr, setLmaxStr] = useState(formatLmax(filter.lmax));
  // The aspect filter is "off" at the wide-open cap sentinel — show it blank then
  // (an empty "no limit" field) rather than a giant 1e9 number. Open3D meshes
  // start here; the user types a real ratio to enable aspect filtering.
  const [aspectStr, setAspectStr] = useState(formatAspect(filter.maxAspectRatio));
  // Toggles the "how to read these" popover next to the separation readout.
  const [showHelp, setShowHelp] = useState(false);

  // Resync the inputs when the filter is changed elsewhere (e.g. the Auto button
  // or a fresh estimate), so the displayed values track the mesh's actual filter.
  useEffect(() => { setLmaxStr(formatLmax(filter.lmax)); }, [filter.lmax]);
  useEffect(() => { setAspectStr(formatAspect(filter.maxAspectRatio)); }, [filter.maxAspectRatio]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPending = () => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };
  // Cancel any pending commit on unmount so it can't fire against a stale mesh.
  useEffect(() => clearPending, []);

  const commitNow = (lmaxValue: string, aspectValue: string) => {
    clearPending();
    const lmax = parseFloat(lmaxValue);
    // A blank aspect field means "no aspect limit" — commit at the cap sentinel.
    const aspectTrimmed = aspectValue.trim();
    const maxAspectRatio = aspectTrimmed === '' ? cap.maxAspectRatio : parseFloat(aspectTrimmed);
    if (!(lmax > 0) || !(maxAspectRatio > 0)) return; // ignore partial input
    onChange(mesh.id, { lmax, maxAspectRatio });
  };

  // Schedule a commit once typing pauses, replacing any still-pending one.
  const commitDebounced = (lmaxValue: string, aspectValue: string) => {
    clearPending();
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      commitNow(lmaxValue, aspectValue);
    }, FILTER_DEBOUNCE_MS);
  };

  // Commit the current input immediately (Enter / blur = explicit confirmation).
  const commitImmediate = () => commitNow(lmaxStr, aspectStr);

  const confidenceClass =
    estimate.label === 'High' ? 'text-green-300'
    : estimate.label === 'Medium' ? 'text-amber-300'
    : estimate.label === 'Low' ? 'text-red-300'
    : 'text-neutral-400';

  // Mode separation shares eta's color scale: far-apart modes (High) are a
  // trustworthy cut; close modes (Low) flag that the auto-Lmax may be slicing
  // one surface rather than trimming bridges.
  const separationRatioClass =
    estimate.sepLabel === 'High' ? 'text-green-300'
    : estimate.sepLabel === 'Medium' ? 'text-amber-300'
    : estimate.sepLabel === 'Low' ? 'text-red-300'
    : 'text-neutral-400';

  return (
    <div className="space-y-1.5" data-testid="mesh-tri-filter">
      <div className="text-[10px] text-neutral-400 flex items-center gap-1">
        <Filter className="w-3 h-3" />
        Filter
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[9px] text-neutral-500 block mb-0.5">L<sub>max</sub> (m)</label>
          <input
            data-testid="mesh-tri-lmax"
            type="number"
            step="0.01"
            min="0.001"
            max={cap.lmax}
            value={lmaxStr}
            onChange={(e) => { setLmaxStr(e.target.value); commitDebounced(e.target.value, aspectStr); }}
            onBlur={commitImmediate}
            onKeyDown={(e) => { if (e.key === 'Enter') commitImmediate(); }}
            onClick={(e) => e.stopPropagation()}
            className="w-full px-1.5 py-1 bg-neutral-700 border border-neutral-600 rounded text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
          />
        </div>
        <div>
          <label className="text-[9px] text-neutral-500 block mb-0.5">Max aspect</label>
          <input
            data-testid="mesh-tri-aspect"
            type="number"
            step="0.5"
            min="1"
            value={aspectStr}
            onChange={(e) => { setAspectStr(e.target.value); commitDebounced(lmaxStr, e.target.value); }}
            onBlur={commitImmediate}
            onKeyDown={(e) => { if (e.key === 'Enter') commitImmediate(); }}
            onClick={(e) => e.stopPropagation()}
            className="w-full px-1.5 py-1 bg-neutral-700 border border-neutral-600 rounded text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
          />
        </div>
      </div>
      {/* Auto button + separation readout — Helios meshes only (they carry the
          backend Otsu estimate). Open3D meshes have no estimate (hasEst false),
          so this whole row is hidden and the panel shows just the Lmax / aspect
          inputs above. */}
      {hasEst && (
      <div className="flex items-start justify-between gap-2">
        <button
          data-testid="mesh-tri-auto"
          onClick={(e) => {
            e.stopPropagation();
            if (!hasEst) return;
            setLmaxStr(formatLmax(estLmax!));
            commitNow(String(estLmax), aspectStr);
          }}
          title="Auto-estimate Lmax from the candidate edge-length distribution"
          className="flex flex-shrink-0 items-center gap-1 text-[10px] text-green-400 hover:text-green-300 transition-colors"
        >
          <Wand2 className="w-3 h-3" /> Auto
        </button>
        {estimate.label !== 'n/a' && (
          <div className="relative flex min-w-0 items-start gap-1">
            <span data-testid="mesh-tri-separation" className={`text-[10px] text-right ${confidenceClass}`}>
              Separation: {estimate.label} (η {estimate.eta.toFixed(2)})
              {estimate.sepRatio != null && (
                <span className={separationRatioClass}>
                  {' · '}Modes {estimate.sepRatio.toFixed(1)}× ({estimate.sepLabel})
                </span>
              )}
            </span>
            <button
              data-testid="mesh-tri-separation-help"
              onClick={(e) => { e.stopPropagation(); setShowHelp((v) => !v); }}
              aria-label="How to read the separation metrics"
              className="flex-shrink-0 mt-px text-neutral-500 hover:text-neutral-200 transition-colors"
            >
              <HelpCircle className="w-3 h-3" />
            </button>
            {showHelp && (
              <div
                data-testid="mesh-tri-separation-help-popover"
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-5 z-20 w-60 space-y-1.5 rounded border border-neutral-600 bg-neutral-800 p-2 text-[9px] leading-snug text-neutral-300 shadow-lg"
              >
                <div>
                  <span className="font-semibold text-neutral-100">η (eta) — split cleanliness.</span>{' '}
                  How cleanly the candidate edge lengths fall into two groups (0–1).
                  High means a sharp valley between short “surface” edges and long
                  “bridge” edges; Low means they blur together, so the auto
                  L<sub>max</sub> is a guess.
                </div>
                <div>
                  <span className="font-semibold text-neutral-100">Modes — how far apart.</span>{' '}
                  The longer edge group’s length divided by the shorter group’s.
                  Genuine gap bridges sit many× above the surface spacing (High).
                  A small ratio (Low) means both groups are really surface —
                  just sampled at different spacings — so cutting between them
                  drops valid triangles and leaves holes.
                </div>
                <div className="text-neutral-400">
                  Watch for <span className="text-green-300">High η</span> with{' '}
                  <span className="text-red-300">Low Modes</span>: a confident cut
                  in the wrong place. Raise L<sub>max</sub> if the mesh looks
                  holey.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      )}
      {estimate.merged && (
        <div className="flex gap-1 rounded px-1.5 py-1 border bg-amber-500/10 border-amber-500/40 text-[9px] text-amber-200">
          <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
          <span>Looks like a merged multi-scan cloud — triangulate each scan position separately for a clean result.</span>
        </div>
      )}
      <SpacingCheck mesh={mesh} estimate={estimate} onCheckSpacing={onCheckSpacing} />
    </div>
  );
}

// Opt-in point-spacing cross-check, rendered under the filter controls. The
// edge-based auto-Lmax (Otsu) can silently overshoot on a sparsely-sampled
// surface — it bridges across the gaps, which corrupts the leaf normals and
// G(theta) — and the candidate-edge distribution can't self-diagnose that (the
// split looks clean even when its lower mode is still bridges). So when the Otsu
// indicators aren't BOTH High, we offer a button that measures the real
// nearest-neighbor spacing of the in-grid points (an independent signal) and
// compares it to the current Lmax. It's a button, not automatic, because the
// measurement is a KD-tree pass that can take tens of seconds on a
// tens-of-millions-of-points cloud — the user opts into that cost. The verdict
// only warns; it never changes Lmax (that stays the user's call).
function SpacingCheck({
  mesh,
  estimate,
  onCheckSpacing,
}: {
  mesh: MeshEntry;
  estimate: TriangleFilterEstimate;
  onCheckSpacing: (id: string) => void;
}) {
  // Only offer the check when the auto-estimate is suspect: an estimate exists
  // and either indicator is below High. High/High means the edge distribution
  // is cleanly bimodal AND the modes are far apart — the case where the
  // edge-based Lmax is trustworthy and the (expensive) cross-check adds nothing.
  const bothHigh = estimate.label === 'High' && estimate.sepLabel === 'High';
  const offer = estimate.label !== 'n/a' && !bothHigh;
  const check = mesh.heliosSpacingCheck;
  if (!offer && !check) return null;

  const running = check?.status === 'running';
  const verdictClass =
    check?.status === 'error' ? 'bg-red-500/10 border-red-500/40 text-red-200'
    : check?.likelyBridging ? 'bg-amber-500/10 border-amber-500/40 text-amber-200'
    : 'bg-green-500/10 border-green-500/40 text-green-200';

  return (
    <div className="space-y-1">
      <button
        data-testid="mesh-tri-check-spacing"
        onClick={(e) => { e.stopPropagation(); if (!running) onCheckSpacing(mesh.id); }}
        disabled={running}
        title="Measure the real point spacing inside the grid and compare it to Lmax (can be slow on large clouds)"
        className={`flex items-center gap-1 text-[10px] transition-colors ${
          running ? 'text-neutral-500 cursor-wait' : 'text-sky-400 hover:text-sky-300'
        }`}
      >
        <Maximize2 className="w-3 h-3" />
        {running ? 'Checking point spacing…' : 'Check point spacing'}
      </button>
      {check && check.status !== 'running' && check.message && (
        <div
          data-testid="mesh-tri-spacing-verdict"
          className={`flex gap-1 rounded px-1.5 py-1 border text-[9px] leading-snug ${verdictClass}`}
        >
          {(check.status === 'error' || check.likelyBridging) && (
            <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
          )}
          <span>{check.message}</span>
        </div>
      )}
    </div>
  );
}

// Compact Lmax display: enough precision to be useful without a noisy tail.
function formatLmax(v: number): string {
  if (!Number.isFinite(v)) return '';
  return Number(v.toPrecision(4)).toString();
}

// Format the aspect-ratio filter for its input. The wide-open cap sentinel
// (>= 1e8, used when no aspect filtering is applied — the default for Open3D
// meshes) renders as blank so the field reads as "no limit" instead of a giant
// number; a real ratio renders normally.
function formatAspect(v: number): string {
  if (!Number.isFinite(v) || v >= 1e8) return '';
  return Number(v.toPrecision(4)).toString();
}

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
  // Header bulk actions: count of selected rows, whether any bulk target is
  // currently visible (drives the eye icon), and the section-or-selection
  // show/hide and delete handlers.
  selectedCount: number;
  anyTargetVisible: boolean;
  onToggleVisibilityAll: () => void;
  onDeleteAll: () => void;
  // Modifier-aware select: Ctrl/Cmd toggles, Shift selects a range.
  onSelect: (id: string, additive: boolean, range: boolean) => void;
  onToggleVisibility: (id: string) => void;
  onRequestDelete: (id: string, name: string) => void;
  onToggleExpanded: (id: string) => void;
  // The mesh whose floating Transform panel is currently open (or null). Drives
  // the active highlight on each row's transform button.
  transformMeshId: string | null;
  // Select this mesh and toggle its floating Transform panel (position /
  // rotation / scale + gizmos).
  onToggleTransform: (id: string) => void;
  onRename: (id: string, value: string) => void;
  onRenamingChange: (id: string | null, value: string) => void;
  // Opens the color popover for a mesh, anchored to the swatch's screen rect.
  onOpenColorPopover: (id: string, anchor: { top: number; left: number }) => void;
  onCloseColorPopover: () => void;
  onColorModeChange: (id: string, mode: MeshColorMode) => void;
  onColormapChange: (name: ColormapName) => void;
  onOpacityChange: (id: string, value: number) => void;
  onWireframeChange: (v: boolean) => void;
  // Open the leaf-angle distribution plot for a Helios mesh.
  onOpenLeafAngles: (id: string) => void;
  // Apply the interactive Lmax / aspect filter to a Helios triangulation mesh.
  onHeliosFilterChange: (id: string, next: { lmax: number; maxAspectRatio: number }) => void;
  // Run the opt-in point-spacing cross-check on a Helios mesh (offered when the
  // Otsu indicators aren't both High). Writes the verdict to mesh.heliosSpacingCheck.
  onCheckSpacing: (id: string) => void;
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
  selectedCount,
  anyTargetVisible,
  onToggleVisibilityAll,
  onDeleteAll,
  onSelect,
  onToggleVisibility,
  onRequestDelete,
  onToggleExpanded,
  transformMeshId,
  onToggleTransform,
  onRename,
  onRenamingChange,
  onOpenColorPopover,
  onCloseColorPopover,
  onColorModeChange,
  onColormapChange,
  onOpacityChange,
  onWireframeChange,
  onOpenLeafAngles,
  onHeliosFilterChange,
  onCheckSpacing,
}: MeshesListPanelProps) {
  return (
    <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-64 max-h-[40vh] flex flex-col">
      <div className="p-2 border-b border-neutral-700 flex items-center gap-2">
        <Box className="w-4 h-4 text-neutral-400" />
        <span className="text-xs font-medium text-neutral-300 flex-1">Meshes</span>
        <button
          data-testid="meshes-bulk-hide"
          onClick={onToggleVisibilityAll}
          className="p-1 hover:bg-neutral-700 rounded"
          title={selectedCount > 0 ? `Show/hide ${selectedCount} selected` : 'Show/hide all'}
        >
          {anyTargetVisible
            ? <Eye className="w-3 h-3 text-neutral-400" />
            : <EyeOff className="w-3 h-3 text-neutral-600" />}
        </button>
        <button
          data-testid="meshes-bulk-delete"
          onClick={onDeleteAll}
          className="p-1 hover:bg-red-600/30 rounded"
          title={selectedCount > 0 ? `Delete ${selectedCount} selected` : 'Delete all'}
        >
          <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
        </button>
      </div>
      <div className="overflow-y-auto flex-1 p-1">
        {meshes.map(mesh => {
          const isSelected = selectedMeshIds.has(mesh.id);
          // Deduped against the full mesh list so two identical auto-names
          // (e.g. a second "Helios triangulation") read "… (2)".
          const displayName = meshDisplayNameFor(
            mesh,
            meshes,
            (m) => clouds.find(c => c.id === m.sourceCloudId)?.data.fileName,
          );
          const isRenaming = renamingMeshId === mesh.id;
          const isColorOpen = colorPopoverMeshId === mesh.id;
          const meshTextured = isTextured(mesh);
          const showColorSwatch = !mesh.isPlant && !meshTextured;
          const canColorByTriangle = isTriangulated(mesh);
          const canSetOpacity = supportsOpacity(mesh);
          // Provenance is worth surfacing even when the source cloud is gone
          // (which flips isTriangulated off), so expandability includes it.
          const canExpand = canColorByTriangle || canSetOpacity || !!mesh.triangulationParams;
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
              data-has-vertex-colors={mesh.data.vertexColors && mesh.data.vertexColors.length > 0 ? 'true' : 'false'}
              data-opacity={meshOpacity}
              data-selected={isSelected ? 'true' : 'false'}
              data-visible={mesh.visible ? 'true' : 'false'}
              data-mesh-color={mesh.color}
              data-mesh-rotation={(() => { const r = meshRotations.get(mesh.id) || { x: 0, y: 0, z: 0 }; return `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.z.toFixed(1)}`; })()}
              data-mesh-position={(() => { const p = meshPositions.get(mesh.id) || { x: 0, y: 0, z: 0 }; return `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`; })()}
              data-mesh-scale={(() => { const s = meshScales.get(mesh.id) || { x: 1, y: 1, z: 1 }; return `${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)}`; })()}
              onClick={(e) => onSelect(mesh.id, e.ctrlKey || e.metaKey, e.shiftKey)}
              className={`flex items-center gap-2 p-2 rounded cursor-pointer select-none transition-colors ${
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
                data-testid="mesh-transform-toggle"
                onClick={(e) => { e.stopPropagation(); onToggleTransform(mesh.id); }}
                className={`p-1 rounded ${
                  transformMeshId === mesh.id
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-neutral-600 text-neutral-400'
                }`}
                title="Transform (move / rotate / scale)"
              >
                <Maximize2 className="w-3 h-3" />
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
                {/* Triangulation provenance: how this mesh was reconstructed and
                    with which parameters. Only present on triangulated meshes. */}
                {mesh.triangulationParams && (
                  <div className="text-[10px] text-neutral-400 space-y-0.5" data-testid="mesh-triangulation-info">
                    <div className="text-neutral-300">
                      {TRIANGULATION_METHOD_LABELS[mesh.method] ?? mesh.method} triangulation
                    </div>
                    {mesh.triangulationParams.depth !== undefined && (
                      <div>Octree depth: {mesh.triangulationParams.depth}</div>
                    )}
                    {mesh.triangulationParams.alpha !== undefined && (
                      <div>Alpha: {mesh.triangulationParams.alpha}</div>
                    )}
                    {mesh.triangulationParams.radii && mesh.triangulationParams.radii.length > 0 && (
                      <div>Radii: {mesh.triangulationParams.radii.map(r => r.toFixed(3)).join(', ')}</div>
                    )}
                    {mesh.triangulationParams.lmax !== undefined && (
                      <div>L<sub>max</sub>: {formatLmax(mesh.triangulationParams.lmax)} m</div>
                    )}
                    {mesh.triangulationParams.maxAspectRatio !== undefined
                      && mesh.triangulationParams.maxAspectRatio < 1e8 && (
                      <div>Max aspect ratio: {mesh.triangulationParams.maxAspectRatio}</div>
                    )}
                    {mesh.triangulationParams.scanCount !== undefined && (
                      <div>Scans fused: {mesh.triangulationParams.scanCount}</div>
                    )}
                    {mesh.triangulationParams.candidateTriangles !== undefined && (
                      <div data-testid="mesh-triangulation-filter-stats" className="pt-0.5 border-t border-neutral-700/60 mt-0.5">
                        <div className="text-neutral-300">Filter breakdown</div>
                        <div>Candidates: {mesh.triangulationParams.candidateTriangles.toLocaleString()}</div>
                        <div>Kept: {mesh.data.triangleCount.toLocaleString()}</div>
                        <div>Dropped — L<sub>max</sub>: {(mesh.triangulationParams.droppedLmax ?? 0).toLocaleString()}, aspect: {(mesh.triangulationParams.droppedAspect ?? 0).toLocaleString()}{(mesh.triangulationParams.droppedDegenerate ?? 0) > 0 ? `, degenerate: ${(mesh.triangulationParams.droppedDegenerate ?? 0).toLocaleString()}` : ''}</div>
                      </div>
                    )}
                    {mesh.triangulationParams.normalRadius !== undefined && (
                      <div>Normal radius: {mesh.triangulationParams.normalRadius}, max nn: {mesh.triangulationParams.normalMaxNn}</div>
                    )}
                    {mesh.triangulationParams.pointsUsed !== undefined && (
                      <div>Points used: {mesh.triangulationParams.pointsUsed.toLocaleString()}</div>
                    )}
                  </div>
                )}
                {/* Interactive Lmax / aspect filter — on any triangulated mesh
                    that carries the candidate metrics (Helios meshes from the
                    backend; Open3D meshes get them computed client-side at build
                    time). Helios meshes additionally show the Auto / separation
                    diagnostics; Open3D meshes show just the Lmax / aspect inputs. */}
                {mesh.triangleFilter && mesh.unfilteredMesh && (
                  <TriangleFilterControls mesh={mesh} onChange={onHeliosFilterChange} onCheckSpacing={onCheckSpacing} />
                )}
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
                {/* Leaf-angle distribution — any triangulated mesh (Helios or the
                    Open3D methods). The plot is pure triangle geometry; it reads
                    per-voxel cells when the mesh carries a grid, else falls back
                    to a single whole-mesh distribution. */}
                {isTriangulated(mesh) && (
                  <button
                    data-testid="mesh-leaf-angles"
                    onClick={(e) => { e.stopPropagation(); onOpenLeafAngles(mesh.id); }}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1 text-[11px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded"
                    title="Plot the leaf angle distribution (inclination PDF + azimuth)"
                  >
                    <ChartPie className="w-3 h-3" />
                    Leaf angles…
                  </button>
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
