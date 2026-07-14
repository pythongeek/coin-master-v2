# P3 — Deposit-Side KYC (Complete Design Doc)

> **Companion to `/root/P3-KYC-DESIGN.md` (regulatory rationale)**
> This file = the *implementation* plan with concrete code + SQL + UX.

---

## Goal

Bring deposits in line with KYC requirements so CryptoFlip doesn't:
1. **Violate FATF Travel Rule** (≥ USD 1,000 transfers need verified customer info)
2. **Violate FinCEN MSB rules** (custodial wallets must KYC customers)
3. **Allow self-excluded users to keep depositing** (responsible-gambling harm)
4. **Allow sanctioned-country residents to deposit**

The fix is **tiered enforcement**: small deposits stay frictionless for new users to try the platform; larger deposits require proportional KYC verification.

---

## Tiered deposit rules (the core table)

| Daily deposit cumulative | Max single tx | KYC required | Tier | What gets verified |
|---|---|---|---|---|
| < **50 USDT** | 50 USDT | None | 0 (unverified) | Email + DOB + country only (basic signup) |
| **50 – 499 USDT** | 500 USDT | Tier 1 (basic) | 1 | + Government ID number + selfie holding ID |
| **500 – 9,999 USDT** | 5,000 USDT | Tier 2 (intermediate) | 2 | + Proof of address (utility bill < 3 months) |
| ≥ **10,000 USDT** | 50,000 USDT | Tier 3 (full) | 3 | + Source of funds declaration + enhanced due diligence |

All thresholds **configurable** via `admin_settings` table.

**Plus** (HARD BLOCKS, no override except super_admin):
- Self-excluded users (existing check from P1)
- Sanctioned-country residents: IR, KP, SY, CU (and any additions)
- Age < 18

---

## Code changes — full breakdown

### A. Database (1 migration)

**`migrations/024_deposit_kyc.sql`** — adds 2 columns + 4 admin_settings:

```sql
-- New per-user override (super_admin can grant temporary exemption)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_deposit_override_until timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_deposit_override_reason text,
  ADD COLUMN IF NOT EXISTS kyc_deposit_override_by    uuid REFERENCES users(id);

-- New admin config: tier thresholds (per-tier max single-tx amount)
INSERT INTO admin_settings (key, value, description) VALUES
  ('deposit_tier0_max_per_tx',  '50',     'Max single-tx deposit for tier0 (USDT)'),
  ('deposit_tier1_max_per_tx',  '500',    'Max single-tx deposit for tier1 (USDT)'),
  ('deposit_tier2_max_per_tx',  '5000',   'Max single-tx deposit for tier2 (USDT)'),
  ('deposit_tier3_max_per_tx',  '50000',  'Max single-tx deposit for tier3 (USDT)'),
  ('deposit_tier0_max_daily',   '50',     'Max daily cumulative deposit for tier0 (USDT)'),
  ('deposit_tier1_max_daily',   '500',    'Max daily cumulative deposit for tier1 (USDT)'),
  ('deposit_tier2_max_daily',   '10000',  'Max daily cumulative deposit for tier2 (USDT)'),
  ('deposit_tier3_max_daily',   '100000', 'Max daily cumulative deposit for tier3 (USDT)'),
  ('deposit_kyc_enforcement_mode', 'warn', 'off | warn | strict. Default warn for 30-day rollout.'),
  ('deposit_kyc_strict_after',  '2026-08-15', 'Date to auto-flip warn → strict if enforcement_mode=warn'),
  ('deposit_kyc_overrides_allowed', 'true', 'super_admin can grant per-user deposit KYC overrides')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- Audit log table for KYC overrides (regulators want this trail)
CREATE TABLE IF NOT EXISTS kyc_override_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_user_id uuid NOT NULL REFERENCES users(id),
  granted_until timestamptz NOT NULL,
  reason text NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_kyc_override_log_user ON kyc_override_log(user_id, created_at DESC);
```

### B. Backend — service layer (1 file change)

**`binance-pay-qr.service.ts` — `initiateQrDeposit()`** — add this block right after the daily-cap check:

```typescript
// P3: Deposit-side KYC enforcement
const kycCheck = await checkDepositKyc(input.userId, input.amountUsdt);
if (!kycCheck.allowed) {
  throw new Error(kycCheck.reason);
}
```

