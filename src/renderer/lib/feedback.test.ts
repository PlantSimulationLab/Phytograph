import { describe, it, expect } from 'vitest';
import {
  type Diagnostics,
  diagnosticsSummary,
  buildIssueBody,
  buildGithubUrl,
  buildMailtoUrl,
} from './feedback';
import { REPO_URL } from '../../shared/constants';

const DIAG: Diagnostics = {
  appVersion: '0.13.1',
  backendVersion: '0.13.1',
  pyheliosVersion: 'v0.1.22',
  heliosVersion: 'v1.3.74',
  platform: 'darwin',
};

describe('diagnosticsSummary', () => {
  it('renders a one-line version/backend/engine/OS summary', () => {
    expect(diagnosticsSummary(DIAG)).toBe(
      'Phytograph 0.13.1 · backend 0.13.1 · PyHelios v0.1.22 · Helios v1.3.74 · darwin',
    );
  });
});

describe('buildIssueBody', () => {
  it('includes the description and the environment block for a bug', () => {
    const body = buildIssueBody('bug', 'It crashed on import.', DIAG);
    expect(body).toContain('## Bug description');
    expect(body).toContain('It crashed on import.');
    expect(body).toContain('- Phytograph: 0.13.1');
    expect(body).toContain('- Backend: 0.13.1');
    expect(body).toContain('- PyHelios: v0.1.22');
    expect(body).toContain('- Helios (C++): v1.3.74');
    expect(body).toContain('- OS: darwin');
  });

  it('uses a feature heading for feature mode', () => {
    const body = buildIssueBody('feature', 'Add dark mode.', DIAG);
    expect(body).toContain('## Feature request');
    expect(body).toContain('Add dark mode.');
  });

  it('substitutes a placeholder when the description is empty', () => {
    const body = buildIssueBody('bug', '   ', DIAG);
    expect(body).toContain('_(no description provided)_');
  });

  it('omits the session-logs block when no log file name is given', () => {
    const body = buildIssueBody('bug', 'desc', DIAG);
    expect(body).not.toContain('## Session logs');
  });

  it('names the attached log file when one is provided', () => {
    const body = buildIssueBody('bug', 'desc', DIAG, 'phytograph-logs-2026-06-12T10-00-00.txt');
    expect(body).toContain('## Session logs');
    expect(body).toContain('`phytograph-logs-2026-06-12T10-00-00.txt`');
    expect(body).toContain('drag');
  });
});

describe('buildGithubUrl', () => {
  it('builds a new-issue URL with title, body, labels and template params', () => {
    const body = buildIssueBody('bug', 'desc', DIAG);
    const url = buildGithubUrl('bug', 'Crash on import', body);
    expect(url.startsWith(`${REPO_URL}/issues/new?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('title')).toBe('Crash on import');
    expect(params.get('labels')).toBe('bug');
    expect(params.get('template')).toBe('bug.yml');
    expect(params.get('body')).toContain('- OS: darwin');
  });

  it('uses enhancement label and feature template for feature mode', () => {
    const url = buildGithubUrl('feature', 'Dark mode', 'body');
    const params = new URL(url).searchParams;
    expect(params.get('labels')).toBe('enhancement');
    expect(params.get('template')).toBe('feature.yml');
  });

  it('trims the title', () => {
    const url = buildGithubUrl('bug', '  spaced  ', 'body');
    expect(new URL(url).searchParams.get('title')).toBe('spaced');
  });
});

describe('buildMailtoUrl', () => {
  it('builds a mailto: URL with an encoded subject and body', () => {
    const body = buildIssueBody('bug', 'desc', DIAG);
    const url = buildMailtoUrl('bug', 'Crash & burn', body, 'team@example.com');
    expect(url.startsWith('mailto:team@example.com?')).toBe(true);
    // Subject is percent-encoded (RFC 6068 — no '+' for spaces).
    expect(url).toContain(encodeURIComponent('[Phytograph Bug] Crash & burn'));
    expect(url).toContain('&body=');
    expect(url).toContain(encodeURIComponent('- OS: darwin'));
    expect(url).not.toContain(' '); // no raw spaces
  });

  it('tags the subject as a feature request for feature mode', () => {
    const url = buildMailtoUrl('feature', 'Dark mode', 'body', 'team@example.com');
    expect(url).toContain(encodeURIComponent('[Phytograph Feature request] Dark mode'));
  });
});
