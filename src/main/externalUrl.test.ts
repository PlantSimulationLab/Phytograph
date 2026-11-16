import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from './externalUrl';

describe('isAllowedExternalUrl', () => {
  it.each([
    'https://github.com/PlantSimulationLab/Phytograph/issues/new?title=x',
    'mailto:someone@example.org?subject=Feedback',
  ])('allows %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it.each([
    'file:///Applications/Calculator.app',
    'file:///C:/Windows/System32/calc.exe',
    'http://example.org',
    'javascript:alert(1)',
    'smb://host/share',
    'vscode://file/etc/passwd',
    'not a url',
    '',
  ])('refuses %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });

  it('refuses a non-string', () => {
    expect(isAllowedExternalUrl({ toString: () => 'https://x' })).toBe(false);
    expect(isAllowedExternalUrl(undefined)).toBe(false);
  });
});