New helper `checkDepositKyc()` (in `kyc-enforcement.service.ts`):

```typescript
export async function checkDepositKyc(
  userId: string,
  amountUsdt: number
): Promise<{ allowed: boolean; reason: string; tier: number; required: number }> {
  // 1. Read user
  // 2. HARD BLOCKS:
  //    a. self_excluded_until > now → block
  //    b. kyc_country in [IR, KP, SY, CU, AF] → block  
  //    c. age < 18 (from kyc_verified_at... or DOB column if we add it) → block
  // 3. Check per-user override (kyc_deposit_override_until > now) → allow
  // 4. Read admin thresholds from admin_settings
  // 5. Compute user's current tier (kyc_tier → 0/1/2/3)
  // 6. Pick the smallest tier whose max_per_tx >= amountUsdt → that's the REQUIRED tier
  //    (e.g. depositing 600 USDT → tier1 max is 500, tier2 max is 5000 → required tier 2)
  // 7. If required tier > user's tier → block with friendly message
  // 8. If 'warn' mode → log + email user but allow
  // 9. Return allowed + the tier info (used by route for response)
}
```

### C. Backend — admin routes (1 file new + 1 extension)

**NEW: `routes/admin-kyc.ts`** — admin CRUD for overrides + view overrides log:

```
GET    /api/admin/kyc/overrides          → list all active overrides
POST   /api/admin/kyc/overrides          → grant override to a user (super_admin only)
DELETE /api/admin/kyc/overrides/:userId  → revoke override
GET    /api/admin/kyc/overrides-log      → full audit trail (paginated)
GET    /api/admin/kyc/deposit-stats      → how many users are blocked + amounts
```

Body for POST override:
```json
{
  "userId": "uuid",
  "grantedDays": 30,
  "reason": "VIP customer - KYC in progress with bank statement"
}
```

**EXTENSION to `admin-payments-qr.ts`**: when admin manually credits a deposit (`/release`), warn if user doesn't meet deposit KYC for that amount, log the override in `kyc_override_log`.

### D. Frontend — 3 changes

1. **`/wallet/deposit` page** — when `/initiate` returns 403 + `requires_kyc_upgrade: true`, show a friendly panel:
   ```
   ┌─────────────────────────────────────────────────┐
   │  Verify your identity to deposit 600 USDT        │
   │  ──────────────────────────────────────────────  │
   │  Current verified tier: Basic (Tier 1)          │
   │  Required for this deposit: Tier 2 (ID + address)│
   │                                                  │
   │  [ Start verification ] [ Lower amount ]          │
   └─────────────────────────────────────────────────┘
   ```
2. **`/admin` → KYC Overrides tab** — list/grant/revoke
3. **Reuse the `AdminSystemLogs` style** — add a "Deposit KYC" stats card to admin overview

### E. UX copy (English + Bengali)

| Tier required | English message | Bengali message |
|---|---|---|
| Tier 0 → Tier 1 | "Complete identity verification to deposit more than 50 USDT/day" | "৫০ মার্কিন ডলারের বেশি জমা দিতে পরিচয় যাচাই করুন" |
| Tier 1 → Tier 2 | "Verify your address to deposit more than 500 USDT/day" | "৫০০ মার্কিন ডলারের বেশি জমা দিতে ঠিকানা যাচাই করুন" |
| Sanctioned country | "Deposits are not available in your region" | "আপনার অঞ্চলে জমা গ্রহণযোগ্য নয়" |
| Self-excluded | "Your account is in a self-exclusion period until <date>" | "<তারিখ> পর্যন্ত আপনার অ্যাকাউন্ট স্ব-বর্জনে আছে" |

---

## Migration / rollout plan (3 phases, 30 days total)

### Phase 1: `warn` mode (Days 1–14)
- Code ships, KYC checks run, but ALL blocks downgrade to **warnings**
- Every blocked deposit gets logged + queued email: *"Your deposit was processed but we recommend verifying your identity for higher limits"*
- No user friction — just observability
- Goal: measure how many deposits WOULD be blocked

### Phase 2: Hybrid (Days 15–30)
- Tier 0 → Tier 1 block at 50 USDT/day becomes **HARD** (most jurisdictions require this)
- Tier 1 → Tier 2/3 still warn-only (give users time to upgrade)
- Self-exclusion + sanctioned country blocks are HARD from Day 1 (legal requirement)

