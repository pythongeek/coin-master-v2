# SYSTEM_SPEC.md
# Source of truth. AI agents and developers read this before any architectural decision.
# Last updated: 2026-08-14

## Project
Provably fair crypto slot game. MVP target.
Structure: /frontend (Next.js 14 App Router) + /backend (Express, TypeScript)
Proxy: frontend/app/api/[...path]/route.ts forwards all headers (Cookie + Set-Cookie) between browser and backend.

## BUILT AND VERIFIED

### Auth — Step 1 COMPLETE (commits 0655dff + f942b93)
- httpOnly cf_token cookie set by Express on login / register / wallet
- Cookie flags: HttpOnly, SameSite=Strict, Secure=production-only, Max-Age=7d, Path=/
- Frontend never reads raw JWT. No localStorage auth. No document.cookie auth.
- User data reaches client via GET /api/auth/me only.
- Zustand store: initialize() called on mount (ClientInit.tsx) and after login.
- All 22 admin dashboard components use frontend/lib/api.ts (credentials:'include').
- Logout: POST /api/auth/logout → backend Max-Age=0 → cookie cleared.
- cookie-parser NOT installed. Raw header parsed via readCookieValue() in auth middleware.
- Auth middleware: Bearer first → cookie fallback. Both paths use same jwt.verify().
- Token still in login JSON response (in-memory for socket compat — see DEFERRED-SOCKET).

### Spin Flow — Step 2 COMPLETE
- Spin triggered via Socket.IO emit('game:bet') from `BetControls.tsx:130` (with HTTP fallback `POST /api/game/bet` at `routes/game.ts:46`)
- Auth gate: HTTP route mounts `authMiddleware`; socket `game:bet` handler enforces `if (!user) return socket.emit('game:error', ...)` at `socket-game.ts:46`
- Balance deduction: **server-side only**, raw-SQL transaction (`game-engine.ts:264` `BEGIN`, `:279` `SELECT ... FOR UPDATE`, `:309` debit) → `COMMIT` at line 609. Equivalent atomicity to `prisma.$transaction`.
- Minimum balance check: inside the transaction, AFTER row lock acquired (`game-engine.ts:296-310`)
- Bet record: `INSERT INTO bets (..., 'resolved', ...)` at `game-engine.ts:571-600`, BEFORE the COMMIT at line 609
- Balance returned: server reads `SELECT balance FROM users` post-COMMIT at line 642, sends as `result.newBalance` in socket `game:result` payload
- UI balance update: `frontend/lib/useSocketEvents.ts:46` calls `storeRef.current.updateBalance(result.newBalance)` — server-returned, NO client-side arithmetic
- Double-spin prevention: client-side `canBet` flag (`BetControls.tsx:40, 816`) AND server-side Redis `lockBet` (`game-engine.ts:256`) — belt + braces

### Provably-Fair RNG — Step 3 COMPLETE
- **RNG-1** serverSeed: `crypto.randomBytes(32)` at `provably-fair.ts:84-87`; clientSeed (server fallback): `crypto.randomBytes(16)` at `provably-fair.ts:255`; **client-side** clientSeed: `crypto.getRandomValues(Uint8Array(16))` at `BetControls.tsx:33-37, 151-156, 198-203` — three locations (useState init, handleFlip post-bet regen, executeAutoplayBet). NO `Math.random()` or `Date.now()` for seed material.
- **RNG-2** `/verify` endpoint now 400s on SHA256(serverSeed) !== serverSeedHash BEFORE running the HMAC computation (`routes/game.ts:124-131`). Forged seed pairs produce a `SEED_HASH_MISMATCH` error.
- **RNG-3** Nonce atomicity: `reserveNonce()` at `server-seed.ts:48-87` uses `BEGIN; SELECT ... FOR UPDATE; UPDATE active_bets = active_bets + 1; COMMIT`. Two concurrent bets for the same user cannot get the same nonce.
- **RNG-4** Seed rotation: `rotateSeedIfNeeded` at `server-seed.ts:142-180` marks old seed is_active=false + revealed_at=NOW() BEFORE inserting the new seed. Now **awaited** synchronously in `reserveNonce` (was fire-and-forget — race window closed).
- **RNG-5** `getBetHistory` now JOINs `game_seeds` so the response carries `server_seed`, `server_seed_hash`, `client_seed`, `nonce` alongside the bet row. Users can offline-verify every bet (`game-engine.ts:738-758`).

