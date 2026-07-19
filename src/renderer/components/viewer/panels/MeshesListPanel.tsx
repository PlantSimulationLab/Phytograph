import { useState, useEffect, useRef } from 'react';
import { Box, Leaf, Eye, EyeOff, Trash2, ChevronRight, ChevronDown, Palette, ChartPie, Wand2, AlertTriangle, Filter, HelpCircle, Maximize2, Download } from 'lucide-react';
import type { MeshEntry, MeshColorMode, PointCloudEntry } from '../../../lib/pointCloudTypes';
import { meshDisplayNameFor, TRIANGULATION_METHOD_LABELS, DEM_SURFACE_LABELS, DEM_LAYER_ORDER } from '../../../lib/pointCloudTypes';
import { meshHasScanColors } from '../../../lib/pointCloudHelpers';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { InfoHint } from '../../InfoHint';
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
            onWheel={(e) => e.currentTarget.blur()}
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
            onWheel={(e) => e.currentTarget.blur()}
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

// Raster-export controls for a DEM mesh. A DTM carries several scalar layers
// (elevation / density / intensity / hillshade / slope / aspect) — tick which to
// export, then pick a format (one file per checked layer). DSM/CHM (no layers)
// export their single surface grid. `activeLayer` (the mesh's current Color-by
// band) is checked by default so "export what I'm looking at" is one click.
function DemRasterExportControls({
  mesh,
  activeLayer,
  onExport,
}: {
  mesh: MeshEntry;
  activeLayer?: string;
  onExport: (id: string, format: 'asc' | 'tif', layerNames?: string[]) => void;
}) {
  const layerNames = mesh.demLayers
    ? DEM_LAYER_ORDER.filter((n) => mesh.demLayers?.[n])
    : [];
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(activeLayer && mesh.demLayers?.[activeLayer] ? [activeLayer] : layerNames.slice(0, 1)),
  );
  const toggle = (name: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(name); else next.delete(name);
      return next;
    });
  const selected = layerNames.filter((n) => checked.has(n));
  const hasLayers = layerNames.length > 0;

  return (
    <div className="space-y-1" data-testid="mesh-dem-export">
      <div className="text-[10px] text-neutral-500" data-testid="mesh-dem-detail">
        {mesh.demGrid!.nx.toLocaleString()} × {mesh.demGrid!.ny.toLocaleString()} cells
        {' · '}{mesh.demGrid!.cellSize.toFixed(2)} m
        {' · '}{mesh.data.triangleCount.toLocaleString()} triangles
      </div>
      <div className="text-[10px] text-neutral-400 flex items-center gap-1">
        <Download className="w-3 h-3" />
        Export raster
      </div>
      {hasLayers && (
        <div className="space-y-0.5" data-testid="mesh-dem-layer-picker">
          {layerNames.map((name) => (
            <label key={name} className="flex items-center gap-1.5 text-[10px] text-neutral-300 cursor-pointer">
              <input
                type="checkbox"
                data-testid={`mesh-dem-layer-${name}`}
                checked={checked.has(name)}
                onChange={(e) => toggle(name, e.target.checked)}
                className="rounded bg-neutral-700 border-neutral-600 accent-green-500"
              />
              {mesh.demLayers?.[name]?.label ?? name}
            </label>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-1">
        <button
          data-testid="mesh-dem-export-tif"
          disabled={hasLayers && selected.length === 0}
          onClick={(e) => { e.stopPropagation(); onExport(mesh.id, 'tif', hasLayers ? selected : undefined); }}
          title="Export as GeoTIFF (.tif) — georeferenced when the source CRS is known"
          className="px-2 py-1 text-[11px] bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-200 rounded"
        >
          GeoTIFF
        </button>
        <button
          data-testid="mesh-dem-export-asc"
          disabled={hasLayers && selected.length === 0}
          onClick={(e) => { e.stopPropagation(); onExport(mesh.id, 'asc', hasLayers ? selected : undefined); }}
          title="Export as ESRI ASCII grid (.asc)"
          className="px-2 py-1 text-[11px] bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-200 rounded"
        >
          ASCII grid
        </button>
      </div>
    </div>
  );
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
  // Which DTM scalar layer each DEM mesh is coloured by (mode === 'layer').
  selectedMeshLayer: Map<string, string>;
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
  // Receives the raw select value: a bare MeshColorMode, or `layer:<name>` for a
  // DTM band. The parent decodes the layer form.
  onColorModeChange: (id: string, value: string) => void;
  onColormapChange: (name: ColormapName) => void;
  onOpacityChange: (id: string, value: number) => void;
  onWireframeChange: (v: boolean) => void;
  // Open the leaf-angle distribution plot for a Helios mesh.
  onOpenLeafAngles: (id: string) => void;
  // Export a DEM surface mesh's elevation grid as a GIS raster (mesh.method === 'dem').
  onExportDEMRaster: (id: string, format: 'asc' | 'tif', layerNames?: string[]) => void;
  // "Snap to ground": displace a voxel grid's columns to follow a DEM. The grid
  // then carries authoritative per-column offsets used by both the viewport and
  // the LAD inversion. Clearing removes the snap (grid returns to flat).
  onSnapGridToGround: (gridMeshId: string, demMeshId: string, safetyFraction: number) => void;
  onClearGridSnap: (gridMeshId: string) => void;
  // Apply the interactive Lmax / aspect filter to a Helios triangulation mesh.
  onHeliosFilterChange: (id: string, next: { lmax: number; maxAspectRatio: number }) => void;
  // Run the opt-in point-spacing cross-check on a Helios mesh (offered when the
  // Otsu indicators aren't both High). Writes the verdict to mesh.heliosSpacingCheck.
  onCheckSpacing: (id: string) => void;
  // Why this (ball-pivot) mesh can't be re-used for the leaf-area (LAD) inversion,
  // or null if it can (or LAD doesn't apply). Surfaced as a one-line note on the
  // mesh row so the reason is visible where the mesh lives, not only in the LAD
  // dialog. Computed in the parent (it needs the scan list for the position check).
  ladIneligibilityReason?: (mesh: MeshEntry) => string | null;
}

export function MeshesListPanel({
  meshes,
  clouds,
  selectedMeshIds,
  expandedMeshIds,
  renamingMeshId,
  renamingMeshValue,
  colorPopoverMeshId,
  selectedMeshLayer,
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
  onExportDEMRaster,
  onSnapGridToGround,
  onClearGridSnap,
  onHeliosFilterChange,
  onCheckSpacing,
  ladIneligibilityReason,
}: MeshesListPanelProps) {
  return (
    <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-64 max-h-[40vh] flex flex-col shrink-0">
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
          // DEM surfaces always carry intrinsic per-face color modes (elevation +
          // the derived hillshade/slope/aspect), independent of whether the source
          // cloud still exists — so offer the "Color by" dropdown for them even when
          // isTriangulated flips off (e.g. after the source octree was rebuilt).
          const canColorByTriangle = isTriangulated(mesh) || mesh.method === 'dem';
          const canSetOpacity = supportsOpacity(mesh);
          // Provenance is worth surfacing even when the source cloud is gone
          // (which flips isTriangulated off), so expandability includes it.
          // Grids and planes expand to show their geometry (center/size/…).
          const canExpand = canColorByTriangle || canSetOpacity || !!mesh.triangulationParams
            || !!mesh.gridSubdivisions || !!mesh.isPlane;
          const isExpanded = expandedMeshIds.has(mesh.id);
          const colorMode = meshColorModes.get(mesh.id) ?? 'solid';
          const meshOpacity = meshOpacities.get(mesh.id) ?? defaultOpacityFor(mesh);
          return (
            <div key={mesh.id}>
            <div
              data-testid="mesh-row"
              data-mesh-id={mesh.id}
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
                {mesh.gridSubdivisions ? (
                  // A grid voxel is a box, so its triangle count (always 12) is
                  // meaningless. Show a compact subtitle; full geometry
                  // (center/size) lives in the expanded options.
                  (() => {
                    const g = mesh.gridSubdivisions;
                    return (
                      <div className="text-[10px] text-neutral-500" data-testid="mesh-row-count">
                        Voxel grid · {g.x} × {g.y} × {g.z}
                      </div>
                    );
                  })()
                ) : mesh.isPlane ? (
                  // A plane is always two triangles, so the count is meaningless.
                  // Full geometry (center/size/rotation) lives in the expanded
                  // options; the name already reads "Plane".
                  <div className="text-[10px] text-neutral-500" data-testid="mesh-row-count">
                    Plane
                  </div>
                ) : mesh.method === 'dem' ? (
                  // DEM surfaces (DTM/DSM/CHM) share a name and triangle count, so
                  // the count alone doesn't say which product it is. Lead with the
                  // surface-type badge; the triangle count moves to the expanded view.
                  <div className="text-[10px] text-neutral-500" data-testid="mesh-row-count">
                    {DEM_SURFACE_LABELS[mesh.demSurfaceType ?? 'dtm']}
                    {mesh.data.surfaceArea && ` · ${mesh.data.surfaceArea.toFixed(2)} m²`}
                  </div>
                ) : (
                  <div className="text-[10px] text-neutral-500" data-testid="mesh-row-count">
                    {mesh.data.triangleCount.toLocaleString()} triangles
                    {mesh.data.surfaceArea && ` · ${mesh.data.surfaceArea.toFixed(2)} m²`}
                    {mesh.isPlant && ' · Helios Plant'}
                  </div>
                )}
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
                data-testid={`mesh-delete-${mesh.id}`}
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
                {/* Voxel-grid geometry: center (mesh position), size (mesh
                    scale, since the base box is a unit cube), and resolution. */}
                {mesh.gridSubdivisions && (() => {
                  const p = meshPositions.get(mesh.id) || { x: 0, y: 0, z: 0 };
                  const s = meshScales.get(mesh.id) || { x: 1, y: 1, z: 1 };
                  const g = mesh.gridSubdivisions;
                  return (
                    <div className="text-[10px] text-neutral-400 space-y-0.5" data-testid="mesh-grid-info">
                      <div>Center: {p.x.toFixed(2)}, {p.y.toFixed(2)}, {p.z.toFixed(2)}</div>
                      <div>Size: {s.x.toFixed(2)} × {s.y.toFixed(2)} × {s.z.toFixed(2)} m</div>
                      <div>Resolution: {g.x} × {g.y} × {g.z}</div>
                    </div>
                  );
                })()}
                {/* Snap to ground: displace the grid columns to follow a DEM.
                    Disabled (with a hint) until a DEM exists in the scene. */}
                {mesh.gridSubdivisions && (
                  <GridSnapControls
                    gridMesh={mesh}
                    demMeshes={meshes.filter(m => m.method === 'dem' && !!m.demGrid)}
                    onSnap={onSnapGridToGround}
                    onClear={onClearGridSnap}
                  />
                )}
                {/* Plane geometry: center (mesh position), size (width × length
                    from the scale x/y; the base quad is a unit square and z is
                    unused), and rotation (Euler degrees). */}
                {mesh.isPlane && (() => {
                  const p = meshPositions.get(mesh.id) || { x: 0, y: 0, z: 0 };
                  const s = meshScales.get(mesh.id) || { x: 1, y: 1, z: 1 };
                  const r = meshRotations.get(mesh.id) || { x: 0, y: 0, z: 0 };
                  return (
                    <div className="text-[10px] text-neutral-400 space-y-0.5" data-testid="mesh-plane-info">
                      <div>Center: {p.x.toFixed(2)}, {p.y.toFixed(2)}, {p.z.toFixed(2)}</div>
                      <div>Size: {s.x.toFixed(2)} × {s.y.toFixed(2)} m</div>
                      <div>Rotation: {r.x.toFixed(0)}°, {r.y.toFixed(0)}°, {r.z.toFixed(0)}°</div>
                    </div>
                  );
                })()}
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
                {/* Leaf-area (LAD) reusability note for a ball-pivot mesh. Eligible
                    meshes (pinned per-scan, scan has a position) say so; ineligible
                    ones explain why and how to fix it — visible here on the mesh, not
                    only buried in the LAD dialog. */}
                {mesh.method === 'ball_pivoting' && (() => {
                  const reason = ladIneligibilityReason?.(mesh) ?? null;
                  if (reason) {
                    return (
                      <div
                        className="flex items-start gap-1 text-[10px] text-amber-300/90"
                        data-testid="mesh-lad-ineligible-note"
                      >
                        <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                        <span>Can’t be used for leaf-area inversion: {reason}.</span>
                      </div>
                    );
                  }
                  if (mesh.data.grid && mesh.data.triangleCellIds) {
                    return (
                      <div
                        className="text-[10px] text-green-400/80"
                        data-testid="mesh-lad-ready-note"
                      >
                        Pinned to a grid — re-usable for leaf-area inversion.
                      </div>
                    );
                  }
                  return null;
                })()}
                {/* Interactive Lmax / aspect filter — HELIOS meshes only. They
                    carry the candidate metrics (triangleFilter + unfilteredMesh)
                    plus the Auto / separation Otsu diagnostics. Open3D cloud
                    methods (ball-pivot / alpha / poisson) each apply their own
                    length scale, so a post-hoc edge-length filter is a no-op for
                    them (see commit f0cf7ba); they carry neither field and this
                    panel stays hidden for them. */}
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
                  // In 'layer' mode the value encodes the chosen band as `layer:<name>`
                  // (mirrors the cloud's `scalar:<field>`); otherwise the bare mode.
                  value={colorMode === 'layer'
                    ? `layer:${selectedMeshLayer.get(mesh.id) ?? 'elevation'}`
                    : colorMode}
                  onChange={(e) => onColorModeChange(mesh.id, e.target.value)}
                  className="w-full bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                >
                  <option value="solid">Solid color</option>
                  {/* A DTM's scalar layers (elevation / density / intensity / hillshade
                      / slope / aspect) — colour the terrain by any band. */}
                  {mesh.demLayers && (
                    <optgroup label="Layers">
                      {DEM_LAYER_ORDER.filter((name) => mesh.demLayers?.[name]).map((name) => (
                        <option key={name} value={`layer:${name}`}>
                          {mesh.demLayers?.[name]?.label ?? name}
                        </option>
                      ))}
                    </optgroup>
                  )}
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
                {/* Leaf-angle distribution — any triangulated SURFACE mesh (Helios
                    or the Open3D methods). The plot is pure triangle geometry; it
                    reads per-voxel cells when the mesh carries a grid, else falls
                    back to a single whole-mesh distribution. Not meaningful for a
                    DEM (terrain, not foliage), so it's hidden there. */}
                {isTriangulated(mesh) && mesh.method !== 'dem' && (
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
                {/* DEM raster export — write the surface's grid/layers as GIS
                    rasters, right where the DEM lives (the surface mesh exports as
                    OBJ/PLY/STL via the Export panel like any mesh). */}
                {mesh.method === 'dem' && mesh.demGrid && (() => {
                  const active = colorMode === 'layer' ? selectedMeshLayer.get(mesh.id) : undefined;
                  return (
                    // Remount when the active band changes so the picker re-seeds its
                    // default check to "the layer you're currently viewing".
                    <DemRasterExportControls
                      key={active ?? '__surface__'}
                      mesh={mesh}
                      activeLayer={active}
                      onExport={onExportDEMRaster}
                    />
                  );
                })()}
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

// Per-grid "Snap to ground" controls in the Meshes-panel expanded row. Picks a
// DEM (when more than one exists) + a safety clearance, then snaps; once snapped,
// offers to clear. Disabled with a hint when no DEM is available.
function GridSnapControls({
  gridMesh,
  demMeshes,
  onSnap,
  onClear,
}: {
  gridMesh: MeshEntry;
  demMeshes: MeshEntry[];
  onSnap: (gridMeshId: string, demMeshId: string, safetyFraction: number) => void;
  onClear: (gridMeshId: string) => void;
}) {
  const [demId, setDemId] = useState<string>('');
  const [fraction, setFraction] = useState<number>(0.1);
  const selectedDemId = demMeshes.some(d => d.id === demId) ? demId : (demMeshes[0]?.id ?? '');
  const snapped = !!gridMesh.gridGroundSnap;
  const noDem = demMeshes.length === 0;

  return (
    <div className="mt-1 pt-1 border-t border-neutral-700/60 space-y-1.5" data-testid="mesh-grid-snap-section">
      <div className="text-[10px] text-neutral-400 flex items-center gap-1">
        Terrain follow
        <InfoHint
          data-testid="mesh-grid-snap-help"
          label="Snap to ground"
          text="Displace each voxel column vertically so the grid follows a DEM surface (level grids assume flat ground). Generate a DEM first. The safety clearance keeps the lowest cell off the ground, as a fraction of one voxel's height. The snapped grid is what both the viewport and the LAD inversion use; editing the grid's transform clears the snap."
        />
      </div>
      {snapped ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-green-300">Snapped to ground</span>
          <button
            data-testid="mesh-grid-snap-clear"
            onClick={(e) => { e.stopPropagation(); onClear(gridMesh.id); }}
            className="px-2 py-1 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-white"
          >
            Clear snap
          </button>
        </div>
      ) : noDem ? (
        <div
          className="text-[10px] text-neutral-500"
          data-testid="mesh-grid-snap-no-dem"
          title="Generate a DEM first (select the cloud → Generate DEM) so the grid can follow the ground."
        >
          Generate a DEM first to enable terrain following.
        </div>
      ) : (
        <div className="space-y-1.5">
          {demMeshes.length > 1 && (
            <select
              data-testid="mesh-grid-snap-dem-select"
              value={selectedDemId}
              onChange={(e) => { e.stopPropagation(); setDemId(e.target.value); }}
              onClick={(e) => e.stopPropagation()}
              className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
            >
              {demMeshes.map(d => (
                <option key={d.id} value={d.id}>{d.name || 'DEM'}</option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-neutral-400 shrink-0">Clearance (× cell)</span>
            <DebouncedNumberInput
              data-testid="mesh-grid-snap-fraction"
              value={fraction}
              min={0}
              debounceMs={0}
              onCommit={setFraction}
              className="w-16 px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
            />
          </div>
          <button
            data-testid="mesh-grid-snap"
            disabled={!selectedDemId}
            onClick={(e) => { e.stopPropagation(); if (selectedDemId) onSnap(gridMesh.id, selectedDemId, fraction); }}
            className="w-full px-2 py-1 text-[10px] rounded font-medium bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white"
          >
            Snap to ground
          </button>
        </div>
      )}
    </div>
  );
}
