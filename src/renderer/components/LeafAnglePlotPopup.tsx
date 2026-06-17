import { useState, useMemo, useEffect } from 'react';
import { X, Leaf, Download } from 'lucide-react';
import { downloadFile } from '../utils/fileDownload';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { MeshEntry } from '../lib/pointCloudTypes';
import {
  computeCellDistributions, fitDeWit, deWitCurve, deWitLabel,
  fitBeta, betaCurve, meshCellIds, triangleCountByCell,
} from '../lib/leafAngleDistribution';
import type { Histogram } from '../lib/leafAngleDistribution';
import { buildRoseGeometry, polarToXY } from '../lib/azimuthRose';

interface LeafAnglePlotPopupProps {
  isOpen: boolean;
  onClose: () => void;
  mesh: MeshEntry | null;
  // Display name to title the window with.
  meshName: string;
}

const DEFAULT_INCL_BINS = 18;   // 5° bins over 0..90
const AZ_BINS = 36;             // 10° sectors
// Selectable inclination bin counts (bins over 0..90° → bin width in °).
const INCL_BIN_OPTIONS = [9, 18, 30, 45, 90];

// Above this many VISIBLE cells we stop drawing one overlay per cell — hundreds
// of Recharts <Line> series / SVG petals / table rows make the panel both
// unreadable and slow to render. Instead we show the single combined
// distribution over the visible cells; narrowing the selection (right-hand
// tick-boxes) back to ≤ this many restores the per-cell overlays.
const MAX_OVERLAY_CELLS = 24;

// Distinct, evenly-spread hues for the per-cell overlay lines.
function cellColor(i: number, n: number): string {
  const hue = n <= 1 ? 140 : Math.round((360 * i) / n);
  return `hsl(${hue}, 70%, 55%)`;
}

// A "cell" in the plot: either a real grid cell id, or the whole mesh (id -1)
// when the mesh has no per-triangle cell ids (non-grid Helios mesh).
interface PlotCell {
  id: number;          // grid cell index, or -1 for whole-mesh
  label: string;
  triangleCount: number;
  color: string;
  // World-space center and dimensions (m) of this cell's grid box, when the mesh
  // carries grid geometry. Absent for a non-grid "Whole mesh" entry.
  center?: [number, number, number];
  size?: [number, number, number];
}

