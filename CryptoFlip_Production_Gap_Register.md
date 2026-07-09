# CryptoFlip Production-Readiness Gap Register

| Pillar | Score | Verdict | Key Gaps / Critical Items |
|--------|-------|---------|---------------------------|
| 1. Architecture & Secrets | 6 / 10 | ⚠️ Partial | Backend Dockerfile uses `npm install --include=dev` then copies all source → final stage only `npm install --omit=dev`, but the builder stage still leaves dev deps in build cache. No `npm ci`, no lockfile reproducibility. `.env.example` contains defaults like `WALLET_MNEMONIC=abandon...` (abandon mnemonic) and duplicate `JWT_SECRET` entries. No runtime env-var schema validation except JWT_SECRET, ADMIN_2FA_REQUIRED and NEXT_PUBLIC_APP_URL. No secret manager integration. |
| 2. Authentication & Access Control | 6 / 10 | ⚠️ Partial | Admin gate is SSR via `isAdminAuthorized` — good. However: `adminMiddleware` only checks `isAdmin` bit; roles (`super_admin`, `support`, `finance`, `auditor`) are not enforced across admin routes (most routes mount `adminMiddleware` only, not `roleMiddleware`). No admin IP allowlist enforcement. No step-up for withdrawals. JWT expiry 7d with no refresh/rotation mechanism. Wallet auth signature verification exists (`wallet-signature.ts`) but needs real RPC/verify test. No enforce 2FA on admin login path? Need verify. |
| 3. Game Fairness & RNG | 7 / 10 | ⚠️ Partial | Provably-fair engine implemented (`resolveFlip`, HMAC-SHA256, nonce reservation on global seed, seed hash verification). Major logic flaw: `placeBet` balance pre-check uses legacy `balance` column only; then debits `bonus_balance_coins` or `withdrawable_balance_coins` (DB trigger syncs). Pre-check can PASS even when both split balances are insufficient, allowing negative-balance bets if `balance` includes stale/pending values. `creditWagering` has dead loop `parseFloat(wagering_required) - parseFloat(wagering_required)` = 0 always; bonus completion logic may therefore complete claims prematurely/incorrectly. Client seeds auto-generated on frontend (BetControls uses `Math.random()+Date.now()`; MobileBetBar uses `Math.random()`); user cannot persist/edit easily, but server does not need to trust it. `server_seeds` rotation global but no DB table `server_seeds` found? yet code works via `server-seed.ts` (in-memory + admin_settings persistence) — verify persistence on restart. |
| 4. Financial / Ledger Integrity | 5 / 10 | 🔴 At Risk | Reconciliation engine still computes expected balance from legacy `transactions` rows only (deposits - withdrawals + bets + squads + rain). It ignores `wallet_balance_coins`, `bonus_balance_coins`, `withdrawable_balance_coins`, and `wagering_*` columns. Because the live DB uses split balances and a trigger `sync_user_balance`, reconciliation will fire false positives for every user with bonus/wagering, or miss true mismatches. Withdrawal flow debits `wallets` table not `users.withdrawable_balance_coins`, creating a dual-ledger system with no unified reconciliation. Affiliate/rakeback credits update `users.balance` directly (legacy) in some places, not the split columns. This is a launch blocker. |
| 5. CORS / CSRF / Headers | 5 / 10 | 🔴 At Risk | `next.config.js` headers still has **hardcoded CORS allowlist** in `.next/routes-manifest.json` containing two `trycloudflare.com` domains and duplicated `localhost:3000/3002`. The source file `next.config.js` itself only allows single `NEXT_PUBLIC_APP_URL`, but the **build artifact is stale** (manifest differs from source). Backend `index.ts` CORS allows any origin matching `HOSTNAME`/`HOST` env, which is effectively a wildcard if not set. `security.ts` CSRF has `EXTRA_ALLOWED_ORIGINS` fallback and permits requests with no Origin/Referer unless `CSRF_REQUIRE_BROWSER_ORIGIN=1`. CSP `connectSrc` hardcodes `ws://localhost:*`, `wss://localhost:*`, `http://localhost:*`. |
| 6. Dependency & Supply Chain | 7 / 10 | ⚠️ Partial | `npm audit` returned moderate vulnerabilities in earlier reports; `bcryptjs` is intentionally chosen (no native binding). Need re-run `npm audit` and `tsc --noEmit` after fixes. No lockfile integrity verification. No SLSA/SBOM. Third-party Web3 dependencies (ethers, @solana/web3.js) must be pinned and verified. |
| 7. Infrastructure & Deployment | 6 / 10 | ⚠️ Partial | Docker stack runs on cx23. Nginx config uses `localhost` as server_name (not a functional risk behind reverse proxy). SSL certs manually managed via certbot volume. Health endpoint exists; need verify DB + Redis check inside. No automated DB backup job visible in repo. PM2 or systemd not used; docker-compose `restart: always` only. Resource limits set (1 CPU, 512M). No graceful shutdown handler check. |
| 8. Error Handling & Observability | 6 / 10 | ⚠️ Partial | No React Error Boundary found around `Coin3D` or game page. `game-engine.ts` catches errors in `socket.io` but `/api/game/bet` returns generic 400. No structured request/audit correlation IDs. Logging is console-based; no external log shipper. Webhook dispatch error handling present but needs retry/backoff review. |

