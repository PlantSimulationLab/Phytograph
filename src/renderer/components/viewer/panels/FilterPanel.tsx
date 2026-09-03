import { ChevronDown, ChevronRight, Filter, Loader2, X } from 'lucide-react';
import type { FilterRange } from '../../../lib/pointCloudTypes';
import type { DenoiseStats, NoiseMethod, NoiseParams } from '../../../utils/backendApi';
import {
  NOISE_METHOD_OPTIONS,
  NOISE_PARAM_FIELDS,
  formatFlaggedSummary,
  formatResolvedParams,
  type NoiseParamKey,
} from '../../../lib/noiseFilter';
import { formatFilterBound } from '../../../lib/filterFields';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';
import { SelectAllHeader } from '../../SelectAllHeader';

interface FieldOption {
  value: string;
  label: string;
  bounds: { min: number; max: number };
  // True for fields whose values are integer counters/indices (target_index,
  // target_count, row/column_index). Drives whole-number range labels and a
  // step=1 input — a fractional n-th return is meaningless. See
  // `lib/filterFields.ts`; storage stays float32 either way.
  integer?: boolean;
}

// A categorical class scheme (ground_class / tree_instance): one entry per class
// with its display label and RGB (0–1) swatch color.
interface CategoricalScheme {
  classes: { value: number; label: string; color: number[] }[];
}

// Presentational point-filter panel. All filter state, the field-encoding logic,
// and the commit/remove/segment handlers live in PointCloudViewer's wrapping IIFE
// and are passed in as derived values + callbacks. Parent gates on
// `showFilterPanel && filterTargetClouds.length > 0`.
interface FilterPanelProps {
  availableFields: FieldOption[];
  selectedFilterField: string | null;
  // The currently-selected field's option.
  selectedField: FieldOption | undefined;
  // Non-null when the selected field is categorical — drives the class-checkbox UI.
  categoricalScheme: CategoricalScheme | null;
  selectedClasses: number[];
  pendingFilterMin: string;
  pendingFilterMax: string;
  // Fields whose filter actually NARROWS the cloud (see `isNarrowing`), for the
  // summary list. A field left at its full extent is deliberately absent: it
  // removes nothing, and listing it read as "a filter is being applied".
  activeFilters: FieldOption[];
  hasAnyFilter: boolean;
  // True when the SELECTED field alone narrows anything. Separate from
  // `hasAnyFilter` so "Remove this filter" is offered per field rather than
  // whenever any other field happens to be filtered.
  selectedFieldNarrows: boolean;
  // Resolves a field value to its committed filter (used to summarise it).
  getFieldFilter: (fieldValue: string) => FilterRange | undefined;
  // True when this field's committed filter actually removes points. The
  // dropdown's "(active)" marker reads from THIS, not from `enabled` — an
  // enabled full-range filter marked every touched field active while removing
  // nothing.
  fieldNarrows: (fieldValue: string) => boolean;
  // Number of clouds this panel will act on. >1 renders the multi-scan notice
  // and pluralises the commit buttons; the fields shown are those COMMON to
  // every selected cloud.
  targetCloudCount: number;
  onClose: () => void;
  onFieldChange: (fieldValue: string) => void;
  onCommitClasses: (classes: number[]) => void;
  onPendingMinChange: (value: string) => void;
  onPendingMaxChange: (value: string) => void;
  onRemoveFilter: () => void;
  onClearAllFilters: () => void;
  onApplyFilter: () => void;
  onSegmentFilter: () => void;
  // True while the permanent filter's backend round-trip (octree reconversion)
  // is in flight. Disables the commit button so an impatient re-click can't
  // queue a second full filter; the cancellable StatusPill carries the progress.
  isApplying?: boolean;

  // ---- Noise section --------------------------------------------------
  // Detect does NOT remove anything: it classifies points into a `noise_class`
  // column and pre-selects that field above, so the commit runs through the same
  // Remove / Segment buttons as every other filter.
  noiseExpanded: boolean;
  noiseMethod: NoiseMethod;
  noiseAutoParams: boolean;
  noiseParams: NoiseParams;
  noiseBusy: boolean;
  // Which scan of a multi-scan run is being classified. null on a single scan.
  noiseProgress: string | null;
  // The PRIMARY scan's result only — Detect runs over the whole selection, so
  // the run total lives in the toast and this box stays about the scan whose
  // criteria the panel is editing.
  noiseResult: DenoiseStats | null;
  noiseError: string | null;
  onToggleNoiseExpanded: () => void;
  onNoiseMethodChange: (method: NoiseMethod) => void;
  onNoiseAutoParamsChange: (auto: boolean) => void;
  onNoiseParamChange: (key: NoiseParamKey, value: number) => void;
  onDetectNoise: () => void;
  onCancelDetectNoise: () => void;
  onClearNoise: () => void;
}

