import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calculator, ChevronDown, Copy, Loader2, MoreVertical, Pencil, Trash2, X } from 'lucide-react';
import { InfoHint } from '../../InfoHint';
import { ScalarHistogram } from '../ScalarHistogram';
import {
  STAT_ROWS,
  formatCount,
  formatStat,
  nonFiniteCaption,
  type ScalarStats,
} from '../../../lib/scalarFieldStats';
import {
  checkExpression,
  checkSlug,
  suggestSlug,
  type ExpressionVocabulary,
} from '../../../lib/scalarFieldExpression';
import type { ScalarFieldInfo } from '../../../utils/backendApi';
import { ObjectPicker, type PickerItem } from '../../ObjectPicker';
import type { BlockedScalarField } from '../../../lib/scalarFieldTargets';

// Presentational panel for the Scalar Fields tool. All state and every handler
// live in PointCloudViewer; the parent gates rendering on
// `showScalarFieldsPanel` alone.
//
// The tool acts on a SET of clouds, which this panel's own picker owns (seeded
// from the viewport selection, never written back to it). Stats POOLS them into
// one distribution; Compute and Fields fan the same action out over each cloud
// in turn. The offered field list is therefore the intersection of what the
// checked clouds carry — see `intersectScalarFields`.
//
// Three tabs over ONE field list, rather than three tools: picking a field,
// reading its distribution and using it in a formula are the same activity a
// few seconds apart, and splitting them would mean choosing the field three
// times.

export type ScalarFieldsTab = 'fields' | 'stats' | 'compute';

export interface ScalarFieldsPanelProps {
  tab: ScalarFieldsTab;
  onTabChange: (tab: ScalarFieldsTab) => void;

  /** Every cloud the picker offers; flat ones carry a `disabledReason`. */
  scanItems: PickerItem[];
  /** The clouds the tool acts on. Independent of the viewport selection. */
  checkedIds: Set<string>;
  onCheckedChange: (next: Set<string>) => void;

  fields: ScalarFieldInfo[];
  /** Carried by every checked cloud but unmeasurable across them (coordinates). */
  blockedFields: BlockedScalarField[];
  /** Slugs only SOME checked clouds carry, so the list cannot offer them. */
  omittedFieldSlugs: string[];
  vocabulary: ExpressionVocabulary;
  /** Alive AND a real return — what the statistics are measured over. */
  visibleCount: number;
  pointCount: number;

  selectedSlug: string | null;
  onSelectSlug: (slug: string) => void;

  stats: ScalarStats | null;
  statsLoading: boolean;
  /** Why the measurement was refused (e.g. pooling coordinates across frames). */
  statsError: string | null;
  /** A limitation worth stating beside the pooled numbers, never a refusal. */
  poolingCaution: string | null;
  /** True when the selected field's values are whole numbers (a class id). */
  selectedIsInteger: boolean;

  expression: string;
  onExpressionChange: (value: string) => void;
  newSlug: string;
  onNewSlugChange: (value: string) => void;
  /** True once the user has edited the name, so it stops auto-following. */
  slugTouched: boolean;

  inProgress: boolean;
  /** "Computing band2 — scan-b (2/3)…" during a fan-out, else null. */
  progress: string | null;
  /** Per-cloud failures from the last fan-out. */
  failures: Array<{ name: string; message: string }>;
  error: string | null;
  /** Column offset of the offending token, when the backend reported one. */
  errorCol: number | null;
  costWarning: string | null;

  onCompute: () => void;
  onCancel: () => void;
  onRename: (slug: string, newSlug: string) => void;
  onDuplicate: (slug: string, newSlug: string) => void;
  onDelete: (slug: string) => void;
  onColorBy: (slug: string) => void;
  onClose: () => void;
}

const TABS: ReadonlyArray<{ id: ScalarFieldsTab; label: string }> = [
  { id: 'fields', label: 'Fields' },
  { id: 'stats', label: 'Stats' },
  { id: 'compute', label: 'Compute' },
];

