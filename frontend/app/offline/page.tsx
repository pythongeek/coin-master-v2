'use client';

/**
 * Offline fallback page shown by the service worker when the network is
 * unreachable AND the requested page is not in the cache.
 */
import Link from 'next/link';
import { WifiOff, RefreshCw } from 'lucide-react';

export default function OfflinePage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-void">
      <div className="glass-card max-w-md w-full p-6 text-center">
        <WifiOff size={40} className="mx-auto text-text-muted mb-3" />
        <h1 className="heading-display text-xl text-text-primary mb-2">You’re offline</h1>
        <p className="text-text-muted text-sm font-mono mb-5">
          CryptoFlip needs a live connection to place bets. Check your network and try again.
          Cached pages (Verifier, Bonuses) may still work.
        </p>
        <div className="flex items-center justify-center gap-3">
          <Link href="/" className="btn-primary px-4 py-2 rounded-lg text-sm font-mono">
            Home
          </Link>
          <button
            onClick={() => window.location.reload()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-text-secondary text-sm font-mono"
          >
            <RefreshCw size={13} /> Retry
          </button>
        </div>
      </div>
    </main>
  );
}