# CryptoFlip Admin Features & Production Readiness Gap Analysis

## 1. Existing Admin Features

### Backend Admin Routes (`/api/admin/*`)

| Domain | Route | Roles | Notes |
|--------|-------|-------|-------|
| **Config** | `GET /api/admin/config` | super_admin, finance, auditor | Live game-math config (house edge, max bet, rain, etc.) |
| **Config** | `PATCH /api/admin/config` | super_admin | Updates admin settings with schema validation |
| **Config** | `POST /api/admin/config/reset` | super_admin | Resets to defaults |
| **Config** | `GET /api/admin/config/public` | public | Anonymous-readable subset |
| **Stats** | `GET /api/admin/stats` | super_admin, support, finance, auditor | Platform stats |
| **Audit** | `GET /api/admin/audit-logs` | super_admin, auditor | Recent audit logs |
| **Fraud** | `GET /api/admin/fraud-logs` | super_admin, support, auditor | Fraud detection logs |
| **Users** | `GET /api/admin/users/search` | super_admin, finance, support | Search users for bonus grants |
| **Users** | `POST /api/admin/users/:id/unflag` | super_admin, support | Unflag users |
| **Security** | `POST /api/admin/seed/rotate` | super_admin | Server seed rotation with step-up password auth |
| **Withdrawals** | `GET /api/admin/withdrawals` | admin | List pending withdrawals |
| **Withdrawals** | `POST /api/admin/withdrawals/:id/approve` | admin | Approve withdrawal + audit |
| **Withdrawals** | `POST /api/admin/withdrawals/:id/reject` | admin | Reject + refund |
| **Withdrawals** | `GET /api/admin/withdrawals/stats` | admin | Volume/pending stats |
| **Withdrawals** | `POST /api/admin/withdrawals/cron/expire-bonuses` | admin | Manual bonus expiry trigger |
| **Bonus** | `GET /api/admin/bonus-campaigns` | super_admin, finance, support, auditor | List campaigns |
| **Bonus** | `GET /api/admin/bonus-campaigns/stats/summary` | super_admin, finance, support, auditor | Global stats |
| **Bonus** | `GET /api/admin/bonus-campaigns/:id` | super_admin, finance, support, auditor | Single campaign |
| **Bonus** | `POST /api/admin/bonus-campaigns` | super_admin, finance | Create campaign |
| **Bonus** | `PATCH /api/admin/bonus-campaigns/:id` | super_admin, finance | Update campaign |
| **Bonus** | `DELETE /api/admin/bonus-campaigns/:id` | super_admin | Delete campaign |
| **Bonus** | `POST /api/admin/bonus-campaigns/:id/grant` | super_admin, finance, support | Manual grant to users |
| **Bonus** | `POST /api/admin/bonus-campaigns/trigger/:event` | super_admin | Trigger event campaigns |
| **Bonus** | `GET /api/admin/bonus-campaigns/:id/claims` | super_admin, finance, support, auditor | List claims |
| **Dashboard** | `GET /api/dashboard/admin/live` | admin | Live admin stats |
| **Dashboard** | `GET /api/dashboard/admin/users` | admin | User list with filters |
| **Dashboard** | `PATCH /api/dashboard/admin/users/:id` | admin | Update user (active/balance?) |
| **Dashboard** | `POST /api/dashboard/admin/seed/rotate` | admin | Duplicate seed rotation route |

### Frontend Admin Panels

| Panel | File | Capabilities | Notes |
|-------|------|--------------|-------|
| **Admin Shell** | `frontend/app/admin/page.tsx` | Tabs: Live, Config, Users, Bonuses, Security | Client-side `localStorage.isAdmin` check; redirects to `/game` if not admin |
| **Live Stats** | `frontend/components/dashboard/AdminLiveStats.tsx` | Reads `/api/dashboard/admin/live` | Static hardcoded UI fallback? Uses absolute API URL |
| **Game Config** | `frontend/components/game/AdminConfig.tsx` | Read/update `/api/admin/config` | Uses relative `/api/admin/config` |
| **Users** | `frontend/components/dashboard/AdminUserTable.tsx` | Search, update, toggle users | **Hardcoded mock data** in source; no real API integration |
| **Bonuses** | `frontend/components/dashboard/AdminBonusPanel.tsx` | Full CRUD + grants + stats | Real API integration; fixed default datetime issue |
| **Security** | `frontend/components/dashboard/SeedRotationPanel.tsx` | Server seed rotation with password | Uses absolute API URL |

---

## 2. Production Readiness Gaps

### A. Authentication & Authorization (Critical)