export function ScalarFieldsPanel(props: ScalarFieldsPanelProps) {
  const {
    tab, onTabChange, scanItems, checkedIds, onCheckedChange,
    fields, blockedFields, omittedFieldSlugs, vocabulary, visibleCount, pointCount,
    selectedSlug, onSelectSlug, stats, statsLoading, statsError,
    poolingCaution, selectedIsInteger,
    expression, onExpressionChange, newSlug, onNewSlugChange, slugTouched,
    inProgress, progress, failures, error, errorCol, costWarning,
    onCompute, onCancel, onRename, onDuplicate, onDelete, onColorBy, onClose,
  } = props;

  // Collapsed when exactly one cloud is checked: the common case shouldn't grow
  // a scrolling list inside a 288 px panel. Any other count is worth seeing,
  // since it changes what every tab means.
  //
  // `pickerOpen` latches once the list has been shown, so narrowing a multi-
  // cloud selection down to one does not yank the list away mid-edit — the
  // user is plainly still working in it, and the next click would land on
  // whatever reflowed into its place.
  const [pickerOpen, setPickerOpen] = useState(false);
  const multi = checkedIds.size !== 1;
  useEffect(() => { if (multi) setPickerOpen(true); }, [multi]);
  const showPicker = pickerOpen || multi;

  const [menuFor, setMenuFor] = useState<string | null>(null);

  const takenSlugs = useMemo(() => fields.map(f => f.slug), [fields]);
  // Names the calculator made, and may therefore REPLACE. Re-running a field
  // you just derived (tweak the formula, run again) is the common loop, so
  // those names must not read as "taken" — only an imported or tool-written
  // column is off limits, and the backend enforces that independently.
  const derivedSlugs = useMemo(
    () => fields.filter(f => f.expression).map(f => f.slug),
    [fields],
  );
  const blockedSlugs = useMemo(
    () => takenSlugs.filter(s => !derivedSlugs.includes(s)),
    [takenSlugs, derivedSlugs],
  );
  // Live feedback for the two mistakes worth catching before a round trip; the
  // backend's AST walker remains the authority on everything else.
  const exprProblem = useMemo(
    () => checkExpression(expression, vocabulary),
    [expression, vocabulary],
  );
  // The auto-suggested name still avoids EVERY existing name, so a fresh
  // formula never silently proposes overwriting an earlier result.
  const effectiveSlug = slugTouched ? newSlug : (newSlug || suggestSlug(expression, takenSlugs));
  const slugProblem = expression.trim() ? checkSlug(effectiveSlug, blockedSlugs) : null;
  const replacingDerived = derivedSlugs.includes(effectiveSlug);
  const canCompute = !!expression.trim() && !exprProblem && !slugProblem && !inProgress;

  const selected = fields.find(f => f.slug === selectedSlug) ?? null;

  return (
    // z-20 is load-bearing, not cosmetic: below it the panel is invisible to
    // readBlockedRects AND sits under the z-10 lasso overlay, which then eats
    // every click aimed at it.
    <div
      data-testid="scalar-fields-panel"
      className="absolute top-4 right-[280px] z-20 bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-72"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-neutral-300 flex items-center gap-2">
          <Calculator className="w-3 h-3" />
          Scalar Fields
        </div>
        <button onClick={onClose} className="p-1 hover:bg-neutral-700 rounded"
                data-testid="scalar-fields-close">
          <X className="w-3 h-3 text-neutral-400" />
        </button>
      </div>

      {/* Which clouds the tool acts on. Seeded from the viewport selection,
          but checking here never changes what is selected in the scene. */}
      <div className="mb-2" data-testid="scalar-scan-section">
        <button
          onClick={() => setPickerOpen(o => !o)}
          data-testid="scalar-scan-toggle"
          data-expanded={showPicker}
          className="w-full flex items-center justify-between text-[10px] text-neutral-400 hover:text-neutral-200 py-0.5"
        >
          <span data-testid="scalar-scan-summary">
            {checkedIds.size === 0
              ? 'No clouds checked'
              : `${checkedIds.size} cloud${checkedIds.size === 1 ? '' : 's'}`}
          </span>
          <ChevronDown className={`w-3 h-3 transition-transform ${showPicker ? '' : '-rotate-90'}`} />
        </button>
        {showPicker && (
          <ObjectPicker
            data-testid="scalar-scan-picker"
            rowTestId="scalar-scan-row"
            mode="multi"
            label="Clouds"
            items={scanItems}
            selectedIds={checkedIds}
            onChange={onCheckedChange}
            emptyMessage="No imported clouds. Scalar fields live in a cloud's session."
          />
        )}
      </div>

      {checkedIds.size === 0 && (
        <div className="text-[10px] text-neutral-500 py-4 text-center"
             data-testid="scalar-no-clouds">
          Check one or more clouds above to inspect their fields.
        </div>
      )}

      {checkedIds.size > 0 && (<>
      {/* Tabs */}
      <div className="flex gap-1 mb-3 bg-neutral-900/60 rounded p-0.5">
        {TABS.map(t => (
          <button
            key={t.id}
            data-testid={`scalar-fields-tab-${t.id}`}
            data-active={tab === t.id}
            onClick={() => onTabChange(t.id)}
            className={`flex-1 px-2 py-1 text-[10px] rounded transition-colors ${
              tab === t.id
                ? 'bg-neutral-700 text-neutral-100'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'fields' && (
        <FieldsTab
          fields={fields}
          blockedFields={blockedFields}
          omittedFieldSlugs={omittedFieldSlugs}
          takenSlugs={takenSlugs}
          selectedSlug={selectedSlug}
          onSelectSlug={onSelectSlug}
          menuFor={menuFor}
          setMenuFor={setMenuFor}
          onRename={onRename}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onColorBy={onColorBy}
          busy={inProgress}
        />
      )}

      {tab === 'stats' && (
        <StatsTab
          fields={fields}
          blockedFields={blockedFields}
          omittedFieldSlugs={omittedFieldSlugs}
          scanCount={checkedIds.size}
          statsError={statsError}
          poolingCaution={poolingCaution}
          selectedSlug={selectedSlug}
          onSelectSlug={onSelectSlug}
          stats={stats}
          loading={statsLoading}
          integer={selectedIsInteger}
          visibleCount={visibleCount}
          pointCount={pointCount}
          label={selected?.label ?? selectedSlug ?? ''}
        />
      )}

      {tab === 'compute' && (
        <ComputeTab
          expression={expression}
          onExpressionChange={onExpressionChange}
          slug={effectiveSlug}
          onSlugChange={onNewSlugChange}
          problem={exprProblem}
          slugProblem={slugProblem}
          fields={fields}
          vocabulary={vocabulary}
          inProgress={inProgress}
          canCompute={canCompute}
          replacingDerived={replacingDerived}
          backendErrorCol={errorCol}
          onCompute={onCompute}
          onCancel={onCancel}
          costWarning={costWarning}
        />
      )}

      </>)}

      {progress && (
        <div className="mt-2 flex items-center gap-2 text-[10px] text-neutral-400"
             data-testid="scalar-fields-progress">
          <Loader2 className="w-3 h-3 animate-spin" /> {progress}
        </div>
      )}

      {error && (
        <div
          data-testid="scalar-fields-error"
          data-error-col={errorCol ?? undefined}
          className="mt-3 p-2 bg-red-900/30 border border-red-600/50 rounded text-[10px] text-red-300"
        >
          {error}
        </div>
      )}

      {/* Which clouds failed, named. A run that succeeded on 3 of 5 must say
          which two didn't, or the user cannot tell what state they are in. */}
      {failures.length > 0 && (
        <div className="mt-1 space-y-0.5" data-testid="scalar-fields-failures">
          {failures.map(f => (
            <div key={f.name} data-testid="scalar-scan-failure" data-scan-name={f.name}
                 className="text-[9px] text-red-300/80" title={f.message}>
              {f.name}: {f.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Note naming the fields the intersection had to drop, and why. */
function OmittedNote({ slugs }: { slugs: string[] }) {
  if (slugs.length === 0) return null;
  return (
    <div className="mt-1 text-[9px] text-neutral-500" data-testid="scalar-omitted-note"
         data-count={slugs.length} title={slugs.join(', ')}>
      {slugs.length} field{slugs.length === 1 ? '' : 's'} hidden — not every
      checked cloud carries {slugs.length === 1 ? 'it' : 'them'}.
    </div>
  );
}

// ── Fields tab ──────────────────────────────────────────────────────────────

/** A rename/duplicate the user is naming, or a delete awaiting confirmation. */
type PendingAction =
  | { kind: 'rename' | 'duplicate'; slug: string; draft: string }
  | { kind: 'delete'; slug: string };

function FieldsTab({
  fields, blockedFields, omittedFieldSlugs, takenSlugs, selectedSlug,
  onSelectSlug, menuFor, setMenuFor,
  onRename, onDuplicate, onDelete, onColorBy, busy,
}: {
  fields: ScalarFieldInfo[];
  blockedFields: BlockedScalarField[];
  omittedFieldSlugs: string[];
  takenSlugs: string[];
  selectedSlug: string | null;
  onSelectSlug: (slug: string) => void;
  menuFor: string | null;
  setMenuFor: (slug: string | null) => void;
  onRename: (slug: string, newSlug: string) => void;
  onDuplicate: (slug: string, newSlug: string) => void;
  onDelete: (slug: string) => void;
  onColorBy: (slug: string) => void;
  busy: boolean;
}) {
  // Naming and confirmation happen INLINE, in the panel. `window.prompt` and
  // `window.confirm` block the main thread, are refused outright by some
  // Electron configurations, and were the only native dialogs anywhere in this
  // renderer — every other naming or destructive flow here is a rendered
  // control. Keeping it in the row also puts the confirmation next to the thing
  // being deleted, rather than in a modal that has lost that context.
  const [pending, setPending] = useState<PendingAction | null>(null);

  if (fields.length === 0 && blockedFields.length === 0) {
    return <div className="text-[10px] text-neutral-500 py-4 text-center">
      No scalar fields shared by the checked clouds.
      <OmittedNote slugs={omittedFieldSlugs} />
    </div>;
  }

  const startRename = (slug: string) => {
    setMenuFor(null);
    setPending({ kind: 'rename', slug, draft: slug });
  };
  const startDuplicate = (slug: string) => {
    setMenuFor(null);
    setPending({ kind: 'duplicate', slug, draft: suggestSlug(`${slug}_copy`, takenSlugs) });
  };
  const startDelete = (slug: string) => {
    setMenuFor(null);
    setPending({ kind: 'delete', slug });
  };

  return (
    <div className="max-h-[320px] overflow-y-auto -mx-1 px-1" data-testid="scalar-fields-list">
      {fields.map(f => {
        const active = pending?.slug === f.slug ? pending : null;
        return (
        <div key={f.slug}>
        <div
          data-testid="scalar-field-row"
          data-slug={f.slug}
          data-editable={f.editable}
          data-derived={!!f.expression}
          data-selected={selectedSlug === f.slug}
          className={`group flex items-center gap-1 px-2 py-1 rounded text-[11px] cursor-pointer ${
            selectedSlug === f.slug ? 'bg-neutral-700' : 'hover:bg-neutral-700/50'
          }`}
          onClick={() => onSelectSlug(f.slug)}
        >
          <div className="flex-1 min-w-0">
            <div className="truncate text-neutral-200">{f.label}</div>
            {f.expression && (
              <div className="truncate text-[9px] text-neutral-500 font-mono"
                   title={f.expression}>
                = {f.expression}
              </div>
            )}
          </div>
          {!f.editable && (
            <span className="text-[9px] text-neutral-500 shrink-0" title={
              f.kind === 'builtin'
                ? 'A coordinate or intensity — usable in a formula, but not a stored column.'
                : 'Other tools read this field by name, so it cannot be renamed or removed.'
            }>
              {f.kind === 'builtin' ? 'built-in' : 'locked'}
            </span>
          )}
          {f.editable && (
            <div className="relative shrink-0">
              <button
                data-testid={`scalar-field-menu-${f.slug}`}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(menuFor === f.slug ? null : f.slug);
                }}
                className="p-0.5 rounded hover:bg-neutral-600 opacity-0 group-hover:opacity-100 data-[open=true]:opacity-100"
                data-open={menuFor === f.slug}
              >
                <MoreVertical className="w-3 h-3 text-neutral-400" />
              </button>
              {menuFor === f.slug && (
                <div className="absolute right-0 top-5 z-30 bg-neutral-900 border border-neutral-700 rounded shadow-lg py-0.5 w-32">
                  <MenuItem icon={Pencil} label="Rename…" testId={`scalar-field-rename-${f.slug}`}
                            onClick={() => startRename(f.slug)} />
                  <MenuItem icon={Copy} label="Duplicate…" testId={`scalar-field-duplicate-${f.slug}`}
                            onClick={() => startDuplicate(f.slug)} />
                  <MenuItem icon={Trash2} label="Delete" danger testId={`scalar-field-delete-${f.slug}`}
                            onClick={() => startDelete(f.slug)} />
                </div>
              )}
            </div>
          )}
          <button
            data-testid={`scalar-field-colorby-${f.slug}`}
            onClick={(e) => { e.stopPropagation(); onColorBy(f.slug); }}
            className="text-[9px] px-1 py-0.5 rounded bg-neutral-600/60 hover:bg-neutral-600 text-neutral-300 opacity-0 group-hover:opacity-100 shrink-0"
            title="Colour the cloud by this field"
          >
            colour
          </button>
        </div>

        {active && active.kind !== 'delete' && (
          <NameForm
            action={active.kind}
            slug={active.slug}
            draft={active.draft}
            // The field being RENAMED keeps its own name available; a duplicate
            // must not collide with it.
            taken={active.kind === 'rename'
              ? takenSlugs.filter(s => s !== active.slug)
              : takenSlugs}
            busy={busy}
            onDraftChange={(draft) => setPending({ ...active, draft })}
            onCancel={() => setPending(null)}
            onSubmit={(name) => {
              setPending(null);
              if (active.kind === 'rename') onRename(active.slug, name);
              else onDuplicate(active.slug, name);
            }}
          />
        )}

        {active && active.kind === 'delete' && (
          <div
            data-testid={`scalar-field-delete-confirm-${f.slug}`}
            className="mx-2 mb-1 p-2 bg-red-900/25 border border-red-700/50 rounded"
          >
            <div className="text-[10px] text-red-200 mb-1.5">
              Delete “{f.label}”? Point-cloud edits are not kept in the undo
              history, so this cannot be undone.
            </div>
            <div className="flex gap-1">
              <button
                data-testid={`scalar-field-delete-cancel-${f.slug}`}
                onClick={() => setPending(null)}
                className="flex-1 px-2 py-1 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
              >
                Cancel
              </button>
              <button
                data-testid={`scalar-field-delete-apply-${f.slug}`}
                disabled={busy}
                onClick={() => { setPending(null); onDelete(f.slug); }}
                className="flex-1 px-2 py-1 text-[10px] rounded bg-red-600 hover:bg-red-500 text-white disabled:bg-neutral-600"
              >
                Delete
              </button>
            </div>
          </div>
        )}
        </div>
        );
      })}

      {/* Fields every checked cloud carries but which cannot be measured
          ACROSS them. Shown disabled with the reason rather than silently
          dropped — a field that simply vanished would read as a bug. */}
      {blockedFields.map(({ field: f, reason }) => (
        <div
          key={f.slug}
          data-testid="scalar-field-row"
          data-slug={f.slug}
          data-blocked="true"
          title={reason}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] opacity-40 cursor-not-allowed"
        >
          <div className="flex-1 min-w-0 truncate text-neutral-300">{f.label}</div>
          <span className="text-[9px] text-neutral-500 shrink-0">per cloud only</span>
        </div>
      ))}

      <OmittedNote slugs={omittedFieldSlugs} />
    </div>
  );
}

/** Inline name entry for a rename or a duplicate. */
function NameForm({
  action, slug, draft, taken, busy, onDraftChange, onCancel, onSubmit,
}: {
  action: 'rename' | 'duplicate';
  slug: string;
  draft: string;
  taken: string[];
  busy: boolean;
  onDraftChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const trimmed = draft.trim();
  const problem = checkSlug(trimmed, taken);
  // A rename to the same name is a no-op rather than an error, so it is simply
  // not submittable.
  const unchanged = action === 'rename' && trimmed === slug;
  const canSubmit = !problem && !unchanged && !busy;

  return (
    <div
      data-testid={`scalar-field-name-form-${slug}`}
      className="mx-2 mb-1 p-2 bg-neutral-900/60 border border-neutral-700 rounded"
    >
      <label className="text-[9px] text-neutral-400 mb-1 block">
        {action === 'rename' ? 'New name' : 'Name for the copy'}
      </label>
      <input
        data-testid={`scalar-field-name-input-${slug}`}
        type="text"
        value={draft}
        autoFocus
        spellCheck={false}
        onChange={(e) => onDraftChange(e.target.value)}
        // Stop viewport shortcuts firing while typing, and give the two keys a
        // user expects in a name field their obvious meanings.
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && canSubmit) onSubmit(trimmed);
          if (e.key === 'Escape') onCancel();
        }}
        className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600 font-mono"
      />
      {problem && !unchanged && (
        <div className="mt-1 text-[9px] text-amber-300"
             data-testid={`scalar-field-name-problem-${slug}`}>
          {problem}
        </div>
      )}
      <div className="flex gap-1 mt-1.5">
        <button
          data-testid={`scalar-field-name-cancel-${slug}`}
          onClick={onCancel}
          className="flex-1 px-2 py-1 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
        >
          Cancel
        </button>
        <button
          data-testid={`scalar-field-name-apply-${slug}`}
          disabled={!canSubmit}
          onClick={() => onSubmit(trimmed)}
          className="flex-1 px-2 py-1 text-[10px] rounded bg-green-600 hover:bg-green-500 text-white disabled:bg-neutral-600 disabled:text-neutral-400"
        >
          {action === 'rename' ? 'Rename' : 'Duplicate'}
        </button>
      </div>
    </div>
  );
}


function MenuItem({ icon: Icon, label, onClick, testId, danger }: {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
  testId: string;
  danger?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className={`w-full flex items-center gap-1.5 px-2 py-1 text-[10px] hover:bg-neutral-700 ${
        danger ? 'text-red-300' : 'text-neutral-200'
      }`}
    >
      <Icon className="w-2.5 h-2.5" />
      {label}
    </button>
  );
}

// ── Stats tab ───────────────────────────────────────────────────────────────

function StatsTab({
  fields, blockedFields, omittedFieldSlugs, scanCount, statsError, poolingCaution,
  selectedSlug, onSelectSlug, stats, loading, integer,
  visibleCount, pointCount, label,
}: {
  fields: ScalarFieldInfo[];
  blockedFields: BlockedScalarField[];
  omittedFieldSlugs: string[];
  scanCount: number;
  statsError: string | null;
  poolingCaution: string | null;
  selectedSlug: string | null;
  onSelectSlug: (slug: string) => void;
  stats: ScalarStats | null;
  loading: boolean;
  integer: boolean;
  visibleCount: number;
  pointCount: number;
  label: string;
}) {
  const nonFinite = nonFiniteCaption(stats ?? undefined);
  return (
    <div>
      <select
        data-testid="scalar-stats-field"
        value={selectedSlug ?? ''}
        onChange={(e) => onSelectSlug(e.target.value)}
        className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600 mb-2"
      >
        {!selectedSlug && <option value="">Choose a field…</option>}
        {fields.map(f => (
          <option key={f.slug} value={f.slug}>{f.label}</option>
        ))}
        {/* Present on every checked cloud but not measurable across them. Kept
            visible and disabled so the absence is explained, not mysterious. */}
        {blockedFields.map(({ field: f }) => (
          <option key={f.slug} value={f.slug} disabled data-blocked="true">
            {f.label} — per cloud only
          </option>
        ))}
      </select>

      <OmittedNote slugs={omittedFieldSlugs} />

      {statsError && (
        <div data-testid="scalar-stats-error"
             className="mt-2 p-2 bg-amber-900/25 border border-amber-600/40 rounded text-[10px] text-amber-200">
          {statsError}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-6 text-[10px] text-neutral-400"
             data-testid="scalar-stats-loading">
          <Loader2 className="w-3 h-3 animate-spin" /> Measuring…
        </div>
      )}

      {!loading && !stats && selectedSlug && (
        <div className="text-[10px] text-neutral-500 py-4 text-center">
          No finite values in this field.
        </div>
      )}

      {!loading && stats && (
        <div data-testid="scalar-stats">
          <ScalarHistogram data={stats.histogram} integer={integer} />

          <table className="w-full text-[10px] mt-2">
            <tbody>
              {STAT_ROWS.map(row => (
                <tr key={row.key} data-testid={`scalar-stat-${row.key}`}>
                  <td className="text-neutral-400 py-0.5">{row.label}</td>
                  <td className="text-neutral-200 text-right font-mono"
                      data-value={stats[row.key] as number | undefined}>
                    {row.key === 'count'
                      ? formatCount(stats.count)
                      : formatStat(stats[row.key] as number | undefined, integer)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {nonFinite && (
            <div className="mt-1 text-[9px] text-amber-300/80" data-testid="scalar-stats-nonfinite">
              {nonFinite}
            </div>
          )}

          {/* Pooling is stated explicitly: the same histogram over 3 clouds and
              over 1 means different things, and nothing else on screen says
              which this is. */}
          {scanCount > 1 && (
            <div className="mt-1 text-[9px] text-neutral-400" data-testid="scalar-stats-pooled"
                 data-scan-count={scanCount}>
              Pooled across {scanCount} clouds as one distribution.
            </div>
          )}

          {poolingCaution && (
            <div className="mt-1 text-[9px] text-amber-300/80"
                 data-testid="scalar-pooling-caution">
              {poolingCaution}
            </div>
          )}

          {/* Why the count can differ from the clouds' point count. Stated
              rather than left as a discrepancy the user has to puzzle out. */}
          {visibleCount < pointCount && (
            <div className="mt-1 text-[9px] text-neutral-500">
              Measured over {formatCount(visibleCount)} of {formatCount(pointCount)} points
              — hidden and sky/miss points are excluded, exactly as the colour scale excludes them.
            </div>
          )}
          <div className="sr-only">{label}</div>
        </div>
      )}
    </div>
  );
}

// ── Compute tab ─────────────────────────────────────────────────────────────

function ComputeTab({
  expression, onExpressionChange, slug, onSlugChange, problem, slugProblem,
  fields, vocabulary, inProgress, canCompute, replacingDerived,
  backendErrorCol, onCompute, onCancel, costWarning,
}: {
  expression: string;
  onExpressionChange: (v: string) => void;
  slug: string;
  onSlugChange: (v: string) => void;
  problem: ReturnType<typeof checkExpression>;
  slugProblem: string | null;
  fields: ScalarFieldInfo[];
  vocabulary: ExpressionVocabulary;
  inProgress: boolean;
  canCompute: boolean;
  /** The chosen name belongs to an existing DERIVED field, which will be replaced. */
  replacingDerived: boolean;
  /** Offset the BACKEND reported for the last rejected expression. */
  backendErrorCol: number | null;
  onCompute: () => void;
  onCancel: () => void;
  costWarning: string | null;
}) {
  const [showRef, setShowRef] = useState(false);
  // The client-side hint wins while the user is typing; once they submit, the
  // backend's offset is the authoritative one. Clamped to the current text so a
  // stale offset from a previous submission cannot point past the end.
  const rawCol = problem?.col ?? backendErrorCol ?? null;
  const caretCol = rawCol !== null && rawCol >= 0 && rawCol <= expression.length
    ? rawCol
    : null;
  return (
    <div>
      <label className="text-[10px] text-neutral-400 mb-1 flex items-center gap-1">
        Expression
        <InfoHint
          data-testid="scalar-compute-expression-help"
          label="Expression"
          text="A formula over this cloud's existing fields, evaluated once per point. Use a field by name (intensity, z, curvature), the usual operators, and functions like sqrt or ifelse. Whole-field values such as mean(intensity) are measured over the visible points, so (intensity - mean(intensity)) / std(intensity) normalises the field."
        />
      </label>
      {/* A raw textarea bound to a string draft, not a numeric input: this is
          free text and every intermediate state is legitimate. */}
      <textarea
        data-testid="scalar-compute-expression"
        value={expression}
        onChange={(e) => onExpressionChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        disabled={inProgress}
        rows={2}
        spellCheck={false}
        placeholder="intensity * 2"
        className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600 font-mono resize-none"
      />

      {/* Point at the offending token. This is what the bespoke error plumbing
          in `computeScalarField` preserves the offset FOR — without it the
          column is metadata nothing renders. The textarea is monospace and
          `px-2` (8px), so a caret row with the same font and padding lines up
          per character; a wrapped long formula is the known limit, and the
          message below still names the token. */}
      {caretCol !== null && (
        <div
          aria-hidden
          data-testid="scalar-compute-caret"
          data-col={caretCol}
          className="font-mono text-xs text-amber-300 px-2 leading-none select-none whitespace-pre overflow-hidden"
        >
          {`${' '.repeat(caretCol)}^`}
        </div>
      )}

      {problem && (
        <div className="mt-1 text-[9px] text-amber-300" data-testid="scalar-compute-hint"
             data-col={problem.col ?? undefined}>
          {problem.message}
        </div>
      )}

      <label className="text-[10px] text-neutral-400 mt-2 mb-1 block">New field name</label>
      <input
        data-testid="scalar-compute-slug"
        type="text"
        value={slug}
        onChange={(e) => onSlugChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        disabled={inProgress}
        spellCheck={false}
        className="w-full bg-neutral-700 text-neutral-200 text-xs rounded px-2 py-1 border border-neutral-600 font-mono"
      />
      {slugProblem && (
        <div className="mt-1 text-[9px] text-amber-300" data-testid="scalar-compute-slug-hint">
          {slugProblem}
        </div>
      )}
      {!slugProblem && replacingDerived && (
        <div className="mt-1 text-[9px] text-neutral-400" data-testid="scalar-compute-replace-hint">
          Replaces the existing “{slug}” with this formula.
        </div>
      )}

      <button
        onClick={() => setShowRef(v => !v)}
        data-testid="scalar-compute-reference-toggle"
        className="mt-2 text-[9px] text-neutral-400 hover:text-neutral-200"
      >
        {showRef ? 'Hide' : 'Show'} available names
      </button>
      {showRef && (
        <div className="mt-1 p-2 bg-neutral-900/50 rounded text-[9px] space-y-1"
             data-testid="scalar-compute-reference">
          <Reference title="Fields" items={fields.map(f => f.slug)} />
          <Reference title="Functions" items={vocabulary.functions} />
          <Reference title="Whole-field" items={vocabulary.aggregates} />
          <Reference title="Constants" items={vocabulary.constants} />
        </div>
      )}

      {costWarning && !inProgress && (
        <div
          data-testid="scalar-compute-cost-warning"
          className="mt-2 p-2 bg-amber-900/30 border border-amber-600/50 rounded text-[10px] text-amber-200 flex gap-1.5"
        >
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span>{costWarning}</span>
        </div>
      )}

      {inProgress ? (
        <div className="flex gap-2 mt-3">
          <button
            data-testid="scalar-compute-run"
            disabled
            className="flex-1 px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 bg-neutral-600 text-neutral-400 cursor-not-allowed"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            Computing…
          </button>
          <button
            data-testid="scalar-compute-cancel"
            onClick={onCancel}
            className="px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-1 bg-red-600 hover:bg-red-500 text-white"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </div>
      ) : (
        <button
          data-testid="scalar-compute-run"
          onClick={onCompute}
          disabled={!canCompute}
          className={`w-full mt-3 px-3 py-2 text-xs rounded font-medium flex items-center justify-center gap-2 text-white ${
            !canCompute
              ? 'bg-neutral-600 text-neutral-400 cursor-not-allowed'
              : costWarning
                ? 'bg-amber-600 hover:bg-amber-500'
                : 'bg-green-600 hover:bg-green-500'
          }`}
        >
          {costWarning ? <AlertTriangle className="w-3 h-3" /> : <Calculator className="w-3 h-3" />}
          {costWarning ? 'Compute Anyway' : (replacingDerived ? 'Recompute Field' : 'Compute Field')}
        </button>
      )}
    </div>
  );
}

function Reference({ title, items }: { title: string; items: readonly string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <span className="text-neutral-500">{title}: </span>
      <span className="text-neutral-300 font-mono">{items.join(', ')}</span>
    </div>
  );
}
