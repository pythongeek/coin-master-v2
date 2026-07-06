# Phase 3 — SAST Findings + Manual Review

Date: 2026-07-06
Scope: `/root/coin-master/backend/src`
Tools: Semgrep `p/owasp-top-ten`, `p/nodejsscan`; manual line-by-line review.

## 1. Semgrep SAST Findings (4 total)

| # | File | Line | Rule | Severity | Summary | Finding | Risk | Recommended Fix |
|---|------|------|------|----------|---------|---------|------|-----------------|
| 1 | `config/database.ts` | 67 | `node_insecure_random_generator` | WARNING | `Math.random()` used for referral code generation in migration. | `const rand = Math.floor(100000 + Math.random() * 900000);` | **Medium** — referral codes are not security-critical, but predictable codes could make enumeration/replay slightly easier. | Replace with `crypto.randomInt(100000, 999999)` (Node ≥14.10). |
| 2 | `routes/auth.ts` | 70 | `node_insecure_random_generator` | WARNING | `Math.random()` used for signup referral code. | Same pattern as #1. | **Medium** — same as above; also used in wallet auth flow. | Same fix; refactor into a shared helper so both call sites use one secure generator. |
| 3 | `routes/auth.ts` | 260 | `node_insecure_random_generator` | WARNING | `Math.random()` used for wallet auto-registration referral code. | Same pattern. | **Medium** | Same fix via shared helper. |
| 4 | `utils/totp.ts` | 102 | `node_timing_attack` | WARNING | TOTP code comparison uses `===` instead of constant-time comparison. | `if (calculated === token) { return true; }` | **Low–Medium** — local TOTP window is small (±1 step), and brute force is mitigated by rate limiting, but still violates constant-time best practice. | Replace with `crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(token))` after length validation. |

No findings for: SQL injection, hardcoded secrets, XSS, path traversal, eval/dynamic import abuse, or insecure deserialization.

## 2. Manual Review — `backend/src/middleware/auth.ts` (JWT)

| Aspect | Finding | Risk | Recommendation |
|--------|---------|------|----------------|
| Secret startup guard | `JWT_SECRET` is validated at module load: must be ≥32 chars or process throws. | Good | Keep. |
| Algorithm | `jwt.verify(token, JWT_SECRET)` with no `algorithms` option. | **Medium** — `none` algorithm downgrade possible if secret is public and an attacker can strip the signature. | Pass `{ algorithms: ['HS256'] }` explicitly to `jwt.verify` and `jwt.sign`. |
| Token extraction | `req.headers.authorization?.replace('Bearer ', '')` | Low | If header is `Token xxx` or malformed, the replace will fail gracefully and return 401; acceptable. |
| Temp token gate | Rejects `decoded.isTemp` with a clear 2FA error. | Good | Prevents bypassing 2FA login. |
| `adminMiddleware` | Checks `user.isAdmin`. | Good | Works as legacy gate. |
| `roleMiddleware` | Falls back `user.isAdmin ? 'super_admin' : 'user'`; allows `super_admin` through any allowed role list. | Good | Backward compatible. |
| Missing type safety | `(req as Request & { user: AuthPayload }).user = decoded` is repeated and relies on casting. | Low | Create a typed `AuthenticatedRequest` interface and use module augmentation. |
| Token expiry | 7-day expiry. | Medium | Consider shorter access tokens (15 min) + refresh tokens, or at least allow env override. |
| No revocation | No token blacklist or `jti` tracking. | Medium | Stolen token is usable until expiry. Consider logout/refresh-token rotation. |

## 3. Manual Review — `backend/src/routes` Auth Coverage