### Admin Gate — Step 4 CONFIRMED (no fixes required)
Three-layer defense-in-depth — all confirmed in code:
- Layer 1 (Edge): `frontend/middleware.ts` — secret gateway header + IP allowlist. Non-matching path → rewrite to /404. Does NOT verify JWT (by design — JWT check is per-request on the backend).
- Layer 2 (Page): `frontend/app/admin/page.tsx` — server-side `cookies()` + `isAdminAuthorized()` → backend `/api/auth/me` + role check against `ADMIN_ROLES` set (`super_admin`, `admin`, `support`, `finance`, `auditor`). Soft-rejection: non-admin sees rejection JSX at /admin URL (200, no admin shell rendered).
- Layer 3 (API): every `backend/src/routes/admin-*.ts` has `router.use(authMiddleware, adminMiddleware|roleMiddleware)` applied at router level — covers every handler in each file. `admin.ts` further adds per-route `roleMiddleware([...])` per endpoint. Unauthenticated → 401. Authenticated non-admin → 403.

### Balance / Wallet — Step 5 CONFIRMED (no fixes required)
- **Balance column type:** `users.balance DECIMAL(18, 8)` (`schema.sql:17`), `users.bonus_balance_coins DECIMAL(18, 8)`, `users.withdrawable_balance_coins DECIMAL(18, 8)`, `wallets.balance DECIMAL(36, 18)` (`schema.sql:176`) — **NOT float**. Exact-precision arithmetic in SQL.
- **Arithmetic safety:** all decrement/credit is SQL-side `column - $N` or `column + $N` (e.g. `backend/src/services/bonus.ts:529-535` `debitBalanceForBet`, `:555-559` `creditPayout`). JS only `parseFloat(...)`s the result. No JS floating-point arithmetic on stored balance.
- **Deposit atomicity:** `backend/src/services/payment.ts:166` (`payment_orders FOR UPDATE`) and `backend/src/services/admin-adjustment.service.ts:257` — both use `BEGIN/FOR UPDATE/UPDATE/INSERT/COMMIT` with row locks.
- **Withdrawal safety:** `backend/src/services/withdrawal-queue.ts:36-205` `BEGIN; SELECT balance, locked_balance FROM wallets WHERE id = $1 AND user_id = $2 FOR UPDATE; UPDATE wallets SET locked_balance += $3; INSERT INTO transactions; COMMIT` — check + decrement are inside the same transaction with S1-H13 rowCount guard.
- **Bet deduction atomicity:** confirmed Step 2 — same raw-SQL transaction envelope wraps balance check + source-decision + debit + bet INSERT + credit. Re-confirmed Step 5.
- **Bonus/withdrawable split:** both columns are DECIMAL (separate columns). `determineBalanceSource` picks ONE source per bet (prefer bonus while wagering is incomplete AND bonus covers amount; else withdrawable), and `debitBalanceForBet` decrements that one source inside the same tx. `users.balance` is the trigger-maintained derived sum (`game-engine.ts:476`).
- **DB-level negative-balance constraint:** **MISSING**. Application guards exist in `game-engine.ts:296-310`, `bonus.ts:537` (`WHERE ${col} >= $2` predicate on the UPDATE itself), `withdrawal-queue.ts`. Logged as `DEBT-BALANCE-CONSTRAINT` (see TECH DEBT). Migration SQL provided in Step 5 commit message; manual execution required during low-traffic window.

