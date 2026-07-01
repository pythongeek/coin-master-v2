'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  WALLET BUTTON — compact "💰 X Coin" pill in the navbar
 * ═══════════════════════════════════════════════════════════════
 *
 *  Tapping it opens the WalletModal (parent component).
 *  Shows the current Coin balance, clickable to deposit.
 *
 *  Visual: gold pill with coin icon, hover glow.
 * ═══════════════════════════════════════════════════════════════
 */

import { Coins } from 'lucide-react';

export interface WalletButtonProps {
  balance: number;
  onClick: () => void;
}

export function WalletButton({ balance, onClick }: WalletButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="wallet-button"
      aria-label="Open wallet"
      className="
        group flex items-center gap-2
        px-3 py-1.5 rounded-full
        bg-brand-gold/10 hover:bg-brand-gold/20
        border border-brand-gold/30 hover:border-brand-gold/60
        text-brand-gold
        transition-all duration-200
        hover:shadow-[0_0_12px_rgba(232,169,61,0.3)]
      "
    >
      <Coins size={14} className="transition-transform group-hover:scale-110" />
      <span className="font-mono text-sm font-semibold">
        {balance.toFixed(2)}
      </span>
      <span className="text-xs text-brand-gold/70 hidden sm:inline">Coin</span>
    </button>
  );
}

export default WalletButton;