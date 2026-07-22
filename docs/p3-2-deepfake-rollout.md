# Phase 3 / P3-2 — Deepfake KYC Rollout (RISK-SIGNAL, NOT BLOCKING)

> This document is the **operator runbook** for admin/operator. It is **not
> code** — every step below will become real code in the upcoming P3-2
> sub-steps. Read this before flipping any switch.

## TL;DR

| Sub-step | What lands | Production risk when shipped | Switch position |
|---|---|---|---|
| **P3-2a** *(this one)* | Migration 038 + 6 `admin_settings` defaults. **No behaviour change.** | None — pure schema + flag. | All OFF. |
| P3-2b | New `services/deepfake-detector.ts` with `noop` + `http` providers. Admin-controlled URL/timeout/threshold. | None — default provider is noop. | OFF. |
| P3-2c | Hook into `kyc-uniqueness.ts` (submitKYC) — best-effort, never blocks. | None — only writes `users.deepfake_score`. | OFF until URL is set. |
| P3-2d | Add 3 features to `FEATURE_COLUMNS` (`deepfake_score`, `deepfake_check_recent`, `kyc_deepfake_strictness`). Updates `notebooks/01_train_xgboost_labelled_fraud.ipynb` so trainer stays in sync. | Low — feature values are 0 until toggle goes live; old trained models ignore the new columns via `feature_columns.json` in ml_models. | OFF. |
| P3-2e | Admin KYC review panel: deepfake_score column + threshold badge + filter. | None — operator visibility only. | OFF. |
| P3-2f | AdminSettingsPanel: 6 deepfake knobs (enable, endpoint, timeout, threshold, block_above, log_image). | None — UI only. | OFF. |

**`block_above` MUST stay `false` permanently** until the operator has manually reviewed ≥ 100 deepfake_scores against real fraud cases AND verified the threshold's false-positive rate is < 1%.

---

## Migration 038 (P3-2a — already applied)

Applied via `backend/migrations/038_kyc_deepfake.sql`. Adds:

| Object | Purpose |
|---|---|
| `users.deepfake_score REAL NULL` | Probability 0..1 from the detector. NULL until P3-2b/c wires the call. |
| `users.deepfake_checked_at TIMESTAMPTZ NULL` | When the last check ran. Used for staleness (only trust recent scores). |
| `users.deepfake_check_status` text NULL (`not_run`/`ok`/`error`/`skipped`/`timeout`) | Cheap quick-filter for the operator. |
| `kyc_deepfake_audit` (table) | Append-only log of EVERY check — provides the compliance chain when the master switch flips. |
| 3 indexes (user+time, kyc+time, score-only) | Fast panels + reports. |
| 6 `admin_settings` rows | Defaults below. |

Seeded `admin_settings` (all safe defaults):

```
kyc_deepfake_enabled          = false     -- master switch; nothing happens while false
kyc_deepfake_endpoint         = ""        -- admin fills when wiring a real detector
kyc_deepfake_timeout_ms       = 2000      -- 2s HTTP budget per check
kyc_deepfake_score_threshold  = 0.70      -- P3-2b honours this ONLY as "open fraud_signal for review"
kyc_deepfake_block_above      = false     -- KEEP false; see "Hard-block policy" below
kyc_deepfake_log_image        = false     -- never store the selfie in audit; PII risk
```

### Hard-block policy (very explicit)

`kyc_deepfake_block_above=true` is the ONE flag that can prevent a real user from playing the casino. Treat it like nuclear launch codes:

1. It defaults to `false` for the lifetime of this platform.
2. Anyone proposing to flip it must **first**:
   - Have ≥ 100 `kyc_deepfake_audit` rows with `status='ok'` for confirmed-fraud users.
   - Have ≥ 100 `kyc_deepfake_audit` rows with `status='ok'` for confirmed-legit users.
   - Run the false-positive rate math: **FP / (FP + TN) must be < 0.5%** for the threshold value.
   - Document those numbers in `docs/p3-2-deepfake-rollout.md` (append below with date + sample size).
