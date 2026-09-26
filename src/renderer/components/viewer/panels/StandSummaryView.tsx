import { Download } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { InfoHint } from '../../InfoHint';
import {
  JENKINS_GROUPS, type BiomassMethod, type HistogramBin, type JenkinsGroup, type StandSettings,
  type StandSummary,
} from '../../../lib/standSummary';

// The Stand tab of the tree inventory panel: stand settings, the summary
// figures and the two class histograms. Pure render; the summary is computed
// by the parent (lib/standSummary.ts) from the tree list and these settings.
interface StandSummaryViewProps {
  settings: StandSettings;
  onSettingsChange: (patch: Partial<StandSettings>) => void;
  summary: StandSummary;
  /** Measured plot area, shown as the placeholder of the area field. */
  measuredPlotAreaM2: number | null;
  onExport: () => void;
}

function fmt(v: number | null | undefined, digits: number, unit = ''): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '—';
}

function Histogram({ bins, unit, testId }: { bins: HistogramBin[]; unit: string; testId: string }) {
  if (bins.length === 0) return <div className="text-[10px] text-neutral-500">No trees.</div>;
  const max = Math.max(1, ...bins.map(b => b.count));
  return (
    <div data-testid={testId} className="flex items-end gap-px h-20">
      {bins.map(b => (
        <div
          key={b.lo}
          data-testid={`${testId}-bin`}
          data-lo={b.lo}
          data-count={b.count}
          title={`${b.lo}–${b.hi} ${unit}: ${b.count}`}
          className="flex-1 flex flex-col items-center justify-end min-w-0"
        >
          <div className="text-[8px] text-neutral-400">{b.count || ''}</div>
          <div className="w-full bg-emerald-600/80 rounded-t-sm" style={{ height: `${(b.count / max) * 56}px` }} />
          <div className="text-[8px] text-neutral-500 truncate w-full text-center">{b.lo}</div>
        </div>
      ))}
    </div>
  );
}

const ROW = 'flex justify-between gap-2';

