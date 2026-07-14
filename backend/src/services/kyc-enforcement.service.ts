/**
 * =============================================================
 *  KYC ENFORCEMENT SERVICE - deposit-side tier checks
 * =============================================================
 *
 *  Used by the deposit flow (binance-pay-qr.service.ts) to enforce:
 *    1. Self-exclusion (hard block; admin-reversible)
 *    2. Sanctioned countries (hard block; per-user exception)
 *    3. Age >= 18 (hard block)
 *    4. Tier threshold check (block if amount exceeds current KYC tier)
 *    5. Per-user KYC override (super_admin grant, auto-expiry)
 *    6. KYC expiry policy (warn-only by default, admin-toggleable auto-downgrade)
 *
 *  All thresholds come from admin_settings (DB-driven, hot-reload).
 *  Sanctioned country list is also admin-editable.
 *
 *  Returns:
 *    { allowed: boolean, reason?: string, tier: number, requiredTier: number,
 *      blockedBy?: 'self_exclusion' | 'sanctions' | 'age' | 'tier' | 'kyc_expired',
 *      action: 'allow' | 'block' | 'warn' }
 *
 *  'warn' = enforcement_mode is 'warn' (soft block, log + email but allow)
 *  'block' = enforcement_mode is 'strict' or hard-block condition triggered
 */

import { query, withTransaction } from '../config/database';
import { getRawSetting } from './admin-config';
import { queueEmail } from './notification.service';

export type BlockReason =
  | 'self_exclusion'
  | 'sanctions'
  | 'age'
  | 'tier'
  | 'kyc_expired';

export interface KycCheckResult {
  allowed: boolean;
  reason?: string;
  blockedBy?: BlockReason;
  tier: number;
  requiredTier: number;
  enforcementMode: 'off' | 'warn' | 'strict';
  action: 'allow' | 'block' | 'warn';
  /** Suggested message shown to the user when blocked */
  userMessage?: { en: string; bn: string };
}

// Default sanctioned countries (overridden by admin_settings if set)
const DEFAULT_SANCTIONED = ['IR', 'KP', 'SY', 'CU', 'AF'];

/**
 * Read current KYC configuration from admin_settings.
 * Hot-reload on every call (no caching) so admin changes take effect immediately.
 */
async function loadKycConfig(): Promise<{
  thresholds: Record<number, { maxPerTx: number; maxDaily: number }>;
  sanctionedCountries: string[];
  enforcementMode: 'off' | 'warn' | 'strict';
  expiryCheckEnabled: boolean;
  expiryGraceDays: number;
  expiryAutoAction: 'warn_only' | 'downgrade_to_tier0' | 'downgrade_to_tier1';
  tierMaxAgeDays: Record<number, number>;
}> {
  const [
    t0tx, t0day, t1tx, t1day, t2tx, t2day, t3tx, t3day,
    sanctioned, mode,
    expEnabled, expGrace, expAction,
    t1Age, t2Age, t3Age,
  ] = await Promise.all([
    getRawSetting('deposit_tier0_max_per_tx'),
    getRawSetting('deposit_tier0_max_daily'),
    getRawSetting('deposit_tier1_max_per_tx'),
    getRawSetting('deposit_tier1_max_daily'),
    getRawSetting('deposit_tier2_max_per_tx'),
    getRawSetting('deposit_tier2_max_daily'),
    getRawSetting('deposit_tier3_max_per_tx'),
    getRawSetting('deposit_tier3_max_daily'),
    getRawSetting('kyc_sanctioned_countries'),
    getRawSetting('deposit_kyc_enforcement_mode'),
    getRawSetting('kyc_expiry_check_enabled'),
    getRawSetting('kyc_expiry_grace_days'),
    getRawSetting('kyc_expiry_auto_action'),
    getRawSetting('kyc_tier1_max_age_days'),
    getRawSetting('kyc_tier2_max_age_days'),
    getRawSetting('kyc_tier3_max_age_days'),
  ]);

  // Parse sanctioned countries JSON array (fallback to default)
  let sanctionedList: string[] = DEFAULT_SANCTIONED;
  if (sanctioned) {
    try {
      const parsed = JSON.parse(sanctioned);
      if (Array.isArray(parsed)) {
        sanctionedList = parsed.filter((c) => typeof c === 'string' && c.length === 2).map((c) => c.toUpperCase());
      }
    } catch {
      // Invalid JSON in admin_settings - fall back to default
    }
  }

  return {
    thresholds: {
      0: { maxPerTx: parseFloat(t0tx || '100'), maxDaily: parseFloat(t0day || '100') },
      1: { maxPerTx: parseFloat(t1tx || '500'), maxDaily: parseFloat(t1day || '500') },
      2: { maxPerTx: parseFloat(t2tx || '5000'), maxDaily: parseFloat(t2day || '10000') },
      3: { maxPerTx: parseFloat(t3tx || '50000'), maxDaily: parseFloat(t3day || '100000') },
    },
    sanctionedCountries: sanctionedList,
    enforcementMode: (mode as 'off' | 'warn' | 'strict') || 'warn',
    expiryCheckEnabled: expEnabled === 'true',
    expiryGraceDays: parseInt(expGrace || '90', 10),
    expiryAutoAction: (expAction as 'warn_only' | 'downgrade_to_tier0' | 'downgrade_to_tier1') || 'warn_only',
    tierMaxAgeDays: {
      1: parseInt(t1Age || '1825', 10),
      2: parseInt(t2Age || '1095', 10),
      3: parseInt(t3Age || '365', 10),
    },
  };
}