| Router | Auth Pattern | Public Endpoints | Notes |
|--------|--------------|------------------|-------|
| `admin.ts` | Route-level `authMiddleware + roleMiddleware` | None | All 21 routes protected. Some endpoints (e.g., `/config`, `/stats`) use `['super_admin', 'finance', 'auditor']` — correct. |
| `admin-bonus.ts` | Route-level | None | Correctly uses `super_admin`/`finance`/`support`/`auditor` roles. |
| `admin-withdrawals.ts` | `router.use(authMiddleware, adminMiddleware)` | None | Strong pattern; all admin-only. |
| `admin-health.ts` | Route-level | None | Protected. |
| `admin-public.ts` | No auth | `/api/admin/config/public`, `/api/admin/config/public/banner` | **Intentionally public** — exposes only `houseEdgePercent` and banner info. Documented and acceptable. |
| `leaderboards.ts` | No auth | `GET /api/game/leaderboards` | **Public by design** — returns top-10 aggregated stats; no PII beyond username. Acceptable. |
| `dashboard.ts` | Mixed | None | User stats (`/stats/:userId`) and chart/history have ownership guard (`self || admin`). Admin routes use `roleMiddleware`. |
| `game.ts` | Mixed | `POST /api/game/bet` missing `authMiddleware` | **Critical finding** — `POST /api/game/bet` only uses `gameLimiter`, `validateBody`, `fraudGuard` but **no `authMiddleware`**. The `userId` comes from `req.body`, allowing anyone to bet as any user. |
| `game.ts` | Mixed | `GET /api/game/history/:userId` | Protected with ownership guard. Good. |
| `game.ts` | Mixed | `GET /api/game/config`, `GET /api/game/seed`, `GET /api/game/jackpot` | Public by design; acceptable. |
| `auth.ts` | Public | All auth routes | Correct. |
| `wallet.ts` | `authMiddleware` | `POST /deposit/callback/binance`, `POST /deposit/callback/redotpay` | Callbacks correctly auth-protected; ensure webhooks validate signatures in handlers. |
| `kyc.ts` | Mixed | Admin list endpoints protected; user-facing ones protected. | OK. |
| `webhooks.ts` | `authMiddleware` | Binance/RedotPay webhook routes | Verify signatures inside handlers (not visible in route file). |
| `payment.ts` | `authMiddleware` | `GET /health` | Protected; consider making health public if used by load balancer. |
| `promo.ts` | `authMiddleware` | None | OK. |
| `affiliate.ts` | `authMiddleware` | None | OK. |

### Key Missing Auth Finding
- **`POST /api/game/bet` does not use `authMiddleware`**. It relies on the `fraudGuard` and `userId` from the body. This is a **critical authorization flaw**: an attacker can place a bet on behalf of any user by sending a different `userId`.
- The `placeBet` function then checks `currentBalance < req.amount` and uses `FOR UPDATE` row lock, but it never validates that the caller is the user.

### Recommendation
- Add `authMiddleware` to `POST /api/game/bet` and derive `userId` from `req.user.userId`, ignoring the body value (or validating it matches).
- If the frontend currently sends `userId` in the body, change the API contract to read it from the token, or reject mismatches.

## 4. Manual Review — `backend/src/services/provably-fair.ts` (Highest-Value File)

| Lines | Function | Finding | Risk | Recommendation |
|-------|----------|---------|------|----------------|
| 84–87 | `generateServerSeed()` | Uses `crypto.randomBytes(32)` → 256-bit hex. | Good | Sufficient entropy. |
| 95–100 | `hashServerSeed()` | SHA-256 of the raw 32-byte seed. | Good | Standard commitment scheme. |
| 109–134 | `computeFlip()` | HMAC-SHA256(serverSeed, clientSeed:nonce) with first 4 bytes; even=heads, odd=tails. | Good | Deterministic, verifiable, no bias. |
| 139–167 | `computeFlipWithMultiplier()` | HMAC-SHA256; roll scaled to 0–99.999999; `winChance = (100 - houseEdge)/targetMultiplier`. | Good | Correct probability math. |
| 178–213 | `resolveFlip()` | Delegates to `computeFlipWithMultiplier` and returns payout. | Good | Payout uses `toFixed(8)` parseFloat. |
| 218–248 | `verifyFlip()` | Recomputes hash, compares `hashServerSeed(input.serverSeed) === input.serverSeedHash`, recomputes outcome. | **Good** | Independent verification works. |
| 254–256 | `generateClientSeed()` | `crypto.randomBytes(16)` → 128-bit hex. | Good | Acceptable. |

### Issues / Observations in Provably Fair Core

1. **Bias in `computeFlipWithMultiplier` roll scaling**  
   Line 158: `const roll = (rawValue / 0xFFFFFFFF) * 100;`  
   `0xFFFFFFFF` is 32 bits, but `rawValue` is only 4 bytes (32 bits), so the maximum is exactly `0xFFFFFFFF`. The distribution is uniform over `[0, 100)` — no modulo bias. **OK.**