## Overall Launch Gate Status
**🔴 NOT READY for public launch.**

Critical blockers (must fix before launch):
1. **Financial ledger reconciliation is wrong** — it ignores the split-balance columns that the live app actually uses. Fix reconciliation to match `sync_user_balance` trigger and unify the wallet-vs-user balance model, or disable bonus/wagering split-balance flow and revert to single balance.
2. **Balance pre-check bug in `placeBet`** — pre-checks `balance` but debits `bonus/withdrawable`, so insufficiency checks can be bypassed.
3. **Stale CORS manifest** — `frontend/.next/routes-manifest.json` and `frontend/.next/dev/routes-manifest.json` contain hardcoded `trycloudflare.com` domains. Rebuild frontend and verify output.
4. **Backend CORS allows any origin with same hostname** — effectively bypasses allowlist if `HOSTNAME`/`HOST` are not explicitly set.
5. **`creditWagering` dead calculation** — `need = 0` always; claim completion logic may be incorrect.

High severity (fix before launch if possible):
6. No React Error Boundary around `Coin3D` / game page.
7. `AdminLiveStats.tsx` and `SeedRotationPanel.tsx` contain hardcoded `localhost:4000` fallback in `API` constant (non-fatal if env is set, but still present).
8. CSP `connectSrc` hardcodes localhost; production should allow `wss://<domain>` and `https://<domain>` only.
9. Admin middleware does not enforce role-based access; any admin can rotate seeds, approve withdrawals, etc.
10. `.env.example` contains dangerous placeholder mnemonic (`abandon...`).

## Files Requiring Immediate Change
- `/root/coin-master/backend/src/services/reconciliation-engine.ts` (unify with split balance columns)
- `/root/coin-master/backend/src/services/game-engine.ts` (balance pre-check vs debit source)
- `/root/coin-master/backend/src/services/bonus.ts` (`creditWagering` calculation)
- `/root/coin-master/backend/src/index.ts` (CORS hostname fallback)
- `/root/coin-master/backend/src/middleware/security.ts` (CSP localhost; CSRF fallback)
- `/root/coin-master/frontend/next.config.js` (already clean, but rebuild stale artifacts)
- `/root/coin-master/frontend/components/dashboard/AdminLiveStats.tsx` (remove localhost fallback)
- `/root/coin-master/frontend/components/dashboard/SeedRotationPanel.tsx` (remove localhost fallback)
- `/root/coin-master/frontend/lib/socket.ts` (already uses `NEXT_PUBLIC_SOCKET_URL` or `window.location.origin`, fallback `localhost` is non-fatal but still present)
- `/root/coin-master/frontend/app/game/page.tsx` or game page (add Error Boundary)
- `/root/coin-master/.env.example` (remove dangerous defaults)
- `/root/coin-master/frontend/.next/routes-manifest.json` and `frontend/.next/dev/routes-manifest.json` (delete or rebuild)
