import { describe, expect, it, vi } from 'vitest';
import { createProgressChannel } from './progressChannel';

describe('createProgressChannel', () => {
  it('publishes each new value to every subscriber', () => {
    const ch = createProgressChannel();
    const a = vi.fn();
    const b = vi.fn();
    ch.subscribe(a);
    ch.subscribe(b);
    ch.set({ label: 'Ray-tracing', value: 0.2 });
    expect(ch.get()).toEqual({ label: 'Ray-tracing', value: 0.2 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a value equal to the current one', () => {
    // The scan creep keeps setting the same converged value at 25 Hz; each
    // notification is a pill re-render.
    const ch = createProgressChannel();
    const l = vi.fn();
    ch.subscribe(l);
    ch.set({ label: 'x', value: 0.5 });
    ch.set({ label: 'x', value: 0.5 });
    ch.set(null);
    ch.set(null);
    expect(l).toHaveBeenCalledTimes(2);
    expect(ch.get()).toBeNull();
  });

  it('stops notifying after unsubscribe', () => {
    const ch = createProgressChannel();
    const l = vi.fn();
    const off = ch.subscribe(l);
    off();
    ch.set({ label: 'x', value: 0.1 });
    expect(l).not.toHaveBeenCalled();
  });
});
