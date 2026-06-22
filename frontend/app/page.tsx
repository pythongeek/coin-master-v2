import Link from 'next/link'
import { Coins, Gamepad2, BarChart3, Settings, ShieldCheck, Users, CloudRain } from 'lucide-react'

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      {/* লোগো */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-brand-green/10
                        border border-brand-green/25 text-brand-green mb-5 shadow-elevate-md">
          <Coins size={30} strokeWidth={2} />
        </div>
        <h1 className="heading-display text-5xl md:text-6xl text-text-primary mb-3">
          CRYPTO<span className="text-brand-green">FLIP</span>
        </h1>
        <p className="text-text-secondary text-base font-mono">
          বাংলাদেশের প্রথম <span className="text-brand-green">Provably Fair</span> কয়েন ফ্লিপ গেম
        </p>
      </div>

      {/* বৈশিষ্ট্য ব্যাজ */}
      <div className="flex flex-wrap items-center justify-center gap-2 mb-10">
        {[
          { Icon: ShieldCheck, label: 'Provably Fair' },
          { Icon: Users,       label: 'Squad Flip' },
          { Icon: CloudRain,   label: 'Crypto Rain' },
        ].map(({ Icon, label }) => (
          <div key={label} className="glass-card flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-mono text-text-secondary">
            <Icon size={13} className="text-brand-green" />
            {label}
          </div>
        ))}
      </div>

      {/* ন্যাভিগেশন */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 w-full max-w-2xl">
        <Link
          href="/game"
          className="glass-card p-6 text-center hover:border-brand-green/50 hover:-translate-y-0.5 transition-all duration-200"
        >
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-brand-green/10 text-brand-green mb-3">
            <Gamepad2 size={20} />
          </div>
          <div className="heading-display text-sm text-text-primary">গেম খেলুন</div>
          <div className="text-text-muted text-xs mt-1 font-mono">Coin Flip Arena</div>
        </Link>

        <Link
          href="/dashboard"
          className="glass-card p-6 text-center hover:border-brand-info/50 hover:-translate-y-0.5 transition-all duration-200"
        >
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-brand-info/10 text-brand-info mb-3">
            <BarChart3 size={20} />
          </div>
          <div className="heading-display text-sm text-text-primary">ড্যাশবোর্ড</div>
          <div className="text-text-muted text-xs mt-1 font-mono">My Stats & History</div>
        </Link>

        <Link
          href="/admin"
          className="glass-card p-6 text-center hover:border-brand-maroon/50 hover:-translate-y-0.5 transition-all duration-200"
        >
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-brand-maroon/10 text-brand-maroon mb-3">
            <Settings size={20} />
          </div>
          <div className="heading-display text-sm text-text-primary">এডমিন</div>
          <div className="text-text-muted text-xs mt-1 font-mono">Control Panel</div>
        </Link>
      </div>

      {/* ফুটার */}
      <p className="mt-16 text-text-muted text-xs font-mono">
        সম্পূর্ণ স্বচ্ছ, স্বয়ংক্রিয়ভাবে যাচাইযোগ্য — HMAC-SHA256 প্রযুক্তি দ্বারা চালিত
      </p>
    </main>
  )
}
