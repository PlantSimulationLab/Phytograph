import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StitchDialog, type StitchCloudOption } from './StitchDialog';

afterEach(cleanup);

// The origin warning is the guard for the issue-#3 follow-up: stitching discards
// scanner origins, so a merged cloud can't run origin-dependent analyses (Backfill
// Misses overlay, Helios triangulation, LAD). The dialog must warn — but ONLY when
// a SELECTED cloud actually carries an origin (nothing is lost when merging plain
// clouds that never had one).

const CLOUDS: StitchCloudOption[] = [
  { id: 'a', label: 'scan_a', pointCount: 100, hasOrigin: true },
  { id: 'b', label: 'scan_b', pointCount: 200, hasOrigin: true },
  { id: 'c', label: 'plain_c', pointCount: 300, hasOrigin: false },
];

function open(props: Partial<React.ComponentProps<typeof StitchDialog>> = {}) {
  const onStitch = vi.fn();
  const onClose = vi.fn();
  render(
    <StitchDialog
      isOpen
      onClose={onClose}
      clouds={CLOUDS}
      initialSelectedIds={props.initialSelectedIds}
      onStitch={onStitch}
      {...props}
    />,
  );
  return { onStitch, onClose };
}

const warning = () => screen.queryByTestId('stitch-origin-warning');
const runButton = () => screen.getByTestId('stitch-run') as HTMLButtonElement;

describe('StitchDialog origin warning', () => {
  it('shows no warning until an origin-bearing cloud is selected', () => {
    open();
    // Nothing selected → no warning, button reads "Stitch" and is disabled (<2).
    expect(warning()).toBeNull();
    expect(runButton().textContent).toContain('Stitch');
    expect(runButton().textContent).not.toContain('anyway');
    expect(runButton().disabled).toBe(true);
  });

  it('warns and relabels the button when selected clouds carry origins', () => {
    open({ initialSelectedIds: new Set(['a', 'b']) });
    const w = warning();
    expect(w).not.toBeNull();
    // Plural copy + the three named origin-dependent analyses.
    expect(w!.textContent).toContain('2 selected clouds have scanner origins');
    expect(w!.textContent).toContain('Backfill Misses');
    expect(w!.textContent).toContain('Helios triangulation');
    expect(w!.textContent).toContain('Leaf Area Density');
    // The action makes the discard explicit.
    expect(runButton().textContent).toBe('Stitch anyway');
    expect(runButton().disabled).toBe(false);
  });

  it('uses singular copy when exactly one selected cloud has an origin', () => {
    // a (origin) + c (no origin) → exactly one origin lost.
    open({ initialSelectedIds: new Set(['a', 'c']) });
    expect(warning()!.textContent).toContain('One selected cloud has a scanner origin');
    expect(runButton().textContent).toBe('Stitch anyway');
  });

  it('does NOT warn when merging only origin-less clouds', () => {
    open({
      clouds: [
        { id: 'x', label: 'plain_x', hasOrigin: false },
        { id: 'y', label: 'plain_y', hasOrigin: false },
      ],
      initialSelectedIds: new Set(['x', 'y']),
    });
    expect(warning()).toBeNull();
    expect(runButton().textContent).toBe('Stitch');
    expect(runButton().disabled).toBe(false);
  });

  it('still runs the stitch when the user confirms past the warning', () => {
    const { onStitch, onClose } = open({ initialSelectedIds: new Set(['a', 'b']) });
    fireEvent.click(runButton());
    expect(onStitch).toHaveBeenCalledWith(['a', 'b']);
    expect(onClose).toHaveBeenCalled();
  });
});