### Env Hygiene — Step 6 CONFIRMED (1 minor finding)
- **`NEXT_PUBLIC_*` audit:** 8 `NEXT_PUBLIC_*` vars in use — `API_URL`, `SOCKET_URL`, `APP_URL`, `APP_NAME`, `APP_VERSION`, `SENTRY_DSN`, `GA_MEASUREMENT_ID`, `CRISP_WEBSITE_ID`, plus legacy `BACKEND_URL` (`frontend/lib/socket.ts:28`). **All non-secret by design:** public URLs, app name, public-DSN (Sentry rate-limits per project, not per URL), Google Analytics measurement ID, Crisp website ID. ✅ Acceptable.
- **Hardcoded secrets outside `process.env`:** none found. ✅
- **`.env.example`** present (15 KB) at repo root, covers both frontend and backend. ✅
- **`.gitignore`** comprehensively covers `.env`, `.env.local`, `.env.production`, `.env.*.local`, `*.pem`, `*.key`, `backend/src/config/secrets.ts`, `frontend/public/keys/{*.key, *.pem, id_*, cx23-access, cx23-access.pub}`. ✅ Verified with `git check-ignore frontend/.env.production.local` → properly ignored. `frontend/public/keys/cx23-access{,.pub}` → properly ignored.
- **`console.log` of sensitive material:** `backend/src/services/kyc.ts:210` logs `[KYC Mock Mode] Generating access token for user ${userId}` — leaks user ID in mock-KYC mode (not in prod). **Fixed in commit `51096b4`:** gated behind `NODE_ENV !== 'production'`, downgraded to `console.debug`. Production logs no longer contain user IDs from this path. No token material itself is logged anywhere in `backend/src/`.

### Step 7 — Final MVP Launch Audit CONFIRMED
**File:line evidence for every audit question.**

