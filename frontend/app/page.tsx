import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      {/* লোগো */}
      <div className="text-center mb-12">
        <h1 className="heading-display text-6xl md:text-8xl text-neon mb-4">
          CRYPTO<span className="text-neon-blue">FLIP</span>
        </h1>
        <p className="text-text-secondary text-lg font-mono">
          বাংলাদেশের প্রথম <span className="text-neon-green">Provably Fair</span> কয়েন ফ্লিপ গেম
        </p>
      </div>

      {/* স্ট্যাটাস ব্যাজ */}
      <div className="flex items-center gap-2 mb-10 glass-card px-6 py-3">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse" />
        <span className="font-mono text-sm text-text-secondary">
          সিস্টেম সেটআপ সম্পন্ন — প্রজেক্ট স্ট্রাকচার রেডি ✅
        </span>
      </div>

      {/* ন্যাভিগেশন */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-2xl">
        <Link
          href="/game"
          className="glass-card p-6 text-center hover:border-neon-green transition-all duration-300 hover:shadow-neon-green group"
        >
          <div className="text-3xl mb-3">🎮</div>
          <div className="heading-display text-sm text-neon-green">গেম খেলুন</div>
          <div className="text-text-muted text-xs mt-1 font-mono">Coin Flip Arena</div>
        </Link>

        <Link
          href="/dashboard"
          className="glass-card p-6 text-center hover:border-neon-blue transition-all duration-300 hover:shadow-neon-blue group"
        >
          <div className="text-3xl mb-3">📊</div>
          <div className="heading-display text-sm text-neon-blue">ড্যাশবোর্ড</div>
          <div className="text-text-muted text-xs mt-1 font-mono">My Stats & History</div>
        </Link>

        <Link
          href="/admin"
          className="glass-card p-6 text-center hover:border-neon-purple transition-all duration-300 hover:shadow-neon-purple group"
        >
          <div className="text-3xl mb-3">⚙️</div>
          <div className="heading-display text-sm text-neon-purple">এডমিন</div>
          <div className="text-text-muted text-xs mt-1 font-mono">Control Panel</div>
        </Link>
      </div>

      {/* ফুটার */}
      <p className="mt-16 text-text-muted text-xs font-mono">
        Phase 1 Complete — Next: Provably Fair Algorithm 🔐
      </p>
    </main>
  )
}
