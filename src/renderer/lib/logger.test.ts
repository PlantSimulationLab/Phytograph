// Covers the console-forwarding formatter. The bug this guards against: React
// logs errors as ('%s\n\n%s', message, componentStack), and forwarding the raw
// args recorded a literal "%s" while discarding the message and component stack
// — the only two useful parts of a renderer bug report.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installConsoleForwarding } from './logger';

const write = vi.fn();

beforeEach(() => {
  write.mockClear();
  (window as unknown as { electronAPI?: unknown }).electronAPI = {
    logs: { write },
  };
  // installConsoleForwarding is idempotent by design (module-level `installed`
  // latch), so patch once here and read what it forwards.
  installConsoleForwarding();
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/** The single forwarded string for the most recent console call. */
function lastForwarded(): string {
  expect(write).toHaveBeenCalled();
  return write.mock.calls.at(-1)![1] as string;
}

describe('console forwarding', () => {
  it('substitutes React\'s ("%s\\n\\n%s", message, componentStack) form', () => {
    console.error(
      '%s\n\n%s',
      'Cannot read properties of null',
      '    in div\n    in App',
    );
    const out = lastForwarded();
    expect(out).toContain('Cannot read properties of null');
    expect(out).toContain('in div');
    expect(out).not.toContain('%s');
  });

  it('forwards warn as well as error, at the right level', () => {
    console.warn('%s failed', 'triangulate');
    expect(write).toHaveBeenLastCalledWith('warn', 'triangulate failed');
  });

  it('formats numeric specifiers', () => {
    console.error('%d points, %f m, %i idx', 1234.7, 0.25, 9.9);
    expect(lastForwarded()).toBe('1234 points, 0.25 m, 9 idx');
  });

  it('treats %% as a literal percent and drops %c styling', () => {
    console.error('%cload %d%% done', 'color:red', 50);
    expect(lastForwarded()).toBe('load 50% done');
  });

  it('appends surplus args and keeps unmatched specifiers literal', () => {
    console.error('%s', 'first', 'second');
    expect(lastForwarded()).toBe('first second');

    console.error('%s and %s', 'only');
    expect(lastForwarded()).toBe('only and %s');
  });

  it('serializes Errors with their stack', () => {
    const err = new Error('boom');
    console.error('failed:', err);
    const out = lastForwarded();
    expect(out).toContain('failed:');
    expect(out).toContain('Error: boom');
  });

  it('falls back to plain joining when there is no format string', () => {
    console.error('plain', { a: 1 }, 42);
    expect(lastForwarded()).toBe('plain {"a":1} 42');
  });

  it('never throws when the IPC bridge is missing', () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    expect(() => console.error('%s', 'no bridge')).not.toThrow();
  });
});
