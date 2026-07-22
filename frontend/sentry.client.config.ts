import * as Sentry from '@sentry/nextjs';

/**
 * Browser Sentry init.
 * Loaded only on the client by Next.js via sentry.client.config naming convention.
 */

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  release: process.env.NEXT_PUBLIC_APP_VERSION || 'unknown',
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0.0,
  replaysOnErrorSampleRate: 1.0,
  beforeSend(event) {
    if (event.exception) {
      // Strip request bodies from errors
      if (event.request?.data) {
        event.request.data = undefined;
      }
    }
    return event;
  },
});