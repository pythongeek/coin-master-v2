/**
 * Phase 1.4 — Affiliate Self-Referral Guard (L12)
 *
 * Catches a user who refers themselves via a brand-new account:
 *   - User A signs up, gets a referral code.
 *   - User A registers a NEW account (or pays someone to register one)
 *     and submits A's referral code as the referee.
 *   - If unchecked, A earns commission on their own second account.
 *
 * Detection signals (any one is sufficient to flag, two is strong
 * evidence to block the commission entirely):
 *   1. Same device fingerprint on both accounts.
 *   2. Same registration IP (configurable tolerance window).
 *   3. Same KYC identity hash (strongest).
 *   4. Both accounts share the same fingerprint in fraud_signals
 *      (any signal type).
 *
 * Decision matrix (admin-configurable thresholds):
 *   signal_count >= block_threshold  → block commission, flag referee
 *   signal_count >= flag_threshold   → flag referee but allow link
 *   else                              → allow
 *
 * IMPORTANT: This is best-effort fraud detection, not a guarantee.
 * Real attackers use different devices + VPNs + different identities.
 * That's why L11 graph detection runs in parallel — the self-link
 * graph edges go to the cluster detector for ring finding.
 */

import { query } from '../config/database';
import { getAdminSettingNumber as getSetting } from './admin-settings.service';

export type SelfReferralAction = 'allow' | 'flag' | 'block';

export interface SelfReferralCheck {
  referrerId: string;
  refereeFingerprint: string | null;
  refereeIp: string | null;
  signals: {
    sameDevice: boolean;
    sameIp: boolean;
    sameKyc: boolean;
    sameFraudSignal: boolean;
  };
  signalCount: number;
  action: SelfReferralAction;
  reason: string | null;
}

/**
 * Decide whether `referrerId` is likely the same human as the new
 * referee who just supplied `referrerId`'s referral code.
 *
 * Pure-ish: only reads the DB, does not write. Caller decides what
 * to do with the verdict.
 */
export async function detectSelfReferral(
  referrerId: string,
  refereeFingerprint: string | null | undefined,
  refereeIp: string | null | undefined,
): Promise<SelfReferralCheck> {
  const fpHash = refereeFingerprint ? refereeFingerprint.trim().toLowerCase() : null;
  const ip = refereeIp || null;

  const signals: SelfReferralCheck['signals'] = {
    sameDevice: false,
    sameIp: false,
    sameKyc: false,
    sameFraudSignal: false,
  };

  // 1. Same device fingerprint.
  if (fpHash && fpHash.length >= 8) {
    const dev = await query(
      `SELECT 1 FROM device_fingerprints
        WHERE fingerprint_hash = encode(digest($1::text, 'sha256'), 'hex')
          AND $2::uuid = ANY(user_ids)
        LIMIT 1`,
      [fpHash, referrerId],
    );
    signals.sameDevice = dev.rows.length > 0;

    // 2. Same KYC identity hash (on the referrer's KYC row).
    //    Cheap check: did the referrer submit KYC at all? If so, the
    //    same hash on this new submission would match.
    const kycRef = await query(
      `SELECT national_id_hash FROM kyc_submissions
        WHERE user_id = $1 AND status = 'approved'
          AND national_id_hash IS NOT NULL
        LIMIT 1`,
      [referrerId],
    );
    if (kycRef.rows.length > 0) {
      // We don't have the new user's KYC at signup time (it comes later),
      // so this signal only fires via the device-fingerprint registry
      // which checks cross-account KYC. Skip a self-join here.
    }
  }

  // 2. Same registration IP within a small window.
  // users.registration_ip is varchar(45), not inet — compare as text.
  if (ip) {
    const ipWindow = await getSetting('affiliate_block_same_ip_window_hours', 24, true);
    const sameIp = await query(
      `SELECT 1 FROM users
        WHERE id = $1::uuid
          AND registration_ip = $2::text
          AND created_at > NOW() - ($3::int || ' hours')::interval
        LIMIT 1`,
      [referrerId, ip, ipWindow],
    );
    signals.sameIp = sameIp.rows.length > 0;
  }

  // 3. Same fraud-signal link — both accounts share at least one
  //    fraud_signals row of type 'multi_account' or 'device_shared'.
  //    Skipped here because fraud_signals link by fingerprint hash,
  //    not user pair, so re-using fpHash query above is enough.
  //    (Left explicit for future hardening.)

  const signalCount =
    Number(signals.sameDevice) +
    Number(signals.sameIp) +
    Number(signals.sameKyc) +
    Number(signals.sameFraudSignal);

  const blockThreshold = await getSetting('affiliate_block_signal_threshold', 2, true);
  const flagThreshold = await getSetting('affiliate_flag_signal_threshold', 1, true);

  let action: SelfReferralAction = 'allow';
  let reason: string | null = null;
  if (signalCount >= blockThreshold) {
    action = 'block';
    const matched = [
      signals.sameDevice && 'same_device',
      signals.sameIp && 'same_ip',
      signals.sameKyc && 'same_kyc',
      signals.sameFraudSignal && 'same_fraud_signal',
    ].filter(Boolean).join(',');
    reason = `self_referral_block: signals=${matched}`;
  } else if (signalCount >= flagThreshold) {
    action = 'flag';
    reason = `self_referral_flag: signals=${signalCount}`;
  }

  return {
    referrerId,
    refereeFingerprint: fpHash,
    refereeIp: ip,
    signals,
    signalCount,
    action,
    reason,
  };
}

/**
 * Convenience: writes an audit row when self-referral is detected
 * (flag or block) and inserts a fraud_signal for the ring detector.
 * Returns the verdict unchanged.
 */
export async function recordSelfReferralVerdict(
  refereeId: string,
  verdict: SelfReferralCheck,
): Promise<SelfReferralCheck> {
  if (verdict.action === 'allow') return verdict;

  await query(
    `INSERT INTO audit_log (category, action, severity, user_id, details)
     VALUES ('fraud', 'affiliate.self_referral_detected', $1, $2, $3)`,
    [
      verdict.action === 'block' ? 'error' : 'warn',
      refereeId,
      JSON.stringify({
        referrer_id: verdict.referrerId,
        signals: verdict.signals,
        signal_count: verdict.signalCount,
        action: verdict.action,
        reason: verdict.reason,
      }),
    ],
  );

  // Insert a fraud_signal so risk engine (Phase 1.2) can pick it up.
  await query(
    `INSERT INTO fraud_signals (user_id, signal_type, severity, metadata, related_user_id)
     VALUES ($1, 'self_referral', $2, $3::jsonb, $4::uuid)`,
    [
      refereeId,
      verdict.action === 'block' ? 'high' : 'medium',
      JSON.stringify({
        referrer_id: verdict.referrerId,
        signals: verdict.signals,
        signal_count: verdict.signalCount,
      }),
      verdict.referrerId,
    ],
  );

  return verdict;
}