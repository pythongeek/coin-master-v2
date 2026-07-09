# KYC Integration Plan — CryptoFlip + kyc-opensource-prod-by-nion

> **For Hermes:** Multi-system, multi-file change. Plan-then-approve gate applies. Do not write code until user says `go` / `start` / `do it`.

## Goal
Replace CryptoFlip’s mock KYC (Sumsub/Gemini stubs) with a real, self-hosted open-source KYC stack (`pythongeek/kyc-opensource-prod-by-nion`). CryptoFlip backend calls the KYC orchestrator server-to-server; frontend uploads document + selfie; admin panel sees results; withdrawals are gated by KYC status.

---

## Phase 0: Baseline & Resource Check (15 min)

Run on cx23:
```bash
free -h
df -h /
docker system df
```

**Expected finding (already verified):**
- cx23: 3.7 GB RAM, 95% disk full.
- KYC stack requires ~8 GB RAM for PaddleOCR alone, ~16 GB total.

**Decision point:**
- If cx23 is the only host, we cannot deploy the full KYC stack there.
- Recommended: provision a separate KYC host (e.g., Hetzner CX42: 8 vCPU / 16 GB / 160 GB) or upgrade cx23.
- If no new host is available, fallback options are documented in "Alternative Paths" at the end of this plan.

**Phase 0 deliverable:**
- `docs/plans/kyc-resource-assessment.md` with host specs and recommendation.

---

## Phase 1: Deploy KYC Stack (on a separate KYC host)

### Task 1.1: Provision KYC host
- Create/allocate a host with ≥16 GB RAM, ≥80 GB disk, Ubuntu 22.04/24.04.
- Install Docker + Docker Compose v2.
- Open ports: 443 (nginx), and optionally 22 for SSH.
- All other services bind to `127.0.0.1` only.

### Task 1.2: Clone and configure KYC stack
```bash
ssh root@<kyc-host>
mkdir -p /opt/kyc-stack && cd /opt/kyc-stack
git clone https://github.com/pythongeek/kyc-opensource-prod-by-nion.git .
cp .env.example .env
nano .env
```

Required env vars:
- `API_KEYS` — generate a strong 32-byte hex key, e.g. `openssl rand -hex 32`
- `OPENAI_API_KEY` — real key
- `COMPREFACE_API_KEY` — generated after first CompreFace boot
- `SECRET_KEY` — `openssl rand -hex 32`
- `POSTGRES_*`, `REDIS_PASSWORD`, `GRAFANA_PASSWORD` — strong passwords
- `CORS_ORIGINS` — CryptoFlip backend URL only

### Task 1.3: Build and start
```bash
make build
make up
make health
```

### Task 1.4: Configure CompreFace
- Open `https://<kyc-host>/` → CompreFace admin
- Create workspace + application → copy API key → update `.env` `COMPREFACE_API_KEY`
- Recreate orchestrator: `docker compose up -d --force-recreate orchestrator`

### Task 1.5: Test KYC endpoint
```bash
curl -X POST https://<kyc-host>/kyc/verify \
  -H "X-API-Key: $KYC_API_KEY" \
  -F "document_image=@test_docs/passport.jpg" \
  -F "selfie_image=@test_docs/selfie.jpg" \
  -F "user_id=test_user_001"
```

Expected: `200 OK` with `final_decision`, `risk_score`, `status: completed`.

---

## Phase 2: CryptoFlip Backend Integration

### Task 2.1: Add KYC env vars to CryptoFlip
Files:
- `.env.example`
- `.env`

Add:
```bash
# KYC Orchestrator
KYC_ORCHESTRATOR_URL=https://<kyc-host>/kyc/verify
KYC_API_KEY=<32-byte-hex-key>
KYC_WEBHOOK_SECRET=<shared-secret-for-webhooks>
KYC_REQUIRED_FOR_WITHDRAWAL=true
KYC_REQUIRED_FOR_BET_ABOVE=1000
```

### Task 2.2: Create KYC client service
Create `backend/src/services/kyc-client.ts`:
- Function `verifyIdentity(userId, documentBuffer, selfieBuffer)` → POST to KYC orchestrator with `X-API-Key`.
- Function `getSessionStatus(sessionId)` → GET from orchestrator (or local DB mirror).
- Function `handleWebhook(payload, signature)` → verify HMAC and update user status.
- Handle timeouts, retries, network errors gracefully.

### Task 2.3: Replace old KYC service
- Delete `backend/src/services/kyc.ts` (the old Sumsub/Gemini mock).
- Update all imports to use `kyc-client.ts`.
- Update `backend/src/routes/kyc.ts`:
  - `POST /api/kyc/verify` — accept multipart/form-data document + selfie, forward to KYC orchestrator, store result in CryptoFlip DB, return safe summary.
  - `GET /api/kyc/status` — return local `users.kyc_status` + latest session.
  - `POST /api/kyc/webhook` — accept KYC orchestrator status callbacks, verify signature, update user.
  - Delete `POST /api/kyc/simulate-success`.
  - Delete `POST /api/kyc/token` (no longer needed; no Sumsub SDK).
  - Delete `POST /api/kyc/verify-ai` (replaced by multipart verify).

