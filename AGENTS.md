# AGENTS.md — AI assistant instructions for CryptoFlip

This file is the **single point of truth** for the canonical project path
and operating conventions. When working on this repo, the agent should
read this file FIRST and follow it.

## Canonical paths

- **Project root:** `/root/coin-master/`
- **Docker compose file:** `/root/coin-master/docker-compose.yml`
- **Backend code:** `/root/coin-master/backend/src/`
- **Frontend code:** `/root/coin-master/frontend/`
- **Environment file:** `/root/coin-master/.env` (mode 0600)
- **Recovery backup of .env:** `/tmp/cf-preflight/.env-recovery.txt`
- **Pre-flight backups:** `/tmp/cf-preflight/`

## Stack

- Host: Hetzner CX23 (46.62.247.167) — shared with Hermes WebUI on :8787
  and OpenClaw on :8789. **Do NOT touch cx33 (Plokymarket prod).**
- Frontend: Next.js 14, container port 3000 → host port 3002
- Backend: Express + TypeScript + Socket.IO, port 4000
- Postgres: 16-alpine, internal-only (NO host port mapping)
- Redis: 7-alpine, host port 6379 (recommend restricting to 127.0.0.1)

## Workspace tag handling

The WebUI surfaces a generic workspace tag at `/root/workspace` (a scratch
dir with unrelated fragments). When this project's tag appears, **always
operate at `/root/coin-master/`**, NOT in the scratch workspace. The
scratch workspace may have files like `fix-*.sql`, `*.tsx` orphans from
other projects — ignore them when working on CryptoFlip.

If the user sends a message that starts work on this project, `cd
/root/coin-master && ls -la` to confirm state before doing anything
destructive.

## Working conventions

- **Read before edit.** Never edit from memory. Stale reports produce false
  positives (the prior "Game route requires userId in body" was actually
  true on disk, not memory).
- **Verify with live HTTP calls** before claiming a fix works.
  `curl -sS -m 5 -w '\n[HTTP %{http_code}]\n' http://localhost:4000/...`
- **Home-page safety check** before AND after any prod change. Required:
  backend `/health`, frontend `/`, frontend `/game`, frontend `/dashboard`.
- **Plan-then-approve gate** for multi-file/bulk/shared-helper changes.
  Single-file surgical fixes are OK to proceed without check-in.
- **Docker build cache gotcha:** `docker compose build --no-cache` is
  insufficient when `dist/` changes are involved. If new code doesn't
  appear after restart, run `docker builder prune -f` then
  `docker compose rm -sf backend && docker compose create backend && docker compose start backend`.
- **Backend Dockerfile quirk:** tsc is invoked with
  `--noEmitOnError false --skipLibCheck || true` to bypass 4 pre-existing
  strict-mode TS errors in `admin-config.ts` (lines 148/150/152) and
  `game.ts` (line 109). Don't remove that flag without first fixing the
  upstream code.

## Pre-existing known issues (not bugs to chase)

- `backend/src/dist/config/database.js` (compiled) sometimes has stale
  imports during incremental builds — full rebuild fixes it.
- `frontend/app/game/page.tsx` uses `useGameStore` (Zustand) — it has
  its own auth state. Don't expect the auth flow to flow through React
  context.
- Wallet UI files in `frontend/components/wallet/` are wired into BOTH
  `app/game/page.tsx` and `app/dashboard/page.tsx` (done 2026-06-29).
- House edge defaults to 2% in the frontend store; live value is fetched
  from `/api/admin/config/public` (added 2026-06-29).
- `routes/game.ts` HTTP handler now uses authMiddleware (fixed 2026-06-29)
  — the real game flow goes through socket-manager.ts.

## Status of security patches (as of last session)

- ✅ SEC-1: `/api/admin/config` and other admin routes use
  `authMiddleware + adminMiddleware` (router-level).
- ✅ SEC-2: register/login mints JWTs with `isAdmin` read from DB, not
  hardcoded. Users still must log out/in after a DB promotion because
  JWTs are immutable tokens (7-day expiry).
- ⚠️ `/api/admin/config/public` exposes `houseEdgePercent` only (one
  safe field). Do NOT add fields like `maxBet`, `rainBudget`,
  `adminWallet` without auditing them.

## Open follow-ups (not blocking, flagged)

- Real Binance/Redot Pay API keys (UI is wired but orders fail with
  "BINANCE_PAY_API_KEY / SECRET not configured").
- `/wallet/return` page (gateway success-redirect target — doesn't exist
  yet but won't be hit until real keys are in).
- Manual/Auto tabs (P0 of original 1.4 plan, deferred).
- Token selector (P1, deferred — wallet modal already has currency switch).
- AutoPlaySettings sub-component (P2, deferred).
- Cloudflare Tunnel (user cancelled; needs browser auth + API token).