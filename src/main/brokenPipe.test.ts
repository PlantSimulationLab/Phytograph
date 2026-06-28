import { describe, it, expect } from 'vitest';
import { isBrokenPipe, pipeErrCode } from './brokenPipe';

describe('pipeErrCode', () => {
  it('returns the string code of a Node syscall error', () => {
    const err = Object.assign(new Error('write EIO'), { code: 'EIO' });
    expect(pipeErrCode(err)).toBe('EIO');
  });

  it('returns undefined when there is no code', () => {
    expect(pipeErrCode(new Error('plain'))).toBeUndefined();
  });

  it('returns undefined for a non-string code (e.g. numeric errno)', () => {
    expect(pipeErrCode({ code: 13 })).toBeUndefined();
  });

  it('does not throw on null/undefined/primitive errors', () => {
    expect(pipeErrCode(null)).toBeUndefined();
    expect(pipeErrCode(undefined)).toBeUndefined();
    expect(pipeErrCode('EIO')).toBeUndefined(); // a bare string has no .code
  });
});

describe('isBrokenPipe', () => {
  it('is true for EIO — the dead-terminal case that caused the crash loop', () => {
    expect(isBrokenPipe(Object.assign(new Error('write EIO'), { code: 'EIO' }))).toBe(true);
  });

  it('is true for EPIPE — the closed-reader case', () => {
    expect(isBrokenPipe(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
  });

  it('is false for an unrelated syscall error (must stay fatal)', () => {
    expect(isBrokenPipe(Object.assign(new Error('no space'), { code: 'ENOSPC' }))).toBe(false);
  });

  it('is false for a generic application error (must stay fatal)', () => {
    expect(isBrokenPipe(new TypeError('cannot read property of undefined'))).toBe(false);
  });

  it('is false for null/undefined', () => {
    expect(isBrokenPipe(null)).toBe(false);
    expect(isBrokenPipe(undefined)).toBe(false);
  });
});
