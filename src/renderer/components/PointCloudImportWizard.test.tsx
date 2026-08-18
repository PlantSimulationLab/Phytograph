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
