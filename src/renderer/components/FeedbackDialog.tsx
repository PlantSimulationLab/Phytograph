import { useState, useEffect, useCallback } from 'react';
import { X, Bug, Lightbulb, Github, Mail } from 'lucide-react';
import { FEEDBACK_EMAIL } from '../../shared/constants';
import {
  type FeedbackMode,
  type Diagnostics,
  diagnosticsSummary,
  buildIssueBody,
  buildGithubUrl,
  buildMailtoUrl,
} from '../lib/feedback';

interface FeedbackDialogProps {
  isOpen: boolean;
  mode: FeedbackMode;
  onClose: () => void;
}

// Collects a title + description, then offers two send paths:
//   - "I have a GitHub account" → opens a pre-filled GitHub new-issue page.
//   - "Continue without a GitHub account" → opens a pre-filled email.
// Diagnostics (app/backend version, OS) are fetched on open and embedded in
// both, visible to the user so they can review/edit before sending.
export function FeedbackDialog({ isOpen, mode, onClose }: FeedbackDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  // Reset fields and (re)load diagnostics each time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setTitle('');
    setDescription('');
    let cancelled = false;
    void window.electronAPI.backend
      .getInfo()
      .then((info) => {
        if (cancelled) return;
        setDiagnostics({
          appVersion: info.appVersion,
          backendVersion: info.expectedVersion,
          pyheliosVersion: info.pyheliosVersion,
          heliosVersion: info.heliosVersion,
          platform: info.platform,
        });
      })
      .catch(() => {
        if (!cancelled) setDiagnostics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const send = useCallback(
    (channel: 'github' | 'email') => {
      const diag: Diagnostics = diagnostics ?? {
        appVersion: 'unknown',
        backendVersion: 'unknown',
        pyheliosVersion: 'unknown',
        heliosVersion: 'unknown',
        platform: 'unknown',
      };
      const body = buildIssueBody(mode, description, diag);
      const url =
        channel === 'github'
          ? buildGithubUrl(mode, title, body)
          : buildMailtoUrl(mode, title, body, FEEDBACK_EMAIL);
      void window.electronAPI.shell.openExternal(url);
      onClose();
    },
    [mode, title, description, diagnostics, onClose],
  );

  if (!isOpen) return null;

  const isBug = mode === 'bug';
  const titleText = isBug ? 'Report a Bug' : 'Request a Feature';
  const Icon = isBug ? Bug : Lightbulb;
  const titlePlaceholder = isBug
    ? 'Brief summary of the bug'
    : 'Brief summary of the feature you want';
  const descPlaceholder = isBug
    ? 'What happened? What did you expect instead? Steps to reproduce, if you know them.'
    : 'What problem would this solve? How do you imagine it working?';
  const canSend = title.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        data-testid="feedback-dialog"
        className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-lg mx-4 overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-neutral-400" />
            <h2 className="text-sm font-semibold text-white">{titleText}</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-700 transition-colors">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-300">Title</label>
            <input
              data-testid="feedback-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={titlePlaceholder}
              className="w-full px-3 py-2 text-sm bg-neutral-900 border border-neutral-700 rounded text-neutral-100 placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-green-500/50"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-300">Details</label>
            <textarea
              data-testid="feedback-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={descPlaceholder}
              rows={6}
              className="w-full px-3 py-2 text-sm bg-neutral-900 border border-neutral-700 rounded text-neutral-100 placeholder-neutral-600 resize-y focus:outline-none focus:ring-1 focus:ring-green-500/50"
            />
          </div>

          {diagnostics && (
            <p className="text-[11px] text-neutral-500">
              Includes: {diagnosticsSummary(diagnostics)}
            </p>
          )}
        </div>

        <div className="px-4 py-3 border-t border-neutral-700 space-y-2">
          <button
            data-testid="feedback-github"
            onClick={() => send('github')}
            disabled={!canSend}
            className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg flex items-center justify-center gap-2 transition-colors"
          >
            <Github className="w-4 h-4" />
            <span className="flex flex-col items-center leading-tight">
              <span className="text-sm font-medium">I have a GitHub account</span>
              <span className="text-[10px] text-green-100/80">you'll be asked to sign in to GitHub</span>
            </span>
          </button>
          <button
            data-testid="feedback-email"
            onClick={() => send('email')}
            disabled={!canSend}
            className="w-full px-4 py-2.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-100 rounded-lg flex items-center justify-center gap-2 transition-colors"
          >
            <Mail className="w-4 h-4" />
            <span className="flex flex-col items-center leading-tight">
              <span className="text-sm font-medium">Continue without a GitHub account</span>
              <span className="text-[10px] text-neutral-400">sends via email</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