/**
 * Determine which tier is REQUIRED for a given deposit amount.
 * Walks tiers 0..3, returns the lowest tier whose maxPerTx >= amount AND maxDaily >= amount.
 */
function requiredTierForAmount(
  amountUsdt: number,
  dailyUsedUsdt: number,
  thresholds: Record<number, { maxPerTx: number; maxDaily: number }>,
): number {
  for (let t = 0; t <= 3; t++) {
    const th = thresholds[t];
    if (th && amountUsdt <= th.maxPerTx && (dailyUsedUsdt + amountUsdt) <= th.maxDaily) {
      return t;
    }
  }
  // Amount exceeds tier 3 limits -> still return 3 (admin override required)
  return 3;
}

/**
 * Compute user's current effective KYC tier.
 * Applies expiry policy if enabled.
 */
function computeEffectiveTier(
  kycTier: string | null,
  kycVerifiedAt: Date | null,
  config: Awaited<ReturnType<typeof loadKycConfig>>,
): { tier: number; expired: boolean; effectiveTier: string } {
  const baseTier = (kycTier || '').toLowerCase();
  let tier = baseTier === 'tier3' || baseTier === '3' ? 3
    : baseTier === 'tier2' || baseTier === '2' ? 2
    : baseTier === 'tier1' || baseTier === '1' ? 1
    : 0;

  let expired = false;

  if (config.expiryCheckEnabled && kycVerifiedAt && tier >= 1) {
    const ageDays = (Date.now() - kycVerifiedAt.getTime()) / (1000 * 60 * 60 * 24);
    const maxAge = config.tierMaxAgeDays[tier] || Infinity;
    if (ageDays > maxAge) {
      expired = true;
      // Apply auto-downgrade
      if (config.expiryAutoAction === 'downgrade_to_tier0') {
        tier = 0;
      } else if (config.expiryAutoAction === 'downgrade_to_tier1') {
        tier = 1;
      }
      // warn_only: tier unchanged, just set expired flag (caller decides action)
    }
  }

  return {
    tier,
    expired,
    effectiveTier: `tier${tier}`,
  };
}

/**
 * Main enforcement entry point. Called from binance-pay-qr.service.ts before
 * creating a QR deposit order.
 *
 * @param userId - the depositing user
 * @param amountUsdt - amount of the proposed deposit
 * @returns KycCheckResult - caller MUST respect allowed=false (block) or check action=warn
 */
