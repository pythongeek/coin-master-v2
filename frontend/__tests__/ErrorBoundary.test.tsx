import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from '@/components/ErrorBoundary';

// Mock lucide-react icons
jest.mock('lucide-react', () => ({
  AlertTriangle: () => <span data-testid="alert-icon">⚠</span>,
  RefreshCw: () => <span data-testid="refresh-icon">↻</span>,
}));

const ThrowError = ({ shouldThrow }: { shouldThrow: boolean }) => {
  if (shouldThrow) {
    throw new Error('Test error');
  }
  return <div data-testid="child">Child content</div>;
};

describe('ErrorBoundary', () => {
  // Suppress console.error for expected errors during tests
  const consoleError = console.error;
  beforeAll(() => {
    console.error = jest.fn();
  });
  afterAll(() => {
    console.error = consoleError;
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">Working content</div>
      </ErrorBoundary>
    );
    expect(screen.getByTestId('child')).toHaveTextContent('Working content');
  });

  it('renders fallback UI when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByTestId('alert-icon')).toBeInTheDocument();
    expect(screen.getByText(/Try Again/i)).toBeInTheDocument();
  });

  it('calls onReset when retry button is clicked', () => {
    const onReset = jest.fn();
    render(
      <ErrorBoundary onReset={onReset}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByText(/Try Again/i));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('renders custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">Custom error</div>}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByTestId('custom-fallback')).toHaveTextContent('Custom error');
  });
});
