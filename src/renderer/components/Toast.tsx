import { useState, useEffect } from 'react';
import { CheckCircle, X, AlertCircle, Info, Copy, Check } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message?: string;
  duration?: number;
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
    // duration to override. Non-errors auto-dismiss after `duration` (3s
    // default). `duration: 0` forces persistence for any type.
    const persist = toast.duration === 0 || (toast.type === 'error' && toast.duration === undefined);
    if (!persist) {
      const timer = setTimeout(() => {
        onClose(toast.id);
      }, toast.duration || 3000);
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
      className={`flex items-start gap-3 p-4 rounded-lg border backdrop-blur-md ${backgrounds[toast.type]} animate-slide-in`}
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

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const handleToast = (event: CustomEvent<ToastMessage>) => {
      setToasts(prev => [...prev, { ...event.detail, id: Date.now().toString() }]);
    };

    window.addEventListener('show-toast' as any, handleToast);
    return () => window.removeEventListener('show-toast' as any, handleToast);
  }, []);

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 max-w-md">
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