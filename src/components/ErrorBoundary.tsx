import React from 'react';
import { isStaleChunkError, recoverFromStaleChunk } from '@/lib/chunkRecovery';
import { reportError } from '@/lib/monitoring';

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ComponentType<{ error?: Error; resetError: () => void }>;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // DOC-090 — exactly ONE monitoring event per React crash.
    //
    // This used to console.error AND reportError while captureConsoleIntegration
    // was active, so a single render crash produced two GlitchTip events (a
    // console-derived one and the explicit exception). Console capture is gone,
    // and the developer-facing log is kept for local debugging only — in
    // production it would be a duplicate of the reported event.
    if (import.meta.env.DEV) {
      console.error('ErrorBoundary caught an error:', error, errorInfo);
    }
    // A recoverable stale-chunk (post-deploy version skew) is not an application
    // fault: reload once via the shared guarded primitive and skip the monitoring
    // event so a self-healing session is not a noisy first-class crash. If the
    // cooldown is active — we already reloaded and the SAME release still failed —
    // recoverFromStaleChunk() returns false and we fall through to report it, so a
    // genuinely broken CURRENT deployment stays observable.
    if (isStaleChunkError(error) && recoverFromStaleChunk()) {
      return;
    }
    reportError(error, {
      area: 'react',
      operation: 'render-boundary',
      extra: { componentStack: errorInfo.componentStack },
    });
  }

  resetError = () => {
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        const FallbackComponent = this.props.fallback;
        return <FallbackComponent error={this.state.error} resetError={this.resetError} />;
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-[200px] p-6 text-center">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md">
            <h2 className="text-lg font-semibold text-red-800 mb-2">Something went wrong</h2>
            <p className="text-red-600 mb-4">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <button
              onClick={this.resetError}
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
