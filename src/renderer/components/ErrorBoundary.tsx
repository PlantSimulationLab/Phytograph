import React, { Component, ReactNode } from 'react';
import { logToSession } from '../lib/logger';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Keep a bare console.error for DevTools (no error object, so the global
    // console-forwarding patch doesn't ALSO write it to the session file — we
    // write the full record once below, including the React componentStack,
    // which is the most useful part for diagnosing a render crash).
    console.error('[ErrorBoundary] Caught error — see session log for details');
    logToSession(
      'error',
      `[ErrorBoundary] ${error.name}: ${error.message}\n${error.stack ?? ''}\ncomponentStack:${errorInfo.componentStack ?? ''}`,
    );
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-6 bg-red-900/20 border border-red-400/30 rounded-lg">
          <h3 className="text-red-400 text-lg font-medium mb-2">Something went wrong</h3>
          <p className="text-red-300/70 text-sm mb-4">
            An error occurred while rendering this component.
          </p>
          <pre className="text-red-200/60 text-xs bg-black/30 p-3 rounded overflow-auto max-h-40">
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-4 px-4 py-2 bg-red-400/20 text-red-300 rounded hover:bg-red-400/30 transition-colors"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
