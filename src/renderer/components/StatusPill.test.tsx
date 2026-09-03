// Two long operations at once must read as two pills, not one covering the other.
//
// Every pill used to position itself at `absolute top-3 left-1/2`, which is only
// correct while exactly one is up. Overlap is ordinary now — an applied crop
// hands its octree rebuild to a background queue and moves straight on to the
// next scan, so the rebuild's pill and the crop's pill are live together by
// design — and users read two pills on the same pixels as the indicator
// flickering between messages, or as "multiple progress pills".
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusPill, { StatusPillHost } from './StatusPill';

describe('StatusPill inside a host', () => {
  it('puts concurrent pills in ONE column, in mount order', () => {
    render(
      <StatusPillHost>
        <StatusPill testId="a" label="Cropping tiny.xyz (2 of 4)…" progress={0.5} />
        <StatusPill testId="b" label="Updating display…" progress={null} />
      </StatusPillHost>,
    );
    const stack = screen.getByTestId('status-pill-stack');
    const a = screen.getByTestId('a');
    const b = screen.getByTestId('b');
    expect(stack.contains(a), 'pill did not portal into the stack').toBe(true);
    expect(stack.contains(b)).toBe(true);
    expect(Array.from(stack.children)).toEqual([a, b]);
    // The column positions them; a pill that still positioned itself would sit
    // on top of its neighbour again.
    for (const pill of [a, b]) {
      expect(pill.className).not.toMatch(/\babsolute\b/);
      expect(pill.className).toMatch(/pointer-events-auto/);
    }
  });

  it('renders the bar only for a finite fraction, clamped to 0..100%', () => {
    render(
      <StatusPillHost>
        <StatusPill testId="determinate" label="Cropping…" progress={0.42} />
        <StatusPill testId="indeterminate" label="Updating display…" progress={null} />
        {/* The old inline mapping could push a fraction past 1 on the last scan. */}
        <StatusPill testId="over" label="Cropping…" progress={1.25} />
      </StatusPillHost>,
    );
    expect(screen.getByTestId('determinate').textContent).toContain('42%');
    expect(screen.getByTestId('indeterminate').textContent).not.toContain('%');
    expect(screen.getByTestId('over').textContent).toContain('100%');
  });

  it('offers a cancel button only when the caller supplies one', () => {
    render(
      <StatusPillHost>
        <StatusPill testId="cancellable" label="Cropping…" onCancel={() => {}} />
        <StatusPill testId="plain" label="Updating display…" />
      </StatusPillHost>,
    );
    expect(screen.queryByTestId('cancellable-cancel')).not.toBeNull();
    expect(screen.queryByTestId('plain-cancel')).toBeNull();
  });
});

describe('StatusPill with no host', () => {
  it('falls back to positioning itself, so a pill outside the viewer still shows', () => {
    render(<StatusPill testId="lonely" label="Downloading update…" progress={0.1} />);
    const pill = screen.getByTestId('lonely');
    expect(pill.className).toMatch(/\babsolute\b/);
    expect(pill.className).toMatch(/top-3/);
  });
});