export function StandSummaryView({ settings, onSettingsChange, summary, measuredPlotAreaM2, onExport }: StandSummaryViewProps) {
  const s = summary;
  return (
    <div data-testid="stand-summary" className="overflow-auto min-h-0 flex-1 text-[10px] text-neutral-300 pr-1">
      <div className="grid grid-cols-3 gap-2 mb-2 text-neutral-400">
        <label className="flex flex-col gap-0.5">
          Min DBH (cm)
          <DebouncedNumberInput
            data-testid="stand-min-dbh" value={settings.minDbhCm} min={0} step={1} debounceMs={0}
            onCommit={n => onSettingsChange({ minDbhCm: n })}
            className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5 w-full"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1">Plot area (m²)
            <InfoHint label="Plot area" text="Leave empty to use the measured plot boundary (the convex hull of the ground points). Enter a surveyed area for a small plot, where the scan's edge is a poor boundary." />
          </span>
          <input
            data-testid="stand-plot-area"
            type="text" inputMode="decimal"
            placeholder={measuredPlotAreaM2 != null ? `${measuredPlotAreaM2.toFixed(0)} (measured)` : 'enter area'}
            defaultValue={settings.plotAreaM2 ?? ''}
            onBlur={e => {
              const v = parseFloat(e.target.value);
              onSettingsChange({ plotAreaM2: Number.isFinite(v) && v > 0 ? v : null });
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5 w-full"
          />
        </label>
        <label className="flex items-center gap-1 mt-3">
          <input
            type="checkbox" data-testid="stand-exclude-dead" checked={settings.excludeDead}
            onChange={e => onSettingsChange({ excludeDead: e.target.checked })}
          />
          Exclude dead trees
        </label>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mb-2" data-testid="stand-figures">
        <div className={ROW}><span>Plot area</span><span data-testid="stand-plot-area-value" data-source={s.plotAreaSource}>{fmt(s.plotAreaM2, 0, ' m²')} {s.plotAreaSource === 'entered' ? '(entered)' : s.plotAreaSource === 'measured' ? '(measured)' : ''}</span></div>
        <div className={ROW}><span>Trees</span><span data-testid="stand-n-trees">{s.nTrees}</span></div>
        <div className={ROW}><span>Stems / ha</span><span data-testid="stand-stems-ha">{fmt(s.stemsPerHa, 0)}</span></div>
        <div className={ROW}><span>Basal area</span><span data-testid="stand-ba-ha">{fmt(s.basalAreaM2PerHa, 2, ' m²/ha')}</span></div>
        <div className={ROW}><span>QMD</span><span data-testid="stand-qmd">{fmt(s.qmdCm, 1, ' cm')}</span></div>
        <div className={ROW}><span>Lorey's height</span><span data-testid="stand-lorey">{fmt(s.loreyHeightM, 2, ' m')}</span></div>
        <div className={ROW}><span>Mean / max height</span><span>{fmt(s.meanHeightM, 1)} / {fmt(s.maxHeightM, 1, ' m')}</span></div>
        <div className={ROW}><span>Canopy cover</span><span data-testid="stand-cover">{s.canopyCover == null ? '—' : `${(s.canopyCover * 100).toFixed(0)}%`}</span></div>
      </div>

      <div className="mb-2">
        <div className="flex items-center justify-between mb-0.5 text-neutral-400">
          <span>DBH classes (cm)</span>
          <DebouncedNumberInput
            aria-label="DBH class width" value={settings.dbhClassCm} min={1} step={1} debounceMs={0}
            onCommit={n => onSettingsChange({ dbhClassCm: n })}
            className="bg-neutral-700 text-neutral-200 rounded px-1 w-12"
          />
        </div>
        <Histogram bins={s.dbhHistogram} unit="cm" testId="stand-dbh-hist" />
      </div>
      <div className="mb-2">
        <div className="flex items-center justify-between mb-0.5 text-neutral-400">
          <span>Height classes (m)</span>
          <DebouncedNumberInput
            aria-label="Height class width" value={settings.heightClassM} min={0.5} step={0.5} debounceMs={0}
            onCommit={n => onSettingsChange({ heightClassM: n })}
            className="bg-neutral-700 text-neutral-200 rounded px-1 w-12"
          />
        </div>
        <Histogram bins={s.heightHistogram} unit="m" testId="stand-height-hist" />
      </div>

      <div className="border-t border-neutral-700 pt-2 mb-2">
        <div className="grid grid-cols-3 gap-2 text-neutral-400">
          <label className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1">Biomass
              <InfoHint label="Biomass" text="Above-ground biomass per tree. Chave et al. (2014) is for tropical trees; Jenkins et al. (2003) for US species groups; QSM volume × wood density needs a QSM per tree (QSM tab). See the Stand metrics page for each method's range." />
            </span>
            <select
              data-testid="stand-biomass-method" value={settings.biomassMethod}
              onChange={e => onSettingsChange({ biomassMethod: e.target.value as BiomassMethod })}
              className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5"
            >
              <option value="none">None</option>
              <option value="chave2014">Chave 2014 (tropical)</option>
              <option value="jenkins2003">Jenkins 2003 (US groups)</option>
              <option value="qsm">QSM volume × density</option>
            </select>
          </label>
          {settings.biomassMethod === 'jenkins2003' ? (
            <label className="flex flex-col gap-0.5 col-span-2">
              Species group
              <select
                data-testid="stand-jenkins-group" value={settings.jenkinsGroup}
                onChange={e => onSettingsChange({ jenkinsGroup: e.target.value as JenkinsGroup })}
                className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5"
              >
                {Object.entries(JENKINS_GROUPS).map(([k, g]) => <option key={k} value={k}>{g.label}</option>)}
              </select>
            </label>
          ) : settings.biomassMethod !== 'none' ? (
            <label className="flex flex-col gap-0.5">
              Wood density (g/cm³)
              <DebouncedNumberInput
                data-testid="stand-wood-density" value={settings.woodDensity} min={0.05} max={1.5} step={0.05}
                debounceMs={0} onCommit={n => onSettingsChange({ woodDensity: n })}
                className="bg-neutral-700 text-neutral-200 rounded px-1 py-0.5 w-full"
              />
            </label>
          ) : null}
        </div>
        {settings.biomassMethod !== 'none' && (
          <div className="mt-1 grid grid-cols-2 gap-x-4">
            <div className={ROW}><span>Biomass</span><span data-testid="stand-biomass">{s.biomassKg == null ? '—' : `${(s.biomassKg / 1000).toFixed(2)} Mg`}</span></div>
            <div className={ROW}><span>per ha</span><span data-testid="stand-biomass-ha">{fmt(s.biomassMgPerHa, 1, ' Mg/ha')}</span></div>
            {(s.biomassMissing > 0 || s.biomassExtrapolated > 0) && (
              <div className="col-span-2 text-amber-400">
                {s.biomassMissing > 0 && `${s.biomassMissing} tree(s) could not be estimated and are not in the total. `}
                {s.biomassExtrapolated > 0 && `${s.biomassExtrapolated} tree(s) are larger than the equation's data.`}
              </div>
            )}
          </div>
        )}
      </div>

      <button
        data-testid="stand-export"
        onClick={onExport}
        className="flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
      >
        <Download className="w-3 h-3" /> Stand summary CSV
      </button>
    </div>
  );
}
