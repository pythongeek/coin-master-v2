import Link from 'next/link'
import { Coins, Gamepad2, BarChart3, Settings, ShieldCheck, Users, CloudRain, Gift } from 'lucide-react'

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-void p-4 text-center">
      <div className="max-w-2xl space-y-6">
        <h1 className="heading-display text-4xl md:text-5xl text-text-primary">
          Welcome to CryptoFlip
        </h1>
        <p className="text-text-muted text-lg">
          Provably fair coin-flip gaming. Play, earn, and climb the leaderboards.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 pt-4">
          <Link
            href="/game"
            className="group glass-card p-5 rounded-2xl border border-border hover:border-brand-gold/50 transition-all"
          >
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-brand-gold/10 flex items-center justify-center text-brand-gold group-hover:bg-brand-gold/20">
              <Gamepad2 size={24} />
            </div>
            <h2 className="text-text-primary font-semibold">Play Game</h2>
            <p className="text-text-muted text-xs mt-1">Flip the coin & win</p>
          </Link>

          <Link
            href="/dashboard"
            className="group glass-card p-5 rounded-2xl border border-border hover:border-brand-gold/50 transition-all"
          >
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-brand-maroon/10 flex items-center justify-center text-brand-maroon group-hover:bg-brand-maroon/20">
              <BarChart3 size={24} />
            </div>
            <h2 className="text-text-primary font-semibold">Dashboard</h2>
            <p className="text-text-muted text-xs mt-1">Stats & history</p>
          </Link>

          <Link
            href="/verifier"
            className="group glass-card p-5 rounded-2xl border border-border hover:border-brand-gold/50 transition-all"
          >
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-brand-green/10 flex items-center justify-center text-brand-green group-hover:bg-brand-green/20">
              <ShieldCheck size={24} />
            </div>
            <h2 className="text-text-primary font-semibold">Verifier</h2>
            <p className="text-text-muted text-xs mt-1">Provably fair</p>
          </Link>

          <Link
            href="/admin"
            className="group glass-card p-5 rounded-2xl border border-border hover:border-brand-gold/50 transition-all"
          >
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-brand-purple/10 flex items-center justify-center text-brand-purple group-hover:bg-brand-purple/20">
              <Settings size={24} />
            </div>
            <h2 className="text-text-primary font-semibold">Admin</h2>
            <p className="text-text-muted text-xs mt-1">Super admin panel</p>
          </Link>

          <Link
            href="/bonus"
            className="group glass-card p-5 rounded-2xl border border-border hover:border-brand-gold/50 transition-all"
          >
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-brand-green/10 flex items-center justify-center text-brand-green group-hover:bg-brand-green/20">
              <Gift size={24} />
            </div>
            <h2 className="text-text-primary font-semibold">Bonuses</h2>
            <p className="text-text-muted text-xs mt-1">Campaigns & rewards</p>
          </Link>

          <Link
            href="/game?tab=squad"
            className="group glass-card p-5 rounded-2xl border border-border hover:border-brand-gold/50 transition-all"
          >
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-brand-blue/10 flex items-center justify-center text-brand-blue group-hover:bg-brand-blue/20">
              <Users size={24} />
            </div>
            <h2 className="text-text-primary font-semibold">Squad Flip</h2>
            <p className="text-text-muted text-xs mt-1">Team up & win</p>
          </Link>
        </div>
      </div>
    </main>
  )
}