2. **Potential floating-point edge case at exactly `winChance`**  
   `won = roll < winChance`. If `roll` equals `winChance` exactly, it is a loss. This is consistent and not exploitable. **OK.**

3. **Server seed entropy source is trusted**  
   `generateServerSeed()` uses OS CSPRNG. No issue.

4. **No seed reveal before bet is guaranteed**  
   The fairness system relies on the server seed remaining secret until after the bet. This is enforced by the game flow (`getSeedSecretById` only used during `placeBet`, seed stored in `game_seeds` with `is_revealed=true`). However, because the active seed is reused for many bets (up to `rotationThreshold`), the seed is not revealed per-bet but per-rotation. The client receives the hash and the revealed seed after the bet in the `verification` object. This is acceptable for a global seed scheme, but users should be able to see the full seed history via `getSeedHistory`.

5. **Client seed trust assumption**  
   The client seed is provided by the user. If the server chooses the client seed (e.g., via `generateClientSeed()` when the user omits it), there is no opportunity for the server to manipulate the outcome because the server secret is already committed (via the hash) and the nonce is reserved atomically. The order of operations in `placeBet` is correct: reserve nonce, retrieve secret, then generate client seed if missing. **OK.**

6. **Nonce reservation is atomic and serialized**  
   `reserveNonce()` uses `SELECT ... FOR UPDATE` on the active seed. **OK.**

7. **Hash mismatch check**  
   `placeBet` checks `secret.serverSeedHash !== serverSeedHash` and throws. This prevents using a wrong seed. **OK.**

### Verdict on Provably Fair
- **No critical bugs found.** The math is correct, the commitment scheme is sound, and the atomic nonce reservation prevents race conditions.
- **Recommendation:** Add an explicit `algorithms` option to JWT signing/verification and fix the `Math.random()` referral-code generators. These are the only SAST findings that affect the cryptographic or fairness posture.

## 5. Other Notable Findings

| File | Observation | Risk | Recommendation |
|------|-------------|------|----------------|
| `routes/auth.ts` | Wallet auth (`POST /auth/wallet`) has a TODO comment: signature verification is not implemented (`void signature;`). | **Critical** — anyone can log in as any wallet address. | Implement EIP-191 / SIWS / Tron signature verification before production. |
| `routes/auth.ts` | `fingerprint` is stored and checked but not validated. | Low | Ensure fingerprint is a stable hash, not user-controlled. |
| `routes/game.ts` | Jackpot verification in `POST /verify` duplicates `computeFlipWithMultiplier` logic inline. | Low | Reuse the `computeFlipWithMultiplier` helper for consistency. |
| `services/game-engine.ts` | `getVipRakebackPercentInline` is duplicated from `services/vip.ts`. | Low | Use the shared function to avoid drift. |
| `services/game-engine.ts` | `lightning` and `scatter` multipliers use `(rawMultiplierVal / 0xFFFFFFFF)`; same 32-bit scaling, uniform. | OK | — |
| `services/game-engine.ts` | `creditPayout` is called for jackpot, lightning, and main payout before `reconcileUser`. Order is safe. | OK | — |
| `services/game-engine.ts` | `dispatchWebhook` is `await`ed but errors can block response. | Low | Consider `dispatchWebhook(...).catch()` to avoid latency. |
| `services/server-seed.ts` | `getSeedSecretById` returns the active seed's secret during a bet. This is necessary but must never be exposed to the client. | Medium | Add a code comment and a linter rule to prevent accidental exposure. |

## 6. Risk Summary

| Severity | Count | Items |
|----------|-------|-------|
| **Critical** | 2 | `POST /api/game/bet` missing auth; wallet signature verification not implemented. |
| **Medium** | 5 | JWT no explicit algorithm; `Math.random()` in referral codes (×3); `fingerprint` not validated; token revocation missing. |
| **Low** | 6 | TOTP timing attack; duplicated helpers; webhook blocking; etc. |

## 7. Recommended Next Steps (Priority Order)

1. **Fix `POST /api/game/bet` auth** — add `authMiddleware` and bind `userId` from token.
2. **Implement wallet signature verification** in `POST /auth/wallet`.
3. **Explicit JWT algorithms** in `authMiddleware.ts` and `createToken`.
4. **Replace `Math.random()`** with `crypto.randomInt` and create a shared referral-code helper.
5. **Constant-time TOTP comparison** in `utils/totp.ts`.
6. Re-run Semgrep + backend tests after fixes.

