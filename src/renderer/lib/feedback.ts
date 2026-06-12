// Pure helpers for the in-app feedback dialog (FeedbackDialog.tsx). Kept
// separate from the component so they're unit-testable. Two send paths:
//   - GitHub: open a pre-filled "new issue" URL (GitHub handles sign-in).
//   - Email:  open a mailto: link to FEEDBACK_EMAIL (no account needed).
// Both paths embed the same diagnostics block so reports arrive with the app
// version, backend version, and OS already attached.
import { REPO_URL } from '../../shared/constants';

export type FeedbackMode = 'bug' | 'feature';

/** Diagnostics auto-attached to every report. Sourced from backend.getInfo(). */
export interface Diagnostics {
  appVersion: string;
  backendVersion: string;
  platform: string;
}

/** One-line human-readable summary shown in the dialog and embedded in reports. */
export function diagnosticsSummary(d: Diagnostics): string {
  return `Phytograph ${d.appVersion} · backend ${d.backendVersion} · ${d.platform}`;
}

/**
 * Build the markdown issue/email body: the user's description followed by an
 * environment block. The same body is used for both the GitHub and email paths.
 */
export function buildIssueBody(mode: FeedbackMode, description: string, d: Diagnostics): string {
  const heading = mode === 'bug' ? '## Bug description' : '## Feature request';
  const desc = description.trim() || '_(no description provided)_';
  return [
    heading,
    '',
    desc,
    '',
    '## Environment',
    '',
    `- Phytograph: ${d.appVersion}`,
    `- Backend: ${d.backendVersion}`,
    `- OS: ${d.platform}`,
  ].join('\n');
}

/**
 * Pre-filled GitHub new-issue URL. `template`/`labels` map to the Issue Forms
 * in .github/ISSUE_TEMPLATE/ so the report lands structured and pre-labelled.
 */
export function buildGithubUrl(mode: FeedbackMode, title: string, body: string): string {
  const params = new URLSearchParams({
    title: title.trim(),
    body,
    labels: mode === 'bug' ? 'bug' : 'enhancement',
    template: mode === 'bug' ? 'bug.yml' : 'feature.yml',
  });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}

/**
 * Pre-filled mailto: URL for the "no GitHub account" path. Note `mailto:` uses
 * RFC-6068 percent-encoding (no `+` for spaces), so we encode subject/body with
 * encodeURIComponent rather than URLSearchParams.
 */
export function buildMailtoUrl(
  mode: FeedbackMode,
  title: string,
  body: string,
  email: string,
): string {
  const tag = mode === 'bug' ? 'Bug' : 'Feature request';
  const subject = `[Phytograph ${tag}] ${title.trim()}`;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
