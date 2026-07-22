# P3 — Final Decisions Log

> **Owner answers received + admin-control matrix defined.**

---

## Tier 0 → 3 Deposit Limits (FINAL)

| Tier | Max single-tx | Max daily cumulative | KYC required |
|---|---|---|---|
| **0 (unverified)** | **100 USDT** | **100 USDT** | None |
| 1 (basic) | 500 USDT | 500 USDT | Email + DOB + ID + selfie |
| 2 (intermediate) | 5,000 USDT | 10,000 USDT | + Proof of address |
| 3 (full) | 50,000 USDT | 100,000 USDT | + Source of funds + EDD |

**All thresholds are admin-configurable** via `admin_settings` keys:
- `deposit_tier0_max_per_tx`, `deposit_tier0_max_daily`
- `deposit_tier1_max_per_tx`, `deposit_tier1_max_daily`
- `deposit_tier2_max_per_tx`, `deposit_tier2_max_daily`
- `deposit_tier3_max_per_tx`, `deposit_tier3_max_daily`

Defaults ship with the values above. Admin can tune without code changes.

---

## Admin Controls Matrix (all 7 areas)

| Area | Default behavior | Admin override | Audit logged? |
|---|---|---|---|
| **Tier thresholds** | Defaults set | `POST /api/admin/kyc/thresholds` | ✅ Yes (`admin_settings` history) |
| **Sanctioned countries** | `[IR, KP, SY, CU, AF]` | `POST /api/admin/kyc/sanctioned-countries` (add/remove) | ✅ Yes (`kyc_override_log`) |
| **Per-country exception** | None | `POST /api/admin/kyc/sanctions-exception` for a specific user | ✅ Yes (`kyc_override_log`) |
| **Self-exclusion reversal** | Hard block | `POST /api/admin/kyc/self-exclusion/reverse` for a user (always with reason) | ✅ Yes (`kyc_override_log`) |
| **Per-user KYC override** | 30 days | `POST /api/admin/kyc/overrides` with `grantedDays` parameter | ✅ Yes (`kyc_override_log`) |
| **KYC expiry** | Warn only | `POST /api/admin/kyc/expiry-policy` (per-tier auto-downgrade ON/OFF + grace days) | ✅ Yes |
| **Email language** | Both EN + BN | Per-user preferred language | ✅ Yes |

---

## Sanctioned Countries

**Initial list** (matches P4 risk service): `IR, KP, SY, CU, AF`

**Admin actions:**
```
GET    /api/admin/kyc/sanctioned-countries
  → { list: ['IR', 'KP', ...], updatedAt, updatedBy }

POST   /api/admin/kyc/sanctioned-countries
  body: { action: 'add' | 'remove', country: 'RU', reason: 'Updated per OFAC advisory 2026-Q3' }
  → 200 OK + audit log entry

POST   /api/admin/kyc/sanctions-exception
  body: { userId, country: 'IR', expiresAt: '2026-09-01', reason: 'Verified dual citizenship + clean record' }
  → 200 OK + audit log entry
```

**Per-user exception** allows a single user from a sanctioned country to deposit, with strict audit trail. Use cases: diplomatic staff, verified dual citizens, recovering assets before account closure.

---

## Self-Exclusion

**Default:** HARD block on any deposit attempt when `self_excluded_until > NOW()`

**Admin actions:**
```
GET    /api/admin/kyc/self-exclusions
  → active exclusions list (paginated)

POST   /api/admin/kyc/self-exclusion/reverse
  body: { userId, reason: 'User requested reversal per MGA complaint #12345' }
  → 200 OK + audit log entry
  → sets self_excluded_until = NULL
  → ALWAYS requires reason (≥ 20 chars) + super_admin role

POST   /api/admin/kyc/self-exclusion/extend
  body: { userId, additionalDays: 30, reason: 'Self-exclusion confirmed via support chat' }
  → 200 OK + audit log entry
```

**Reversal audit trail:**
- Who reversed (admin user_id)
- When reversed (timestamp)
- Why reversed (reason text)
- User's original exclusion date (for context)
- Sends confirmation email to user (both languages)

**Optional safeguard:** Can be configured (per-region) to require 24h cooling-off period before reversal takes effect (responsible-gambling best practice).

---

## Per-User KYC Override

**Used for:** VIP customers awaiting KYC sync, compliance holds, etc.