### Task 2.4: Add `kyc_sessions` table in CryptoFlip DB
Create migration `backend/migrations/015_create_kyc_sessions.sql`:
```sql
CREATE TABLE IF NOT EXISTS kyc_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_session_id VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  final_decision VARCHAR(20) CHECK (final_decision IN ('APPROVED', 'REVIEW', 'REJECTED')),
  risk_score INTEGER,
  risk_tier VARCHAR(20),
  document_valid BOOLEAN,
  face_match BOOLEAN,
  face_similarity DECIMAL(5,4),
  liveness_passed BOOLEAN,
  sanctions_clear BOOLEAN,
  compliance_report_summary TEXT,
  raw_result JSONB,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_kyc_sessions_user_id ON kyc_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_sessions_external ON kyc_sessions(external_session_id);
```

### Task 2.5: Enforce KYC before withdrawal
Update `backend/src/services/withdrawal-queue.ts`:
- Before processing a withdrawal, check `users.kyc_status = 'verified'`.
- If `KYC_REQUIRED_FOR_WITHDRAWAL=true` and user is not verified, reject with reason.
- Add admin override flag for manual review.

### Task 2.6: Enforce KYC for large bets (optional)
Update `backend/src/services/game-engine.ts`:
- If `req.amount > KYC_REQUIRED_FOR_BET_ABOVE` and user is not verified, reject.

### Task 2.7: TypeScript compile & tests
Run:
```bash
cd /root/coin-master/backend
npx tsc --noEmit
npm test
```

Expected: 0 type errors, all tests pass (or update tests to match new flow).

---

## Phase 3: Frontend Integration

### Task 3.1: Update `/kyc` page
File: `frontend/app/kyc/page.tsx`
- Keep the document upload + selfie capture UI.
- Replace `runAIVerify` with `POST /api/kyc/verify` using multipart/form-data.
- Show real verification steps from backend response.
- Poll `GET /api/kyc/status` until `completed`.
- Remove `simulate-success` button and mock-mode badge.
- On approved: show success + document info (name, DOB, doc number) if returned.
- On rejected: show reason and retry button.

### Task 3.2: Add KYC gating to withdrawal UI
File: `frontend/components/dashboard/WithdrawalForm.tsx` (or wherever withdrawal is)
- If `user.kyc_status !== 'verified'`, show a warning and redirect to `/kyc`.

### Task 3.3: Frontend type-check
Run:
```bash
cd /root/coin-master/frontend
npx tsc --noEmit
```

Expected: 0 errors.

---

## Phase 4: Admin Panel

### Task 4.1: Update admin KYC list
File: `backend/src/routes/kyc.ts` (admin routes) and `frontend/app/admin/kyc/page.tsx` if it exists.
- `GET /api/kyc/admin/list` reads from `kyc_sessions` + `users`.
- Show: user, status, decision, risk score, submitted at, reviewed by.
- Add manual review: admin can override to `approved`/`rejected` with note.

### Task 4.2: Admin approval/reject updates
- When admin approves: `UPDATE users SET kyc_status='verified', kyc_verified_at=NOW()`.
- When admin rejects: `UPDATE users SET kyc_status='rejected'`.
- Insert audit log entry.

---

## Phase 5: Security & Compliance

### Task 5.1: Network isolation
- KYC orchestrator is not exposed to the internet except through nginx on 443.
- CryptoFlip backend connects to KYC orchestrator via a VPN or private network. If separate hosts, use Cloudflare Tunnel / WireGuard / Tailscale, or restrict KYC host firewall to cx23 IP.
- Inside Docker, KYC services live on their own `kyc-network` and are not reachable from CryptoFlip frontend containers.

### Task 5.2: API key security
- `KYC_API_KEY` is only in CryptoFlip backend env, never in frontend.
- Use constant-time comparison in KYC orchestrator (already present).
- Rotate key every 90 days (runbook).

### Task 5.3: Webhook signature
- `POST /api/kyc/webhook` verifies HMAC-SHA256 signature from KYC orchestrator.
- Replay protection: check `timestamp` within 5 minutes.

### Task 5.4: PII handling
- Document/selfie images are streamed through CryptoFlip backend to KYC orchestrator; they are not stored on CryptoFlip disk.
- KYC orchestrator stores images in MinIO with a retention policy (e.g., 30 days, then purge).
- CryptoFlip DB only stores the **decision summary**, not raw images or OCR text.
- Add `frontend/.env` / CSP: no `connectSrc` to KYC host directly.

### Task 5.5: Data retention
- Add a daily cron job in KYC stack to purge images older than retention policy.
- Log purge actions to `kyc_audit`.

