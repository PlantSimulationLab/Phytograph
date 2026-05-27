import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DebouncedNumberInput } from './DebouncedNumberInput';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('DebouncedNumberInput', () => {
  it('does not fire onCommit on every keystroke', () => {
    const onCommit = vi.fn();
    render(<DebouncedNumberInput value={1} onCommit={onCommit} data-testid="n" />);
    const input = screen.getByTestId('n') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.change(input, { target: { value: '23' } });
    fireEvent.change(input, { target: { value: '234' } });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('fires onCommit once after the debounce window elapses', () => {
    const onCommit = vi.fn();
    render(<DebouncedNumberInput value={1} onCommit={onCommit} debounceMs={400} data-testid="n" />);
    const input = screen.getByTestId('n') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(5);
  });

  it('fires onCommit immediately on Enter', () => {
    const onCommit = vi.fn();
    render(<DebouncedNumberInput value={1} onCommit={onCommit} data-testid="n" />);
    const input = screen.getByTestId('n') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(7);
  });

  it('fires onCommit on blur', () => {
    const onCommit = vi.fn();
    render(<DebouncedNumberInput value={1} onCommit={onCommit} data-testid="n" />);
    const input = screen.getByTestId('n') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.blur(input, { target: { value: '9' } });
    expect(onCommit).toHaveBeenCalledWith(9);
  });

  it('does not fire onCommit if the parsed value is unchanged', () => {
    const onCommit = vi.fn();
    render(<DebouncedNumberInput value={5} onCommit={onCommit} data-testid="n" />);
    const input = screen.getByTestId('n') as HTMLInputElement;
    // User retypes the same number — no commit should fire.
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('clamps the committed value to min/max bounds', () => {
    const onCommit = vi.fn();
    render(<DebouncedNumberInput value={0.5} min={0} max={1} onCommit={onCommit} data-testid="n" />);
    const input = screen.getByTestId('n') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(1);
  });

  it('ignores non-numeric input (no commit)', () => {
    const onCommit = vi.fn();
    render(<DebouncedNumberInput value={1} onCommit={onCommit} data-testid="n" />);
    const input = screen.getByTestId('n') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('discards the draft on Escape and restores the committed value', () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <DebouncedNumberInput value={1} onCommit={onCommit} data-testid="n" />,
    );
    const input = screen.getByTestId('n') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
    // Re-render with same value; draft should be back to "1".
    rerender(<DebouncedNumberInput value={1} onCommit={onCommit} data-testid="n" />);
    expect(input.value).toBe('1');
  });

  it("does not overwrite the user's draft while the input is focused", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <DebouncedNumberInput value={1} onCommit={onCommit} data-testid="n" />,
    );
    const input = screen.getByTestId('n') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '1.' } });
    // Parent re-renders with the same value while user is mid-type — must not
    // wipe the trailing dot.
    rerender(<DebouncedNumberInput value={1} onCommit={onCommit} data-testid="n" />);
    expect(input.value).toBe('1.');
    // Once blurred, the draft re-syncs to the parent value on next render.
    fireEvent.blur(input, { target: { value: '1.' } });
    // '1.' parses to 1 which equals current value, so no commit. Now next
    // re-render should show committed value.
    rerender(<DebouncedNumberInput value={1} onCommit={onCommit} data-testid="n" />);
    expect(input.value).toBe('1');
  });

  it('passes integer parser through and commits whole numbers only', () => {
    const onCommit = vi.fn();
    render(
      <DebouncedNumberInput
        value={2}
        parse={(s) => parseInt(s, 10)}
        onCommit={onCommit}
        data-testid="n"
      />,
    );
    const input = screen.getByTestId('n') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '7.9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(7);
  });

  it('uses the format prop when displaying values from the parent', () => {
    const onCommit = vi.fn();
    render(
      <DebouncedNumberInput
        value={3.14159}
        format={(n) => n.toFixed(2)}
        onCommit={onCommit}
        data-testid="n"
      />,
    );
    const input = screen.getByTestId('n') as HTMLInputElement;
    expect(input.value).toBe('3.14');
  });
});
