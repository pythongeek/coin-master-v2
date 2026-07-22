import { Inter, Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { GameStoreProvider } from '@/components/providers/GameStoreProvider';
import GlobalBanner from '@/components/GlobalBanner';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';

const inter = Inter({ subsets: ['latin'], variable: '--font-body' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-display' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata = {
  title: 'CryptoFlip — Provably Fair Coin Flip',
  description: 'The first provably fair crypto coin-flip game in Bangladesh. Transparent, fair, and social.',
  keywords: 'crypto, coin flip, provably fair, Bangladesh, betting',
  googleSiteVerification: 'GOOGLE_VERIFICATION_HASH',
  msValidate: { '01': 'BING_VERIFICATION_HASH' },
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'CryptoFlip',
  },
  icons: {
    icon: '/favicon.ico',
    apple: '/icons/icon-192.png',
  },
};

export const viewport = {
  themeColor: '#fbbf24',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover' as const,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} font-body bg-void text-text-primary antialiased min-h-screen`}
      >
        <div className="fixed inset-0 pointer-events-none z-0 bg-vignette" />
        <div className="relative z-10">
          <ServiceWorkerRegister />
          <GameStoreProvider>
            <GlobalBanner />
            {children}
          </GameStoreProvider>
        </div>
      </body>
    </html>
  );
}
