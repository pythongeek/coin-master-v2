const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ... existing config ...
  // P3-3a: was `output: 'standalone'` until P3-3a. Standalone uses
  // @vercel/nft to trace which node_modules entries are imported
  // from the static import graph, then tree-shakes the rest into a
  // tiny image. That breaks ANY client component that is reachable
  // only from an admin route (like d3 from the fraud panel), because
  // the trace from app/dashboard/page.tsx stops at AdminClientShell
  // and never reaches AdminFraudPanel -> ClusterGraphViewer -> d3.
  // Switching to default output keeps the full node_modules shipped
  // to the container at the cost of ~960MB image bloat — acceptable
  // here because the existing image was already 1.4GB.
  // output: 'standalone',
  skipTrailingSlashRedirect: true,
  transpilePackages: ['three'],

  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_ADMIN_PATH: process.env.ADMIN_SECRET_PATH || '',
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
  },

  async rewrites() {
    const secret = process.env.ADMIN_SECRET_PATH;
    if (!secret || secret === '/admin') return [];
    const normalized = secret.startsWith('/') ? secret : `/${secret}`;
    return [
      { source: `${normalized}/:path*`, destination: '/admin/:path*' },
    ];
  },

  async headers() {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    // The CORS /api/* block below is conditional on a valid NEXT_PUBLIC_APP_URL
    // being set at build time. At Docker build time, this env may not be set
    // (the workflow doesn't currently pass build-args), and the build must
    // be hermetic — env-specific values must not break a build. When
    // NEXT_PUBLIC_APP_URL is missing or malformed, the CORS headers are
    // omitted entirely (the browser will apply its default same-origin
    // policy, which is the correct behaviour for a missing-config scenario).
    //
    // Other headers (security headers for HTML pages, immutable cache for
    // /_next/static/*, etc.) are always emitted — they don't depend on
    // appUrl and are correct under all configurations.
    const apiCorsHeaders = appUrl && appUrl.startsWith('http')
      ? [
          {
            source: '/api/:path*',
            headers: [
              { key: 'Access-Control-Allow-Origin', value: appUrl },
              { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' },
              { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
              { key: 'Access-Control-Allow-Credentials', value: 'true' },
            ],
          },
        ]
      : [];

    return [
      ...apiCorsHeaders,
      {
        // HTML pages (incl. /, /game, /admin/*): always revalidate.
        // Forces the browser + any CDN/proxy to refetch on every visit so
        // users with a stale HTML page get the latest chunk hashes quickly
        // (no more "stale build" 404s when we ship code).
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Pragma', value: 'no-cache' },
          { key: 'Expires', value: '0' },
        ],
      },
      {
        // Next.js build chunks / static assets: immutable (content-hashed).
        // Browsers should NEVER revalidate these unless the URL changes.
        source: '/_next/static/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        source: '/static/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400' },
        ],
      },
    ];
  },

  images: {
    formats: ['image/webp'],
    remotePatterns: [],
  },
};

const sentryWebpackPluginOptions = {
  silent: true,
  org: process.env.SENTRY_ORG || 'cryptoflip',
  project: process.env.SENTRY_PROJECT || 'frontend',
  authToken: process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
  transpileClientSDKs: true,
  tunnelRoute: '/monitoring',
  hideSourceMaps: true,
  disableLogger: true,
  automaticVercelMonitors: false,
};

module.exports = withSentryConfig(nextConfig, sentryWebpackPluginOptions);
