"use client";

/**
 * AchievementsGrid — Badge / achievement panel for the dashboard
 */

import { Trophy, Flame, Coins, Dices, TrendingUp, Banknote, Play } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";

const ICON_MAP: Record<string, any> = {
  Trophy,
  Flame,
  Coins,
  Dices,
  TrendingUp,
  Banknote,
  Play,
};

interface AchievementItem {
  id: string;
  progress: number;
  unlockedAt: string | null;
  rewardedAt: string | null;
  achievement: {
    key: string;
    name: string;
    description: string;
    icon: string;
    category: string;
    conditionValue: number;
    coinReward: number;
  };
}

export function AchievementsGrid({ achievements }: { achievements: AchievementItem[] }) {
  const { t } = useTranslation();

  if (!achievements?.length) {
    return (
      <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60 text-text-muted text-sm">
        {t("noAchievements") || "No achievements yet — start playing to unlock badges!"}
      </div>
    );
  }

  return (
    <div className="glass-card p-4 rounded-2xl border border-border bg-surface/60">
      <div className="flex items-center justify-between mb-4">
        <div className="font-bold text-text-primary">{t("achievements") || "Achievements"}</div>
        <div className="text-xs text-text-muted">
          {achievements.filter((a) => a.unlockedAt).length} / {achievements.length}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {achievements.map((a) => {
          const unlocked = !!a.unlockedAt;
          const progress = Math.min(1, a.progress / a.achievement.conditionValue);
          const Icon = ICON_MAP[a.achievement.icon] || Trophy;

          return (
            <div
              key={a.id}
              className={`relative p-3 rounded-xl border text-center transition-all ${
                unlocked
                  ? "bg-brand-gold/10 border-brand-gold/40"
                  : "bg-surface2/50 border-border opacity-70"
              }`}
            >
              {unlocked && (
                <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-brand-gold text-black text-[10px] font-bold flex items-center justify-center">
                  ✓
                </div>
              )}
              <div className={`mx-auto w-10 h-10 rounded-full flex items-center justify-center mb-2 ${
                unlocked ? "bg-brand-gold/20 text-brand-gold" : "bg-surface text-text-muted"
              }`}>
                <Icon size={18} />
              </div>
              <div className="text-xs font-semibold text-text-primary truncate">{a.achievement.name}</div>
              <div className="text-[10px] text-text-muted line-clamp-2 h-7">{a.achievement.description}</div>

              {!unlocked ? (
                <div className="mt-2">
                  <div className="h-1.5 w-full bg-surface rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-info rounded-full transition-all"
                      style={{ width: `${progress * 100}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-text-muted mt-1">
                    {a.progress.toFixed(0)} / {a.achievement.conditionValue.toFixed(0)}
                  </div>
                </div>
              ) : (
                a.achievement.coinReward > 0 && (
                  <div className="mt-2 text-[10px] font-bold text-brand-green">
                    +{a.achievement.coinReward} coins
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
