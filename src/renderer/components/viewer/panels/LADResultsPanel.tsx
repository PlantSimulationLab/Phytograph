import { useState } from 'react';
import { Grid3x3, Eye, EyeOff, Trash2, Download } from 'lucide-react';
import type { LADResultEntry } from '../../../lib/pointCloudTypes';
import { ladRange } from '../../../lib/pointCloudHelpers';
import { ColormapName, COLORMAP_NAMES, COLORMAP_LABELS } from '../../../lib/colormaps';
import {
  LAD_EXPORT_VARIABLES, rasterBlockedReason, type LadExportFormat,
} from '../../../lib/ladExport';

// Export controls for one LAD result. Four formats, because the canopy-structure
// community reads four different things:
//   GeoTIFF   one band per vertical level — the GIS convention (canopyLazR's
//             lad.array.to.raster.stack, AMAPVox's toRaster); opens in QGIS.
//   CSV       one row per voxel, every field. The lossless option, and the only
//             one that survives a rotated or terrain-following grid.
//   .vox      AMAPVox voxel space — the TLS/PAD interchange format.
//   Summary   plain text: occlusion counts, total leaf area, and LAI — the
//             headline canopy number, which no other format carries.
// The variable picker applies to rasters only (one file each). It stays visible
// for the text formats — which always carry every field — with a note saying so,
// rather than appearing and disappearing as the user eyes different buttons.
function LadExportControls({
  result,
  onExport,
}: {
  result: LADResultEntry;
  onExport: (id: string, format: LadExportFormat, variables: string[]) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(['lad']));
  const toggle = (key: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  const selected = LAD_EXPORT_VARIABLES.filter((v) => checked.has(v.key)).map((v) => v.key);
  // Non-null when this grid has no axis-aligned lattice, i.e. a raster would be
  // confidently mis-georeferenced. Disables GeoTIFF and explains why.
  const rasterBlocked = rasterBlockedReason(result);

  return (
    <div className="space-y-1" data-testid="lad-export">
      <div className="text-[10px] text-neutral-400 flex items-center gap-1">
        <Download className="w-3 h-3" />
        Export
      </div>
      <div className="space-y-0.5" data-testid="lad-export-variables">
        {LAD_EXPORT_VARIABLES.map((v) => (
          <label
            key={v.key}
            className="flex items-center gap-1.5 text-[10px] text-neutral-300 cursor-pointer"
          >
            <input
              type="checkbox"
              data-testid={`lad-export-var-${v.key}`}
              checked={checked.has(v.key)}
              onChange={(e) => toggle(v.key, e.target.checked)}
              className="rounded bg-neutral-700 border-neutral-600 accent-green-500"
            />
            {v.label}
          </label>
        ))}
        <div className="text-[9px] text-neutral-500 pt-0.5">
          Raster only — one file per variable. CSV, .vox and .asc always carry every field.
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <button
          data-testid="lad-export-tif"
          disabled={!!rasterBlocked || selected.length === 0}
          onClick={(e) => { e.stopPropagation(); onExport(result.id, 'tif', selected); }}
          title={rasterBlocked
            ?? 'Multi-band GeoTIFF — one band per vertical level, georeferenced when the source CRS is known'}
          className="px-2 py-1 text-[11px] bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-200 rounded"
        >
          GeoTIFF
        </button>
        <button
          data-testid="lad-export-csv"
          onClick={(e) => { e.stopPropagation(); onExport(result.id, 'csv', selected); }}
          title="One row per voxel with every field — lossless, and the only format that carries a rotated or terrain-following grid"
          className="px-2 py-1 text-[11px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded"
        >
          Voxel CSV
        </button>
        <button
          data-testid="lad-export-vox"
          onClick={(e) => { e.stopPropagation(); onExport(result.id, 'vox', selected); }}
          title="AMAPVox voxel space (.vox) — read by the R AMAPVox package and DART/pytools4dart"
          className="px-2 py-1 text-[11px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded"
        >
          AMAPVox
        </button>
        <button
          data-testid="lad-export-txt"
          onClick={(e) => { e.stopPropagation(); onExport(result.id, 'txt', selected); }}
          title="Plain-text summary — voxel and occlusion counts, total leaf area, and LAI"
          className="px-2 py-1 text-[11px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded"
        >
          Summary
        </button>
      </div>
      {rasterBlocked && (
        <div className="text-[9px] text-amber-300" data-testid="lad-export-raster-blocked">
          {rasterBlocked}
        </div>
      )}
    </div>
  );
}

// Presentational right-side list of Leaf Area Density results. Each row expands
// when selected to show opacity / hide-empty / colormap controls. State and the
// LAD mutation handlers live in PointCloudViewer; the parent gates on
// `ladResults.length > 0`.
interface LADResultsPanelProps {
  ladResults: LADResultEntry[];
  selectedLadId: string | null;
  // This result's EFFECTIVE colormap (its own override, else the scene default).
  colormapFor: (id: string) => ColormapName;
  // Whether this result carries its own override, i.e. is no longer following
  // the scene default. Drives the "Reset" affordance.
  isOverridden: (id: string) => boolean;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<LADResultEntry>) => void;
  // Sets this result's override; `undefined` clears it back to inheriting.
  onColormapChange: (id: string, name: ColormapName | undefined) => void;
  // Writes the result out; `variables` applies to the raster format only.
  onExport: (id: string, format: LadExportFormat, variables: string[]) => void;
}

