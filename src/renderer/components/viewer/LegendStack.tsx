import { colormapToCssGradient } from '../../lib/colormaps';
import { formatColorbarTick } from '../../lib/pointCloudHelpers';
import { LegendEntry, layoutLegend } from '../../lib/colorChannel';

// The viewer's single legend overlay.
//
// Replaces the four independent overlays that used to stack along the bottom
// edge (cloud colorbar, cloud class legend, mesh colorbar, mesh source-scan
// legend, LAD colorbar), each captioned only by its variable and with no
// indication of which geometry it described. Every pseudocolored object now
// contributes a ColorChannel; `buildLegendEntries` folds those into the
// deduped `entries` this component draws.
//
// Two things make the stack stay small: identical channels are already merged
// upstream into one grouped entry ("5 scans · Z Height" — the common case of
// many clouds sharing a color mode), and past LEGEND_EXPAND_LIMIT distinct
// entries the remainder collapse into one-line slivers that can be clicked to
// promote. Clicking an expanded entry opens its editor (phase 5).

const BAR_HEIGHT = 180;

export interface LegendStackProps {
  entries: LegendEntry[];
  // The sliver the user clicked to read in full; overrides the selection-based
  // expansion for that one entry.
  promotedKey?: string;
  onPromote?: (key: string) => void;
  // Clicking an expanded entry's caption toggles its editor open/closed.
  onEdit?: (entry: LegendEntry) => void;
  // Which entry currently has its editor open (null = none).
  editingKey?: string | null;
  // Renders the per-object colormap/range editor for an entry. Supplied by the
  // viewer, which owns the setters; keeping it a render prop leaves this
  // component presentational and independently testable.
  renderEditor?: (entry: LegendEntry) => React.ReactNode;
}

// A continuous gradient bar with min/mid/max ticks.
function ContinuousBody({ entry }: { entry: LegendEntry }) {
  const min = entry.min ?? 0;
  const max = entry.max ?? 0;
  const mid = (min + max) / 2;
  // `reversed` flips the gradient direction so the swatch always matches what
  // the renderer paints.
  const direction = entry.reversed ? 'to bottom' : 'to top';
  return (
    <div className="flex items-stretch gap-2">
      <div
        className="w-4 rounded-sm border border-neutral-600 shrink-0"
        style={{ height: BAR_HEIGHT, background: colormapToCssGradient(entry.colormap, 32, direction) }}
      />
      <div
        className="flex flex-col justify-between text-[10px] text-neutral-300 leading-none"
        style={{ height: BAR_HEIGHT }}
      >
        <span>{formatColorbarTick(max)}</span>
        <span className="text-neutral-400">{formatColorbarTick(mid)}</span>
        <span>{formatColorbarTick(min)}</span>
      </div>
    </div>
  );
}

