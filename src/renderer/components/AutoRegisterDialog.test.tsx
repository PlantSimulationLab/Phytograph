// The dialog's job in a multi-scan world: let the user pick a whole SET, and be
// honest about what that buys. Two scans cannot validate each other — on a
// repetitive planting a wrong alignment fits better than the right one — so the
// difference between two and three is a real capability difference, not a
// preference.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AutoRegisterDialog } from './AutoRegisterDialog';

const CLOUDS = [
  { id: 'a', label: 'ScanPos001' },
  { id: 'b', label: 'ScanPos002' },
  { id: 'c', label: 'ScanPos003' },
];

function open(selected: string[], onRegister = vi.fn()) {
  render(
    <AutoRegisterDialog
      isOpen
      onClose={() => {}}
      clouds={CLOUDS}
      initialSelectedIds={new Set(selected)}
      onRegister={onRegister}
    />,
  );
  return onRegister;
}

describe('AutoRegisterDialog', () => {
  it('seeds every selected cloud, not just the first two', () => {
    // A user who selected four clouds means to register four. Dropping the
    // extras would silently downgrade them to an unvalidatable pair.
    const onRegister = open(['a', 'b', 'c']);
    fireEvent.click(screen.getByTestId('auto-register-run'));
    expect(onRegister).toHaveBeenCalledTimes(1);
    const [targetId, sourceIds] = onRegister.mock.calls[0];
    expect(targetId).toBe('a');
    expect([...sourceIds].sort()).toEqual(['b', 'c']);
  });

  it('says the set is cross-checked once three scans are chosen', () => {
    open(['a', 'b', 'c']);
    expect(screen.getByTestId('auto-register-validation-note').textContent)
      .toMatch(/cross-checked/i);
  });

  it('warns that two scans cannot be cross-checked', () => {
    // The honest statement of a real limitation: with no loop, a wrong
    // alignment is undetectable from the geometry alone.
    open(['a', 'b']);
    const note = screen.getByTestId('auto-register-validation-note').textContent ?? '';
    expect(note).toMatch(/nothing to cross-check/i);
    expect(note).toMatch(/third/i);
  });

  it('cannot run without at least one scan to move', () => {
    open(['a']);
    expect((screen.getByTestId('auto-register-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('never lets the reference also be one of the moving scans', () => {
    // Re-pointing the reference at a cloud already queued to move must drop it
    // from the movers -- registering a scan onto itself is meaningless, and
    // silently sending it would make the backend reference index wrong.
    const onRegister = open(['a', 'b', 'c']);
    fireEvent.click(
      screen.getByTestId('auto-register-target-picker')
        .querySelectorAll('[data-testid="picker-row"]')[1]);
    fireEvent.click(screen.getByTestId('auto-register-run'));
    expect(onRegister).toHaveBeenCalledTimes(1);
    const [targetId, sourceIds] = onRegister.mock.calls[0];
    expect(targetId).toBe('b');
    expect(sourceIds).not.toContain('b');
  });
});
