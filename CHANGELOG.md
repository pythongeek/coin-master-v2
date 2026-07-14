# CHANGELOG — All phases P0 → P3.4 (since last commit 81b763e)

## 2026-07-08 → 2026-07-14

### Phase 1 — Binance Pay QR Deposit (live)
- **Backend:** `services/binance-pay-qr.service.ts`, `services/binance-pay-ledger-monitor.service.ts`, `services/chain-config.service.ts`, `services/payment-socket.service.ts`
- **Routes:** `routes/wallet-deposit-qr.ts` (POST /initiate, GET /:orderId, GET /list, DELETE /:orderId, GET /active)
- **Scripts:** `simulate-deposit.ts`, `simulate-trc20.ts`
- **Frontend:** `app/wallet/deposit/page.tsx`, `components/wallet/ChainSelector.tsx`, `components/wallet/EquivalentAmounts.tsx`, `lib/usePaymentUpdates.ts`
- **Docs:** `docs/deploy-binance-pay-qr.md`
- **Migration:** `018_binance_pay_qr.sql`, `024_add_cancelled_status.sql` (later fix for cancelled status enum)

### Phase 2 — Socket.IO Real-time Push (live)
- **Backend:** Stable socket singleton, `payment-socket.service.ts` emits events on payment detected
- **Frontend:** `RecentQrDeposits.tsx` subscribes via `usePaymentUpdates` hook

### Phase 3 — Multi-chain (BSC + TRC20 + ERC20) (live)
- **Migration:** `019_multi_chain_qr.sql`, `020_add_kyc_tier_country.sql`
- **Backend:** `chain-config.service.ts` supports per-chain admin toggles
- **Routes:** `routes/admin-payments-qr.ts` chain config CRUD

### Phase 4 — Withdrawal Risk Scoring (live)
- **Backend:** `services/withdrawal-risk.service.ts`, `services/llm-scorer.service.ts`, `services/llm-feedback-loop.service.ts`
- **Routes:** `routes/admin-withdrawals.ts` enhanced with risk signals display

### Phase 5 — Multi-currency Fiat Equivalents (live)
- **Backend:** `routes/public-fx.ts` exposes `/api/public/fx-rates` + `/api/public/fx-convert`
- **Migration:** `021_rate_cache.sql`
- **Frontend:** deposit/withdraw pages show USD + BDT equivalents

### Phase 6 — Email Notifications (live)
- **Backend:** `services/notification.service.ts` (queue + worker + SMTP), `routes/admin-email.ts` (CRUD recipients/templates/queue)
- **Migration:** `022_email_notifications.sql`
- **Frontend:** `AdminEmail.tsx` (4-tab admin UI)

### Phase 7 — Audit Log Viewer (live)
- **Backend:** `routes/admin-audit.ts` (logs, stats, notes, export)
- **Migration:** `023_audit_notes.sql`
- **Frontend:** `AdminSystemLogs.tsx`

### Phase 8 P0 — Critical Bug Fixes (verified)
- **C1:** User-facing `/wallet/withdraw` page (was missing)
- **C2:** Standalone QR expiration worker (60s tick, independent of ledger monitor)
- **C3:** State rehydrate on reload + cancel button
- **S1:** Withdrawal address validation per chain (EVM + TRON + Solana)

### Phase 8 P1 — KYC tier + dead code + socket (verified)
- **Backend:** 4-tier KYC enforcement in withdrawal-queue (50/500/5000/50000 USDT)
- **Backend:** Removed `services/merchant-payment.ts` (dead code, 199 lines), cleaned unused imports
- **Frontend:** KYC tier card on withdraw page + recent deposit socket push

### Phase 8 P2 — Memo + Idempotency + 2FA + History + Receipts + Config (verified)
- **Backend:** `utils/idempotency.ts` (Redis-backed dedup for /initiate)
- **Backend:** `utils/address-validator.ts` (per-chain EIP-55 checksum)
- **Backend:** `routes/auth-2fa.ts` (TOTP setup/verify/disable/status + step-up middleware)
- **Backend:** Config-driven daily deposit cap (admin_settings)
- **Backend:** User-facing receipt download (`GET /api/wallet/deposit/qr/receipts/:orderId[/:receiptId]`)
- **Frontend:** `/wallet/transactions` page (paginated, type-filtered)
- **Frontend:** Receipt list in deposit page