| # | Gap | Severity | Why It Matters | Evidence |
|---|-----|----------|----------------|----------|
| 1 | **JWT secret fallback to `dev_secret`** | 🔴 Critical | Production tokens signed with hardcoded default if `JWT_SECRET` missing | `auth.ts: createToken` uses `process.env.JWT_SECRET \|\| 'dev_secret'` |
| 2 | **No admin 2FA / TOTP enforcement** | 🔴 Critical | Single password compromise = full admin access; no step-up 2FA for login | `totp.test.ts` exists but not wired to admin login flow |
| 3 | **Session tokens last 7 days with no revocation** | 🟠 High | Stolen JWT remains valid for a week; no token blocklist/refresh rotation | `auth.ts: createToken` sets `expiresIn: '7d'` |
| 4 | **Client-side admin gate only** | 🟠 High | `admin/page.tsx` checks `localStorage.cf_user.isAdmin` — easily bypassed by editing localStorage; backend auth still gates API but the UI shell is client-side only | `frontend/app/admin/page.tsx:35` |
| 5 | **No admin login audit / suspicious activity alerts** | 🟠 High | No visibility into failed admin logins, password changes, or new admin sessions | Not found in auth.ts or audit service |
| 6 | **RBAC role support exists but admin creation flow unclear** | 🟡 Medium | `roleMiddleware` supports 4 roles, but no visible admin-management UI to create finance/support/auditor users | Admin user table is hardcoded mock data |

### B. API Security (Critical)

| # | Gap | Severity | Why It Matters | Evidence |
|---|-----|----------|----------------|----------|
| 7 | **CSRF origin check hardcoded to `NEXT_PUBLIC_APP_URL`** | 🟠 High | Through tunnels or non-localhost domains, CSRF rejects requests unless `TUNNEL_APP_URL` is added; production must allow actual frontend origin | `security.ts: csrfMiddleware` |
| 8 | **CORS allowlist still includes hardcoded old tunnel** | 🟡 Medium | `next.config.js` allows `https://occasions-announced-asia-vsnet.trycloudflare.com` but should be dynamic or strict | `frontend/next.config.js` |
| 9 | **Admin API rate limit is 30 req/min** | 🟡 Medium | Reasonable but no per-route stricter limits for high-impact actions (config reset, seed rotate, withdrawal approve) | `rate-limiter.ts: adminLimiter` |
| 10 | **No API request signing / HMAC for admin actions** | 🟡 Medium | Admin withdrawal approvals rely on JWT + CSRF only; no additional action signing | `admin-withdrawals.ts` |
| 11 | **Duplicate seed-rotation route** | 🟡 Medium | `POST /api/admin/seed/rotate` and `POST /api/dashboard/admin/seed/rotate` both exist; divergence risk | `admin.ts` and `dashboard.ts` |
| 12 | **Middleware `GATEWAY_TOKEN` has fallback to empty string** | 🟡 Medium | If `ADMIN_GATEWAY_TOKEN` missing, direct `/admin` access is allowed for non-localhost (dev bypass) | `middleware.ts: if (!isLocalDev)` checks against `GATEWAY_TOKEN` which can be empty |

### C. Frontend Admin Panel (High)

| # | Gap | Severity | Why It Matters | Evidence |
|---|-----|----------|----------------|----------|
| 13 | **Admin Users panel uses hardcoded mock data** | 🔴 Critical | No real user management; admins cannot view, edit, ban, or role-assign users from the UI | `AdminUserTable.tsx:34-37` has hardcoded rows |
| 14 | **Admin Live Stats uses absolute API URL, breaks through tunnel** | 🟠 High | `AdminLiveStats.tsx` calls `${API}/api/dashboard/admin/live` which resolves to `localhost:4000` on user's machine | `AdminLiveStats.tsx:32` |
| 15 | **Seed Rotation panel uses absolute API URL, breaks through tunnel** | 🟠 High | Same localhost issue | `SeedRotationPanel.tsx:59` |
| 16 | **No admin password change / account settings UI** | 🟠 High | Admin cannot rotate their own password or enable 2FA from the panel | Not found in admin panels |
| 17 | **No admin activity / session management UI** | 🟠 High | Cannot see active admin sessions, force-logout, or audit admin actions visually | No panel found |
| 18 | **No admin KYC / compliance review UI** | 🟠 High | KYC routes exist but no admin panel to review/submit verification | `app/kyc/page.tsx` is user-facing only |
| 19 | **No withdrawal queue UI** | 🟠 High | Backend has full withdrawal approval API, but no frontend panel — admin must use API/curl | `admin-withdrawals.ts` has no matching frontend component |
| 20 | **No audit-log viewer UI** | 🟡 Medium | Backend serves `/api/admin/audit-logs` and `/api/admin/fraud-logs`; no frontend panel | No `AdminAuditLogPanel.tsx` found |
| 21 | **WebSocket connection hardcoded to `ws://localhost:4000`** | 🟡 Medium | Admin panel (and whole app) cannot maintain real-time socket through tunnel | `NEXT_PUBLIC_SOCKET_URL=http://localhost:4000` |
| 22 | **No admin onboarding / role assignment flow** | 🟡 Medium | Cannot create new admin users or assign roles from UI | Mock data only |

### D. Operations & Observability (High)

