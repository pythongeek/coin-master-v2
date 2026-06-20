/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker প্রোডাকশন বিল্ডের জন্য — ছোট, স্বয়ংসম্পূর্ণ আউটপুট তৈরি করে
  output: 'standalone',

  // Three.js এর জন্য transpile করা দরকার
  transpilePackages: ['three'],

  // Environment variables ফ্রন্টএন্ডে পাঠানোর জন্য
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  },

  // WebSocket সাপোর্টের জন্য
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
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
