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

## NOT BUILT (mock or stub — do not claim as complete)

- Spin API: STATUS UNKNOWN — audit required in Step 2
- Provably fair RNG: STATUS UNKNOWN — audit required in Step 3
- Admin gate (JWT-level): middleware.ts checks path+header only, not JWT — Step 4
- Balance atomicity: STATUS UNKNOWN — audit required in Step 5
- Rate limiting on /api/game/spin: NOT built
- Socket ticket endpoint: NOT built (DEFERRED-SOCKET)
- Withdrawal flow: STATUS UNKNOWN

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