export function LADResultsPanel({
  ladResults,
  selectedLadId,
  colormapFor,
  isOverridden,
  onSelect,
  onToggleVisible,
  onRemove,
  onUpdate,
  onColormapChange,
  onExport,
}: LADResultsPanelProps) {
  return (
    <div className="bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg w-64 max-h-[40vh] flex flex-col shrink-0">
      <div className="p-2 border-b border-neutral-700 flex items-center gap-2">
        <Grid3x3 className="w-4 h-4 text-neutral-400" />
        <span className="text-xs font-medium text-neutral-300 flex-1">Leaf Area Density</span>
      </div>
      <div className="overflow-y-auto flex-1 p-1">
        {ladResults.map(result => {
          const isSelected = selectedLadId === result.id;
          const { max } = ladRange(result.voxels);
          return (
            <div key={result.id}>
              <div
                data-testid="lad-row"
                data-voxel-count={result.voxels.length}
                data-lad-max={max}
                // Per-voxel centers (rounded [x,y,z]) for E2E assertions (e.g.
                // terrain-following slope tracking). Capped so a huge grid doesn't
                // bloat the DOM; ample for the small test grids that read it.
                data-voxel-centers={result.voxels.length <= 512
                  ? JSON.stringify(result.voxels.map(v => v.center.map(n => Math.round(n * 1000) / 1000)))
                  : undefined}
                data-return-mode={result.returnMode}
                data-selected={isSelected ? 'true' : 'false'}
                onClick={() => onSelect(result.id)}
                className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                  isSelected ? 'bg-green-600/30 border border-green-500/50' : 'hover:bg-neutral-700/50'
                }`}
              >
                <div className="w-3 h-3 rounded flex-shrink-0" style={{ backgroundColor: result.color }} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-neutral-200 truncate" data-testid="lad-row-name">
                    LAD {result.nx}×{result.ny}×{result.nz}
                  </div>
                  <div className="text-[10px] text-neutral-500">
                    {result.voxels.length.toLocaleString()} voxels · max {max.toFixed(2)} m²/m³ · {result.returnMode === 'multi' ? 'multi-return' : 'single-return'}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleVisible(result.id); }}
                  className="p-1 hover:bg-neutral-600 rounded"
                  title={result.visible ? 'Hide' : 'Show'}
                >
                  {result.visible ? (
                    <Eye className="w-3 h-3 text-neutral-400" />
                  ) : (
                    <EyeOff className="w-3 h-3 text-neutral-600" />
                  )}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(result.id); }}
                  className="p-1 hover:bg-red-600/30 rounded"
                  title="Remove"
                >
                  <Trash2 className="w-3 h-3 text-neutral-500 hover:text-red-400" />
                </button>
              </div>
              {isSelected && (
                <div className="px-2 py-2 space-y-2 border-t border-neutral-700/50">
                  {result.uncertainty && (
                    <div
                      data-testid="lad-uncertainty-summary"
                      className="rounded bg-neutral-900/60 border border-neutral-700/60 px-2 py-1.5"
                    >
                      {result.uncertainty.groupCiValid &&
                       result.uncertainty.groupLadMean != null &&
                       result.uncertainty.groupLadCiLower != null &&
                       result.uncertainty.groupLadCiUpper != null ? (
                        <>
                          <div className="text-[11px] text-neutral-200 font-medium">
                            Mean LAD {result.uncertainty.groupLadMean.toFixed(2)}{' '}
                            [{result.uncertainty.groupLadCiLower.toFixed(2)}–
                            {result.uncertainty.groupLadCiUpper.toFixed(2)}] m²/m³
                          </div>
                          <div className="text-[9px] text-neutral-500">
                            {(result.uncertainty.confidenceLevel * 100).toFixed(0)}% group-scale CI
                            (Pimont et al. 2018) · recommended aggregate
                          </div>
                        </>
                      ) : (
                        <div className="text-[10px] text-amber-300">
                          Uncertainty was computed, but the group-scale interval fell
                          outside the Pimont validity range and is not reported.
                        </div>
                      )}
                      <div
                        className="text-[9px] text-neutral-500 mt-1 cursor-help"
                        title={
                          'This interval reflects sampling uncertainty conditional on ' +
                          'beams that entered the voxels — it does NOT capture occlusion ' +
                          'bias (canopy no beam reached). Single-voxel intervals are ' +
                          'routinely ±50–100% and valid only in narrow regimes; the ' +
                          'group-scale interval shown here is the recommended, much ' +
                          'tighter aggregate.'
                        }
                      >
                        What this does (and doesn’t) capture ⓘ
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="text-[10px] text-neutral-400 block mb-1">
                      Opacity: {result.opacity.toFixed(2)}
                    </label>
                    <input
                      type="range"
                      min="0.05"
                      max="1"
                      step="0.05"
                      value={result.opacity}
                      onChange={(e) => onUpdate(result.id, { opacity: parseFloat(e.target.value) })}
                      className="w-full h-1 bg-neutral-700 rounded appearance-none cursor-pointer"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-[10px] text-neutral-400 cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="lad-hide-empty"
                      checked={result.hideEmpty}
                      onChange={(e) => onUpdate(result.id, { hideEmpty: e.target.checked })}
                      className="rounded bg-neutral-700 border-neutral-600 w-3 h-3 accent-neutral-500"
                    />
                    Hide empty voxels
                  </label>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[10px] text-neutral-400">Colormap</label>
                      {/* Only shown once this result stops following the scene
                          default — otherwise there is nothing to reset. */}
                      {isOverridden(result.id) && (
                        <button
                          data-testid="lad-colormap-reset"
                          onClick={(e) => { e.stopPropagation(); onColormapChange(result.id, undefined); }}
                          className="text-[10px] text-neutral-400 hover:text-green-400 transition-colors"
                          title="Follow the scene default colormap"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                    <select
                      data-testid="lad-colormap"
                      data-overridden={isOverridden(result.id) ? 'true' : 'false'}
                      value={colormapFor(result.id)}
                      onChange={(e) => onColormapChange(result.id, e.target.value as ColormapName)}
                      className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-green-500/50"
                    >
                      {COLORMAP_NAMES.map(name => (
                        <option key={name} value={name}>{COLORMAP_LABELS[name]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="pt-1 border-t border-neutral-700/50">
                    <LadExportControls result={result} onExport={onExport} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
