/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker production build — small, standalone output
  output: 'standalone',

  // Disable trailing-slash redirect so nginx handles /admin internally
  skipTrailingSlashRedirect: true,

  // Three.js transpilation
  transpilePackages: ['three'],

  // Environment variables exposed to the client bundle
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    // Source of truth: .admin-secret-path (chmod 600, gitignored)
    NEXT_PUBLIC_ADMIN_PATH: process.env.ADMIN_SECRET_PATH || '',
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },

  // Secret admin URL rewrites
  async rewrites() {
    const secret = process.env.ADMIN_SECRET_PATH;
    if (!secret || secret === '/admin') return [];
    const normalized = secret.startsWith('/') ? secret : `/${secret}`;
    return [
      { source: `${normalized}/:path*`, destination: '/admin/:path*' },
    ];
  },

  async headers() {
    // CORS for Next.js API route proxies (/api/* on the frontend).
    // Only the canonical app origin is trusted; dynamic origins are
    // denied. Tunnel domains must be explicitly mounted via the
    // upstream proxy, not added to this allowlist.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
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
        // Security headers for all routes
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

module.exports = nextConfig;
