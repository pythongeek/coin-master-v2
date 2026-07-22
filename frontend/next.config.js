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
    if (!appUrl || !appUrl.startsWith('http')) {
      throw new Error('NEXT_PUBLIC_APP_URL must be a valid http/https origin');
    }

    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: appUrl },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
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
