'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  ERROR BOUNDARY — ক্র্যাশ হ্যান্ডলার (HIGH-2)
 * ═══════════════════════════════════════════════════════════════
 *
 *  React Error Boundary যেকোনো কম্পোনেন্ট ক্র্যাশ হলে পুরো পেজ
 *  white-screen না করে একটি graceful fallback UI দেখায়।
 * ═══════════════════════════════════════════════════════════════
 */

import { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('🔴 ErrorBoundary caught:', error);
    console.error('Component stack:', errorInfo.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center gap-4 p-8 min-h-[200px]">
          <div className="w-14 h-14 rounded-xl bg-brand-red/10 flex items-center justify-center">
            <AlertTriangle size={28} className="text-brand-red" />
          </div>
          <div className="text-center">
            <h3 className="heading-display text-sm text-text-primary mb-1">
              Something went wrong
            </h3>
            <p className="text-text-muted text-xs font-mono max-w-xs">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
          </div>
          <button
            onClick={this.handleReset}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-brand-green/40 text-brand-green text-xs font-mono hover:bg-brand-green/10 transition-all"
          >
            <RefreshCw size={13} />
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
