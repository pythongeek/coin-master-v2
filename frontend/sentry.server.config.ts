import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';

/**
 * Sentry DSN is set via the SENTRY_DSN environment variable.
 * If unset, Sentry is silently disabled and errors are logged to console only.
 */

export const register = () => {
  if (!process.env.SENTRY_DSN) {
    console.info('Sentry disabled: SENTRY_DSN not set');
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.NEXT_PUBLIC_APP_VERSION || 'unknown',
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 1.0,
  });
};

register();

export const onRequestError = Sentry.captureRequestError;

// Optional helper for manual error capture
export const captureException = (err: unknown, context?: Record<string, unknown>) => {
  if (!process.env.SENTRY_DSN) {
    console.error('Sentry disabled; error:', err, context);
    return;
  }
  Sentry.captureException(err, { extra: context });
};