export async function checkDepositKyc(
  userId: string,
  amountUsdt: number,
): Promise<KycCheckResult> {
  const config = await loadKycConfig();

  // Load user
  const userRes = await query(
    `SELECT
       kyc_status, kyc_tier, kyc_country, kyc_verified_at,
       self_excluded_until, is_active,
       preferred_language,
       kyc_deposit_override_until, kyc_deposit_override_reason,
       kyc_country_exception_until, kyc_country_exception_reason,
       EXTRACT(YEAR FROM AGE(date_of_birth)) AS age_years
     FROM users
     WHERE id = $1`,
    [userId]
  );
  if (!userRes.rows.length) {
    return {
      allowed: false,
      reason: 'User not found',
      tier: 0,
      requiredTier: 0,
      enforcementMode: config.enforcementMode,
      action: 'block',
    };
  }
  const u = userRes.rows[0];

  // ---- HARD BLOCKS (no override except super_admin KYC override) ----

  // 1. Self-exclusion (admin-reversible per P3-FINAL-DECISIONS)
  if (u.self_excluded_until && new Date(u.self_excluded_until) > new Date()) {
    return blockResult({
      blockedBy: 'self_exclusion',
      reason: `Account is self-excluded until ${new Date(u.self_excluded_until).toISOString().slice(0, 10)}`,
      reasonBn: `আপনার অ্যাকাউন্ট ${new Date(u.self_excluded_until).toISOString().slice(0, 10)} পর্যন্ত স্ব-বর্জনে আছে`,
      tier: 0,
      requiredTier: 0,
      enforcementMode: config.enforcementMode,
    });
  }

  // 2. Sanctioned country (per-user exception possible)
  const userCountry = (u.kyc_country || '').toUpperCase();
  const isSanctioned = userCountry && config.sanctionedCountries.includes(userCountry);
  const hasCountryException = u.kyc_country_exception_until && new Date(u.kyc_country_exception_until) > new Date();
  if (isSanctioned && !hasCountryException) {
    return blockResult({
      blockedBy: 'sanctions',
      reason: `Deposits are not available from your country (${userCountry})`,
      reasonBn: `আপনার দেশ (${userCountry}) থেকে জমা গ্রহণযোগ্য নয়`,
      tier: 0,
      requiredTier: 0,
      enforcementMode: config.enforcementMode,
    });
  }

  // 3. Age check (only if date_of_birth is populated; we skip if null to not break signup)
  if (u.age_years !== null && u.age_years < 18) {
    return blockResult({
      blockedBy: 'age',
      reason: 'Deposits are not available to users under 18',
      reasonBn: '১৮ বছরের কম বয়সী ব্যবহারকারীদের জন্য জমা গ্রহণযোগ্য নয়',
      tier: 0,
      requiredTier: 0,
      enforcementMode: config.enforcementMode,
    });
  }

  // 4. Inactive user
  if (!u.is_active) {
    return blockResult({
      blockedBy: 'self_exclusion',
      reason: 'Account is inactive',
      reasonBn: 'অ্যাকাউন্ট নিষ্ক্রিয়',
      tier: 0,
      requiredTier: 0,
      enforcementMode: config.enforcementMode,
    });
  }

  // ---- TIER CHECK ----

  // Compute user's current tier (with expiry policy applied)
  const { tier: userTier, expired: kycExpired } = computeEffectiveTier(
    u.kyc_tier,
    u.kyc_verified_at ? new Date(u.kyc_verified_at) : null,
    config,
  );

  // Sum today's deposits (already-paid + awaiting_payment + detected + verifying)
  const dailyRes = await query(
    `SELECT COALESCE(SUM(amount_crypto), 0)::float8 AS total
     FROM payment_orders
     WHERE user_id = $1 AND gateway = 'binance_pay_qr'
       AND created_at > NOW() - INTERVAL '24 hours'
       AND status IN ('awaiting_payment', 'detected', 'verifying', 'paid')`,
    [userId]
  );
  const dailyUsed = dailyRes.rows[0]?.total || 0;

  // What's required for this amount?
  const reqTier = requiredTierForAmount(amountUsdt, dailyUsed, config.thresholds);

  // Override bypasses tier check
  const hasOverride = u.kyc_deposit_override_until && new Date(u.kyc_deposit_override_until) > new Date();
  if (hasOverride && userTier < reqTier) {
    // Override grants access even though tier insufficient
    return {
      allowed: true,
      tier: userTier,
      requiredTier: reqTier,
      enforcementMode: config.enforcementMode,
      action: 'allow',
    };
  }

  // KYC expired (warn or auto-downgrade already applied above)
  if (kycExpired) {
    // Expired tier + amount exceeds new (downgraded) tier -> block with 'kyc_expired' reason
    if (userTier < reqTier && config.expiryAutoAction !== 'warn_only') {
      return blockResult({
        blockedBy: 'kyc_expired',
        reason: `Your KYC verification has expired. Please re-verify to deposit this amount.`,
        reasonBn: 'আপনার KYC যাচাইকরণের মেয়াদ শেষ হয়েছে। এই পরিমাণ জমা দিতে আবার যাচাই করুন।',
        tier: userTier,
        requiredTier: reqTier,
        enforcementMode: config.enforcementMode,
      });
    }
    // warn_only mode + expired -> warn but allow (with email nudge)
    if (userTier >= reqTier) {
      // Even though expired, amount still within current tier. Allow.
      return {
        allowed: true,
        tier: userTier,
        requiredTier: reqTier,
        enforcementMode: config.enforcementMode,
        action: 'allow',
      };
    }
  }

  // Standard tier check
  if (userTier < reqTier) {
    const block: BlockReason = 'tier';
    const msgs = tierUpgradeMessage(userTier, reqTier, amountUsdt);
    return {
      allowed: config.enforcementMode === 'warn',  // warn mode: still allow
      blockedBy: block,
      reason: msgs.en,
      tier: userTier,
      requiredTier: reqTier,
      enforcementMode: config.enforcementMode,
      action: config.enforcementMode === 'warn' ? 'warn' : 'block',
      userMessage: msgs,
    };
  }

  // All checks passed
  return {
    allowed: true,
    tier: userTier,
    requiredTier: reqTier,
    enforcementMode: config.enforcementMode,
    action: 'allow',
  };
}

