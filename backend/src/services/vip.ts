/**
 * VIP Tier system
 * Gamifies total wagered volume with visible tiers and rakeback rewards.
 */

export interface VipTier {
  name: string;
  wagerRequired: number;
  rakebackPercent: number;
  color: string;
  icon: string;
}

export const VIP_TIERS: VipTier[] = [
  { name: 'Bronze',  wagerRequired: 0,      rakebackPercent: 0.05, color: '#cd7f32', icon: '🥉' },
  { name: 'Silver',  wagerRequired: 1000,     rakebackPercent: 0.10, color: '#c0c0c0', icon: '🥈' },
  { name: 'Gold',    wagerRequired: 10000,    rakebackPercent: 0.15, color: '#ffd700', icon: '🥇' },
  { name: 'Platinum',wagerRequired: 50000,    rakebackPercent: 0.20, color: '#e5e4e2', icon: '💠' },
  { name: 'Diamond', wagerRequired: 250000,   rakebackPercent: 0.25, color: '#b9f2ff', icon: '💎' },
];

export function getVipRakebackPercent(wagered: number): number {
  const tier = getVipTier(wagered);
  return tier.rakebackPercent;
}

export function getVipTier(wagered: number): VipTier {
  let current = VIP_TIERS[0];
  for (const tier of VIP_TIERS) {
    if (wagered >= tier.wagerRequired) current = tier;
    else break;
  }
  return current;
}

export function getVipProgress(wagered: number): {
  currentTier: VipTier;
  nextTier: VipTier | null;
  progressPercent: number;
  wagerToNext: number;
} {
  const currentTier = getVipTier(wagered);
  const currentIndex = VIP_TIERS.findIndex(t => t.name === currentTier.name);
  const nextTier = VIP_TIERS[currentIndex + 1] || null;

  if (!nextTier) {
    return { currentTier, nextTier: null, progressPercent: 100, wagerToNext: 0 };
  }

  const range = nextTier.wagerRequired - currentTier.wagerRequired;
  const progress = Math.max(0, Math.min(1, (wagered - currentTier.wagerRequired) / range));
  return {
    currentTier,
    nextTier,
    progressPercent: Math.round(progress * 100),
    wagerToNext: Math.max(0, nextTier.wagerRequired - wagered),
  };
}
