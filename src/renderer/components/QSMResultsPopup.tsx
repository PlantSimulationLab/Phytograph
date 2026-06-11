import { useState, useMemo, useEffect } from 'react';
import { X, TreePine } from 'lucide-react';
import {
  BarChart, Bar, Cell, ComposedChart, Scatter, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { QSMEntry } from '../lib/pointCloudTypes';
import {
  taperProfile, diameterAtHeight, rankBars, branchAngleHistogram,
  heightProfile, surfCovHistogram, madHistogram, qaSummary, perShootRows,
  rankLabel, LOW_COVERAGE,
  type CoverageGrade, type ShootRow,
} from '../lib/qsmDistributions';

interface QSMResultsPopupProps {
  isOpen: boolean;
  onClose: () => void;
  qsm: QSMEntry | null;
  // Display name to title the window with.
  qsmName: string;
}

// Selectable branch-angle bin counts (bins over 0..90° → bin width in °).
const ANGLE_BIN_OPTIONS = [9, 18, 30, 45];
// What the rank-distribution bars measure.
type RankMetric = 'count' | 'length' | 'volume';
// What the vertical profile measures.
type ProfileMetric = 'volume' | 'length';
// How the per-shoot table is sorted.
type ShootSortKey = 'shootId' | 'rank' | 'lengthM' | 'baseDiameterMm' | 'branchAngleDeg' | 'childCount' | 'surfCov';

const RANK_BAR_COLOR = '#84cc16';   // lime
const NEUTRAL_BAR_COLOR = '#52525b'; // neutral
const LOW_COV_COLOR = '#d97706';    // amber — under-covered (one-sided) cylinders

// Coverage grade — how point-supported the STRUCTURE is (volume-weighted). This
// is an occlusion diagnostic, NOT a pass/fail: low coverage is normal on TLS and
// the model's radius correction is designed to handle it.
const GRADE_STYLE: Record<CoverageGrade, { label: string; cls: string }> = {
  high: { label: 'HIGH', cls: 'bg-green-600/20 border-green-500/50 text-green-300' },
  moderate: { label: 'MODERATE', cls: 'bg-amber-600/20 border-amber-500/50 text-amber-300' },
  low: { label: 'LOW', cls: 'bg-orange-600/20 border-orange-500/50 text-orange-300' },
};

const AXIS_TICK = { fill: '#a1a1aa', fontSize: 10 };
const TOOLTIP_STYLE = { background: '#27272a', border: '1px solid #3f3f46', borderRadius: 6, fontSize: 11 };

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function QSMResultsPopup({ isOpen, onClose, qsm, qsmName }: QSMResultsPopupProps) {
  const cyls = qsm?.cylinders ?? [];
  const shoots = qsm?.shoots ?? [];
  const metrics = qsm?.metrics ?? null;

  // Right-column controls.
  const [angleBins, setAngleBins] = useState(18);
  const [rankMetric, setRankMetric] = useState<RankMetric>('length');
  const [profileMetric, setProfileMetric] = useState<ProfileMetric>('volume');
  const [sortKey, setSortKey] = useState<ShootSortKey>('lengthM');
  const [sortDesc, setSortDesc] = useState(true);

  // Reset table sort when the QSM changes.
  useEffect(() => { setSortKey('lengthM'); setSortDesc(true); }, [qsm?.id]);

  const qa = useMemo(() => qaSummary(cyls), [cyls]);
  const taper = useMemo(() => taperProfile(cyls), [cyls]);
  const dbh = useMemo(() => diameterAtHeight(cyls, 1.3), [cyls]);
  const bars = useMemo(() => rankBars(metrics), [metrics]);
  const angleHist = useMemo(() => branchAngleHistogram(cyls, shoots, angleBins), [cyls, shoots, angleBins]);
  const profile = useMemo(() => heightProfile(cyls, 20), [cyls]);
  const surfHist = useMemo(() => surfCovHistogram(cyls, 20), [cyls]);
  const madHist = useMemo(() => madHistogram(cyls, 20), [cyls]);
  const shootRows = useMemo(() => perShootRows(cyls, shoots), [cyls, shoots]);

  const sortedShoots = useMemo(() => {
    const dir = sortDesc ? -1 : 1;
    return shootRows.slice().sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      // Nulls (e.g. trunk branch angle) sort last regardless of direction.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
  }, [shootRows, sortKey, sortDesc]);

  if (!isOpen || !qsm) return null;

  // Recharts rows.
  const taperData = taper.map(p => ({ diameterMm: p.diameterMm, heightM: p.heightM, lowCoverage: p.lowCoverage }));
  const rankData = bars.map(b => ({
    label: b.label,
    value: rankMetric === 'count' ? b.nShoots : rankMetric === 'length' ? b.totalLengthM : b.woodyVolM3 * 1e6,
  }));
  const rankUnit = rankMetric === 'count' ? 'shoots' : rankMetric === 'length' ? 'm' : 'cm³';
  const angleData = angleHist.binCenters.map((c, i) => ({ angle: Math.round(c), count: angleHist.counts[i] }));
  const profileData = profile.map(b => ({
    height: +b.heightMid.toFixed(2),
    value: profileMetric === 'volume' ? b.volM3 * 1e6 : b.lengthM,
  }));
  const profileUnit = profileMetric === 'volume' ? 'cm³' : 'm';
  const surfData = surfHist.binCenters.map((c, i) => ({ x: +c.toFixed(2), count: surfHist.counts[i] }));
  const madData = madHist.binCenters.map((c, i) => ({ x: +c.toFixed(1), count: madHist.counts[i] }));

  const grade = GRADE_STYLE[qa.grade];

  const sortBtn = (key: ShootSortKey, label: string) => (
    <button
      onClick={() => { if (sortKey === key) setSortDesc(d => !d); else { setSortKey(key); setSortDesc(true); } }}
      className="text-left hover:text-neutral-200 flex items-center gap-0.5"
    >
      {label}{sortKey === key ? (sortDesc ? ' ↓' : ' ↑') : ''}
    </button>
  );

  return (
    <div
      data-testid="qsm-results-popup"
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation(); }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-4xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <TreePine className="w-4 h-4 text-green-400" />
            <h2 className="text-sm font-semibold text-white">QSM Results — {qsmName}</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 max-h-[78vh] overflow-y-auto">
          <div className="grid grid-cols-[1fr_auto] gap-4">
            {/* Left: plots + tables */}
            <div className="space-y-4 min-w-0">
              {/* Scan-coverage badge strip — an occlusion diagnostic, volume-
                  weighted, NOT a fit pass/fail (low coverage is normal on TLS). */}
              <div
                data-testid="qsm-qa-badge"
                data-grade={qa.grade}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 rounded border text-[11px] ${grade.cls}`}
                title="How completely the scan saw the woody surface, weighted by volume. Low coverage means one-sided/occluded wood — the model fills it in from the taper and pipe-model, so this is a coverage diagnostic, not a fit failure."
              >
                <span className="font-semibold">Scan coverage: {grade.label}</span>
                {Number.isFinite(qa.volMedianSurfCov) && (
                  <span>median surf_cov {qa.volMedianSurfCov.toFixed(2)} (by volume)</span>
                )}
                <span>{pct(qa.wellCoveredVolFrac)} of volume well-covered</span>
                {Number.isFinite(qa.volMedianMadMm) && (
                  <span>median residual {qa.volMedianMadMm.toFixed(1)} mm</span>
                )}
                {qa.lowCoverageVolFrac > 0.005 && (
                  <span>{pct(qa.lowCoverageVolFrac)} of volume one-sided</span>
                )}
              </div>

              {/* Summary metrics table */}
              {metrics && (
                <div data-testid="qsm-summary-table">
                  <h3 className="text-xs font-medium text-neutral-300 mb-1">Whole-tree summary</h3>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-[11px] text-neutral-400">
                    <Row k="Trunk Ø" v={`${metrics.trunk_diameter_mm.toFixed(1)} mm`} />
                    <Row k="DBH (interp. @1.3 m)" v={dbh != null ? `${dbh.toFixed(1)} mm` : '—'} />
                    <Row k="Height" v={`${metrics.tree_height_m.toFixed(2)} m`} />
                    <Row k="TCSA" v={`${(metrics.tcsa_m2 * 1e4).toFixed(1)} cm²`} />
                    <Row k="Canopy W × H" v={`${metrics.canopy_width_m.toFixed(2)} × ${metrics.canopy_height_m.toFixed(2)} m`} />
                    <Row k="Total length" v={`${metrics.total_length_m.toFixed(2)} m`} />
                    <Row k="Woody volume" v={`${(metrics.total_woody_volume_m3 * 1e6).toFixed(0)} cm³`} />
                    <Row k="Stem / branch vol" v={`${(metrics.stem_volume_m3 * 1e6).toFixed(0)} / ${(metrics.branch_volume_m3 * 1e6).toFixed(0)} cm³`} />
                    <Row k="Scaffolds" v={`${metrics.n_scaffolds}`} />
                    <Row k="Shoots / max rank" v={`${metrics.n_shoots_total} / ${metrics.max_rank}`} />
                  </div>
                </div>
              )}

              {/* Stem taper profile */}
              <div>
                <h3 className="text-xs font-medium text-neutral-300 mb-1">Stem taper (trunk diameter vs height)</h3>
                <div style={{ width: '100%', height: 260 }} data-testid="qsm-taper-chart">
                  {/* Explicit numeric height avoids Recharts' first-render
                      "width/height should be > 0" warning: a default
                      height="100%" measures as -1 before the post-mount resize
                      effect runs. Parent box is already fixed-height, so height
                      was never responsive; width stays fluid. */}
                  <ResponsiveContainer width="100%" height={260}>
                    <ComposedChart data={taperData} margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
                      <CartesianGrid stroke="#3f3f46" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="diameterMm" type="number"
                        tick={AXIS_TICK}
                        label={{ value: 'Diameter (mm)', position: 'insideBottom', offset: -8, fill: '#a1a1aa', fontSize: 11 }}
                      />
                      <YAxis
                        dataKey="heightM" type="number" tick={AXIS_TICK}
                        label={{ value: 'Height (m)', angle: -90, position: 'insideLeft', fill: '#a1a1aa', fontSize: 11 }}
                      />
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#e4e4e7' }} />
                      {/* Connected line traces the taper; scatter marks each cylinder,
                          poor-fit ones in red so suspect trunk fits stand out. */}
                      <Line type="monotone" dataKey="diameterMm" stroke="#84cc16" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      <Scatter dataKey="diameterMm" isAnimationActive={false}>
                        {taperData.map((p, i) => (
                          <Cell key={i} fill={p.lowCoverage ? LOW_COV_COLOR : '#84cc16'} />
                        ))}
                      </Scatter>
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Branch-order distribution */}
              <div>
                <h3 className="text-xs font-medium text-neutral-300 mb-1">
                  Branch-order distribution ({rankMetric === 'count' ? 'shoot count' : rankMetric === 'length' ? 'total length' : 'woody volume'})
                </h3>
                <div style={{ width: '100%', height: 220 }} data-testid="qsm-rank-chart">
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={rankData} margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
                      <CartesianGrid stroke="#3f3f46" strokeDasharray="3 3" />
                      <XAxis dataKey="label" tick={AXIS_TICK} />
                      <YAxis tick={AXIS_TICK} label={{ value: rankUnit, angle: -90, position: 'insideLeft', fill: '#a1a1aa', fontSize: 11 }} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#e4e4e7' }} cursor={{ fill: '#ffffff10' }} />
                      <Bar dataKey="value" fill={RANK_BAR_COLOR} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Branch-angle histogram */}
              <div>
                <h3 className="text-xs font-medium text-neutral-300 mb-1">
                  Branch-angle distribution ({angleHist.total} branches)
                </h3>
                <div style={{ width: '100%', height: 220 }} data-testid="qsm-angle-chart">
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={angleData} margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
                      <CartesianGrid stroke="#3f3f46" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="angle" tick={AXIS_TICK}
                        label={{ value: 'Fork angle vs parent (°)', position: 'insideBottom', offset: -8, fill: '#a1a1aa', fontSize: 11 }}
                      />
                      <YAxis tick={AXIS_TICK} label={{ value: 'count', angle: -90, position: 'insideLeft', fill: '#a1a1aa', fontSize: 11 }} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#e4e4e7' }} cursor={{ fill: '#ffffff10' }} />
                      <Bar dataKey="count" fill={RANK_BAR_COLOR} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Scan-coverage & fit-tightness diagnostics */}
              <div>
                <h3 className="text-xs font-medium text-neutral-300 mb-1">
                  Scan coverage &amp; fit
                </h3>
                <p className="text-[10px] text-neutral-500 mb-1.5 max-w-prose">
                  Surface coverage is how much of each cylinder the scanner saw —
                  low values are one-sided/occluded wood (normal on TLS), shown
                  amber. The model infers radius there from taper &amp; pipe-model.
                  MAD is the absolute fit residual, shown for information.
                </p>
                <div className="grid grid-cols-2 gap-3" data-testid="qsm-qa-charts">
                  <QAHist
                    title="Surface coverage"
                    data={surfData}
                    excluded={surfHist.excluded}
                    isLow={(x) => x < LOW_COVERAGE}
                  />
                  <QAHist
                    title="Fit residual (MAD, mm)"
                    data={madData}
                    excluded={madHist.excluded}
                  />
                </div>
              </div>

              {/* Vertical profile */}
              <div>
                <h3 className="text-xs font-medium text-neutral-300 mb-1">
                  Vertical profile ({profileMetric === 'volume' ? 'woody volume' : 'length'} by height)
                </h3>
                <div style={{ width: '100%', height: 300 }} data-testid="qsm-profile-chart">
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart layout="vertical" data={profileData} margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
                      <CartesianGrid stroke="#3f3f46" strokeDasharray="3 3" />
                      <XAxis type="number" tick={AXIS_TICK} label={{ value: profileUnit, position: 'insideBottom', offset: -8, fill: '#a1a1aa', fontSize: 11 }} />
                      <YAxis type="category" dataKey="height" tick={AXIS_TICK} reversed label={{ value: 'Height (m)', angle: -90, position: 'insideLeft', fill: '#a1a1aa', fontSize: 11 }} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#e4e4e7' }} cursor={{ fill: '#ffffff10' }} />
                      <Bar dataKey="value" fill={RANK_BAR_COLOR} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Per-shoot table */}
              <div>
                <h3 className="text-xs font-medium text-neutral-300 mb-1">Shoots ({shootRows.length})</h3>
                <div className="max-h-[40vh] overflow-y-auto border border-neutral-700 rounded" data-testid="qsm-shoot-table">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-neutral-800 text-neutral-400 border-b border-neutral-700">
                      <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:font-medium">
                        <th>{sortBtn('shootId', 'ID')}</th>
                        <th>{sortBtn('rank', 'Rank')}</th>
                        <th>{sortBtn('lengthM', 'Length')}</th>
                        <th>{sortBtn('baseDiameterMm', 'Base Ø')}</th>
                        <th>{sortBtn('branchAngleDeg', 'Angle')}</th>
                        <th>{sortBtn('childCount', 'Children')}</th>
                        <th>{sortBtn('surfCov', 'Coverage')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedShoots.map(r => (
                        <ShootTableRow key={r.shootId} r={r} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Right: controls */}
            <div className="w-52 flex-shrink-0 space-y-4">
              <div>
                <h3 className="text-xs font-medium text-neutral-300 mb-1.5">Branch-angle bins</h3>
                <select
                  data-testid="qsm-angle-bins"
                  value={angleBins}
                  onChange={(e) => setAngleBins(parseInt(e.target.value, 10))}
                  className="w-full bg-neutral-700 text-neutral-200 text-[11px] px-1.5 py-1 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
                >
                  {ANGLE_BIN_OPTIONS.map(n => (
                    <option key={n} value={n}>{n} ({(90 / n).toFixed(1)}° wide)</option>
                  ))}
                </select>
              </div>

              <RadioGroup
                title="Branch-order metric"
                testId="qsm-rank-metric"
                value={rankMetric}
                onChange={(v) => setRankMetric(v as RankMetric)}
                options={[['count', 'Shoot count'], ['length', 'Total length'], ['volume', 'Woody volume']]}
              />

              <RadioGroup
                title="Vertical profile metric"
                testId="qsm-profile-metric"
                value={profileMetric}
                onChange={(v) => setProfileMetric(v as ProfileMetric)}
                options={[['volume', 'Woody volume'], ['length', 'Length']]}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span>{k}</span>
      <span className="text-neutral-200 text-right">{v}</span>
    </>
  );
}

function ShootTableRow({ r }: { r: ShootRow }) {
  return (
    <tr
      data-low-coverage={r.lowCoverage ? 'true' : 'false'}
      className={`[&>td]:px-2 [&>td]:py-0.5 text-neutral-300 border-b border-neutral-800 last:border-0 ${
        r.lowCoverage ? 'bg-amber-500/10' : ''
      }`}
    >
      <td>{r.shootId}</td>
      <td>{rankLabel(r.rank)}</td>
      <td>{r.lengthM.toFixed(2)} m</td>
      <td>{r.baseDiameterMm.toFixed(1)} mm</td>
      <td>{r.branchAngleDeg != null ? `${r.branchAngleDeg.toFixed(0)}°` : '—'}</td>
      <td>{r.childCount}</td>
      <td>{r.surfCov != null ? r.surfCov.toFixed(2) : '—'}</td>
    </tr>
  );
}

function QAHist({
  title, data, excluded, isLow,
}: {
  title: string;
  data: { x: number; count: number }[];
  excluded: number;
  // When given, bins whose x is "low coverage" are tinted amber; otherwise the
  // histogram is purely informational (single neutral color).
  isLow?: (x: number) => boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] text-neutral-400">{title}</span>
        {excluded > 0 && (
          <span className="text-[9px] text-neutral-600" title="Cylinders without this metric were excluded">
            {excluded.toLocaleString()} n/a
          </span>
        )}
      </div>
      <div style={{ width: '100%', height: 180 }}>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 14, left: 0 }}>
            <CartesianGrid stroke="#3f3f46" strokeDasharray="3 3" />
            <XAxis dataKey="x" tick={{ fill: '#a1a1aa', fontSize: 9 }} />
            <YAxis tick={{ fill: '#a1a1aa', fontSize: 9 }} />
            <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#e4e4e7' }} cursor={{ fill: '#ffffff10' }} />
            <Bar dataKey="count" isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={i} fill={isLow && isLow(d.x) ? LOW_COV_COLOR : NEUTRAL_BAR_COLOR} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function RadioGroup({
  title, testId, value, onChange, options,
}: {
  title: string;
  testId: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div data-testid={testId}>
      <h3 className="text-xs font-medium text-neutral-300 mb-1.5">{title}</h3>
      <div className="space-y-1">
        {options.map(([val, label]) => (
          <label key={val} className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer">
            <input
              type="radio"
              checked={value === val}
              onChange={() => onChange(val)}
              value={val}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}