function blockResult(opts: {
  blockedBy: BlockReason;
  reason: string;
  reasonBn: string;
  tier: number;
  requiredTier: number;
  enforcementMode: 'off' | 'warn' | 'strict';
}): KycCheckResult {
  return {
    allowed: false,
    reason: opts.reason,
    blockedBy: opts.blockedBy,
    tier: opts.tier,
    requiredTier: opts.requiredTier,
    enforcementMode: opts.enforcementMode,
    action: 'block',
    userMessage: { en: opts.reason, bn: opts.reasonBn },
  };
}

function tierUpgradeMessage(
  currentTier: number,
  requiredTier: number,
  amountUsdt: number,
): { en: string; bn: string } {
  if (currentTier === 0 && requiredTier >= 1) {
    return {
      en: `Complete identity verification to deposit more than 100 USDT/day. Your deposit of ${amountUsdt} USDT requires Tier 1 (basic KYC).`,
      bn: `১০০ মার্কিন ডলারের বেশি জমা দিতে পরিচয় যাচাই করুন। ${amountUsdt} মার্কিন ডলার জমা করতে টায়ার ১ (প্রাথমিক KYC) প্রয়োজন।`,
    };
  }
  if (currentTier <= 1 && requiredTier >= 2) {
    return {
      en: `Verify your address to deposit more than 500 USDT/day. Your deposit of ${amountUsdt} USDT requires Tier 2 (intermediate KYC).`,
      bn: `৫০০ মার্কিন ডলারের বেশি জমা দিতে ঠিকানা যাচাই করুন। ${amountUsdt} মার্কিন ডলার জমা করতে টায়ার ২ (মধ্যম KYC) প্রয়োজন।`,
    };
  }
  if (currentTier <= 2 && requiredTier >= 3) {
    return {
      en: `Your deposit of ${amountUsdt} USDT requires Tier 3 (full KYC with source-of-funds verification).`,
      bn: `${amountUsdt} মার্কিন ডলার জমা করতে টায়ার ৩ (সম্পূর্ণ KYC এবং তহবিলের উৎস যাচাই) প্রয়োজন।`,
    };
  }
  return {
    en: `Your deposit of ${amountUsdt} USDT exceeds your current KYC tier.`,
    bn: `${amountUsdt} মার্কিন ডলার জমা আপনার বর্তমান KYC টায়ারের সীমা অতিক্রম করেছে।`,
  };
}

/**
 * Audit-log helper for admin actions on KYC config.
 * Called from the admin routes, not from the user-facing flow.
 */
export async function logKycOverride(
  adminUserId: string,
  action: string,
  details: Record<string, unknown>,
  reason: string,
  userId?: string,
): Promise<void> {
  await query(
    `INSERT INTO kyc_override_log (user_id, admin_user_id, action, details, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId || null, adminUserId, action, JSON.stringify(details), reason]
  );
}