import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SelectAllHeader } from './SelectAllHeader';
import { ObjectPicker } from './ObjectPicker';

afterEach(cleanup);

function renderHeader(selectedCount: number, totalCount = 3) {
  const onSelectAll = vi.fn();
  const onDeselectAll = vi.fn();
  render(
    <SelectAllHeader
      data-testid="hdr"
      label="Scans"
      selectedCount={selectedCount}
      totalCount={totalCount}
      onSelectAll={onSelectAll}
      onDeselectAll={onDeselectAll}
    />,
  );
  return {
    box: screen.getByTestId<HTMLInputElement>('hdr'),
    onSelectAll,
    onDeselectAll,
  };
}

describe('SelectAllHeader', () => {
  // The whole point of replacing the old "All | None" text pair: the control
  // reports the current state, not just two actions.
  it('is unchecked with nothing selected', () => {
    const { box } = renderHeader(0);
    expect(box.checked).toBe(false);
    expect(box.indeterminate).toBe(false);
  });

  it('is indeterminate on a partial selection', () => {
    const { box } = renderHeader(2, 3);
    expect(box.checked).toBe(false);
    expect(box.indeterminate).toBe(true);
  });

  it('is checked when everything is selected', () => {
    const { box } = renderHeader(3, 3);
    expect(box.checked).toBe(true);
    expect(box.indeterminate).toBe(false);
  });

  it('selects all from empty and from partial, and clears when full', async () => {
    const user = userEvent.setup();

    const empty = renderHeader(0);
    await user.click(empty.box);
    expect(empty.onSelectAll).toHaveBeenCalledTimes(1);
    expect(empty.onDeselectAll).not.toHaveBeenCalled();
    cleanup();

    // Partial must select the rest, NOT clear — the indeterminate box is the
    // one a user clicks expecting "give me everything".
    const partial = renderHeader(1, 3);
    await user.click(partial.box);
    expect(partial.onSelectAll).toHaveBeenCalledTimes(1);
    expect(partial.onDeselectAll).not.toHaveBeenCalled();
    cleanup();

    const full = renderHeader(3, 3);
    await user.click(full.box);
    expect(full.onDeselectAll).toHaveBeenCalledTimes(1);
    expect(full.onSelectAll).not.toHaveBeenCalled();
  });

  it('names the action it will take, in both directions', () => {
    expect(renderHeader(0).box.getAttribute('aria-label')).toBe('Select all');
    cleanup();
    expect(renderHeader(3, 3).box.getAttribute('aria-label')).toBe('Deselect all');
  });

  it('disables itself when there is nothing to select', () => {
    expect(renderHeader(0, 0).box.disabled).toBe(true);
  });

  it('lets a visibility list rename the action and the count', () => {
    render(
      <SelectAllHeader
        data-testid="vis"
        label="Cells"
        countNoun="visible"
        actionLabels={{ check: 'Show all', uncheck: 'Hide all' }}
        selectedCount={2}
        totalCount={5}
        onSelectAll={vi.fn()}
        onDeselectAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId<HTMLInputElement>('vis').getAttribute('aria-label')).toBe('Show all');
    expect(screen.getByText('(2/5 visible)')).toBeTruthy();
  });
});

describe('ObjectPicker select-all', () => {
  const ITEMS = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C', disabledReason: 'no point data' },
  ];

  it('offers the master checkbox by default, with no All/None links', () => {
    render(
      <ObjectPicker data-testid="pick" items={ITEMS} selectedIds={new Set()} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('pick-select-all')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'None' })).toBeNull();
  });

  it('sweeps in only the selectable rows', async () => {
    const onChange = vi.fn();
    render(
      <ObjectPicker data-testid="pick" items={ITEMS} selectedIds={new Set()} onChange={onChange} />,
    );
    await userEvent.click(screen.getByTestId('pick-select-all'));
    // 'c' is disabled — including it would produce a selection the submit
    // silently drops again.
    expect(onChange).toHaveBeenCalledWith(new Set(['a', 'b']));
  });

  it('reads as checked once every selectable row is on, ignoring disabled ones', () => {
    render(
      <ObjectPicker
        data-testid="pick"
        items={ITEMS}
        selectedIds={new Set(['a', 'b'])}
        onChange={vi.fn()}
      />,
    );
    const box = screen.getByTestId<HTMLInputElement>('pick-select-all');
    expect(box.checked).toBe(true);
    expect(box.indeterminate).toBe(false);
  });

  it('shows no master checkbox in single-select mode', () => {
    render(
      <ObjectPicker
        data-testid="pick"
        mode="single"
        items={ITEMS}
        selectedIds={new Set(['a'])}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('pick-select-all')).toBeNull();
  });
});