| ID | Item | Status | Evidence |
|---|---|---|---|
| A1 | Login sets httpOnly cookie; raw JWT NOT in localStorage | ✅ CONFIRMED | `backend/src/routes/auth.ts:327-333` sets cookie; `store.ts:181-184` saves token in memory only (no `localStorage.setItem` in `lib/store.ts`/`lib/auth-cookies.ts`); `lib/auth-cookies.ts` is now no-op wrappers |
| A2 | `/api/auth/me` rehydrates identity after page load | ✅ CONFIRMED | `frontend/components/ClientInit.tsx:21-23` calls `initialize()`; `store.ts:191-220` `initialize()` → `apiGet('/api/auth/me')` → `set({ user, … })` |
| A3 | Logout clears cookie server-side (Max-Age=0) | ✅ CONFIRMED | `store.ts:217-228` `logout()` → `apiPost('/api/auth/logout')`; `routes/auth.ts:618-628` `res.cookie('cf_token', '', { maxAge: 0, … })` |
| A4 | JWT has explicit expiry (not undefined/Infinity) | ✅ CONFIRMED | `backend/src/middleware/auth.ts:126-127` `createToken` → `jwt.sign(payload, JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' })` |
| A5 | Cookie flags: httpOnly + Secure(prod) + SameSite=Strict | ✅ CONFIRMED | `routes/auth.ts:327-333, 415-420, 581-586` (setter) and `:619-625` (clearer) all use `httpOnly:true, secure: NODE_ENV==='production', sameSite:'strict'` |
| G1 | Spin route requires valid session | ✅ CONFIRMED | `routes/game.ts:47` chain: `router.post('/bet', gameLimiter, authMiddleware, validateBody(betSchema), fraudGuard, ...)` |
| G2 | Balance deduction atomic w/ FOR UPDATE inside tx | ✅ CONFIRMED | `game-engine.ts:264` BEGIN; `:280-288` SELECT … `FOR UPDATE` on `users`; `:310` `debitBalanceForBet`; `:609` COMMIT |
| G3 | Spin INSERT before COMMIT before res.json | ✅ CONFIRMED | `game-engine.ts:572` `INSERT INTO bets`; `:609` COMMIT; `routes/game.ts:71-86` `res.json` runs only after `placeBet` returns (post-COMMIT) |
| G4 | Seed hash committed pre-spin, seed revealed post-spin | ✅ CONFIRMED | `routes/game.ts:311` `GET /api/game/seed` returns `{ serverSeedHash: seed.serverSeedHash, ... }` only; `game-engine.ts` reveals `serverSeed` only inside the bet transaction after INSERT |
| G5 | Double-spin prevention | ✅ CONFIRMED | `BetControls.tsx:42-44` `isSpinning = gameStatus==='spinning'`; `:44` `canBet = user && !isSpinning && !isAutoPlayRunning`; `:426-565` all spin action buttons `disabled={isSpinning\|isAutoPlayRunning}`; `game-engine.ts:259` `lockBet` Redis lock |
| G6 | clientSeed uses crypto.getRandomValues (Step 3 fix) | ✅ CONFIRMED | `BetControls.tsx:36-40, 152-158, 200-205` — three replacement sites, no `Math.random()` remaining |
| G7 | /verify returns 400 on hash mismatch (Step 3 fix) | ✅ CONFIRMED | `routes/game.ts:120-129` computes `crypto.createHash('sha256').update(serverSeed).digest('hex')`, compares to claimed `serverSeedHash`, returns `400 { code: 'SEED_HASH_MISMATCH' }` on mismatch |
| G8 | Error state shown to user on spin failure | ✅ CONFIRMED | `useSocketEvents.ts:66-69` `onError` → `setGameStatus('idle')` + `addNotification(\`❌ ${data.message}\`, 'info')` |
| G9 | Insufficient balance UI | ✅ CONFIRMED | `BetControls.tsx:178-180` (manual autoplay path) + `:207-209` (start autoplay path) both check `user.balance < amount` → `addNotification('insufficientBalance', info)` or `stopAutoPlay('insufficientBalance')` |
| Ad1 | `/admin/*` protected at edge | ✅ CONFIRMED | `frontend/middleware.ts:46` `GATEWAY_HEADER='x-admin-gateway'`; `:80-118` `isAdminPath`; `:127-160` apply allowlist + gateway header + rewrite to /404 on miss |
| Ad2 | `/api/admin/*` protected at backend | ✅ CONFIRMED | `grep "router.use(authMiddleware\|adminMiddleware\|roleMiddleware" backend/src/routes/admin*.ts` returns 11 hits across all admin files (deposit.ts, admin-withdrawals.ts, admin-balance.ts, admin-audit.ts, admin-cohorts.ts, admin-email.ts, admin-fraud-reports.ts, admin-geoip.ts, admin-kyc.ts) |
| Ad3 | No admin data in client bundle for non-admin | ✅ CONFIRMED | `app/admin/page.tsx:22-44` server-side `await cookies()` + `isAdminAuthorized(token)`; rejection JSX returned when auth fails; `<AdminClientShell>` only rendered on success |
| F1 | Zero `localStorage.*cf_token` code hits | ✅ CONFIRMED | grep returns 1 hit — `frontend/lib/api.ts:7` is a JSDoc comment describing the **removed** pattern, not active code. All 31 admin + auth components verified post-PR-1B |
| F2 | Zero `Authorization.*Bearer` in admin/game | ✅ CONFIRMED | grep returns 0 hits in `frontend/components/dashboard/` and `frontend/components/game/` |
| F3 | UI balance comes from server (newBalance) | ✅ CONFIRMED | `useSocketEvents.ts:46, 57, 63` all call `storeRef.current.updateBalance(result.newBalance / scatter.newBalance / data.balance)`; `BetControls.tsx:258` reads `lastResult.newBalance` for bet-resume logic |
| F4 | Loading state on spin button | ✅ CONFIRMED | `BetControls.tsx:426, 448, 492, 508, 524, 550, 564` all `disabled={isSpinning\|isAutoPlayRunning}`; spin handler sets `setGameStatus('spinning')` at `:148, 197` |
| F5 | Loading state on withdrawal button | ✅ CONFIRMED | `app/wallet/withdraw/page.tsx:85` `submitting` state; `:161/178` set true before / false after; `:430` `disabled={!canSubmit}` where `canSubmit = ... && !submitting && ...` |
| I1 | `.env*` not in git history | ✅ CONFIRMED | `git log --all --full-history -- "**/.env*"` → empty output |
| I2 | `frontend/public/keys/*` not in git history | ✅ CONFIRMED | `git log --all --full-history -- "frontend/public/keys/*"` → empty output (was reset in PR-1B) |
| I3 | Rate limiting on spin route | ✅ CONFIRMED | `gameLimiter` at `rate-limiter.ts:247-260`: **60 req/min, Redis store, per-user key** (not just per-IP). Applied at `routes/game.ts:47, 118`. Separate `loginLimiter`, `authLimiter`, `kycVerifyLimiter`, `adminLimiter`, `apiLimiter` also exist |
| I4 | CORS not wildcard in prod | ✅ CONFIRMED | `index.ts:111-114` exits with `process.exit(1)` if `NODE_ENV=production && corsOrigin.length === 0`; `:147-150` cors origin callback only allows whitelisted origins + no-origin (curl/server-to-server) |
| I5 | Balance constraint migration ready | ✅ **NEW this step** | Created `backend/migrations/059_balance_non_negative_constraints.sql` — pre-flight DO block + idempotent ALTER TABLE … ADD CONSTRAINT for all balance columns + wallets locked_balance invariant. **NOT executed on production DB** — operator runs with backup during low-traffic window |
| I6 | DEFERRED-SOCKET documented + HTTP fallback path | ✅ CONFIRMED | SYSTEM_SPEC.md has DEFERRED-SOCKET entry; HTTP fallback `POST /api/game/bet` at `routes/game.ts:46-47` works without socket |
| I7 | NODE_ENV=production disables debug output | ✅ CONFIRMED | `kyc.ts:210-213` gated behind `process.env.NODE_ENV !== 'production'`; no other `console.log(token/password/secret)` in `backend/src/` |
| I8 | Startup env check | ✅ CONFIRMED | `backend/src/config/env.ts:6-72` zod envSchema covers DATABASE_URL, REDIS_URL, JWT_SECRET, KMS_PROVIDER, ALLOW_INSECURE_HOT_WALLET, TronGrid endpoints, etc.; `:78-82` `process.exit(1)` on parse failure |