### Phase 8 P3 — Deposit-Side KYC + 15 Admin Endpoints + Bilingual Email (verified)
- **Migration:** `024_deposit_kyc.sql` (7 user columns + `kyc_override_log` + 19 admin_settings)
- **Migration:** `025_bilingual_email_templates.sql` (adds subject_bn / body_html_bn / body_text_bn to admin_email_templates)
- **Backend:** `services/kyc-enforcement.service.ts` (core tier/sanction/age checks + override bypass)
- **Backend:** `routes/admin-kyc.ts` (15 endpoints: config, thresholds, sanctioned-countries, overrides, self-exclusion reverse/extend, sanctions-exception, audit log, deposit stats)
- **Backend:** Bilingual notification: `notification.service.ts` picks language from `users.preferred_language`
- **Frontend:** `AdminKycOverrides.tsx` (4-tab UI: Overrides / Self-Exclusions / Sanctions / Settings)
- **Frontend:** Deposit page error UX for KYC_TIER/KYC_SANCTIONS/KYC_AGE/KYC_SELF_EXCLUSION/KYC_EXPIRED with bilingual message

### Phase 8 P3.4 — Admin Manual Balance Adjustments (verified)
- **Migration:** `026_admin_balance_adjustments.sql` (admin audit table + 4 admin_settings)
- **Backend:** `services/admin-adjustment.service.ts` (credit/deduct with audit + email)
- **Backend:** `routes/admin-balance.ts` (4 endpoints: GET balances, POST credit, POST deduct, GET history)
- **Frontend:** `AdminBalanceAdjustment.tsx` (replaces broken `AdminCoinManagement.tsx` which is now deleted)
- **Admin route mount:** `app.use('/api/admin/balance', adminBalanceRoutes)`

### Operational Improvements
- **Cron jobs (in /var/spool/cron/crontabs/root):**
  - `0 4 * * * /root/scripts/cleanup-cron.sh` — nightly Docker/npm/log cleanup
  - `*/5 * * * * /root/scripts/disk-alert.sh` — 3-tier disk alert (warn/error/emergency)
- **Docs:** `docs/MAINTENANCE-DISK.md`
- **Scripts:** `scripts/cleanup-cron.sh`, `scripts/disk-alert.sh` (committed to repo for reproducibility)

### Security
- `.gitignore` updated to exclude `frontend/public/keys/cx23-access` (SSH private key) and `.env-backups/`
- Per-tier KYC enforced for deposits AND withdrawals
- 2FA step-up for large withdrawals (5-min grace window)
- All admin balance adjustments audit-logged with IP + UA + reason (min 20 chars)
- Withdrawal address validation per chain (EIP-55 checksum for EVM)

### Files Touched (high-level)

**Backend (added):**
- 8 new services (`admin-adjustment`, `binance-pay-qr`, `binance-pay-ledger-monitor`, `chain-config`, `kyc-enforcement`, `llm-scorer`, `llm-feedback-loop`, `notification`, `payment-socket`, `withdrawal-risk`)
- 9 new route files (`admin-audit`, `admin-balance`, `admin-email`, `admin-kyc`, `admin-payments-qr`, `auth-2fa`, `public-fx`, `wallet-deposit-qr`)
- 3 new utility files (`address-validator`, `env-loader`, `idempotency`)
- 9 new migrations (018 → 026)

**Backend (removed):**
- `services/merchant-payment.ts` (dead code, 199 lines)
- `test/validation.test.ts`, `test/wallet.test.ts` (used removed service)

**Frontend (added):**
- 9 new dashboard components (`AdminBalanceAdjustment`, `AdminChainConfig`, `AdminDepositDashboard`, `AdminEmail`, `AdminKycOverrides`, `AdminQrReviewQueue`, `AdminSystemLogs`, `RecentQrDeposits`)
- 4 new user pages (`/wallet/deposit`, `/wallet/withdraw`, `/wallet/transactions`, `/admin/payments/deposits/[orderId]`)
- 3 wallet UI components (`ChainSelector`, `EquivalentAmounts`)

**Frontend (removed):**
- `AdminCoinManagement.tsx` (dead stub, replaced by AdminBalanceAdjustment)

### Stats
- ~5,800 lines of new code across backend + frontend
- 27 backend route files, 62 frontend components
- 26 migrations applied
- All TS clean (backend + frontend)
- All P0/P1/P2/P3 verified end-to-end