import { init } from '@sentry/nextjs';

/**
 * Edge Sentry init.
 * Used for middleware / edge routes.
 */

init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  release: process.env.NEXT_PUBLIC_APP_VERSION || 'unknown',
  tracesSampleRate: 0.0,
});