## NOT BUILT (mock or stub — do not claim as complete)

All Step 1-7 audit items CONFIRMED (no `STATUS UNKNOWN` left). See **VERIFIED COMPLETE** block below for the full audit summary. Items below this line are intentional known limitations / post-MVP backlog, NOT bugs.

- **DEFERRED-SOCKET:** socket fallback known — `socket-lifecycle.ts:36` reads `handshake.auth.token` (in-memory) only, never reads the `Cookie` header. Hard refresh loses socket until re-login. HTTP `POST /api/game/bet` works regardless. Tracked as #1 in **POST-MVP BACKLOG**.
- **DEFERRED-JSON-TOKEN:** token still appears in login JSON response (`routes/auth.ts:332`) for socket compat. Blocked by DEFERRED-SOCKET.
- **DEFERRED-CSRF:** SameSite=Strict mitigates for MVP. Full CSRF tokens are priority 2.
- **DEFERRED-ROTATE:** JWT has no rotation / blacklist on admin role change. Tracked priority 2.
- **DEFERRED-COOKIE-PARSER:** `readCookieValue()` inline parser in `middleware/auth.ts:33-43`. Works, but a 4-line refactor to `cookie-parser` mid-priority.

## DEFERRED — do not touch without explicit step instruction

| ID | What | Blocked by |
|---|---|---|
| DEFERRED-SOCKET | Replace socket token-in-JSON with /api/auth/socket-ticket | needs socket-ticket endpoint |
| DEFERRED-JSON-TOKEN | Remove token from login JSON response | blocked by DEFERRED-SOCKET |
| DEFERRED-CSRF | CSRF tokens for POST endpoints | SameSite=Strict mitigates now |
| DEFERRED-ROTATE | JWT rotation on role change | no blacklist exists |
| DEFERRED-COOKIE-PARSER | Replace readCookieValue() with cookie-parser | works now, refactor later |

## TECH DEBT — pre-existing, NOT introduced by Step 1-2

| ID | What | Risk | Fix in |
|---|---|---|---|
| DEBT-SCHEMA-BET | `bets` table has no Prisma `model` — all ops are raw SQL | Schema drift undetected by `prisma migrate` | Step 6 |
| DEBT-SCHEMA-USER | `users` table has no Prisma `model` — raw SQL only | Same; loss of compile-time safety | Step 6 |
| DEBT-BALANCE-CONSTRAINT | No DB-level `CHECK (balance >= 0)` on `users.balance`, `users.bonus_balance_coins`, `users.withdrawable_balance_coins`, or `wallets.balance` | Application guards (game-engine.ts:296-310, bonus.ts:537 WHERE-clause, withdrawal-queue.ts FOR UPDATE) cover all current code paths; new code paths bypass this safety net | Add migration 022_balance_non_negative.sql during Step 6 manual deploy |
| DEBT-SOCKET-CONF | `socket-lifecycle.ts:36` reads `handshake.auth.token` + `Authorization` header only, never reads the `Cookie` header — all cookie-authenticated browsers currently connect as guests (HTTP `/api/game/bet` is the working fallback) | No realtime game-play over socket until `DEFERRED-SOCKET` lands | DEFERRED-SOCKET |
| DEBT-SOCKET-STYLE | Some socket error paths silently no-op (`emit('game:bet')` with no cookie = silent reject instead of UI feedback) | Hard to debug | DEFERRED-SOCKET |

