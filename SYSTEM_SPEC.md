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
| Spin API | [READ IN STEP 2] |
| RNG utility | [READ IN STEP 2] |
| Prisma schema | prisma/schema.prisma |
| Game store | frontend/lib/store.ts (same file, gameStore slice) |

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