### Phase 3: `strict` mode (Day 30+)
- All tier checks become HARD blocks
- Only path to bypass: admin override + reason + audit log
- `deposit_kyc_strict_after` config auto-flips on the date set in admin_settings

### Grandfathering for existing users
- All existing users get `kyc_deposit_override_until = NOW() + 30 days` at deploy time
- They get 1 email + 1 in-app banner saying "Verify by <date> to keep your deposit privileges"
- On Day 30, anyone still at tier 0 gets a soft cap of 50 USDT/day
- New users (post-deploy) have NO override — they hit the tier system immediately

---

## Admin override use cases (real scenarios)

| Scenario | Override needed? | Notes |
|---|---|---|
| New user deposits 800 USDT before completing KYC | Yes — tier 2 | VIP fast-track with reason "VIP-pending-KYC" |
| Self-excluded user requests crypto return | NO — fund return path | Admin uses /api/admin/wallet/adjust |
| Sanctioned country (IR) user | NO — refuse | Flag account, escalate to compliance officer |
| VIP customer passes video KYC, awaiting system sync | Yes — 7 days | Track in compliance spreadsheet |
| Chargeback investigation | NO — different flow | Use existing refund endpoint |
| P2P marketplace sell | NO — different flow | Use existing /api/admin/wallet/adjust |

---

## Rollout risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Users blocked, churn | Medium | Medium | 30-day warn mode, grandfathering, in-app banner |
| False positive (legitimate user blocked) | Low | High | Per-user override + audit log; admin alerts |
| Self-excluded user finds workaround (alt account) | Medium | High | IP + device fingerprinting (future P5 work) |
| Regulator audit (e.g. MGA) | Low | Critical | Audit log + override trail + age check |
| Bin P3 breaks existing happy-path deposits | Low | High | Warn mode for 14 days → measure before hardening |

---

## Estimated scope

- **1 migration** (SQL)
- **1 new service** (`kyc-enforcement.service.ts`, ~200 LOC)
- **1 service edit** (`binance-pay-qr.service.ts`, +5 LOC)
- **1 new admin route** (`routes/admin-kyc.ts`, ~250 LOC)
- **1 mount in `index.ts`** (+2 LOC)
- **Frontend deposit page error handling** (~50 LOC)
- **Frontend admin overrides page** (new component, ~300 LOC)
- **Tests** (`test/deposit-kyc.test.ts`, ~150 LOC)
- **Migration of existing users** (one-time SQL at deploy)

**Total: ~1000 LOC, 6 files, ~2-3 hours.**

---

## Configuration defaults (what gets seeded at deploy)

```sql
-- Thresholds (admin can change later)
deposit_tier0_max_per_tx = 50
deposit_tier0_max_daily = 50
deposit_tier1_max_per_tx = 500
deposit_tier1_max_daily = 500
deposit_tier2_max_per_tx = 5000
deposit_tier2_max_daily = 10000
deposit_tier3_max_per_tx = 50000
deposit_tier3_max_daily = 100000

-- Rollout schedule
deposit_kyc_enforcement_mode = 'warn'        -- safe default
deposit_kyc_strict_after = NOW() + INTERVAL '30 days'

-- Grandfathering (run after migration)
UPDATE users SET kyc_deposit_override_until = NOW() + INTERVAL '30 days',
                 kyc_deposit_override_reason = 'Grandfathered at P3 deploy',
                 kyc_deposit_override_by = (SELECT id FROM users WHERE username='owner')
WHERE created_at < NOW() - INTERVAL '1 hour'  -- skip users created in last hour
  AND kyc_tier = '0' OR kyc_tier IS NULL;
```

---

## Success metrics (90 days post-launch)

1. **KYC completion rate**: % of users who start a deposit >50 USDT that end up verifying
2. **Block rate**: % of deposit attempts that get blocked at each tier
3. **Self-exclusion breach rate**: # of self-excluded users who try to deposit (should be 0)
4. **Sanctioned-country deposits**: # blocked (should be 0)
5. **Override usage**: # of admin overrides granted, # revoked early, average duration
6. **Conversion impact**: deposit volume change (warn vs strict mode)

---

## Files this PR will touch