### Task 5.6: Compliance checklist
- KYC required before withdrawal.
- Admin review workflow for `REVIEW` cases.
- Audit trail for every KYC decision and admin override.
- Sanctions/PEP screening enabled (Yente + OpenSanctions).
- Liveness detection enabled (CompreFace + liveness service).

---

## Phase 6: Testing & Rollout

### Task 6.1: Local/integration tests
- Backend tests: `cd /root/coin-master/backend && npm test`
- Frontend tests: `cd /root/coin-master/frontend && npm test`
- KYC stack tests: `cd /opt/kyc-stack && make test`
- End-to-end: upload a real document + selfie, verify approval/rejection flow.

### Task 6.2: Home safety check
Before and after deployment:
```bash
for endpoint in /health /api/health /api/kyc/status; do
  curl -s -o /dev/null -w "%{http_code}" https://crazycoin.duckdns.org$endpoint
done
```
Expected: 3 × 200.

### Task 6.3: Reset existing mock-verified users
For production:
```sql
UPDATE users SET kyc_status='unverified', kyc_verified_at=NULL WHERE kyc_status='verified';
```
(Only after the new KYC flow is live and tested.)

### Task 6.4: Deploy
1. Build and start KYC stack on KYC host.
2. Update CryptoFlip `.env` with KYC host + API key.
3. Build/deploy CryptoFlip backend + frontend.
4. Verify end-to-end KYC flow.
5. Verify withdrawal is blocked for unverified users.
6. Verify admin review works.

---

## Files Expected to Change

| File | Change |
|------|--------|
| `.env.example` | Add KYC env vars |
| `.env` | Add real KYC env vars |
| `backend/src/services/kyc.ts` | Delete old mock service |
| `backend/src/services/kyc-client.ts` | New KYC orchestrator HTTP client |
| `backend/src/routes/kyc.ts` | Replace routes with orchestrator-backed flow |
| `backend/src/services/withdrawal-queue.ts` | Enforce KYC before withdrawal |
| `backend/src/middleware/security.ts` | Update CSP if needed |
| `backend/migrations/015_create_kyc_sessions.sql` | New KYC sessions table |
| `frontend/app/kyc/page.tsx` | Replace mock verification with real API |
| `frontend/components/dashboard/WithdrawalForm.tsx` | KYC gate |
| `frontend/lib/api/base.ts` | Add multipart upload helper if needed |
| `frontend/app/admin/page.tsx` or admin KYC page | Show KYC list |
| `docker-compose.kyc.yml` (optional) | If running KYC on same host |
| `docs/plans/kyc-integration-plan.md` | This plan |
| `docs/runbooks/kyc-operations.md` | New runbook |

---

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| 1 | cx23 has only 3.7 GB RAM; full KYC stack needs 16 GB | Deploy on a separate KYC host or upgrade cx23 |
| 2 | Disk is 95% full on cx23 | Clean up build cache / provision bigger disk before adding anything |
| 3 | KYC stack has no code for some components? | Scaffold is complete; we verify with `make test` and `make health` |
| 4 | PII leak from document/selfie images | Stream through backend, no disk storage, encrypted MinIO, retention policy |
| 5 | OpenAI API cost / latency | Set timeout 120s, cache sanctions results, monitor usage |
| 6 | CompreFace cold start / accuracy | Test with real documents; consider fallback to manual review |
| 7 | Existing users verified via mock mode | Reset to unverified after launch |
| 8 | Withdrawal blocking harms UX | Show clear KYC prompt and auto-redirect |

---

## Rollback

Per-step revert commands:

1. KYC stack deployment:
   ```bash
   ssh root@<kyc-host>
   cd /opt/kyc-stack
   make clean
   ```

2. CryptoFlip backend changes:
   ```bash
   cd /root/coin-master
   git checkout -- backend/src/services/kyc.ts
   git checkout -- backend/src/routes/kyc.ts
   rm backend/src/services/kyc-client.ts
   rm backend/migrations/015_create_kyc_sessions.sql
   # Restore .env from backup
   ```

3. Frontend changes:
   ```bash
   git checkout -- frontend/app/kyc/page.tsx
   git checkout -- frontend/components/dashboard/WithdrawalForm.tsx
   ```

4. If KYC gating caused withdrawal failures, temporarily disable:
   ```bash
   KYC_REQUIRED_FOR_WITHDRAWAL=false
   ```

---

## What I Will NOT Do

- I will not deploy to production without testing the full KYC flow end-to-end.
- I will not store KYC images on the CryptoFlip host disk.
- I will not expose `KYC_API_KEY` to the frontend or commit it.
- I will not skip the KYC-required-for-withdrawal check in production.
- I will not provision a new cloud server without your explicit approval.

---

## Awaiting Your `go` / `start` / `do it`

Before proceeding, confirm:
1. **Deploy KYC stack on a separate host?** (recommended) or upgrade cx23?
2. **Do you want to provision a new KYC host?** (I can suggest Hetzner specs)
3. **Fallback if no host:** use Sumsub/Onfido/Jumio API instead? Or keep mock KYC for now?
