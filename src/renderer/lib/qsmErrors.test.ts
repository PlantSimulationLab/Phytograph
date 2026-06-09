import { describe, it, expect } from 'vitest';
import { prettifyQSMError } from './qsmErrors';

describe('prettifyQSMError', () => {
  it('rewrites a stale-session 404 into a re-import remedy', () => {
    // The exact shape the backend/fetch layer produces when a session is gone.
    const raw = '404: Cloud session not found: 524e925e';
    const out = prettifyQSMError(raw);
    expect(out).toMatch(/backend restarted/i);
    expect(out).toMatch(/re-import/i);
    // The opaque session id is not surfaced to the user.
    expect(out).not.toContain('524e925e');
  });

  it('matches the message case-insensitively and without the 404 prefix', () => {
    expect(prettifyQSMError('Cloud Session Not Found: abc')).toMatch(/re-import/i);
  });

  it('passes through unrelated errors unchanged', () => {
    expect(prettifyQSMError('Need at least 50 points to build a QSM')).toBe(
      'Need at least 50 points to build a QSM',
    );
    expect(prettifyQSMError('Skeleton extraction produced no nodes')).toBe(
      'Skeleton extraction produced no nodes',
    );
  });
});
