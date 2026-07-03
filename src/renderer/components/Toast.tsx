import { useState, useEffect } from 'react';
import { CheckCircle, X, AlertCircle, Info, Copy, Check } from 'lucide-react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message?: string;
  duration?: number;
  // Optional action buttons rendered in the card (e.g. "Move onto scene" /
  // "Keep as-is" for a frame-mismatch warning). Each button runs its onClick
  // and then dismisses the toast. Actions travel through the show-toast
  // CustomEvent, so their closures must be self-contained (no stale React state).
  actions?: ToastAction[];
}

interface ToastProps {
  toast: ToastMessage;
  onClose: (id: string) => void;
}

function Toast({ toast, onClose }: ToastProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    // Copy the full title + message so a user can paste an error (paths,
    // stack-trace snippets) into a bug report. The toast text itself is also
    // selectable, but a one-click copy is friendlier for long messages.
    const text = toast.message ? `${toast.title}\n${toast.message}` : toast.title;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable; the text stays manually selectable.
    }
  };

  useEffect(() => {
    // Error toasts persist until the user dismisses them — a failure the user
    // misses is worse than a stale toast. They can still set an explicit
    // duration to override. Non-errors auto-dismiss after `duration`, defaulting
    // per type: warnings linger (10s) so they're not missed, success/info clear
    // sooner (4s). `duration: 0` forces persistence for any type.
    const persist = toast.duration === 0 || (toast.type === 'error' && toast.duration === undefined);
    if (!persist) {
      const defaultDuration = toast.type === 'warning' ? 10000 : 4000;
      const timer = setTimeout(() => {
        onClose(toast.id);
      }, toast.duration || defaultDuration);
      return () => clearTimeout(timer);
    }
  }, [toast, onClose]);

  const icons = {
    success: <CheckCircle className="w-5 h-5 text-green-400" />,
    error: <AlertCircle className="w-5 h-5 text-red-400" />,
    info: <Info className="w-5 h-5 text-blue-400" />,
    warning: <AlertCircle className="w-5 h-5 text-yellow-400" />
  };

  const backgrounds = {
    success: 'bg-green-500/10 border-green-500/20',
    error: 'bg-red-500/10 border-red-500/20',
    info: 'bg-blue-500/10 border-blue-500/20',
    warning: 'bg-yellow-500/10 border-yellow-500/20'
  };

  return (
    <div
      data-testid={`toast-${toast.type}`}
      // pointer-events-auto re-enables interaction on the card itself; the
      // container wrapper is pointer-events-none so the empty space around the
      // toasts (and behind a persistent toast's bounding box) stays click-through
      // and never occludes the app controls anchored in the same corner.
      className={`pointer-events-auto flex items-start gap-3 p-4 rounded-lg border backdrop-blur-md ${backgrounds[toast.type]} animate-slide-in`}
    >
      <span className="flex-shrink-0">{icons[toast.type]}</span>
      {/* min-w-0 lets the text column shrink so long, unbroken strings (e.g.
          file paths) wrap inside the toast instead of overflowing and pushing
          the action buttons off-screen. select-text + break-words make the
          message selectable and copy-pasteable. */}
      <div className="flex-1 min-w-0 select-text">
        <p data-testid="toast-title" className="font-medium text-white break-words">{toast.title}</p>
        {toast.message && (
          <p data-testid="toast-message" className="text-sm text-white/70 mt-1 break-words whitespace-pre-wrap">{toast.message}</p>
        )}
        {toast.actions && toast.actions.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {toast.actions.map((action, i) => (
              <button
                key={i}
                data-testid={`toast-action-${i}`}
                onClick={() => {
                  action.onClick();
                  onClose(toast.id);
                }}
                className="px-2 py-1 text-xs font-medium rounded bg-white/10 hover:bg-white/20 text-white transition-colors"
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex-shrink-0 flex items-start gap-1">
        <button
          data-testid="toast-copy"
          onClick={handleCopy}
          title="Copy message"
          className="text-white/50 hover:text-white/80 transition-colors"
        >
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </button>
        <button
          data-testid="toast-close"
          onClick={() => onClose(toast.id)}
          title="Dismiss"
          className="text-white/50 hover:text-white/80 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

let toastSeq = 0;

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const handleToast = (event: CustomEvent<ToastMessage>) => {
      // Monotonic counter, not Date.now() — two toasts fired in the same
      // millisecond would otherwise collide and produce duplicate React keys.
      const id = `${Date.now()}-${toastSeq++}`;
      setToasts(prev => [...prev, { ...event.detail, id }]);
    };

    window.addEventListener('show-toast' as any, handleToast);
    return () => window.removeEventListener('show-toast' as any, handleToast);
  }, []);

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[110] space-y-2 max-w-md pointer-events-none">
      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onClose={removeToast} />
      ))}
    </div>
  );
}

// Helper function to show toast
export function showToast(toast: Omit<ToastMessage, 'id'>) {
  window.dispatchEvent(new CustomEvent('show-toast', { detail: toast }));
}