```
POST   /api/admin/kyc/overrides
  body: {
    userId: 'uuid',
    grantedDays: 30,                // 7/14/30/60/custom
    scope: 'deposit' | 'withdrawal' | 'all',  // or just 'deposit' for P3
    reason: 'VIP customer — KYC in progress with notarized docs'
  }
  → 200 OK + audit log entry
  → sets kyc_deposit_override_until = NOW() + grantedDays * INTERVAL '1 day'

DELETE /api/admin/kyc/overrides/:userId
  → revokes override (sets the column to NULL)

GET    /api/admin/kyc/overrides
  → list all active overrides (paginated)
```

**Auto-expiry:** Once `kyc_deposit_override_until < NOW()`, the override no longer applies — user falls back to tier checks. No manual cleanup needed.

**Configurable duration:** Default 30 days, but admin can grant 7/14/30/60/custom days per request.

---

## KYC Expiry Policy

**Use case:** User verified Tier 3 KYC in 2024. By 2026 their passport expires. Should we auto-downgrade?

**Default policy (admin-configurable):**
- `kyc_expiry_check_enabled`: `false` (default — KYC doesn't auto-expire)
- `kyc_expiry_grace_days`: `90` (after expiry, warn for 90 days before action)
- `kyc_expiry_auto_action`: `'warn_only'` (default), `'downgrade_to_tier0'`, `'downgrade_to_tier1'`

**Behavior when enabled:**
1. On each deposit, check if `kyc_verified_at + tier_max_age` < NOW()
2. If yes:
   - In `warn_only` mode: log + email user "Your KYC is aging, please re-verify"
   - In `downgrade_to_tierN` mode: warn + auto-set kyc_tier = tierN until re-verified
3. Admin can override per-user with KYC override (above)

**Tier max ages** (admin-configurable):
- `kyc_tier1_max_age_days`: `1825` (5 years)
- `kyc_tier2_max_age_days`: `1095` (3 years)
- `kyc_tier3_max_age_days`: `365` (1 year)

---

## Email Language Strategy

**Both English AND Bengali** for every KYC notification. Implementation:

1. User table has new column `preferred_language` (default 'en')
2. Every notification template in `admin_email_templates` table has both `subject_en`, `subject_bn`, `body_html_en`, `body_html_bn` fields
3. Notification service picks language based on `user.preferred_language`
4. User can change preference in `/settings`

**Default language for new users:** `en` (Bangladesh users can switch in settings)

**KYC-specific emails (both languages):**
- `kyc.upgrade_required` — when deposit amount exceeds current tier
- `kyc.expiring_soon` — when KYC is aging (45-day warning)
- `kyc.expired` — when KYC has expired
- `kyc.override_granted` — when admin grants an override
- `kyc.override_revoked` — when admin revokes
- `kyc.sanction_exception_granted` — per-user sanctions exception

---

## Implementation Updates to P3-IMPLEMENTATION-PLAN.md

**Changes from original plan:**

| Original | New |
|---|---|
| Tier 0 = 50 USDT/day | Tier 0 = **100 USDT/day** |
| Sanctioned list hardcoded | Sanctioned list = **DB-driven + admin-editable** |
| Self-exclusion always hard | Self-exclusion **reversible by admin** (with audit) |
| Override = fixed 30 days | Override = **admin-chosen days** per grant |
| English-only emails | **EN + BN bilingual** for all KYC notifications |
| KYC expiry not addressed | KYC expiry = **3-tier policy** (warn / downgrade-to-0 / downgrade-to-1) + admin-controlled |
| Thresholds = code constants | Thresholds = **DB-driven + admin-editable** |

---

## Database Migration Updates

`migrations/024_deposit_kyc.sql` will include:

```sql
-- Per-user language preference
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_language varchar(5) NOT NULL DEFAULT 'en';

-- New admin_settings entries (defaults shipped)
INSERT INTO admin_settings (key, value, description) VALUES
  -- Tier thresholds (admin-editable)
  ('deposit_tier0_max_per_tx', '100',     'Tier 0 max single-tx deposit (USDT)'),
  ('deposit_tier0_max_daily',  '100',     'Tier 0 max daily cumulative deposit (USDT)'),
  ('deposit_tier1_max_per_tx', '500',     'Tier 1 max single-tx deposit (USDT)'),
  ('deposit_tier1_max_daily',  '500',     'Tier 1 max daily cumulative deposit (USDT)'),
  ('deposit_tier2_max_per_tx', '5000',    'Tier 2 max single-tx deposit (USDT)'),
  ('deposit_tier2_max_daily',  '10000',   'Tier 2 max daily cumulative deposit (USDT)'),
  ('deposit_tier3_max_per_tx', '50000',   'Tier 3 max single-tx deposit (USDT)'),
  ('deposit_tier3_max_daily',  '100000',  'Tier 3 max daily cumulative deposit (USDT)'),
  -- Sanctioned country list (admin-editable as JSON array)
  ('kyc_sanctioned_countries', '["IR","KP","SY","CU","AF"]',
   'ISO country codes blocked from deposits (admin-editable)'),
  -- KYC expiry policy
  ('kyc_expiry_check_enabled', 'false',
   'If true, KYC ages out per tier_max_age_days'),
  ('kyc_expiry_grace_days', '90',
   'Days after expiry before auto-action'),
  ('kyc_expiry_auto_action', 'warn_only',
   'warn_only | downgrade_to_tier0 | downgrade_to_tier1'),
  ('kyc_tier1_max_age_days', '1825', '5 years'),
  ('kyc_tier2_max_age_days', '1095', '3 years'),
  ('kyc_tier3_max_age_days', '365',  '1 year'),
  -- Self-exclusion config
  ('self_exclusion_reversal_cooling_hours', '24',
   'Hours before reversal takes effect (0 = instant, 24 = standard)'),
  -- Bilingual notifications
  ('email_default_language', 'en',
   'Default language for new users (en | bn)'),
  -- Rollout (unchanged from original plan)
  ('deposit_kyc_enforcement_mode', 'warn',
   'off | warn | strict'),
  ('deposit_kyc_strict_after',  '2026-08-15',
   'Date to auto-flip warn → strict')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;
```

---

## Admin Route Summary (updated)

```
Existing (Phase 6 admin/email):
  GET    /api/admin/email/smtp-status
  POST   /api/admin/email/test
  ...

NEW for P3:

GET    /api/admin/kyc/thresholds
  → all tier limits + sanctioned list + expiry policy + rollout mode
  → admin can read full config in one call

POST   /api/admin/kyc/thresholds
  body: { tier: 0, maxPerTx: 200, maxDaily: 200 }   // single threshold update
  OR:    { sanctionedCountries: ['IR', 'KP', 'VE'] }   // replace sanctioned list
  OR:    { expiryPolicy: { enabled: true, autoAction: 'downgrade_to_tier1' } }
  → audit log

GET    /api/admin/kyc/sanctioned-countries
  → { list: [...], updatedAt, updatedBy }

POST   /api/admin/kyc/sanctioned-countries
  body: { action: 'add' | 'remove', country: 'XX', reason: '...' }

POST   /api/admin/kyc/sanctions-exception
  body: { userId, country, expiresAt, reason }

GET    /api/admin/kyc/self-exclusions?status=active|expired
  → paginated

POST   /api/admin/kyc/self-exclusion/reverse
  body: { userId, reason }   // reason ≥ 20 chars

POST   /api/admin/kyc/self-exclusion/extend
  body: { userId, additionalDays, reason }

GET    /api/admin/kyc/overrides
  → list active overrides

POST   /api/admin/kyc/overrides
  body: { userId, grantedDays, scope, reason }

DELETE /api/admin/kyc/overrides/:userId
  → revoke

GET    /api/admin/kyc/overrides-log
  → full audit trail (paginated, filterable by action)

POST   /api/admin/kyc/expiry-policy
  body: { enabled, autoAction, graceDays }

GET    /api/admin/kyc/deposit-stats
  → block counts per tier + would-be-blocked (in warn mode) + sanctioned blocks
```

---

## Frontend Admin UI Updates

The `AdminKycOverrides` component grows from 1 tab to 4 tabs:

| Tab | What it shows |
|---|---|
| **Overrides** | Active per-user overrides + grant/revoke + audit log |
| **Self-Exclusions** | Active exclusions + reverse/extend |
| **Sanctions** | Sanctioned country list + per-country exceptions |
| **Settings** | Tier thresholds + expiry policy + rollout mode + email language |

---

## Updated Estimate

| Change | LOC delta |
|---|---|
| Sanctioned list admin routes | +120 |
| Self-exclusion reversal/extend routes | +80 |
| Override grant with custom days | +60 |
| KYC expiry policy routes | +80 |
| Bilingual email templates | +200 (5 templates × 2 langs) |
| Admin UI tabs (3 → 4) | +400 |
| Total | **+940 LOC** |

**New total: ~2025 LOC** (up from 1085), ~3-4 hours of work.

---

## Status

- ✅ All 7 owner questions answered
- ✅ Tier 0 = 100 USDT confirmed
- ✅ Admin-control matrix defined for every dimension
- ✅ Bilingual (EN + BN) notification strategy confirmed
- ✅ KYC expiry = warn-first + admin-controlled auto-action
- ✅ Design updated (this file)
- ⏳ Ready to code once you say "go"