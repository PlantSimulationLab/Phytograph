import { useState, useEffect } from 'react';
import { CheckCircle, X, AlertCircle, Info } from 'lucide-react';

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
      {icons[toast.type]}
      <div className="flex-1">
        <p data-testid="toast-title" className="font-medium text-white">{toast.title}</p>
        {toast.message && (
          <p data-testid="toast-message" className="text-sm text-white/70 mt-1">{toast.message}</p>
        )}
      </div>
      <button
        onClick={() => onClose(toast.id)}
        className="text-white/50 hover:text-white/80 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
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