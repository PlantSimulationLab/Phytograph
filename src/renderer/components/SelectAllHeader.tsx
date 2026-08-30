// The header row above a multi-select checkbox list: a tri-state master
// checkbox on the LEFT (aligned with the row checkboxes below it), the list
// label, and a "(n/m selected)" count on the right.
//
// This replaced the right-aligned "All | None" text pair the tool dialogs used
// to share. That pair read as two unrelated words rather than a control, and
// showed nothing about what was already selected — clicking "All" when
// everything was already selected did nothing visible.
//
// ObjectPicker renders this same header inline for the dialogs whose rows are
// plain label rows; this component exists for the dialogs whose rows are
// bespoke multi-column grids (QSM, LAD, triangulation, backfill, synthetic
// scan) and so can't adopt ObjectPicker wholesale.

interface SelectAllHeaderProps {
  /** The list's name, e.g. "Scans". Rendered as the checkbox's own label. */
  label: string;
  /** How many selectable rows are currently checked. */
  selectedCount: number;
  /** How many rows the master checkbox can reach. */
  totalCount: number;
  /** Check every selectable row. */
  onSelectAll: () => void;
  /** Clear the selection. */
  onDeselectAll: () => void;
  /**
   * Past-participle describing what the count means. Defaults to 'selected';
   * lists that toggle visibility rather than a run selection pass 'visible'.
   */
  countNoun?: string;
  /**
   * Accessible name / tooltip for the master checkbox in each direction.
   * Defaults to Select all / Deselect all; a visibility list passes
   * Show all / Hide all.
   */
  actionLabels?: { check: string; uncheck: string };
  'data-testid'?: string;
  /** Extra controls rendered between the label and the count. */
  children?: React.ReactNode;
}

export function SelectAllHeader({
  label,
  selectedCount,
  totalCount,
  onSelectAll,
  onDeselectAll,
  countNoun = 'selected',
  actionLabels = { check: 'Select all', uncheck: 'Deselect all' },
  'data-testid': testId,
  children,
}: SelectAllHeaderProps) {
  const allSelected = totalCount > 0 && selectedCount >= totalCount;
  const someSelected = selectedCount > 0;
  const action = allSelected ? actionLabels.uncheck : actionLabels.check;

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <label
          className={`flex items-center gap-2 ${
            totalCount === 0 ? 'cursor-not-allowed' : 'cursor-pointer group'
          }`}
          title={totalCount === 0 ? undefined : action}
        >
          <input
            type="checkbox"
            aria-label={action}
            data-testid={testId}
            // Indeterminate is a DOM property, not an attribute, so it can only
            // be set through a ref — the partial state is the common one here.
            ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
            checked={allSelected}
            disabled={totalCount === 0}
            onChange={() => (allSelected ? onDeselectAll() : onSelectAll())}
            className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-700 text-green-500 focus:ring-0 focus:ring-offset-0"
          />
          <span className="text-xs font-medium text-neutral-300 group-hover:text-neutral-100 transition-colors">
            {label}
          </span>
        </label>
        {children}
      </div>
      <span className="text-[10px] text-neutral-500">
        ({selectedCount}/{totalCount} {countNoun})
      </span>
    </div>
  );
}
