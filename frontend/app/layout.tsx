import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CryptoFlip — Provably Fair Coin Flip',
  description: 'বাংলাদেশের প্রথম Provably Fair ক্রিপ্টো কয়েন ফ্লিপ গেম। স্বচ্ছ, সৎ, এবং সামাজিক।',
  keywords: 'crypto, coin flip, provably fair, Bangladesh, betting',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="bn" className="dark">
      <head>
        {/* Google Fonts — Orbitron (display) + Inter (body) + JetBrains Mono */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700;800;900&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-body bg-void text-text-primary antialiased min-h-screen">
        {/* ব্যাকগ্রাউন্ড গ্রিড প্যাটার্ন */}
        <div
          className="fixed inset-0 pointer-events-none z-0 opacity-20"
          style={{
            backgroundImage: 'radial-gradient(circle, #1A1A2E 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />
        {/* মেইন কন্টেন্ট */}
        <div className="relative z-10">
          {children}
        </div>
      </body>
    </html>
  )
}