| # | Gap | Severity | Why It Matters | Evidence |
|---|-----|----------|----------------|----------|
| 23 | **No structured health checks for admin dependencies** | 🟠 High | Redis/Postgres failures in admin flows (rate limiter, audit logs) are not exposed clearly | `api/health` only? No admin health dashboard |
| 24 | **No centralized admin audit log viewer** | 🟠 High | Audit logs are written but not easily searchable/filterable by admin | `backend/backups/s3-mock/audit-logs-*.json` are raw files |
| 25 | **No alerting on admin actions** | 🟠 High | Seed rotation, config change, withdrawal approval should notify/alert | Not found |
| 26 | **No backup/restore UI for admin config** | 🟡 Medium | Config reset exists but no point-in-time backup/restore | `admin-config.ts` has `resetToDefaults` only |
| 27 | **No rate-limit status / abuse dashboard** | 🟡 Medium | Cannot see who is being throttled or why | No admin panel |
| 28 | **No log aggregation / error tracking** | 🟡 Medium | No Sentry/DataDog integration; debugging relies on container logs | Not found in docker-compose |

### E. Deployment & Configuration (Medium)

| # | Gap | Severity | Why It Matters | Evidence |
|---|-----|----------|----------------|----------|
| 29 | **Admin path / gateway token loaded from files at build time** | 🟡 Medium | `ADMIN_SECRET_PATH` and `ADMIN_GATEWAY_TOKEN` require build-time injection; rotating them needs rebuild/redeploy | `compose-with-secrets.py`, `nginx/install-admin-vhost.py` |
| 30 | **Production nginx profile is disabled by default** | 🟡 Medium | Admin vhost setup is manual and not part of default compose | `docker-compose.yml: nginx profile: production` |
| 31 | **No TLS termination setup for admin vhost in default compose** | 🟡 Medium | Admin vhost is expected on `:3003` but no cert management shown | `nginx/install-admin-vhost.py` |
| 32 | **Environment variables mix secrets and config** | 🟡 Medium | `.env` contains passwords, tokens, DB URLs; no secret manager integration | `.env` access denied (secret-bearing) |
| 33 | **No CI/CD pipeline for admin feature tests** | 🟡 Medium | Tests exist but no GitHub Actions/CI file visible | No `.github/workflows` found |

### F. Compliance & Data (Medium)

| # | Gap | Severity | Why It Matters | Evidence |
|---|-----|----------|----------------|----------|
| 34 | **No admin action approval workflow** | 🟠 High | Super_admin can change config / rotate seed / approve withdrawals alone; no second-approver for critical actions | `admin.ts`, `admin-withdrawals.ts` |
| 35 | **No immutable audit log** | 🟠 High | Audit logs are in DB/files on server; no append-only external store (WORM) | `audit-logs-*.json` in local backups |
| 36 | **No GDPR/data export for users** | 🟡 Medium | User data export/deletion not available in admin panel | Not found |
| 37 | **No admin access log / IP restrictions** | 🟡 Medium | Admin panel accessible from any IP if secret path is known; no IP allowlist | `middleware.ts` only checks header/localhost |
| 38 | **No admin password policy enforcement** | 🟡 Medium | `admin/admin123` is default; no complexity/rotation requirements | Memory: `admin/admin123` |

---

## 3. Immediate Blockers for Production Launch

1. **Admin User Management UI is fake** — hardcoded mock data (`AdminUserTable.tsx`). Admins cannot manage users.
2. **Withdrawal Queue UI missing** — backend API exists but no frontend panel; finance team cannot operate.
3. **JWT secret fallback** — must be mandatory, no default.
4. **No admin 2FA** — must enforce TOTP for admin login.
5. **Client-side admin gate only** — server-side admin page check or SSR guard required.
6. **Absolute API URLs break tunnel/cloud access** — `AdminLiveStats`, `AdminUserTable`, `SeedRotationPanel` must use `/api/*` proxy.
7. **WebSocket URL hardcoded** — real-time features break outside localhost.

---

## 4. Recommended Priority Order

### Phase 1 — Safety (do before any public launch)
- Remove JWT fallback default; fail startup if `JWT_SECRET` not set.
- Enforce 2FA/TOTP for admin accounts.
- Add IP allowlist / admin access restriction via nginx or middleware.
- Make admin gateway token mandatory and rotate it.
- Fix absolute API URLs in admin panels to use `/api/*` proxy.
- Fix WebSocket URL to be relative/dynamic.

### Phase 2 — Core Admin Operations
- Replace `AdminUserTable` mock data with real `/api/dashboard/admin/users` integration.
- Build Withdrawal Queue UI (`/api/admin/withdrawals`).
- Build Audit Log viewer (`/api/admin/audit-logs`, `/api/admin/fraud-logs`).
- Add admin password change / 2FA setup UI.
- Add admin session management (list, revoke).

### Phase 3 — Compliance & Reliability
- Immutable, tamper-proof audit log (external WORM store or DB append-only with signatures).
- Second-approver workflow for critical actions (seed rotate, config change, large withdrawals).
- Secret manager integration (HashiCorp Vault, AWS Secrets Manager, etc.).
- CI/CD pipeline with admin API tests.
- Admin health/dependency dashboard and alerting.

---

*Generated from inspection of `/root/workspace/coin-master` backend routes, frontend admin components, middleware, auth, rate-limiting, and docker-compose configuration.*
