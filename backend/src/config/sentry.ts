import * as Sentry from '@sentry/node';

/**
 * Backend Sentry error tracking.
 *
 * SENTRY_DSN must be set for reporting; otherwise errors are only logged.
 */

export function initSentry() {
  if (!process.env.SENTRY_DSN) {
    console.info('Sentry disabled: SENTRY_DSN not set');
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.APP_VERSION || 'unknown',
    tracesSampleRate: 0.05,
    integrations: [],
  });
}

export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (!process.env.SENTRY_DSN) {
    console.error('Error:', err, context);
    return;
  }
  Sentry.captureException(err, { extra: context });
}

export default Sentry;