// One swatch + name per class. The list can be long (a generic categorical
// import may carry dozens of classes), so it scrolls inside a capped box
// rather than overrunning the top of the window — and opts back into pointer
// events, since the overlay above it is pointer-events-none.
function CategoricalBody({ entry }: { entry: LegendEntry }) {
  if (!entry.scheme) return null;
  return (
    <div className="flex flex-col gap-1 min-h-0 max-h-[220px] overflow-y-auto pointer-events-auto">
      {entry.scheme.classes.map((cls) => (
        <div key={cls.value} className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-sm border border-neutral-600 shrink-0"
            style={{
              backgroundColor: `rgb(${Math.round(cls.color[0] * 255)}, ${Math.round(
                cls.color[1] * 255,
              )}, ${Math.round(cls.color[2] * 255)})`,
            }}
          />
          <span className="text-[10px] text-neutral-200 leading-none whitespace-nowrap">
            {cls.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// A collapsed entry: a colormap-tinted dot plus "Object · Variable" on one
// line. Clicking promotes it to full size.
function Sliver({ entry, onPromote }: { entry: LegendEntry; onPromote?: (key: string) => void }) {
  // For a categorical entry the dot shows the first class colour; for a
  // continuous one, a miniature of the gradient.
  const swatch = entry.kind === 'categorical' && entry.scheme?.classes.length
    ? {
        backgroundColor: `rgb(${entry.scheme.classes[0].color
          .map(c => Math.round(c * 255))
          .join(', ')})`,
      }
    : { background: colormapToCssGradient(entry.colormap, 8, 'to right') };

  return (
    <button
      type="button"
      data-testid="legend-sliver"
      data-legend-key={entry.key}
      onClick={() => onPromote?.(entry.key)}
      className="flex items-center gap-2 w-full text-left px-1 py-0.5 rounded hover:bg-neutral-700/60 transition-colors pointer-events-auto"
      title={`${entry.objectLabel} · ${entry.variableLabel}`}
    >
      <span className="w-2.5 h-2.5 rounded-sm border border-neutral-600 shrink-0" style={swatch} />
      <span className="text-[10px] text-neutral-300 truncate">
        <span className="text-neutral-200">{entry.objectLabel}</span>
        <span className="text-neutral-500"> · </span>
        {entry.variableLabel}
      </span>
    </button>
  );
}

// One fully-drawn legend: object name on top (the caption that says WHICH
// geometry this describes), variable beneath it, then the scale.
function ExpandedEntry({
  entry,
  onEdit,
  editing,
  editor,
}: {
  entry: LegendEntry;
  onEdit?: (entry: LegendEntry) => void;
  editing?: boolean;
  editor?: React.ReactNode;
}) {
  const interactive = !!onEdit;
  // The per-family test id this entry has always been addressed by. The four
  // legend overlays were unified into this component, but the E2E suite (and
  // anyone reading a trace) still identifies them by origin + kind, so those
  // ids are preserved rather than forcing a rename across 15 spec files.
  const legacyTestId =
    entry.origin === 'mesh'
      ? (entry.kind === 'categorical' ? 'mesh-scan-legend' : 'mesh-colorbar')
      : entry.origin === 'lad'
        ? 'lad-colorbar'
        : (entry.kind === 'categorical' ? 'class-legend' : 'colorbar');
  return (
    <div
      data-testid={legacyTestId}
      data-legend-entry="true"
      data-legend-editing={editing ? 'true' : 'false'}
      {...(entry.kind === 'categorical' && entry.origin === 'cloud'
        ? { 'data-legend-attribute': entry.scheme?.attribute }
        : {})}
      {...(entry.kind === 'categorical' && entry.origin === 'mesh'
        // Class count, under the name the mesh source-scan legend has always
        // used — it lists one row per contributing scan.
        ? { 'data-scan-count': entry.scheme?.classes.length ?? 0 }
        : {})}
      {...(entry.kind === 'continuous'
        ? { 'data-colorbar-label': entry.variableLabel }
        : {})}
      data-legend-key={entry.key}
      data-legend-kind={entry.kind}
      data-legend-object={entry.objectLabel}
      data-legend-variable={entry.variableLabel}
      data-legend-colormap={entry.colormap}
      data-legend-objects={entry.objectIds.join(',')}
      data-legend-selected={entry.selected ? 'true' : 'false'}
      // Continuous entries carry the mapped domain for tests and for quick
      // readout; these mirror the old data-colorbar-* hooks.
      {...(entry.kind === 'continuous'
        ? { 'data-colorbar-min': entry.min, 'data-colorbar-max': entry.max }
        : {})}
      className={[
        'flex flex-col max-h-[calc(100vh-7rem)] bg-neutral-800/90 backdrop-blur-sm rounded-lg',
        'shadow-lg px-2.5 py-2 border select-none',
        entry.selected ? 'border-blue-500/60' : 'border-neutral-700/50',
        interactive ? 'pointer-events-auto' : '',
      ].join(' ')}
    >
      {/* Only the caption toggles the editor — clicking inside the editor
          itself must not close it. */}
      <button
        type="button"
        data-testid="legend-entry-caption"
        onClick={interactive ? () => onEdit?.(entry) : undefined}
        disabled={!interactive}
        className={[
          'mb-1.5 shrink-0 max-w-[140px] text-left rounded',
          interactive ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
        ].join(' ')}
        title={interactive ? 'Edit colors' : undefined}
      >
        <div className="text-[10px] font-medium text-neutral-100 truncate" title={entry.objectLabel}>
          {entry.objectLabel}
        </div>
        <div className="text-[10px] text-neutral-400 truncate" title={entry.variableLabel}>
          {entry.variableLabel}
        </div>
      </button>
      {entry.kind === 'continuous' ? (
        <ContinuousBody entry={entry} />
      ) : (
        <CategoricalBody entry={entry} />
      )}
      {editing && editor && (
        <div
          data-testid="legend-editor"
          className="mt-2 pt-2 border-t border-neutral-700/60 pointer-events-auto w-[140px]"
        >
          {editor}
        </div>
      )}
    </div>
  );
}

export function LegendStack({
  entries, promotedKey, onPromote, onEdit, editingKey, renderEditor,
}: LegendStackProps) {
  if (entries.length === 0) return null;
  const { expanded, collapsed } = layoutLegend(entries, promotedKey);

  return (
    <div
      data-testid="legend-stack"
      data-legend-count={entries.length}
      data-legend-expanded={expanded.length}
      data-legend-collapsed={collapsed.length}
      className="flex flex-row items-end gap-3 pointer-events-none"
    >
      {expanded.map((entry) => (
        <ExpandedEntry
          key={entry.key}
          entry={entry}
          onEdit={onEdit}
          editing={editingKey === entry.key}
          editor={renderEditor?.(entry)}
        />
      ))}
      {collapsed.length > 0 && (
        <div
          data-testid="legend-collapsed"
          className="flex flex-col gap-0.5 bg-neutral-800/90 backdrop-blur-sm rounded-lg shadow-lg px-1.5 py-1.5 border border-neutral-700/50 select-none max-w-[180px]"
        >
          {collapsed.map((entry) => (
            <Sliver key={entry.key} entry={entry} onPromote={onPromote} />
          ))}
        </div>
      )}
    </div>
  );
}