3. Even then, prefer staying at `false` and adding a human-review queue instead.

### When `deepfake_score` IS NOT NULL going forward

- It is written by P3-2c **only if** `kyc_deepfake_enabled=true` AND `kyc_deepfake_endpoint` is non-empty.
- It is read by P3-2d as input to `FEATURE_COLUMNS` for retrained XGBoost models.
- It appears in `AdminKycPanel` (P3-2e) as a column + a red badge when `score ≥ score_threshold`.
- It NEVER auto-blocks unless `kyc_deepfake_block_above=true`. Even then, it should be the LAST thing you flip.

---

## P3-2b — `services/deepfake-detector.ts` (to do)

Provider interface, two implementations:

1. `NoopProvider()` — returns `null` (no signal). Default.
2. `HttpProvider({ url, timeoutMs, apiKeyHeader? })` — POSTs `{image_url}` to `url`, expects `{score}` back.

Public API:

```ts
export async function checkImageForDeepfake(
  userId: string,
  imageUrl: string,
  kycSubmissionId?: string,
): Promise<{
  score: number | null;   // 0..1 or null = skip / error
  status: 'ok' | 'error' | 'skipped' | 'timeout';
  durationMs: number;
  endpoint: string;
}>;
```

Side effects (best-effort, never blocks the KYC submit):
- Writes one `kyc_deepfake_audit` row.
- Updates `users.deepfake_score` + `users.deepfake_checked_at` + `users.deepfake_check_status`.
- IF `score ≥ kyc_deepfake_score_threshold` AND `kyc_deepfake_enabled=true` → open one `fraud_signals` row:
  ```
  user_id = userId
  signal_type = 'deepfake_high_probability'
  severity    = 'warn'   (NOT 'high' — sub-steps until block_above=true)
  status      = 'open'
  metadata    = {score, threshold, endpoint, kyc_submission_id}
  detected_at = NOW()
  ```
  Admin sees this in `Admin → Fraud Center → Recent Alerts` immediately.

Constraints:

- 30-second HTTP timeout hard cap (admin-set value must be ≤ this).
- Cache layer: skip re-checking the same image URL within 24 h (saves the upstream service from abuse).
- NEVER throws — bad upstream = null + audit row status='error', KYC submission proceeds normally.

## P3-2c — Hook into `kyc-uniqueness.ts` (to do)

Inside `submitKYCSafe()` (or just after), after `hashDoc()`:
1. `await checkImageForDeepfake(userId, kyc_selfie_url, kycSubmissionId)` — wrapped in try/catch, log + proceed.
2. Document the call site in `kyc-uniqueness.ts` with a comment linking back to this doc.

## P3-2d — Extend `FEATURE_COLUMNS` (to do)

Three new columns, appended (never reorder!):
```
deepfake_score           REAL (NULL → 0)
deepfake_check_recent    0/1   -- 1 if checked within last 7 days
kyc_deepfake_strictness  REAL  -- admin's threshold normalised
```

`buildFeatureVectorFromRows()` updated. `ai-risk-engine.signalsFromContext` gains one synthetic signal:
```
{
  code: 'deepfake_score_high',
  weight: 5,        -- minor until block_above=true
  detail: 'kyc_deepfake_score ≥ kyc_deepfake_score_threshold within 7d',
}
```

`notebooks/01_train_xgboost_labelled_fraud.ipynb` patch: `FEATURE_COLUMNS` updated to 35 entries, `feature_sql` extended to fetch the new columns.

## P3-2e — `AdminKycPanel` extension (to do)

Three additions to the existing KYC review list:
- New column "Deepfake" with value `0.34 (12h ago)`; red badge when `score ≥ threshold`.
- Filter: "Deepfake only" / "Above threshold".
- Expand row → show full `kyc_deepfake_audit` history for that user (last 5 checks).

## P3-2f — `AdminSettingsPanel` extension (to do)

One new group "Deepfake KYC" with 6 controls (toggle, endpoint, timeout, threshold, block_above, log_image). Mirrors the existing live-config UX.

---

## Manual runbook for the operator (no code involved)