## FILE MAP

| Purpose | Path |
|---|---|
| Auth middleware (backend) | backend/src/middleware/auth.ts |
| Auth routes (backend) | backend/src/routes/auth.ts |
| Frontend API helper | frontend/lib/api.ts |
| Zustand store | frontend/lib/store.ts |
| Proxy | frontend/app/api/[...path]/route.ts |
| Edge middleware | frontend/middleware.ts |
| Admin gate server-side | frontend/app/admin/page.tsx |
| App auth init | frontend/components/ClientInit.tsx |
| Spin API route | backend/src/routes/game.ts |
| Game engine (placeBet) | backend/src/services/game-engine.ts |
| Provably fair util | backend/src/services/provably-fair.ts |
| Socket lifecycle (auth) | backend/src/services/socket-lifecycle.ts |
| Socket game handlers | backend/src/services/socket-game.ts |
| Socket events hook | frontend/lib/useSocketEvents.ts |
| Server seed service | backend/src/services/server-seed.ts |
| Spin button component | frontend/components/game/BetControls.tsx |
| Prisma schema | backend/prisma/schema.prisma (PARTIAL — see DEBT-SCHEMA-BET) |

## VERIFIED COMPLETE (Steps 1-7)

| Step | Scope | Status |
|---|---|---|
| 1 | Auth: httpOnly `cf_token` cookie + `/api/auth/me` rehydration + cookie-clear logout | ✅ CONFIRMED (`0655dff` PR-1A, `f942b93` PR-1B) |
| 2 | Spin flow: auth-gate, atomic deduction, server-returned balance, double-spin prevented, DB-before-response | ✅ CONFIRMED (read-only, `0cb685d`) |
| 3 | Provably-fair RNG: HMAC-SHA256, `crypto.getRandomValues` clientSeed, SHA-256 hash gate on `/api/game/verify`, sync seed rotation, JOIN bet history fields | ✅ FIXED + CONFIRMED (`e933f9c`, `b6e2045`) |
| 4 | Admin gate: 3-layer defense-in-depth (edge → page → API), cookie-auth everywhere | ✅ CONFIRMED (`64cbb6c`) |
| 5 | Balance/wallet: DECIMAL columns, SQL-only arithmetic, atomic deposit/withdrawal/bet with FOR UPDATE, bonus+withdrawable split | ✅ CONFIRMED (`86755c2`) |
| 6 | Env hygiene: NEXT_PUBLIC_* non-secrets, no hardcoded secrets, .env.example present, .gitignore comprehensive, no `console.log(token/password)` in prod | ✅ FIXED + CONFIRMED (`51096b4`, `02779df`) |
| 7 | Final MVP audit: 30 items in 5 sections (auth, game, admin, frontend, infra), all CONFIRMED + 1 pre-deploy migration written | ✅ CONFIRMED (this commit) |

## PRE-DEPLOY GATES (operator runs, NOT agent)

These must complete BEFORE production traffic. None of them are agent actions.

