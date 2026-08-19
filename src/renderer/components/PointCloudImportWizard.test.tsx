import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { PointCloudImportWizard, type WizardResult } from './PointCloudImportWizard';
import type { PointCloudPreviewResponse, PreviewColumn } from '../utils/backendApi';

// THE GAP THIS CLOSES: unticking a column's "Import" checkbox has to actually
// remove the field, and the two format families reach that outcome by different
// routes — an ASCII column rides the positional ColumnPlan as role 'skip', while
// an in-file (LAS/PLY/E57) column has no position to skip and must travel as a
// slug in `droppedSlugs`. Both are asserted here on the real component, driven
// through the real checkbox, because the wizard is the only place that decides
// which of the two mechanisms a given column uses.

vi.mock('../utils/backendApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/backendApi')>();
  return { ...actual, previewPointCloud: vi.fn() };
});
vi.mock('./Toast', () => ({ showToast: vi.fn() }));

import { previewPointCloud } from '../utils/backendApi';

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

function col(overrides: Partial<PreviewColumn> & { index: number }): PreviewColumn {
  return {
    header_name: null,
    detected_role: 'extra',
    suggested_label: `Column ${overrides.index + 1}`,
    suggested_slug: `col_${overrides.index + 1}`,
    type_hint: 'float',
    remappable: true,
    ...overrides,
  };
}

function preview(columns: PreviewColumn[], kind = 'ascii'): PointCloudPreviewResponse {
  return {
    kind,
    delimiter: 'whitespace',
    has_header: true,
    columns,
    sample_rows: [['0', '0', '0', '1', '2']],
    warning: null,
    suggested_shift: null,
  } as PointCloudPreviewResponse;
}

// An ASCII layout: xyz plus two carried scalars.
const ASCII_COLUMNS = [
  col({ index: 0, header_name: 'x', detected_role: 'x' }),
  col({ index: 1, header_name: 'y', detected_role: 'y' }),
  col({ index: 2, header_name: 'z', detected_role: 'z' }),
  col({ index: 3, header_name: 'reflectance', detected_role: 'reflectance' }),
  col({ index: 4, header_name: 'junk', suggested_slug: 'junk', suggested_label: 'Junk' }),
];

// An in-file layout (LAS): the file fixes every role, so nothing is remappable.
const LAS_COLUMNS = [
  col({ index: 0, header_name: 'x', detected_role: 'x', remappable: false }),
  col({ index: 1, header_name: 'y', detected_role: 'y', remappable: false }),
  col({ index: 2, header_name: 'z', detected_role: 'z', remappable: false }),
  col({ index: 3, header_name: 'Deviation', detected_role: 'extra', remappable: false,
        suggested_slug: 'Deviation', suggested_label: 'Deviation' }),
  col({ index: 4, header_name: 'Amplitude', detected_role: 'extra', remappable: false,
        suggested_slug: 'Amplitude', suggested_label: 'Amplitude' }),
];

async function open(columns: PreviewColumn[], kind = 'ascii') {
  vi.mocked(previewPointCloud).mockResolvedValue(preview(columns, kind));
  const onComplete = vi.fn();
  render(
    <PointCloudImportWizard
      inputs={[{ path: `/p/scan.${kind === 'ascii' ? 'xyz' : 'las'}`, fileName: 'scan' }]}
      onCancel={vi.fn()}
      onComplete={onComplete}
    />,
  );
  // Wait for the preview to resolve and the column table to render.
  await waitFor(() => expect(screen.getAllByTestId('import-wizard-column').length)
    .toBe(columns.length));
  return onComplete;
}

/** The Import checkbox inside the header cell for source column `index`. */
function includeBox(index: number): HTMLInputElement | null {
  const cell = document.querySelector(`[data-testid="import-wizard-column"][data-col-index="${index}"]`);
  return cell?.querySelector('[data-testid="import-wizard-include"]') as HTMLInputElement ?? null;
}

function submit(): WizardResult {
  fireEvent.click(screen.getByTestId('import-wizard-import'));
  return null as never;
}