export function LeafAnglePlotPopup({ isOpen, onClose, mesh, meshName }: LeafAnglePlotPopupProps) {
  const data = mesh?.data ?? null;

  // The cells available to plot. With a multi-cell grid, one entry per occupied
  // cell; otherwise a single "whole mesh" entry.
  const cells = useMemo<PlotCell[]>(() => {
    if (!data) return [];
    const ids = meshCellIds(data);
    // No per-triangle cells, or a single-cell (auto 1×1×1) grid → there's no
    // per-cell structure to split on, so present one "Whole mesh" entry (id -1
    // ⇒ the PDF uses the whole mesh, not a cell filter).
    if (ids.length <= 1) {
      return [{ id: -1, label: 'Whole mesh', triangleCount: data.triangleCount, color: cellColor(0, 1) }];
    }
    const counts = triangleCountByCell(data);
    const grid = mesh?.data.grid;
    const nx = grid?.nx ?? 0;
    const ny = grid?.ny ?? 0;
    const nz = grid?.nz ?? 0;
    // Per-cell box: uniform dimensions = grid size / subdivisions; the box runs
    // from (grid center − size/2). Cell (ix,iy,iz) center sits half a cell in.
    const cellSize: [number, number, number] | null =
      grid && nx > 0 && ny > 0 && nz > 0
        ? [grid.size[0] / nx, grid.size[1] / ny, grid.size[2] / nz]
        : null;
    const gridMin: [number, number, number] | null = grid
      ? [grid.center[0] - grid.size[0] / 2, grid.center[1] - grid.size[1] / 2, grid.center[2] - grid.size[2] / 2]
      : null;
    return ids.map((id, i) => {
      // Decode row-major index back to (i,j,k) for a readable label when we know
      // the grid shape; fall back to the flat index otherwise.
      let label = `Cell ${id}`;
      let center: [number, number, number] | undefined;
      if (nx > 0 && ny > 0) {
        const ix = id % nx;
        const iy = Math.floor(id / nx) % ny;
        const iz = Math.floor(id / (nx * ny));
        label = `Cell (${ix}, ${iy}, ${iz})`;
        if (cellSize && gridMin) {
          center = [
            gridMin[0] + (ix + 0.5) * cellSize[0],
            gridMin[1] + (iy + 0.5) * cellSize[1],
            gridMin[2] + (iz + 0.5) * cellSize[2],
          ];
        }
      }
      return {
        id, label, triangleCount: counts.get(id) ?? 0, color: cellColor(i, ids.length),
        center, size: cellSize ?? undefined,
      };
    });
  }, [data, mesh]);

  // Hidden cell ids (the tick-boxes deselect these). Reset when the mesh changes.
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  useEffect(() => { setHidden(new Set()); }, [mesh?.id]);

  // Number of inclination PDF bins (user-configurable in the window).
  const [inclBins, setInclBins] = useState(DEFAULT_INCL_BINS);

  // Overlay the fitted Beta curves on the inclination chart (off by default to
  // keep the plot readable when many cells are visible).
  const [showBeta, setShowBeta] = useState(false);

  const visibleCells = useMemo(() => cells.filter(c => !hidden.has(c.id)), [cells, hidden]);

  // When too many cells are visible to overlay individually, fall back to a
  // single combined curve (see MAX_OVERLAY_CELLS).
  const overlayPerCell = visibleCells.length <= MAX_OVERLAY_CELLS;

  // ALL per-cell distributions in ONE pass over the mesh triangles — inclination
  // PDF, azimuth histogram, and G(θ) bucketed by cell. This is the fix for the
  // multi-second freeze: the old code called computeInclinationPdf /
  // computeAzimuthHistogram / computeGTheta once per visible cell, each
  // rescanning every triangle (O(cells × triangles)). Now toggling visibility is
  // a cheap Map lookup; only changing the mesh or the bin count recomputes.
  const dists = useMemo(() => {
    if (!data) return new Map<number, { inclPdf: Histogram; azHist: Histogram; gtheta: number | null }>();
    const ids = cells.map(c => c.id);
    return computeCellDistributions(data, ids, inclBins, AZ_BINS);
  }, [data, cells, inclBins]);

  // Per-cell inclination PDFs (only the visible ones) for the overlaid lines.
  const inclPdfs = useMemo(
    () => visibleCells.map(c => ({ cell: c, pdf: dists.get(c.id)!.inclPdf })).filter(x => x.pdf),
    [visibleCells, dists],
  );

  // Combined PDF over all VISIBLE triangles, for the de Wit fit + reference
  // curve. Built by area-weighted union of the visible per-cell PDFs (the
  // whole-mesh entry is just one such "cell"). Null when nothing is visible —
  // then there's no fit line, which is the correct empty state.
  const combinedPdf = useMemo(() => {
    if (!data || inclPdfs.length === 0) return null;
    const binCenters = inclPdfs[0].pdf.binCenters;
    const binWidth = inclPdfs[0].pdf.binWidth;
    const weights = new Array(binCenters.length).fill(0);
    let totalArea = 0;
    for (const { pdf } of inclPdfs) {
      for (let b = 0; b < weights.length; b++) weights[b] += pdf.density[b] * pdf.totalArea * binWidth;
      totalArea += pdf.totalArea;
    }
    if (totalArea <= 0) return null;
    const density = weights.map(w => w / (totalArea * binWidth));
    return { binCenters, binWidth, density, totalArea };
  }, [data, inclPdfs]);

  const deWit = useMemo(() => (combinedPdf ? fitDeWit(combinedPdf) : null), [combinedPdf]);

  // Per-cell fits for the parameters table: each visible cell's own de Wit
  // archetype and Beta(alpha,beta). Both can be null for a degenerate cell
  // (e.g. all triangles coplanar) — the table shows "—" then.
  // gtheta is measured directly from the mesh geometry (per-triangle normal vs.
  // its beam direction — the scanner when known, else nadir), so it needs
  // `data` + cell id, not the PDF.
  const cellFits = useMemo(
    () => inclPdfs.map(({ cell, pdf }) => ({
      cell,
      deWit: fitDeWit(pdf),
      beta: fitBeta(pdf),
      gtheta: dists.get(cell.id)?.gtheta ?? null,
    })),
    [inclPdfs, dists],
  );

  // Combined fit/projection over all VISIBLE cells, for the summary row shown
  // when there are too many cells to list per-cell.
  const combinedBeta = useMemo(() => (combinedPdf ? fitBeta(combinedPdf) : null), [combinedPdf]);
  const combinedGTheta = useMemo(() => {
    let weighted = 0, area = 0;
    for (const { cell, pdf } of inclPdfs) {
      const gt = dists.get(cell.id)?.gtheta;
      if (gt != null && pdf.totalArea > 0) { weighted += gt * pdf.totalArea; area += pdf.totalArea; }
    }
    return area > 0 ? weighted / area : null;
  }, [inclPdfs, dists]);

  // Format a 3-vector (cell center or dimensions, in metres) as "(x, y, z)" for
  // a CSV cell — quoting handles the embedded commas. Blank when absent (a
  // non-grid whole-mesh / combined row has no single box).
  const vec3 = (v?: [number, number, number]) =>
    v ? `(${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)})` : '';

  // Export the fitted-parameters table exactly as shown: per-cell rows while
  // overlaying, otherwise the single combined row. Mirrors the JSX table below
  // (same columns, same null→"—" handling, here as an empty CSV field), with the
  // cell's grid-box center and dimensions (m) appended.
  const exportParamsCsv = () => {
    const header = [
      'Cell', 'center_xyz_m', 'dimensions_xyz_m',
      'alpha', 'beta', 'mean_inclination_deg', 'R2', 'G_theta', 'de_Wit',
    ];
    const num = (v: number | null | undefined, digits: number) => (v != null ? v.toFixed(digits) : '');
    // Quote a field if it contains a comma, quote, or newline (the cell labels
    // like "Cell (0, 0, 0)" and the "(x, y, z)" vectors contain commas).
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows: string[][] = overlayPerCell
      ? cellFits.map(({ cell, deWit: cd, beta, gtheta }) => [
          cell.label,
          vec3(cell.center),
          vec3(cell.size),
          num(beta?.alpha, 2),
          num(beta?.beta, 2),
          num(beta?.meanIncl, 1),
          num(beta?.r2, 2),
          num(gtheta, 3),
          cd ? deWitLabel(cd.best) : '',
        ])
      : [[
          `All visible (${visibleCells.length} cells)`,
          '',
          '',
          num(combinedBeta?.alpha, 2),
          num(combinedBeta?.beta, 2),
          num(combinedBeta?.meanIncl, 1),
          num(combinedBeta?.r2, 2),
          num(combinedGTheta, 3),
          deWit ? deWitLabel(deWit.best) : '',
        ]];
    const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n') + '\n';
    const safeName = (meshName || 'mesh').replace(/[^\w.-]+/g, '_');
    void downloadFile(csv, `${safeName}_leaf_angle_parameters.csv`);
  };

  // Export the inclination probability density curves themselves (the empirical
  // data plotted in the chart): one row per series — each visible cell while
  // overlaying, or a single combined row otherwise — with one column per
  // inclination bin. The header names each column by its bin-center angle
  // (degrees). Same source data as `chartData`, so the CSV matches the cell
  // lines on screen. Density units: area fraction per ° (sum over bins × bin
  // width = 1).
  const exportDistributionsCsv = () => {
    if (inclPdfs.length === 0) return;
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const centers = inclPdfs[0].pdf.binCenters;
    // One row per series: [label, center, dimensions, density-per-bin]. The
    // trailing columns are the bin-center angles. Center/dimensions are blank for
    // the non-grid combined row.
    const series: { label: string; cell?: PlotCell; values: number[] }[] = overlayPerCell
      ? inclPdfs.map(({ cell, pdf }) => ({ label: cell.label, cell, values: pdf.density }))
      : combinedPdf
        ? [{ label: `All visible (${visibleCells.length} cells)`, values: combinedPdf.density }]
        : [];
    const header = ['cell', 'center_xyz_m', 'dimensions_xyz_m', ...centers.map(a => a.toFixed(2))];
    const rows = series.map(s => [
      s.label,
      vec3(s.cell?.center),
      vec3(s.cell?.size),
      ...centers.map((_, b) => (s.values[b] != null ? s.values[b].toExponential(6) : '')),
    ]);
    const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n') + '\n';
    const safeName = (meshName || 'mesh').replace(/[^\w.-]+/g, '_');
    void downloadFile(csv, `${safeName}_leaf_angle_distributions.csv`);
  };

  // Recharts data: one row per inclination bin, a key per visible cell, the
  // combined best-fit de Wit curve, and (when toggled on) a per-cell Beta curve.
  const chartData = useMemo(() => {
    if (inclPdfs.length === 0) return [];
    const centers = inclPdfs[0].pdf.binCenters;
    const fitCurve = deWit && combinedPdf ? deWitCurve(deWit.best, centers) : null;
    const betaCurves = overlayPerCell && showBeta
      ? cellFits.map(f => ({ id: f.cell.id, curve: f.beta ? betaCurve(f.beta.alpha, f.beta.beta, centers) : null }))
      : [];
    return centers.map((angle, b) => {
      const row: Record<string, number> = { angle: Math.round(angle) };
      // One series per cell while overlaying; a single combined series otherwise
      // (building 1000 keys per row would be as slow as drawing 1000 lines).
      if (overlayPerCell) {
        for (const { cell, pdf } of inclPdfs) row[`c${cell.id}`] = pdf.density[b];
      } else if (combinedPdf) {
        row.combined = combinedPdf.density[b];
      }
      if (fitCurve) row.fit = fitCurve[b];
      for (const bc of betaCurves) if (bc.curve) row[`bf${bc.id}`] = bc.curve[b];
      return row;
    });
  }, [inclPdfs, deWit, combinedPdf, showBeta, cellFits, overlayPerCell]);

  // Azimuth rose: per-cell petals sharing one radial scale so cells compare.
  const azHists = useMemo(
    () => visibleCells.map(c => ({ cell: c, hist: dists.get(c.id)!.azHist })).filter(x => x.hist),
    [visibleCells, dists],
  );

  // Combined azimuth histogram over the visible cells (area-weighted union),
  // mirroring combinedPdf — drawn as a single petal when there are too many
  // cells to draw one each.
  const combinedAz = useMemo(() => {
    if (azHists.length === 0) return null;
    const { binCenters, binWidth } = azHists[0].hist;
    const weights = new Array(binCenters.length).fill(0);
    let totalArea = 0;
    for (const { hist } of azHists) {
      for (let b = 0; b < weights.length; b++) weights[b] += hist.density[b] * hist.totalArea * binWidth;
      totalArea += hist.totalArea;
    }
    if (totalArea <= 0) return null;
    return { binCenters, binWidth, density: weights.map(w => w / (totalArea * binWidth)), totalArea };
  }, [azHists]);

  const roseMax = useMemo(
    () => overlayPerCell
      ? Math.max(1e-30, ...azHists.flatMap(a => a.hist.density))
      : Math.max(1e-30, ...(combinedAz?.density ?? [])),
    [azHists, combinedAz, overlayPerCell],
  );

  const toggleCell = (id: number) => {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (!isOpen || !mesh || !data) return null;

  // Rose canvas geometry.
  const ROSE = 240, cx = ROSE / 2, cy = ROSE / 2, rOuter = ROSE / 2 - 28;
  const roseSpokes = buildRoseGeometry([1], [0], cx, cy, rOuter).spokes;
  const roseRings = buildRoseGeometry([1], [0], cx, cy, rOuter).rings;

  return (
    <div
      data-testid="leaf-angle-popup"
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation(); }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-4xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Leaf className="w-4 h-4 text-green-400" />
            <h2 className="text-sm font-semibold text-white">Leaf Angle Distribution — {meshName}</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              data-testid="export-params-csv"
              onClick={exportParamsCsv}
              disabled={cellFits.length === 0}
              title="Export the fitted parameters table to a CSV file"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download className="w-3.5 h-3.5" />
              Parameters CSV
            </button>
            <button
              data-testid="export-distributions-csv"
              onClick={exportDistributionsCsv}
              disabled={inclPdfs.length === 0}
              title="Export the inclination probability density curves to a CSV file"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download className="w-3.5 h-3.5" />
              Distributions CSV
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
              <X className="w-4 h-4 text-neutral-400" />
            </button>
          </div>
        </div>

        <div className="p-4 max-h-[78vh] overflow-y-auto">
          <div className="grid grid-cols-[1fr_auto] gap-4">
            {/* Left: inclination PDF + azimuth rose */}
            <div className="space-y-4 min-w-0">
              {/* Inclination PDF */}
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <h3 className="text-xs font-medium text-neutral-300">
                    Inclination PDF (area-weighted)
                  </h3>
                  {deWit && (
                    <span
                      data-testid="dewit-fit-label"
                      className="text-[11px] text-lime-300"
                      title="Closest canonical de Wit leaf-angle distribution"
                    >
                      Best fit: {deWitLabel(deWit.best)} (R²={deWit.scores[0].r2.toFixed(2)})
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mb-1">
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-neutral-400">Bins</label>
                    <select
                      data-testid="incl-bins"
                      value={inclBins}
                      onChange={(e) => setInclBins(parseInt(e.target.value, 10))}
                      className="bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-0.5 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                    >
                      {INCL_BIN_OPTIONS.map(n => (
                        <option key={n} value={n}>{n} ({(90 / n).toFixed(n >= 90 ? 0 : 1)}° wide)</option>
                      ))}
                    </select>
                  </div>
                  <label
                    className={`flex items-center gap-1.5 text-[10px] cursor-pointer select-none ${overlayPerCell ? 'text-neutral-400' : 'text-neutral-600 cursor-not-allowed'}`}
                    title={overlayPerCell
                      ? "Overlay each visible cell's fitted Beta curve (dashed)"
                      : `Available when ≤ ${MAX_OVERLAY_CELLS} cells are visible`}
                  >
                    <input
                      type="checkbox"
                      data-testid="show-beta-fit"
                      checked={showBeta && overlayPerCell}
                      disabled={!overlayPerCell}
                      onChange={(e) => setShowBeta(e.target.checked)}
                    />
                    Show Beta fit
                  </label>
                </div>
                {!overlayPerCell && (
                  <p data-testid="combined-mode-note" className="text-[10px] text-amber-300/90 mb-1 max-w-prose">
                    {visibleCells.length} cells visible — showing the combined distribution over them.
                    Select ≤ {MAX_OVERLAY_CELLS} cells (right) to overlay per-cell curves.
                  </p>
                )}
                <div style={{ width: '100%', height: 260 }} data-testid="incl-chart">
                  {/* Explicit numeric height (not the default height="100%"):
                      ResponsiveContainer seeds its size state to -1×-1 and only
                      measures the real box in a post-mount effect, so a
                      percent height computes as -1 on first render and trips
                      Recharts' "width/height should be > 0" warning every time
                      the popup opens. A fixed height short-circuits that path
                      (the parent box is already a fixed 260px, so height was
                      never actually responsive); width stays fluid. */}
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
                      <CartesianGrid stroke="#3f3f46" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="angle" type="number" domain={[0, 90]}
                        ticks={[0, 15, 30, 45, 60, 75, 90]}
                        tick={{ fill: '#a1a1aa', fontSize: 10 }}
                        label={{ value: 'Inclination (°)', position: 'insideBottom', offset: -8, fill: '#a1a1aa', fontSize: 11 }}
                      />
                      <YAxis
                        tick={{ fill: '#a1a1aa', fontSize: 10 }}
                        label={{ value: 'Density g(θ) — area per ° inclination', angle: -90, position: 'insideLeft', fill: '#a1a1aa', fontSize: 11 }}
                      />
                      <Tooltip
                        contentStyle={{ background: '#27272a', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 11 }}
                        labelStyle={{ color: '#e4e4e7' }}
                        formatter={(v) => (typeof v === 'number' ? v.toExponential(2) : String(v))}
                      />
                      {overlayPerCell ? inclPdfs.map(({ cell }) => (
                        <Line
                          key={cell.id} type="linear" dataKey={`c${cell.id}`} name={cell.label}
                          stroke={cell.color} strokeWidth={1.5}
                          dot={{ r: 2.5, fill: cell.color, strokeWidth: 0 }}
                          activeDot={{ r: 3.5 }}
                          isAnimationActive={false}
                        />
                      )) : (
                        <Line
                          type="linear" dataKey="combined" name={`All visible (${visibleCells.length} cells)`}
                          stroke="#a3e635" strokeWidth={2}
                          dot={{ r: 2.5, fill: '#a3e635', strokeWidth: 0 }}
                          activeDot={{ r: 3.5 }}
                          isAnimationActive={false}
                        />
                      )}
                      {deWit && (
                        <Line
                          type="linear" dataKey="fit" name={`de Wit: ${deWitLabel(deWit.best)}`}
                          stroke="#e4e4e7" strokeWidth={1.5} strokeDasharray="5 4" dot={false}
                          isAnimationActive={false}
                        />
                      )}
                      {showBeta && cellFits.map(({ cell, beta }) => (
                        beta && (
                          <Line
                            key={`bf${cell.id}`} type="linear" dataKey={`bf${cell.id}`}
                            name={`Beta: ${cell.label}`}
                            stroke={cell.color} strokeWidth={1.5} strokeDasharray="4 3" dot={false}
                            isAnimationActive={false}
                          />
                        )
                      ))}
                      {/* Anchor so an empty chart still renders axes. */}
                      <ReferenceLine x={0} stroke="transparent" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Per-cell fitted-distribution parameters */}
                {cellFits.length > 0 && (
                  <div className="mt-2">
                    <h4 className="text-[11px] font-medium text-neutral-300 mb-1">
                      Fitted distribution parameters
                    </h4>
                    {/* Bounded + scrollable so a many-cell grid can't overrun the
                        layout (and so we never mount hundreds of rows tall). */}
                    <div className="max-h-64 overflow-y-auto">
                    <table
                      data-testid="beta-fit-table"
                      className="w-full text-[11px] text-neutral-300 border-collapse"
                    >
                      <thead>
                        <tr className="text-neutral-500 text-left">
                          <th className="font-medium py-0.5 pr-2">Cell</th>
                          <th className="font-medium py-0.5 px-2 text-right" title="Beta shape parameter α">α</th>
                          <th className="font-medium py-0.5 px-2 text-right" title="Beta shape parameter β">β</th>
                          <th className="font-medium py-0.5 px-2 text-right" title="Mean inclination">mean θ (°)</th>
                          <th className="font-medium py-0.5 px-2 text-right" title="Beta fit R²">R²</th>
                          <th
                            className="font-medium py-0.5 px-2 text-right"
                            title="G(θ): area-weighted mean |normal · beam direction| — the leaf-projection coefficient. Beam is the scanner direction when known, else nadir (straight down)."
                          >G(θ)</th>
                          <th className="font-medium py-0.5 pl-2">de Wit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {/* Per-cell rows while overlaying; a single combined row
                            otherwise (hundreds of rows = the same overrun we're
                            avoiding in the chart). */}
                        {overlayPerCell ? cellFits.map(({ cell, deWit: cd, beta, gtheta }) => (
                          <tr
                            key={cell.id}
                            data-testid="beta-fit-row"
                            data-cell-id={cell.id}
                            className="border-t border-neutral-700/60"
                          >
                            <td className="py-0.5 pr-2">
                              <span className="inline-flex items-center gap-1.5 min-w-0">
                                <span
                                  className="inline-block w-2.5 h-2.5 rounded-sm border border-neutral-600 shrink-0"
                                  style={{ backgroundColor: cell.color }}
                                />
                                <span className="truncate">{cell.label}</span>
                              </span>
                            </td>
                            <td className="py-0.5 px-2 text-right tabular-nums">{beta ? beta.alpha.toFixed(2) : '—'}</td>
                            <td className="py-0.5 px-2 text-right tabular-nums">{beta ? beta.beta.toFixed(2) : '—'}</td>
                            <td className="py-0.5 px-2 text-right tabular-nums">{beta ? beta.meanIncl.toFixed(1) : '—'}</td>
                            <td className="py-0.5 px-2 text-right tabular-nums">{beta ? beta.r2.toFixed(2) : '—'}</td>
                            <td className="py-0.5 px-2 text-right tabular-nums">{gtheta != null ? gtheta.toFixed(3) : '—'}</td>
                            <td className="py-0.5 pl-2">{cd ? deWitLabel(cd.best) : '—'}</td>
                          </tr>
                        )) : (
                          <tr
                            data-testid="beta-fit-row"
                            data-cell-id="combined"
                            className="border-t border-neutral-700/60"
                          >
                            <td className="py-0.5 pr-2">
                              <span className="inline-flex items-center gap-1.5 min-w-0">
                                <span
                                  className="inline-block w-2.5 h-2.5 rounded-sm border border-neutral-600 shrink-0"
                                  style={{ backgroundColor: '#a3e635' }}
                                />
                                <span className="truncate">All visible ({visibleCells.length} cells)</span>
                              </span>
                            </td>
                            <td className="py-0.5 px-2 text-right tabular-nums">{combinedBeta ? combinedBeta.alpha.toFixed(2) : '—'}</td>
                            <td className="py-0.5 px-2 text-right tabular-nums">{combinedBeta ? combinedBeta.beta.toFixed(2) : '—'}</td>
                            <td className="py-0.5 px-2 text-right tabular-nums">{combinedBeta ? combinedBeta.meanIncl.toFixed(1) : '—'}</td>
                            <td className="py-0.5 px-2 text-right tabular-nums">{combinedBeta ? combinedBeta.r2.toFixed(2) : '—'}</td>
                            <td className="py-0.5 px-2 text-right tabular-nums">{combinedGTheta != null ? combinedGTheta.toFixed(3) : '—'}</td>
                            <td className="py-0.5 pl-2">{deWit ? deWitLabel(deWit.best) : '—'}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    </div>
                  </div>
                )}
              </div>

              {/* Azimuth rose */}
              <div>
                <h3 className="text-xs font-medium text-neutral-300 mb-1">
                  Azimuth distribution (area-weighted)
                </h3>
                <svg
                  data-testid="azimuth-rose"
                  width={ROSE} height={ROSE}
                  className="bg-neutral-900/40 rounded mx-auto block"
                >
                  {/* Concentric rings */}
                  {roseRings.map((r, i) => (
                    <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke="#3f3f46" strokeWidth={1} />
                  ))}
                  {/* Spokes + compass labels */}
                  {roseSpokes.map((s, i) => {
                    const lbl = polarToXY((360 / roseSpokes.length) * i, rOuter + 12, cx, cy);
                    return (
                      <g key={i}>
                        <line x1={cx} y1={cy} x2={s.outer.x} y2={s.outer.y} stroke="#3f3f46" strokeWidth={1} />
                        <text x={lbl.x} y={lbl.y} fill="#71717a" fontSize={9} textAnchor="middle" dominantBaseline="middle">
                          {s.label}
                        </text>
                      </g>
                    );
                  })}
                  {/* One petal per visible cell, or a single combined petal when
                      there are too many cells to draw individually. */}
                  {overlayPerCell ? azHists.map(({ cell, hist }) => {
                    const g = buildRoseGeometry(hist.density, hist.binCenters, cx, cy, rOuter, { maxDensity: roseMax });
                    return (
                      <path
                        key={cell.id} d={g.path} fill={cell.color} fillOpacity={0.18}
                        stroke={cell.color} strokeWidth={1.5}
                      />
                    );
                  }) : combinedAz && (
                    <path
                      d={buildRoseGeometry(combinedAz.density, combinedAz.binCenters, cx, cy, rOuter, { maxDensity: roseMax }).path}
                      fill="#a3e635" fillOpacity={0.18} stroke="#a3e635" strokeWidth={1.5}
                    />
                  )}
                </svg>
              </div>
            </div>

            {/* Right: per-cell tick-boxes */}
            <div className="w-56 flex-shrink-0">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-medium text-neutral-300">
                  Cells ({visibleCells.length}/{cells.length})
                </h3>
                {cells.length > 1 && (
                  <div className="flex gap-2">
                    <button
                      data-testid="cells-all"
                      onClick={() => setHidden(new Set())}
                      className="text-[10px] text-neutral-400 hover:text-neutral-200"
                    >All</button>
                    <span className="text-neutral-600 text-[10px]">|</span>
                    <button
                      data-testid="cells-none"
                      onClick={() => setHidden(new Set(cells.map(c => c.id)))}
                      className="text-[10px] text-neutral-400 hover:text-neutral-200"
                    >None</button>
                  </div>
                )}
              </div>
              <div className="max-h-[60vh] overflow-y-auto space-y-1 pr-1" data-testid="cell-list">
                {cells.map(cell => {
                  const checked = !hidden.has(cell.id);
                  return (
                    <label
                      key={cell.id}
                      data-testid="cell-checkbox"
                      data-cell-id={cell.id}
                      data-checked={checked ? 'true' : 'false'}
                      className="flex items-center gap-2 text-xs text-neutral-200 cursor-pointer hover:bg-neutral-700/40 rounded px-1 py-0.5"
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleCell(cell.id)} />
                      <span className="inline-block w-3 h-3 rounded-sm border border-neutral-600 shrink-0" style={{ backgroundColor: cell.color }} />
                      <span className="truncate flex-1">{cell.label}</span>
                      <span className="text-neutral-500">{cell.triangleCount.toLocaleString()}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
