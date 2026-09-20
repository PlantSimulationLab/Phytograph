import { useMemo, useState } from 'react';
import { X, BarChart3, Download } from 'lucide-react';
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { downloadFile } from '../utils/fileDownload';
import type { LADResultEntry } from '../lib/pointCloudTypes';
import { computeLadProfile, ladProfileCsv } from '../lib/ladProfile';

interface LADProfilePopupProps {
  isOpen: boolean;
  onClose: () => void;
  result: LADResultEntry | null;
}

/**
 * Vertical LAD profile and bulk LAI for one gridded LAD result.
 *
 * The plot puts LAD on x and height on y — the orientation the canopy-structure
 * literature always draws a profile in, because it reads as a picture of the
 * canopy standing up. Height is the value axis (`type="number"`), not a
 * category, so uneven level spacing on a terrain-following grid stays true to
 * scale instead of being flattened to equal bands.
 *
 * Every number here counts MEASURED voxels only, matching the summary export
 * byte for byte; see `lib/ladProfile.ts` for why an occluded voxel must never be
 * averaged in as a zero.
 */
export function LADProfilePopup({ isOpen, onClose, result }: LADProfilePopupProps) {
  // Shade ±1 SD of LAD across each level's voxels. Off by default: on a canopy
  // with strong horizontal heterogeneity the band is wide enough to swamp the
  // mean line, and the mean is what the profile is for.
  const [showSpread, setShowSpread] = useState(false);

  const profile = useMemo(
    () => (result ? computeLadProfile(result) : null),
    [result],
  );

  const chartData = useMemo(() => {
    if (!profile) return [];
    return profile.levels.map(l => ({
      height: l.height,
      lad: l.meanLad,
      // Recharts draws a band from an [lo, hi] pair. Clamped at 0 because a
      // negative leaf area density is not a thing the axis should imply.
      spread: [Math.max(0, l.meanLad - l.stdLad), l.meanLad + l.stdLad] as [number, number],
      level: l.level,
      measured: l.measuredCount,
      occluded: l.occludedCount,
      laiContribution: l.laiContribution,
    }));
  }, [profile]);

  if (!isOpen || !result || !profile) return null;

  const heightLabel = profile.terrainFollow
    ? 'Mean height above ground (m)'
    : 'Height (m)';

  const exportCsv = () => {
    void downloadFile(
      ladProfileCsv(profile),
      `lad-profile-${result.nx}x${result.ny}x${result.nz}.csv`,
    );
  };

  // Levels that hold no measurement at all — either empty air or entirely
  // occluded. Named in the caption so a gap in the line reads as "nothing was
  // measured here", not as a rendering glitch.
  const emptyLevels = profile.levels.filter(l => l.measuredCount === 0).length;

  return (
    <div
      data-testid="lad-profile-popup"
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation(); }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-3xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-green-400" />
            <h2 className="text-sm font-semibold text-white">
              LAD Profile — {result.nx}×{result.ny}×{result.nz} grid
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              data-testid="lad-profile-export-csv"
              onClick={exportCsv}
              title="Export the per-level profile and the bulk LAI to a CSV file"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Profile CSV
            </button>
            <button
              data-testid="lad-profile-close"
              onClick={onClose}
              className="p-1 rounded hover:bg-neutral-700 transition-colors"
            >
              <X className="w-4 h-4 text-neutral-400" />
            </button>
          </div>
        </div>

        <div className="p-4 max-h-[80vh] overflow-y-auto space-y-3">
          {/* Bulk LAI — the headline number, and the one no export format but
              the summary .txt carries. */}
          <div
            data-testid="lad-bulk-lai"
            data-lai={profile.lai}
            data-leaf-area={profile.leafArea}
            data-ground-area={profile.groundArea}
            data-wai={profile.wai ?? ''}
            data-pai={profile.pai ?? ''}
            className="rounded-lg bg-neutral-900/60 border border-neutral-700/60 px-3 py-2"
          >
            <div className="flex items-baseline gap-3 flex-wrap">
              <div className="text-lg font-semibold text-lime-300">
                LAI {profile.lai.toFixed(3)}
              </div>
              <div className="text-[11px] text-neutral-400">
                m²/m² · {profile.leafArea.toFixed(1)} m² measured leaf area over a{' '}
                {profile.groundArea.toFixed(1)} m² footprint
              </div>
            </div>
            {/* Wood, only when the cloud carried a leaf/wood classification.
                WAI is TOTAL woody surface area per unit ground while LAI is
                one-sided leaf area, so the two add to PAI. */}
            {profile.wai != null && profile.pai != null && (
              <div className="flex items-baseline gap-3 flex-wrap mt-1">
                <div className="text-sm font-semibold text-amber-300/90">
                  WAI {profile.wai.toFixed(3)}
                </div>
                <div className="text-sm font-semibold text-neutral-300">
                  PAI {profile.pai.toFixed(3)}
                </div>
                <div className="text-[11px] text-neutral-400">
                  m²/m² · {(profile.woodArea ?? 0).toFixed(1)} m² measured wood
                  surface area · LAI + WAI = PAI
                </div>
              </div>
            )}
            {profile.occludedCount > 0 && (
              <div className="text-[10px] text-neutral-500 mt-1">
                {profile.occludedCount} of {profile.totalCount} voxels were occluded and
                are excluded from this total — an occluded voxel is unmeasured, not empty,
                so counting it as zero density would bias LAI low.
                {profile.filledLeafArea > 0 && (
                  <>
                    {' '}Interpolating them adds {profile.filledLeafArea.toFixed(1)} m²
                    (LAI {profile.laiWithFilled.toFixed(3)}), which is an estimate, not a
                    measurement.
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-neutral-300">
              Vertical profile — mean LAD per level
            </h3>
            <label className="flex items-center gap-1.5 text-[10px] text-neutral-400 cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="lad-profile-spread"
                checked={showSpread}
                onChange={(e) => setShowSpread(e.target.checked)}
                className="rounded bg-neutral-700 border-neutral-600 w-3 h-3 accent-green-500"
              />
              Show ±1 SD across each level
            </label>
          </div>

          {/* Fixed numeric height, not height="100%": ResponsiveContainer seeds
              its size to -1 and only measures after mount, so a percent height
              trips Recharts' "width/height should be > 0" warning on open. */}
          <div style={{ width: '100%', height: 320 }} data-testid="lad-profile-chart">
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart
                data={chartData}
                layout="vertical"
                margin={{ top: 8, right: 16, bottom: 20, left: 8 }}
              >
                <CartesianGrid stroke="#3f3f46" strokeDasharray="3 3" />
                {/* Vertical layout ⇒ x is the VALUE axis (LAD), y the height. */}
                <XAxis
                  type="number"
                  dataKey="lad"
                  tick={{ fill: '#a1a1aa', fontSize: 10 }}
                  label={{
                    value: 'Leaf area density (m²/m³)', position: 'insideBottom',
                    offset: -10, fill: '#a1a1aa', fontSize: 11,
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="height"
                  // Height is a real coordinate, so let the data set the domain
                  // rather than anchoring at 0 — a grid that starts 2 m up
                  // shouldn't render two metres of empty axis.
                  domain={['dataMin', 'dataMax']}
                  tick={{ fill: '#a1a1aa', fontSize: 10 }}
                  tickFormatter={(v: number) => v.toFixed(1)}
                  width={52}
                  label={{
                    value: heightLabel, angle: -90, position: 'insideLeft',
                    fill: '#a1a1aa', fontSize: 11,
                  }}
                />
                <Tooltip
                  contentStyle={{
                    background: '#27272a', border: '1px solid #3f3f46',
                    borderRadius: 6, fontSize: 11,
                  }}
                  labelStyle={{ color: '#e4e4e7' }}
                  labelFormatter={(v) => `Height ${Number(v).toFixed(2)} m`}
                  formatter={(value, name) => {
                    // The spread band is a [lo, hi] pair drawn behind the line,
                    // not a series worth a tooltip row of its own. Returning a
                    // bare node (rather than a [node, name] pair) renders it
                    // as nothing — the formatter's documented ReactNode return.
                    if (name === 'spread') return null;
                    return [`${Number(value).toFixed(4)} m²/m³`, 'Mean LAD'];
                  }}
                />
                {showSpread && (
                  <Area
                    dataKey="spread"
                    stroke="none"
                    fill="#22c55e"
                    fillOpacity={0.18}
                    isAnimationActive={false}
                  />
                )}
                <Line
                  type="linear"
                  dataKey="lad"
                  name="Mean LAD"
                  stroke="#a3e635"
                  strokeWidth={2}
                  dot={{ r: 2.5, fill: '#a3e635', strokeWidth: 0 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
                {/* Anchor so an all-zero profile still renders its axes. */}
                <ReferenceLine x={0} stroke="transparent" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <p className="text-[10px] text-neutral-500">
            Each point is the mean LAD over the measured voxels in one horizontal
            level of the grid; levels are Helios cell levels, so a terrain-following
            grid profiles height above the ground rather than absolute elevation.
            {emptyLevels > 0 && (
              <> {emptyLevels} level{emptyLevels === 1 ? '' : 's'} held no measured
                voxel and read as zero.</>
            )}
          </p>

          {/* The numbers behind the line. A profile plot alone hides how much
              each level rests on, and a level averaging three voxels is a very
              different claim from one averaging ninety. */}
          <div>
            <h3 className="text-xs font-medium text-neutral-300 mb-1">Per-level values</h3>
            <div className="max-h-56 overflow-y-auto">
              <table
                data-testid="lad-profile-table"
                className="w-full text-[11px] text-neutral-300 border-collapse"
              >
                <thead className="sticky top-0 bg-neutral-800">
                  <tr className="text-neutral-500 text-left">
                    <th className="font-medium py-0.5 pr-2">Level</th>
                    <th className="font-medium py-0.5 px-2 text-right">{profile.terrainFollow ? 'Mean h (m)' : 'Height (m)'}</th>
                    <th className="font-medium py-0.5 px-2 text-right">Mean LAD</th>
                    <th className="font-medium py-0.5 px-2 text-right" title="Population standard deviation of LAD across the level's measured voxels">SD</th>
                    <th className="font-medium py-0.5 px-2 text-right" title="Measured leaf area in this level">Area (m²)</th>
                    <th className="font-medium py-0.5 px-2 text-right" title="This level's share of the bulk LAI — the column sums to it">LAI</th>
                    <th className="font-medium py-0.5 px-2 text-right" title="Measured voxels / voxels present at this level">Meas.</th>
                    <th className="font-medium py-0.5 pl-2 text-right" title="Voxels screened out as occluded">Occl.</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Highest level first, so the table reads top-down like the plot. */}
                  {[...profile.levels].reverse().map(l => (
                    <tr
                      key={l.level}
                      data-testid="lad-profile-row"
                      data-level={l.level}
                      data-mean-lad={l.meanLad}
                      data-measured={l.measuredCount}
                      className="border-t border-neutral-700/40"
                    >
                      <td className="py-0.5 pr-2">{l.level}</td>
                      <td className="py-0.5 px-2 text-right tabular-nums">{l.height.toFixed(2)}</td>
                      <td className="py-0.5 px-2 text-right tabular-nums">{l.meanLad.toFixed(4)}</td>
                      <td className="py-0.5 px-2 text-right tabular-nums text-neutral-500">{l.stdLad.toFixed(4)}</td>
                      <td className="py-0.5 px-2 text-right tabular-nums">{l.leafArea.toFixed(2)}</td>
                      <td className="py-0.5 px-2 text-right tabular-nums">{l.laiContribution.toFixed(3)}</td>
                      <td className="py-0.5 px-2 text-right tabular-nums text-neutral-500">
                        {l.measuredCount}/{l.voxelCount}
                      </td>
                      <td className={`py-0.5 pl-2 text-right tabular-nums ${l.occludedCount > 0 ? 'text-amber-400/80' : 'text-neutral-600'}`}>
                        {l.occludedCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
