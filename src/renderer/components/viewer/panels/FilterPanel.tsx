import { Filter, X } from 'lucide-react';
import type { FilterRange } from '../../../lib/pointCloudTypes';

interface FieldOption {
  value: string;
  label: string;
  bounds: { min: number; max: number };
}

// A categorical class scheme (ground_class / tree_instance): one entry per class
// with its display label and RGB (0–1) swatch color.
interface CategoricalScheme {
  classes: { value: number; label: string; color: number[] }[];
}

// Presentational point-filter panel. All filter state, the field-encoding logic,
// and the commit/remove/segment handlers live in PointCloudViewer's wrapping IIFE
// and are passed in as derived values + callbacks. Parent gates on
// `showFilterPanel && firstSelectedCloud`.
interface FilterPanelProps {
  availableFields: FieldOption[];
  selectedFilterField: string | null;
  // The currently-selected field's option + committed filter (if any).
  selectedField: FieldOption | undefined;
  currentFilter: FilterRange | undefined;
  // Non-null when the selected field is categorical — drives the class-checkbox UI.
  categoricalScheme: CategoricalScheme | null;
  selectedClasses: number[];
  pendingFilterMin: string;
  pendingFilterMax: string;
  // Fields that currently have an enabled filter (for the summary list).
  activeFilters: FieldOption[];
  hasAnyFilter: boolean;
  // Resolves a field value to its committed filter (used to label active fields).
  getFieldFilter: (fieldValue: string) => FilterRange | undefined;
  onClose: () => void;
  onFieldChange: (fieldValue: string) => void;
  onCommitClasses: (classes: number[]) => void;
  onPendingMinChange: (value: string) => void;
  onPendingMaxChange: (value: string) => void;
  onRemoveFilter: () => void;
  onClearAllFilters: () => void;
  onApplyFilter: () => void;
  onSegmentFilter: () => void;
}

export function FilterPanel({
  availableFields,
  selectedFilterField,
  selectedField,
  currentFilter,
  categoricalScheme,
  selectedClasses,
  pendingFilterMin,
  pendingFilterMax,
  activeFilters,
  hasAnyFilter,
  getFieldFilter,
  onClose,
  onFieldChange,
  onCommitClasses,
  onPendingMinChange,
  onPendingMaxChange,
  onRemoveFilter,
  onClearAllFilters,
  onApplyFilter,
  onSegmentFilter,
}: FilterPanelProps) {
  return (
    <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-64">
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
              {f.label} {getFieldFilter(f.value)?.enabled ? '(active)' : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Categorical field: class checkboxes (keep the checked classes). */}
      {selectedFilterField && selectedField && categoricalScheme && (
        <div className="mb-3">
          <div className="text-[10px] text-neutral-500 mb-1">
            Keep classes ({selectedClasses.length}/{categoricalScheme.classes.length})
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
          <div className="flex gap-2 mb-2">
            <button
              data-testid="filter-class-all"
              onClick={() => onCommitClasses(categoricalScheme.classes.map(c => c.value))}
              className="flex-1 px-2 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 rounded"
            >
              All
            </button>
            <button
              data-testid="filter-class-none"
              onClick={() => onCommitClasses([])}
              className="flex-1 px-2 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 rounded"
            >
              None
            </button>
          </div>
          {currentFilter?.enabled && (
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
            Range: {selectedField.bounds.min.toFixed(2)} to {selectedField.bounds.max.toFixed(2)}
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
                step="any"
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
                step="any"
                className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1.5 border border-neutral-600"
              />
            </div>
          </div>
          {currentFilter?.enabled && (
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
                : `${filter?.min.toFixed(2)} - ${filter?.max.toFixed(2)}`;
              return (
                <div key={f.value} className="text-[10px] text-neutral-300 bg-neutral-900/50 rounded px-2 py-1 flex justify-between items-center">
                  <span>{f.label}: {summary}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Clear All button */}
      {hasAnyFilter && (
        <button
          onClick={onClearAllFilters}
          className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded mb-2"
        >
          Clear All Filters
        </button>
      )}

      {/* Commit actions: remove the out-of-range points, or segment the
          cloud into in-range + out-of-range (keeps both). */}
      {hasAnyFilter && (
        <div className="flex flex-col gap-2">
          <button
            data-testid="filter-remove"
            onClick={onApplyFilter}
            className="w-full px-2 py-1.5 text-xs bg-red-600 hover:bg-red-500 rounded text-white"
          >
            Filter (remove points)
          </button>
          <button
            data-testid="filter-segment"
            onClick={onSegmentFilter}
            className="w-full px-2 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 rounded text-white"
          >
            Segment (split into two clouds)
          </button>
        </div>
      )}
    </div>
  );
}