### Before P3-2c ships

1. Pick a deepfake HTTP service to point at. Acceptable: a SaaS API you have a key for, a small in-house XceptionNet microservice, or any service that takes `{image_url}` and returns `{score}`.
2. Sanity-test it from this box:
   ```bash
   curl -s -X POST http://your-deepfake-svc/check \
        -H 'Content-Type: application/json' \
        -d '{"image_url":"https://example.com/selfie.jpg"}'
   # Expect {"score":0.42,"duration_ms":380}
   ```
3. Decide your real threshold + tolerance. We seeded 0.70 as a starting point — adjust in `Admin → Settings → Deepfake KYC → score threshold` after P3-2f ships.
4. Plan your false-positive math. Goal: < 0.5% FP at the operating threshold.

### Day-of-flip (when P3-2c/f are deployed)

1. Open `Admin → Settings → Deepfake KYC` (P3-2f adds this tab).
2. Fill `kyc_deepfake_endpoint` with the URL you tested above.
3. Save. (Endpoint is now configured but the master switch is still off.)
4. **Smoke-test OFF → ON in sequence**:
   ```bash
   # 1. flip endpoint only, keep enabled=false → confirm the row update works
   # 2. flip ON → check logs for 5 minutes → turn OFF if anything weird
   # 3. when confident → ON permanently
   ```
5. Watch `Admin → Fraud Center → Recent Alerts` for `alert_type='DEEPFAKE_001'` (new alias added in P3-2c).
6. Run `SELECT count(*), status FROM kyc_deepfake_audit GROUP BY 2;` weekly — errors should be < 1% of total.

### Compliance checklist (annual)

- [ ] ≥ 100 confirmed-fraud users have `kyc_deepfake_audit` rows with `status='ok'` (proves the detector sees fraud).
- [ ] ≥ 100 confirmed-legit users have `kyc_deepfake_audit` rows with `status='ok'` (proves the detector sees legit).
- [ ] FP rate ≤ 0.5% at the operating threshold.
- [ ] `kyc_deepfake_log_image` is `false` everywhere except dev — proves no PII leaks.
- [ ] `kyc_deepfake_block_above` is `false` — proves no auto-block.

If any of these fail: keep `kyc_deepfake_enabled=true` for signal-collection but DO NOT flip `block_above=true`. The signal still feeds your rule-engine + future ML model.

---

## Quick file index (what each piece needs)

| Sub-step | Backend files | Frontend files | Migration |
|---|---|---|---|
| P3-2a | none (admin_settings already exists) | none | `038_kyc_deepfake.sql` ✓ applied |
| P3-2b | NEW `backend/src/services/deepfake-detector.ts`; minor edit to `admin-settings.service.ts` (just `getAdminSettingNumber` already there) | none | none |
| P3-2c | NEW tiny block inside `kyc-uniqueness.ts`; +1 import | none | none |
| P3-2d | `ml-features.ts` (append 3 cols + update `buildFeatureVectorFromRows` + update `loadUserContext`); `ai-risk-engine.ts` (add 1 synthetic signal) | none | none |
| P3-2e | NEW `GET /api/admin/kyc/deepfake-report` (lightweight endpoint) | edit `AdminKycPanel.tsx` — add column + filter + drill-in | none |
| P3-2f | none (existing `/admin/settings/bulk` covers it) | edit `AdminSettingsPanel.tsx` + `GroupBy` in `ml-features.ts` keeps it clean | none |
| P3-2g (optional bonus) | one-time nightly job recomputing deepfake_score column from cached audit rows | none | none |

Estimated total LOC across P3-2b..f: ~330 (matches my earlier estimate).

---

## Change log (operator-side notes — append on every flip)

```
[date] reason                            sample_size  fp_rate  who
[date] switched on for signal collection  n/a         n/a    @
[date] threshold changed 0.70 → 0.65       n/a         n/a    @
[date] block_above=true: PROHIBITED until  ___        ___    N/A
```

(Don't fill the block_above=true line. If you find yourself writing it, stop and reread the "Hard-block policy" above.)