```
[ ] Take a backup:
        pg_dump $DATABASE_URL > backup_pre_059_$(date +%Y%m%d-%H%M%S).sql

[ ] Pre-flight validation (all three must return 0 rows):
        -- users balance integrity
        SELECT COUNT(*) FROM users
         WHERE balance < 0
            OR COALESCE(bonus_balance_coins, 0) < 0
            OR COALESCE(withdrawable_balance_coins, 0) < 0
            OR COALESCE(total_wagered, 0) < 0
            OR COALESCE(pending_rakeback, 0) < 0
            OR COALESCE(wallet_balance_coins, 0) < 0;

        -- wallets balance + locked_balance invariant
        SELECT COUNT(*) FROM wallets
         WHERE balance < 0
            OR locked_balance < 0
            OR locked_balance > balance + locked_balance;

        -- If either returns > 0: STOP. Reconcile data first, do NOT relax the constraint.

[ ] Apply the migration:
        psql $DATABASE_URL -f backend/migrations/059_balance_non_negative_constraints.sql

[ ] Verify constraints installed:
        SELECT conname FROM pg_constraint
         WHERE conname IN (
           'users_balance_nonneg',
           'users_wallet_coin_nonneg',
           'users_wagered_nonneg',
           'wallets_balance_nonneg',
           'wallets_locked_balance_invariant'
         )
         ORDER BY conname;
        -- Expected: 5 rows

[ ] Confirm NODE_ENV=production in production container env:
        docker exec backend sh -c 'echo $NODE_ENV'
        -- Expected: production

[ ] Clean build:
        cd frontend && rm -rf .next && npm run build
        cd backend && rm -rf dist && npm run build

[ ] Smoke test (see ./SMOKE_TEST.md if generated):
        - login → check Set-Cookie cf_token; HttpOnly; SameSite=Strict
        - spin → newBalance matches API response
        - logout → cookie cleared, /api/auth/me returns 401
        - admin login → /admin renders shell; non-admin gets rejection JSX
        - insufficient balance → UI shows 'insufficientBalance' toast
        - hard refresh → spin still works (HTTP fallback)

[ ] Confirm (one-time, after the apply):
        git log --all --full-history -- "frontend/public/keys/*"
        -- Expected: empty output (rotate any keys if non-empty)
```

## POST-MVP BACKLOG (do NOT block launch — defer to v1.1)

| Priority | Item | Effort |
|---|---|---|
| 1 | **DEFERRED-SOCKET:** add `POST /api/auth/socket-ticket` endpoint that returns a 30-second JWT for socket handshake. Update `socket-lifecycle.ts:36` to read `Cookie` header (or ticket from auth message) instead of `handshake.auth.token`. Fixes hard-refresh socket drop. | 4-6h |
| 2 | **DEFERRED-JSON-TOKEN:** remove `token` from login JSON response (`routes/auth.ts:332, 422, 590`). Blocked by #1 (socket currently reads token from login response). | 1h |
| 3 | **DEBT-SCHEMA-BET:** add Prisma `model Bet { … }` so `prisma migrate diff` can detect schema drift vs raw SQL. Currently zero compile-time safety on the bets table. | 4h |
| 4 | **DEBT-SCHEMA-USER:** same for `model User { … }` — refers to the `users` table that all auth + balance + KYC code reads from. | 4h |
| 5 | **DEFERRED-CSRF:** add per-session CSRF token in a non-httpOnly `cf_csrf` cookie, validate on every POST. SameSite=Strict covers MVP but a POST via a malicious <form> on crazycoin.duckdns.org could still forge. | 3h |
| 6 | **DEFERRED-ROTATE:** JWT blacklist (Redis SET with TTL = remaining lifetime). Invalidate on admin role demotion, password change, manual logout. | 4h |
| 7 | **Admin soft-rejection (200 page)** → hard redirect to `/403` for non-admins. Currently shows rejection JSX at /admin URL (200 + glass card). Functional but UX is wrong. | 1h |
| 8 | **Normalize admin components** to use `apiGet/apiPost` instead of raw `fetch`. Style improvement, no security impact (already cookie-auth). | 3h |
| 9 | **DEFERRED-COOKIE-PARSER:** replace `readCookieValue()` inline parser in `middleware/auth.ts:33-43` with `cookie-parser` middleware. Cosmetic, no functional change. | 30min |

## KNOWN BUILD NOTES

- Dockerfile uses --noEmitOnError false --skipLibCheck — tsc warnings won't block build
- Run rm -rf .next before next build (stale artifacts from pre-PR-1B localStorage era)
- AdminWithdrawalQueue uses raw fetch (needs X-Admin-2FA-Token header) — intentional, not a bug
- Some migrated admin components use raw fetch instead of apiGet — consistent behavior, inconsistent style

## SENIOR DEV RULES — enforce every session

1. Read SYSTEM_SPEC.md before any architectural decision.
2. Read the actual file before proposing changes. Show current lines.
3. SELF-AUDIT at end of every response: [done] [not done] [can break]
4. Trace the full user flow before claiming a feature works.
5. Flag new bugs found — do not silently fix unreported issues.
6. No TODOs, no placeholders, no "this should work."
7. DEFERRED items above are off limits until their step is started.