| File | Type | LOC |
|---|---|---|
| `backend/migrations/024_deposit_kyc.sql` | NEW | +40 |
| `backend/src/services/kyc-enforcement.service.ts` | NEW | +200 |
| `backend/src/services/binance-pay-qr.service.ts` | EDIT | +10 |
| `backend/src/routes/admin-kyc.ts` | NEW | +250 |
| `backend/src/index.ts` | EDIT | +5 |
| `frontend/app/wallet/deposit/page.tsx` | EDIT | +50 |
| `frontend/components/dashboard/AdminKycOverrides.tsx` | NEW | +300 |
| `frontend/components/dashboard/AdminClientShell.tsx` | EDIT | +10 |
| `frontend/lib/api/wallet.ts` | EDIT | +20 |
| `docs/deposit-kyc.md` | NEW | +200 |

**Total: 10 files, ~1085 LOC.**

---

## Open questions for owner (need your input)

1. **Should the Tier 0 limit be 50 USDT or higher?** iGaming in BD market tends to be lower-stakes; 50 is FATF-safe. But you might want 20 or 100.
2. **Self-exclusion enforcement — hard or reversible?** I recommend hard (no override). But if VIPs need a path to play despite self-exclusion, that's a separate flow.
3. **Sanctioned country list** — current code uses IR/KP/SY/CU/AF (P4 risk service). Want to add more? (RU, VE, MM?)
4. **Override duration default** — I picked 30 days. Want 7/14/60?
5. **Email language for KYC upgrade prompts** — Bengali only? English only? Both?
6. **Auto-deactivation on bad KYC** — if KYC expires (e.g. ID is 5 years old), auto-set user to tier0. Or just warn?
7. **Age column** — we don't have a DOB column. Add one? Use age computed from passport MRZ? Require it in the basic KYC step?

---

## Status

- Design: **DONE**
- Documentation: **DONE** (this file + `/root/P3-KYC-DESIGN.md`)
- Code: **NOT STARTED** (waiting for owner input on the 7 open questions + go-ahead)

Once you answer the open questions + say "go", I can implement P3 in ~2-3 hours with the 30-day phased rollout.

---

## UPDATE 2026-07-14 — Owner Decision Log

**See `/root/P3-FINAL-DECISIONS.md` for full details.**

### Key changes from initial draft

| Dimension | Was | Now |
|---|---|---|
| Tier 0 limit | 50 USDT | **100 USDT** |
| Tier thresholds | Hardcoded in code | **DB-driven + admin-editable** |
| Sanctioned countries | `[IR, KP, SY, CU, AF]` hardcoded | **DB-driven, admin add/remove** |
| Per-country exception | None | **Admin-grantable per user** |
| Self-exclusion reversal | Not addressed | **Reversible by admin** (24h cooling default) |
| Self-exclusion extend | Not addressed | **Admin-grantable per user** |
| Override duration | Fixed 30 days | **Per-grant, admin chooses** |
| Email language | English only | **EN + BN bilingual** |
| KYC expiry | Not addressed | **Warn-first + admin-controlled auto-downgrade** |
| User language preference | None | New `users.preferred_language` column |

### Admin Route Catalog (final, 15+ endpoints)

```
Settings & Config (read + write):
  GET/POST  /api/admin/kyc/thresholds
  GET/POST  /api/admin/kyc/sanctioned-countries
  POST      /api/admin/kyc/sanctions-exception
  GET/POST  /api/admin/kyc/expiry-policy

Per-User Overrides:
  GET       /api/admin/kyc/overrides
  POST      /api/admin/kyc/overrides
  DELETE    /api/admin/kyc/overrides/:userId
  GET       /api/admin/kyc/overrides-log (audit trail)

Self-Exclusion:
  GET       /api/admin/kyc/self-exclusions
  POST      /api/admin/kyc/self-exclusion/reverse
  POST      /api/admin/kyc/self-exclusion/extend

Stats & Visibility:
  GET       /api/admin/kyc/deposit-stats
  GET       /api/admin/kyc/audit-summary
```

### Updated scope estimate

- ~2025 LOC total (up from 1085)
- ~3-4 hours of work
- 10 new admin endpoints + 6 bilingual email templates + 4-tab admin UI

### Ready for implementation

Awaiting "go" to start coding.