export function FilterPanel({
  availableFields,
  selectedFilterField,
  selectedField,
  categoricalScheme,
  selectedClasses,
  pendingFilterMin,
  pendingFilterMax,
  activeFilters,
  hasAnyFilter,
  selectedFieldNarrows,
  getFieldFilter,
  fieldNarrows,
  targetCloudCount,
  onClose,
  onFieldChange,
  onCommitClasses,
  onPendingMinChange,
  onPendingMaxChange,
  onRemoveFilter,
  onClearAllFilters,
  onApplyFilter,
  onSegmentFilter,
  isApplying = false,
  noiseExpanded,
  noiseMethod,
  noiseAutoParams,
  noiseParams,
  noiseBusy,
  noiseProgress,
  noiseResult,
  noiseError,
  onToggleNoiseExpanded,
  onNoiseMethodChange,
  onNoiseAutoParamsChange,
  onNoiseParamChange,
  onDetectNoise,
  onCancelDetectNoise,
  onClearNoise,
}: FilterPanelProps) {
  const methodOption = NOISE_METHOD_OPTIONS.find(o => o.value === noiseMethod);
  return (
    <div className="absolute top-4 right-[280px] z-20 bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Filter className="w-3 h-3" />
          Filter Points
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-neutral-700 rounded"
        >
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      {/* Multi-scan notice. The commit buttons act on every selected scan, so
          say so up front — and say that the field list is the INTERSECTION,
          which explains why a field present on one scan may be missing here. */}
      {targetCloudCount > 1 && (
        <div
          data-testid="filter-multi-scan-notice"
          className="mb-3 text-[10px] text-neutral-300 bg-neutral-900/50 rounded px-2 py-1.5"
        >
          Filtering <span className="font-medium">{targetCloudCount} scans</span>. Fields
          shown are those every selected scan has.
        </div>
      )}

      {/* Noise: classify stray/flyer points into a `noise_class` column. It is a
          section of THIS panel rather than its own tool because the removal is
          the Filter tool's — Detect only arms the buttons at the bottom. */}
      <div className="mb-3 border-b border-neutral-700 pb-3">
        <button
          data-testid="filter-noise-toggle"
          onClick={onToggleNoiseExpanded}
          className="w-full flex items-center gap-1 text-[11px] text-neutral-300 hover:text-neutral-100"
        >
          {noiseExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <span className="font-medium">Noise</span>
          {!noiseExpanded && noiseResult && (
            <span
              className={`ml-auto text-[10px] ${noiseResult.over_removal ? 'text-red-400' : 'text-neutral-500'}`}
            >
              {noiseResult.flagged.toLocaleString()} flagged
            </span>
          )}
        </button>

        {noiseExpanded && (
          <div className="mt-2 space-y-2">
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">Method</label>
              <select
                data-testid="filter-noise-method"
                value={noiseMethod}
                onChange={(e) => onNoiseMethodChange(e.target.value as NoiseMethod)}
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
              >
                {NOISE_METHOD_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {methodOption && (
                <p className="text-[10px] text-neutral-500 mt-1 leading-snug">{methodOption.blurb}</p>
              )}
            </div>

            <label className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer">
              <input
                data-testid="filter-noise-auto"
                type="checkbox"
                checked={noiseAutoParams}
                onChange={(e) => onNoiseAutoParamsChange(e.target.checked)}
              />
              Auto parameters
            </label>

            {/* Auto FILLS and greys these rather than hiding them: the user has
                to be able to see what the auto rule picked to judge whether it
                is sane for their scan. */}
            {NOISE_PARAM_FIELDS[noiseMethod].map(field => (
              <div key={field.key}>
                <label className="text-[10px] text-neutral-400 block mb-1">{field.label}</label>
                <DebouncedNumberInput
                  data-testid={`filter-noise-${field.key}`}
                  // NaN renders as an empty box (DebouncedNumberInput's default
                  // format), which is what an unset parameter should look like.
                  value={noiseParams[field.key] ?? NaN}
                  onCommit={(v) => onNoiseParamChange(field.key, v)}
                  disabled={noiseAutoParams || noiseBusy}
                  min={field.min}
                  step={field.step}
                  debounceMs={0}
                  parse={field.integer ? (s) => parseInt(s, 10) : undefined}
                  className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600 disabled:opacity-50"
                />
              </div>
            ))}

            {noiseBusy ? (
              <div className="space-y-1">
                <button
                  data-testid="filter-noise-cancel"
                  onClick={onCancelDetectNoise}
                  className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded flex items-center justify-center gap-2"
                >
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Cancel
                </button>
                {noiseProgress && (
                  <div
                    data-testid="filter-noise-progress"
                    className="text-[10px] text-neutral-400 text-center truncate"
                  >
                    {noiseProgress}
                  </div>
                )}
              </div>
            ) : (
              <button
                data-testid="filter-noise-detect"
                onClick={onDetectNoise}
                className="w-full px-2 py-1.5 text-xs bg-neutral-600 hover:bg-neutral-500 rounded text-white"
              >
                {/* Say the scan count, like the commit buttons below: Detect
                    acts on the whole selection, and silently classifying five
                    scans when the panel shows one scan's numbers would be a
                    surprise. */}
                {targetCloudCount > 1 ? `Detect noise in ${targetCloudCount} scans` : 'Detect noise'}
              </button>
            )}

            {noiseError && (
              <div data-testid="filter-noise-error" className="text-[10px] text-red-400 leading-snug">
                {noiseError}
              </div>
            )}

            {noiseResult && (
              <div
                data-testid="filter-noise-result"
                data-flagged={noiseResult.flagged}
                data-fraction={noiseResult.fraction.toFixed(4)}
                data-over-removal={noiseResult.over_removal ? 'true' : 'false'}
                className={`rounded px-2 py-1.5 text-[10px] leading-snug border ${
                  noiseResult.over_removal
                    ? 'bg-red-950/40 border-red-800 text-red-200'
                    : 'bg-neutral-900/50 border-neutral-700 text-neutral-300'
                }`}
              >
                <div className="font-medium">{formatFlaggedSummary(noiseResult)}</div>
                <div className="text-neutral-500">{formatResolvedParams(noiseResult)}</div>
                <div className="mt-1">Flagged points are shown in red in the viewport.</div>
                {noiseResult.warnings.map((w, i) => (
                  <div key={i} className="mt-1 text-amber-300">{w}</div>
                ))}
              </div>
            )}

            {noiseResult && (
              <button
                data-testid="filter-noise-clear"
                onClick={onClearNoise}
                className="w-full px-2 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 rounded"
              >
                Clear detection
              </button>
            )}
          </div>
        )}
      </div>

      {/* Field Dropdown */}
      <div className="mb-3">
        <label className="text-[10px] text-neutral-400 block mb-1">Field</label>
        <select
          data-testid="filter-field-select"
          value={selectedFilterField || ''}
          onChange={(e) => onFieldChange(e.target.value)}
          className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
        >
          <option value="">Select a field...</option>
          {availableFields.map(f => (
            <option key={f.value} value={f.value}>
              {f.label} {fieldNarrows(f.value) ? '(active)' : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Categorical field: class checkboxes (keep the checked classes). */}
      {selectedFilterField && selectedField && categoricalScheme && (
        <div className="mb-3">
          {/* Master checkbox at the head of the list, same as every other
              checkbox list in the app — it lines up with the class boxes and
              shows the all/none/partial state. */}
          <div className="mb-1">
            <SelectAllHeader
              data-testid="filter-class-all"
              label="Keep classes"
              countNoun="kept"
              actionLabels={{ check: 'Keep all classes', uncheck: 'Keep none' }}
              selectedCount={selectedClasses.length}
              totalCount={categoricalScheme.classes.length}
              onSelectAll={() => onCommitClasses(categoricalScheme.classes.map(c => c.value))}
              onDeselectAll={() => onCommitClasses([])}
            />
          </div>
          <div className="max-h-40 overflow-y-auto space-y-1 mb-2 pr-1">
            {categoricalScheme.classes.map(c => {
              const checked = selectedClasses.includes(c.value);
              return (
                <label
                  key={c.value}
                  className="flex items-center gap-2 text-xs text-neutral-200 cursor-pointer hover:bg-neutral-700/40 rounded px-1 py-0.5"
                >
                  <input
                    data-testid={`filter-class-${c.value}`}
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = checked
                        ? selectedClasses.filter(v => v !== c.value)
                        : [...selectedClasses, c.value].sort((a, b) => a - b);
                      onCommitClasses(next);
                    }}
                  />
                  <span
                    className="inline-block w-3 h-3 rounded-sm border border-neutral-600 shrink-0"
                    style={{ backgroundColor: `rgb(${c.color.map(ch => Math.round(ch * 255)).join(',')})` }}
                  />
                  <span className="truncate">{c.label}</span>
                  <span className="text-neutral-500 ml-auto">{c.value}</span>
                </label>
              );
            })}
          </div>
          {selectedFieldNarrows && (
            <button
              onClick={onRemoveFilter}
              className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
            >
              Remove this filter
            </button>
          )}
        </div>
      )}

      {/* Min/Max Inputs - continuous fields only (categorical uses the
          class checkboxes above). */}
      {selectedFilterField && selectedField && !categoricalScheme && (
        <div className="mb-3">
          <div className="text-[10px] text-neutral-500 mb-1">
            Range: {formatFilterBound(selectedField.bounds.min, !!selectedField.integer)} to{' '}
            {formatFilterBound(selectedField.bounds.max, !!selectedField.integer)}
          </div>
          <div className="flex gap-2 mb-2">
            <div className="flex-1">
              <label className="text-[10px] text-neutral-400 block mb-1">Min</label>
              <input
                data-testid="filter-min-input"
                type="number"
                onWheel={(e) => e.currentTarget.blur()}
                value={pendingFilterMin}
                onChange={(e) => onPendingMinChange(e.target.value)}
                step={selectedField.integer ? 1 : 'any'}
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-neutral-400 block mb-1">Max</label>
              <input
                data-testid="filter-max-input"
                type="number"
                onWheel={(e) => e.currentTarget.blur()}
                value={pendingFilterMax}
                onChange={(e) => onPendingMaxChange(e.target.value)}
                step={selectedField.integer ? 1 : 'any'}
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
              />
            </div>
          </div>
          {selectedFieldNarrows && (
            <button
              onClick={onRemoveFilter}
              className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
            >
              Remove this filter
            </button>
          )}
        </div>
      )}

      {/* Active Filters List */}
      {activeFilters.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] text-neutral-500 mb-1 font-medium">Active Filters</div>
          <div className="space-y-1">
            {activeFilters.map(f => {
              const filter = getFieldFilter(f.value);
              const summary = filter?.selectedClasses
                ? `classes ${filter.selectedClasses.join(', ') || '(none)'}`
                : `${formatFilterBound(filter?.min ?? 0, !!f.integer)} - ${formatFilterBound(filter?.max ?? 0, !!f.integer)}`;
              return (
                <div key={f.value} className="text-[10px] text-neutral-300 bg-neutral-900/50 rounded px-2 py-1 flex justify-between items-center">
                  <span>{f.label}: {summary}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Reset the pending criteria. Deliberately NOT called "Clear All
          Filters": the old label implied it could undo a committed filter,
          which it never could — Filter (remove points) permanently deletes the
          out-of-range points, and nothing in this panel brings them back. It
          only resets the criteria set up above, so it says exactly that. */}
      {hasAnyFilter && (
        <button
          data-testid="filter-reset-criteria"
          onClick={onClearAllFilters}
          title="Resets the criteria above. Points already removed by Filter are gone for good."
          className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded mb-2"
        >
          Reset Filter Criteria
        </button>
      )}

      {/* Commit actions: remove the out-of-range points, or segment the
          cloud into in-range + out-of-range (keeps both). */}
      {hasAnyFilter && (
        <div className="flex flex-col gap-2">
          <button
            data-testid="filter-remove"
            onClick={onApplyFilter}
            disabled={isApplying}
            className="w-full px-2 py-1.5 text-xs bg-red-600 hover:bg-red-500 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-red-600"
          >
            {isApplying
              ? 'Filtering…'
              : targetCloudCount > 1
                ? `Filter ${targetCloudCount} scans (remove points)`
                : 'Filter (remove points)'}
          </button>
          <button
            data-testid="filter-segment"
            onClick={onSegmentFilter}
            disabled={isApplying}
            className="w-full px-2 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-cyan-600"
          >
            Segment (split into two clouds)
          </button>
          {/* Say plainly which button is destructive, so a user reaching for
              Filter knows the points are not coming back. */}
          <div className="text-[10px] text-neutral-500 leading-snug">
            Filter deletes the out-of-range points permanently. Segment keeps
            them as a second cloud.
          </div>
        </div>
      )}
    </div>
  );
}
