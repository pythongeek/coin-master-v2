/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker প্রোডাকশন বিল্ডের জন্য — ছোট, স্বয়ংসম্পূর্ণ আউটপুট তৈরি করে
  output: 'standalone',

  // Disable trailing-slash redirect. Without this, `/secret/` → 308 → `/admin`,
  // which then hits the nginx /admin block (404). With skipTrailingSlashRedirect,
  // nginx's proxy_pass handles the URL rewrite internally without involving
  // the client, and the middleware check still gates /admin correctly.
  skipTrailingSlashRedirect: true,

  // Three.js এর জন্য transpile করা দরকার
  transpilePackages: ['three'],

  // Environment variables ফ্রন্টএন্ডে পাঠানোর জন্য
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    // ─── Hidden admin path ─────────────────────────────
    // Exposed to the client so the admin page can show the
    // link in the navbar. Source of truth is the file
    // `.admin-secret-path` in the project root (chmod 600);
    // the build-arg `ADMIN_SECRET_PATH` in docker-compose.yml
    // reads it via `cat`. NEVER commit that file.
    NEXT_PUBLIC_ADMIN_PATH: process.env.ADMIN_SECRET_PATH || '',
  },

  // ─── Secret admin URL ───────────────────────────────
  // Rewrites `<secret>/*` → `/admin/*` so the same React
  // components render at the hidden path. Direct `/admin`
  // is BLOCKED in middleware.ts so even if someone finds
  // it, Next returns 404 before any React code runs.
  async rewrites() {
    const secret = process.env.ADMIN_SECRET_PATH;
    // Next.js requires rewrite sources to start with `/`.
    // The marker `__ADMIN_PATH__` is what we substitute at deploy time
    // if someone forgets the leading slash. The check ensures the
    // secret path is always absolute.
    if (!secret || secret === '/admin') return [];
    const normalized = secret.startsWith('/') ? secret : `/${secret}`;
    return [
      { source: `${normalized}/:path*`, destination: '/admin/:path*' },
    ];
  },

  // WebSocket সাপোর্টের জন্য
  async headers() {
    // Phase 2.5: tightened CORS allowlist (was '*').
    // Only allow the configured frontend URL and the Cloudflare tunnel.
    // Backend has its own CORS check in src/index.ts; this is for
    // Next.js API route proxies (/api/* on the frontend).
    const allowedOrigins = [
      process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      'http://localhost:3002',
      'http://localhost:3000',
      'https://occasions-announced-asia-vsnet.trycloudflare.com',
    ];
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: allowedOrigins.join(', ') },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
        ],
      },
      {
        // Security headers (Phase 2.5: apply to all routes via Next.js)
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },

  // ইমেজ অপটিমাইজেশন
  images: {
    domains: ['localhost'],
    formats: ['image/webp'],
  },
};

module.exports = nextConfig;