describe('PointCloudImportWizard — per-column Import checkbox', () => {
  it('offers no Import checkbox for X/Y/Z, but one for every other column', async () => {
    await open(ASCII_COLUMNS);
    // Geometry is mandatory — hasXYZ already blocks import without it, so an
    // untick there could only produce a dead end.
    expect(includeBox(0)).toBeNull();
    expect(includeBox(1)).toBeNull();
    expect(includeBox(2)).toBeNull();
    expect(includeBox(3)).not.toBeNull();
    expect(includeBox(4)).not.toBeNull();
  });

  it('every column starts ticked, so a no-edit import keeps auto-detect behaviour', async () => {
    await open(ASCII_COLUMNS);
    expect(includeBox(3)!.checked).toBe(true);
    expect(includeBox(4)!.checked).toBe(true);
  });

  it('unticking an ASCII column sends it as role "skip" in the column plan', async () => {
    const onComplete = await open(ASCII_COLUMNS);
    fireEvent.click(includeBox(4)!);
    expect(includeBox(4)!.checked).toBe(false);
    submit();

    const result: WizardResult = onComplete.mock.calls[0][0][0];
    const entry = result.columnPlan!.columns.find((c) => c.index === 4)!;
    expect(entry.role).toBe('skip');
    // The kept scalar is untouched.
    expect(result.columnPlan!.columns.find((c) => c.index === 3)!.role).toBe('reflectance');
    // ASCII skips ride the plan; they must NOT also appear in droppedSlugs, or
    // the backend would receive the same intent through two mechanisms.
    expect(result.droppedSlugs).toEqual([]);
  });

  it('unticking an in-file column sends it in droppedSlugs, not the plan', async () => {
    const onComplete = await open(LAS_COLUMNS, 'las');
    fireEvent.click(includeBox(3)!);
    submit();

    const result: WizardResult = onComplete.mock.calls[0][0][0];
    // buildColumnPlan returns null when nothing is remappable — the positional
    // plan has nothing to bind to for a file-defined layout.
    expect(result.columnPlan).toBeNull();
    expect(result.droppedSlugs).toEqual(['deviation']);
    // The complement is what the RIEGL extract endpoint consumes.
    expect(result.keptSlugs).toContain('amplitude');
    expect(result.keptSlugs).not.toContain('deviation');
  });

  it('re-ticking an ASCII column restores its original role', async () => {
    const onComplete = await open(ASCII_COLUMNS);
    fireEvent.click(includeBox(3)!);   // untick reflectance → 'skip'
    fireEvent.click(includeBox(3)!);   // re-tick → back to 'reflectance'
    expect(includeBox(3)!.checked).toBe(true);
    submit();

    const result: WizardResult = onComplete.mock.calls[0][0][0];
    expect(result.columnPlan!.columns.find((c) => c.index === 3)!.role).toBe('reflectance');
  });

  it('choosing Skip in the dropdown unticks the checkbox, keeping the two in sync', async () => {
    await open(ASCII_COLUMNS);
    const cell = document.querySelector('[data-testid="import-wizard-column"][data-col-index="4"]')!;
    const select = cell.querySelector('[data-testid="import-wizard-role"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'skip' } });
    expect(includeBox(4)!.checked).toBe(false);
  });

  it('warns, naming the tool, when a load-bearing field is dropped', async () => {
    // Dropping is_miss doesn't error — LAD and the Hit/Miss scheme just quietly
    // stop working — so the wizard has to say so. It must NOT block: an all-zero
    // is_miss on a hits-only export is exactly the dead weight worth dropping.
    const onComplete = await open([
      col({ index: 0, header_name: 'x', detected_role: 'x' }),
      col({ index: 1, header_name: 'y', detected_role: 'y' }),
      col({ index: 2, header_name: 'z', detected_role: 'z' }),
      col({ index: 3, header_name: 'is_miss', detected_role: 'is_miss' }),
    ]);
    expect(screen.queryByTestId('import-wizard-drop-warning')).toBeNull();

    fireEvent.click(includeBox(3)!);
    const warning = screen.getByTestId('import-wizard-drop-warning');
    expect(warning.textContent).toMatch(/leaf-area density/i);
    // Still importable.
    expect((screen.getByTestId('import-wizard-import') as HTMLButtonElement).disabled).toBe(false);
    submit();
    expect(onComplete).toHaveBeenCalled();
  });

  it('does not warn for an ordinary scalar', async () => {
    await open(ASCII_COLUMNS);
    fireEvent.click(includeBox(4)!);
    expect(screen.queryByTestId('import-wizard-drop-warning')).toBeNull();
  });

  it('excludes an unticked Label column from categoricalSlugs', async () => {
    // A dropped column never reaches the cloud, so registering a categorical
    // colour scheme for its slug would be dead state.
    const onComplete = await open([
      col({ index: 0, header_name: 'x', detected_role: 'x' }),
      col({ index: 1, header_name: 'y', detected_role: 'y' }),
      col({ index: 2, header_name: 'z', detected_role: 'z' }),
      col({ index: 3, header_name: 'tree_id', suggested_slug: 'tree_id', type_hint: 'categorical' }),
    ]);
    const cell = document.querySelector('[data-testid="import-wizard-column"][data-col-index="3"]')!;
    const select = cell.querySelector('[data-testid="import-wizard-role"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'label' } });
    submit();
    expect((onComplete.mock.calls[0][0][0] as WizardResult).categoricalSlugs).toEqual(['tree_id']);

    cleanup();
    const onComplete2 = await open([
      col({ index: 0, header_name: 'x', detected_role: 'x' }),
      col({ index: 1, header_name: 'y', detected_role: 'y' }),
      col({ index: 2, header_name: 'z', detected_role: 'z' }),
      col({ index: 3, header_name: 'tree_id', suggested_slug: 'tree_id', type_hint: 'categorical' }),
    ]);
    const cell2 = document.querySelector('[data-testid="import-wizard-column"][data-col-index="3"]')!;
    fireEvent.change(cell2.querySelector('[data-testid="import-wizard-role"]') as HTMLSelectElement,
      { target: { value: 'label' } });
    fireEvent.click(includeBox(3)!);   // now drop it
    submit();
    expect((onComplete2.mock.calls[0][0][0] as WizardResult).categoricalSlugs).toEqual([]);
  });
});

// An in-file layout whose scalars may be ROLE-REASSIGNED (LAS/LAZ extra dims,
// .riproject scalars). The layout is still the file's — geometry stays locked —
// but a column's MEANING is not, because an ExtraBytes name is an arbitrary
// vendor string. `shot_time` is the case that motivated this: auto-detection
// cannot know it is the timestamp, and before this the user had no way to say
// so, leaving Backfill Misses and LAD refusing the scan.
const ASSIGNABLE_COLUMNS = [
  col({ index: 0, header_name: 'X', detected_role: 'x', remappable: false }),
  col({ index: 1, header_name: 'Y', detected_role: 'y', remappable: false }),
  col({ index: 2, header_name: 'Z', detected_role: 'z', remappable: false }),
  col({ index: 3, header_name: 'shot_time', detected_role: 'extra', remappable: false,
        role_assignable: true, suggested_slug: 'shot_time', suggested_label: 'shot_time' }),
  col({ index: 4, header_name: 'Amplitude', detected_role: 'extra', remappable: false,
        role_assignable: true, suggested_slug: 'Amplitude', suggested_label: 'Amplitude' }),
];

/** The role <select> inside the cell for source column `index`. */
function roleSelect(index: number): HTMLSelectElement | null {
  const cell = document.querySelector(`[data-testid="import-wizard-column"][data-col-index="${index}"]`);
  return cell?.querySelector('[data-testid="import-wizard-role"]') as HTMLSelectElement ?? null;
}

describe('PointCloudImportWizard — role assignment on fixed-layout formats', () => {
  it('offers the full role list for an assignable scalar, minus geometry', async () => {
    await open(ASSIGNABLE_COLUMNS, 'las');
    const sel = roleSelect(3)!;
    const values = [...sel.options].map((o) => o.value);

    // The point of the feature: the canonical roles are reachable.
    expect(values).toContain('timestamp');
    expect(values).toContain('target_index');
    expect(values).toContain('is_miss');
    expect(values).toContain('reflectance');
    // Still offered as a plain scalar / droppable.
    expect(values).toContain('extra');
    expect(values).toContain('label');
    // Geometry is genuinely fixed by the reader — reassigning it would only
    // produce a broken import.
    expect(values).not.toContain('x');
    expect(values).not.toContain('y');
    expect(values).not.toContain('z');
    expect(sel.disabled).toBe(false);
  });

  it('keeps geometry columns locked', async () => {
    await open(ASSIGNABLE_COLUMNS, 'las');
    // X/Y/Z are not role_assignable, so the select stays disabled.
    expect(roleSelect(0)!.disabled).toBe(true);
  });

  it('sends only the column the user actually changed', async () => {
    const onComplete = await open(ASSIGNABLE_COLUMNS, 'las');
    fireEvent.change(roleSelect(3)!, { target: { value: 'timestamp' } });
    submit();

    const result: WizardResult = onComplete.mock.calls[0][0][0];
    expect(result.roleOverrides).toEqual({ shot_time: 'timestamp' });
    // Amplitude was left alone: pinning an untouched column would freeze it
    // against any future improvement to auto-detection.
    expect(result.roleOverrides).not.toHaveProperty('Amplitude');
  });

  it('sends nothing for a no-edit import', async () => {
    const onComplete = await open(ASSIGNABLE_COLUMNS, 'las');
    submit();
    const result: WizardResult = onComplete.mock.calls[0][0][0];
    expect(result.roleOverrides).toEqual({});
  });

  it('does not pin a column the backend ALREADY auto-detected', async () => {
    // The load-bearing case for the untouched-column guard, and the one the
    // all-'extra' fixture above cannot catch: this column arrives with a real
    // canonical role. Echoing it back as an override would freeze today's
    // detection into the request, so a later improvement to auto-detection
    // (a new alias, a fixed misread) would be silently overridden by a choice
    // the user never made.
    const cols = [
      col({ index: 0, header_name: 'X', detected_role: 'x', remappable: false }),
      col({ index: 1, header_name: 'Y', detected_role: 'y', remappable: false }),
      col({ index: 2, header_name: 'Z', detected_role: 'z', remappable: false }),
      col({ index: 3, header_name: 'gps_time', detected_role: 'timestamp',
            remappable: false, role_assignable: true,
            suggested_slug: 'gps_time', suggested_label: 'gps_time' }),
    ];
    const onComplete = await open(cols, 'las');
    submit();
    const result: WizardResult = onComplete.mock.calls[0][0][0];
    expect(result.roleOverrides).toEqual({});
  });

  it('sends the override when the user CHANGES an auto-detected role', async () => {
    // The complement: the same column, actually reassigned, must be sent.
    const cols = [
      col({ index: 0, header_name: 'X', detected_role: 'x', remappable: false }),
      col({ index: 1, header_name: 'Y', detected_role: 'y', remappable: false }),
      col({ index: 2, header_name: 'Z', detected_role: 'z', remappable: false }),
      col({ index: 3, header_name: 'gps_time', detected_role: 'timestamp',
            remappable: false, role_assignable: true,
            suggested_slug: 'gps_time', suggested_label: 'gps_time' }),
      col({ index: 4, header_name: 'other', detected_role: 'extra',
            remappable: false, role_assignable: true,
            suggested_slug: 'other', suggested_label: 'other' }),
    ];
    const onComplete = await open(cols, 'las');
    fireEvent.change(roleSelect(4)!, { target: { value: 'timestamp' } });
    submit();
    const result: WizardResult = onComplete.mock.calls[0][0][0];
    expect(result.roleOverrides).toEqual({ other: 'timestamp' });
  });

  it('does not send extra/label as an override', async () => {
    // They are not canonical roles — they only pick gradient vs discrete
    // colouring, which the rename box already expresses.
    const onComplete = await open(ASSIGNABLE_COLUMNS, 'las');
    fireEvent.change(roleSelect(4)!, { target: { value: 'label' } });
    submit();
    const result: WizardResult = onComplete.mock.calls[0][0][0];
    expect(result.roleOverrides).toEqual({});
  });

  it('a dropped column travels in droppedSlugs, not as an override', async () => {
    const onComplete = await open(ASSIGNABLE_COLUMNS, 'las');
    fireEvent.change(roleSelect(3)!, { target: { value: 'timestamp' } });
    fireEvent.click(includeBox(3)!);   // then untick it
    submit();

    const result: WizardResult = onComplete.mock.calls[0][0][0];
    expect(result.roleOverrides).toEqual({});
    expect(result.droppedSlugs.length).toBeGreaterThan(0);
  });

  it('still restricts a NON-assignable in-file scalar to Scalar/Label', async () => {
    // The pre-existing behaviour for formats we have not opened up (PLY/PCD).
    await open(LAS_COLUMNS, 'las');
    const values = [...roleSelect(3)!.options].map((o) => o.value);
    expect(values.sort()).toEqual(['extra', 'label']);
  });
});
