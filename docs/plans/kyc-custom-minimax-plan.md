# Custom MiniMax-Powered KYC Plan — CryptoFlip

> **For Hermes:** Multi-file, shared-helper change. Plan-then-approve gate applies. Do not write code until user says `go` / `start` / `do it`.

## Goal
Build a lightweight, production-ready KYC engine inside CryptoFlip that uses **MiniMax M3 vision** as the core AI + open-source helper libraries (OCR, image processing, sanctions). No heavy self-hosted infrastructure (no PaddleOCR, CompreFace, Yente, Elasticsearch). The only cost is MiniMax API usage. Admin can add/rotate the MiniMax API key from the admin panel.

---

## Why this instead of the full open-source stack?

| Concern | Full open-source stack | Custom MiniMax KYC |
|---------|----------------------|--------------------|
| RAM | Needs 16 GB+ | Needs ~500 MB extra |
| Disk | Needs 50 GB+ | Needs ~2 GB |
| Hosting cost | New VPS | Same cx23 host |
| Per-check cost | Free (self-hosted) | MiniMax API only |
| Accuracy | OCR + face + liveness | M3 vision + OCR + local quality checks |
| Maintenance | Many services | One Node.js backend service |

cx23 has only 3.7 GB RAM and 95% disk full, so the custom path is the only viable one without provisioning a new host.

---

## Architecture

```
User uploads document + selfie
           │
           ▼
┌─────────────────────────┐
│  CryptoFlip Frontend    │  → multipart upload to /api/kyc/verify
└─────────────────────────┘
           │
           ▼
┌─────────────────────────┐
│  CryptoFlip Backend     │
│  (Node.js)              │
│                         │
│  1. sharp — resize/     │
│     normalize images     │
│  2. tesseract.js —      │
│     extract raw text     │
│  3. MiniMax M3 Vision   │
│     → document analysis │
│     → face comparison     │
│     → liveness check      │
│     → fraud signals     │
│  4. OpenSanctions API   │
│     → sanctions/PEP      │
│  5. Local risk engine   │
│     → combine scores     │
└─────────────────────────┘
           │
           ▼
┌─────────────────────────┐
│  CryptoFlip DB          │  → kyc_sessions, users.kyc_status
└─────────────────────────┘
```

---

## Phase 0: Baseline (15 min)

Run on cx23:
```bash
free -h
df -h /
```

Already verified: 3.7 GB RAM, 95% disk. Before adding packages, run:
```bash
docker system prune -f
cd /root/coin-master/backend && npx tsc --noEmit
cd /root/coin-master/frontend && npx tsc --noEmit
```

Baseline: record current type-check status and disk space.

---

## Phase 1: Dependencies

### Task 1.1: Add Node.js packages to backend
```bash
cd /root/coin-master/backend
npm install tesseract.js sharp uuid
npm install --save-dev @types/uuid
```

(We already have `axios` or `fetch` for HTTP. If not, add `axios` or use native `fetch` — Node 18+ has native fetch.)

### Task 1.2: Verify Tesseract.js works offline
Tesseract.js downloads language models on first use. We need to cache `eng.traineddata` so first KYC doesn't fail offline.
```bash
mkdir -p /root/coin-master/backend/tesseract-lang
# Download lang file during build
```
Or use `tesseract.js` with `langPath` pointing to a local directory and include `eng.traineddata` in the repo (it's ~10 MB).

### Task 1.3: Confirm MiniMax endpoint
Use the `hermes-minimax-provider-setup` skill. We need to determine the correct OpenAI-compatible vision endpoint for M3:
```bash
curl -s https://api.minimax.io/v1/models \
  -H "Authorization: Bearer $MINIMAX_API_KEY"
```

Expected model: `MiniMax-M3` or `MiniMax-M3-VL` (vision-language).

---

## Phase 2: Core KYC Engine

### Task 2.1: Create encryption helper for admin secrets
File: `backend/src/services/secret-vault.ts`

Purpose: encrypt/decrypt sensitive values stored in `admin_settings` (like MiniMax API key).

```typescript
import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const KEY = crypto.scryptSync(process.env.KYC_SECRET_ENCRYPTION_KEY || process.env.JWT_SECRET || 'fallback', 'salt', 32);

export function encrypt(value: string): string { ... }
export function decrypt(encrypted: string): string { ... }
```

**Security rule:** if `KYC_SECRET_ENCRYPTION_KEY` is not set, backend fails startup in production with a clear error. No plaintext storage.

### Task 2.2: Create MiniMax vision client
File: `backend/src/services/minimax-client.ts`

Functions:
- `verifyIdentity(userId, documentBase64, selfieBase64, rawOcrText)` → sends to MiniMax M3 with a structured agentic prompt.

Prompt asks M3 to act as a KYC verification agent and return JSON:
```json
{
  "document_valid": true,
  "document_type": "passport",
  "extracted_fields": {
    "full_name": "...",
    "date_of_birth": "YYYY-MM-DD",
    "nationality": "...",
    "document_number": "...",
    "expiry_date": "YYYY-MM-DD"
  },
  "face_match": true,
  "face_similarity_score": 0.94,
  "liveness_passed": true,
  "fraud_signals": ["none"],
  "sanctions_risk": "low",
  "reasoning": "...",
  "recommended_decision": "APPROVED"
}
```

Use OpenAI-compatible chat completions with image content:
```json
{
  "model": "MiniMax-M3",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "You are a KYC verification agent..." },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
      ]
    }
  ],
  "response_format": { "type": "json_object" }
}
```

Endpoint: `https://api.minimax.io/v1/chat/completions`
Auth: `Authorization: Bearer <decrypted_key>`

### Task 2.3: Create OCR helper
File: `backend/src/services/kyc-ocr.ts`

Wraps `tesseract.js`:
- Accept base64 image
- Resize with sharp to 1500px on longest side
- Run OCR with `eng` language
- Return raw text + confidence

### Task 2.4: Create local image quality helper
File: `backend/src/services/kyc-quality.ts`

Using `sharp` stats:
- Check blur/laplacian variance (reject if too blurry)
- Check brightness/contrast
- Check face presence (use a simple face detection? Optional; can rely on M3)
- Minimum resolution check

### Task 2.5: Create sanctions helper
File: `backend/src/services/kyc-sanctions.ts`

Use free OpenSanctions API:
```
GET https://api.opensanctions.org/search/?q={name}
```
No API key needed for low volume. Returns PEP/sanctions matches. We can also use M3 to adjudicate matches.

### Task 2.6: Create risk engine
File: `backend/src/services/kyc-risk.ts`

Inputs:
- M3 decision
- OCR confidence
- Image quality score
- Sanctions matches
- Face similarity score

Output:
```json
{
  "score": 12,
  "tier": "LOW",
  "decision": "APPROVED",
  "factors": ["document_valid", "face_match", "liveness_passed", "sanctions_clear"]
}
```

Decision rules:
- `M3.recommended_decision === 'REJECTED'` → REJECTED
- M3 sanctions risk high → REJECTED
- M3 face_match false → REJECTED
- M3 liveness_passed false → REJECTED
- Score < 30 → APPROVED
- 30–69 → REVIEW
- ≥ 70 → REJECTED

### Task 2.7: Create KYC session service
File: `backend/src/services/kyc-session.ts`

Orchestrates the full flow:
```typescript
export async function processKycSubmission(
  userId: string,
  documentBase64: string,
  selfieBase64: string
): Promise<KycResult> {
  // 1. Validate images
  // 2. Run OCR
  // 3. Run M3 vision
  // 4. Run sanctions
  // 5. Run risk engine
  // 6. Persist kyc_sessions row
  // 7. Update users.kyc_status
  // 8. Audit log
}
```

---

## Phase 3: Database

### Task 3.1: New migration
File: `backend/migrations/016_create_kyc_settings_and_sessions.sql`

```sql
-- Settings table extension (admin_settings already exists; we add KYC keys)
INSERT INTO admin_settings (key, value, description) VALUES
  ('kyc_provider', 'minimax', 'KYC provider: minimax, sumsub, manual'),
  ('kyc_minimax_api_key_encrypted', '', 'Encrypted MiniMax API key'),
  ('kyc_required_for_withdrawal', 'true', 'Require KYC before withdrawal'),
  ('kyc_required_for_bet_above', '500', 'Require KYC for bets above this amount (0 = disabled)'),
  ('kyc_auto_approve_threshold', '30', 'Risk score below this is auto-approved'),
  ('kyc_auto_reject_threshold', '70', 'Risk score above this is auto-rejected')
ON CONFLICT (key) DO NOTHING;

-- KYC sessions table
CREATE TABLE IF NOT EXISTS kyc_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'review', 'rejected')),
  provider VARCHAR(20) NOT NULL DEFAULT 'minimax',
  external_session_id VARCHAR(100),
  risk_score INTEGER,
  risk_tier VARCHAR(20),
  document_valid BOOLEAN,
  face_match BOOLEAN,
  face_similarity DECIMAL(5,4),
  liveness_passed BOOLEAN,
  sanctions_clear BOOLEAN,
  extracted_fields JSONB,
  fraud_signals JSONB,
  compliance_reasoning TEXT,
  raw_result JSONB,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kyc_sessions_user_id ON kyc_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_sessions_status ON kyc_sessions(status);
```

---

## Phase 4: Backend Routes

### Task 4.1: Replace KYC routes
File: `backend/src/routes/kyc.ts`

Routes:
- `POST /api/kyc/verify` — multipart upload (document, selfie), calls `processKycSubmission`, returns safe summary.
- `GET /api/kyc/status` — returns latest session + user status.
- `POST /api/kyc/webhook` — optional, for async M3 callbacks (if we add async mode later).
- Delete `POST /api/kyc/token`, `POST /api/kyc/verify-ai`, `POST /api/kyc/simulate-success`.

### Task 4.2: Admin KYC config route
File: `backend/src/routes/admin.ts` (or `admin-config.ts`)

Add:
- `POST /api/admin/config/kyc` — save KYC provider, encrypted MiniMax API key, thresholds, requirements.
  - Only `super_admin` can save the API key.
  - Encrypt the key before storing in `admin_settings`.
- `GET /api/admin/config/kyc` — return non-sensitive settings (hide decrypted key; only show `key_set: true/false`).

### Task 4.3: Enforce KYC on withdrawal
File: `backend/src/services/withdrawal-queue.ts`

- Before creating a withdrawal, check `users.kyc_status === 'verified'`.
- If `kyc_required_for_withdrawal` is true and user not verified, reject with clear message.
- Allow admin override for manual review cases.

### Task 4.4: Enforce KYC on large bets (optional)
File: `backend/src/services/game-engine.ts`

- If bet amount > `kyc_required_for_bet_above` and user not verified, reject.

---

## Phase 5: Admin Panel Frontend

### Task 5.1: Add KYC settings page
File: `frontend/app/admin/settings/kyc/page.tsx` (or add section to existing admin settings page)

Fields:
- KYC Provider: `minimax`
- MiniMax API Key input (password field, hidden, update only)
- Require KYC for withdrawal: toggle
- Require KYC for bets above: number input
- Auto-approve threshold: number
- Auto-reject threshold: number
- Test button: runs a KYC verification with sample images and shows result (uses current API key)

### Task 5.2: Update admin KYC review page
File: `frontend/app/admin/kyc/page.tsx` (if exists) or `frontend/app/admin/page.tsx`

Show KYC sessions from `/api/kyc/admin/list`:
- User info, status, decision, risk score, submitted at
- Manual approve/reject buttons for `review` cases
- View extracted fields (name, DOB, doc number) — not raw images

---

## Phase 6: Frontend KYC Page

### Task 6.1: Update `/kyc` page
File: `frontend/app/kyc/page.tsx`

- Remove mock mode UI and simulate-success button.
- Keep document upload + selfie capture.
- On submit, POST multipart to `/api/kyc/verify`.
- Show real processing steps from backend.
- Poll `/api/kyc/status` until completed.
- On approved: show success + extracted fields (optional).
- On rejected: show reason + retry.
- On review: show "under manual review" message.

---

## Phase 7: Security & Compliance

### Task 7.1: API key protection
- MiniMax API key is encrypted at rest in DB.
- Only `super_admin` can view/update it.
- Backend never returns the decrypted key to frontend.
- Key is read from memory cache with TTL, not from DB on every call.

### Task 7.2: Image handling
- Images are processed in memory; never written to disk.
- After processing, images are discarded.
- Optionally store a low-res thumbnail hash for duplicate detection, but not the image itself.
- Max file size: 10 MB.
- Allowed types: jpg, jpeg, png.
- Virus scan? Not in scope for now; can add later with ClamAV if needed.

### Task 7.3: Audit trail
- Every KYC submission logs to `audit_log`.
- Admin approve/reject actions log to `audit_log`.
- Never log raw images, API keys, or full PII.

### Task 7.4: Rate limiting
- Limit `/api/kyc/verify` to 3 attempts per hour per user to prevent abuse.
- Limit admin API key update to 5 attempts per minute.

---

## Phase 8: Testing & Rollout

### Task 8.1: Backend tests
```bash
cd /root/coin-master/backend
npx tsc --noEmit
npm test
```

### Task 8.2: Frontend tests
```bash
cd /root/coin-master/frontend
npx tsc --noEmit
npm test
```

### Task 8.3: Live test with MiniMax API key
1. Admin saves MiniMax API key.
2. User goes to `/kyc`, uploads document + selfie.
3. Verify `/api/kyc/status` returns correct status.
4. Verify withdrawal is blocked for unverified users.
5. Verify admin can review and approve/reject.

### Task 8.4: Home safety check
Before/after deployment:
```bash
for endpoint in /health /api/health /api/kyc/status; do
  curl -s -o /dev/null -w "%{http_code}" https://crazycoin.duckdns.org$endpoint
done
```
Expected: 3 × 200.

---

## Files to Create / Modify

| File | Purpose |
|------|---------|
| `backend/src/services/secret-vault.ts` | Encrypt/decrypt admin secrets |
| `backend/src/services/minimax-client.ts` | MiniMax M3 vision API client |
| `backend/src/services/kyc-ocr.ts` | Tesseract.js OCR wrapper |
| `backend/src/services/kyc-quality.ts` | Image quality checks |
| `backend/src/services/kyc-sanctions.ts` | OpenSanctions screening |
| `backend/src/services/kyc-risk.ts` | Risk scoring |
| `backend/src/services/kyc-session.ts` | Full KYC orchestration |
| `backend/src/services/kyc.ts` | Delete old mock service |
| `backend/src/routes/kyc.ts` | New KYC routes |
| `backend/src/routes/admin.ts` | KYC config endpoints |
| `backend/src/services/withdrawal-queue.ts` | Enforce KYC on withdrawal |
| `backend/migrations/016_create_kyc_settings_and_sessions.sql` | DB changes |
| `backend/package.json` | Add tesseract.js, sharp, uuid |
| `frontend/app/kyc/page.tsx` | Real KYC upload flow |
| `frontend/app/admin/settings/kyc/page.tsx` | Admin KYC config |
| `frontend/app/admin/kyc/page.tsx` | Admin KYC review |
| `.env.example` | Add `KYC_SECRET_ENCRYPTION_KEY` |
| `.env` | Add real encryption key |

---

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| 1 | MiniMax API key invalid or M3 vision not available | Probe endpoint first; fallback to manual review mode |
| 2 | cx23 disk is 95% full before adding packages | Clean build cache first; tesseract.js + sharp add ~500 MB |
| 3 | Tesseract.js OCR accuracy poor | Use it as a signal only; M3 vision is primary |
| 4 | Face matching/liveness solely by LLM | Add local image quality checks; mark uncertain as REVIEW |
| 5 | OpenSanctions API rate limits | Cache results; retry with backoff |
| 6 | API key stored in admin_settings | AES-256-GCM encryption with env-derived key |
| 7 | KYC gating breaks withdrawals | Clear UI message; admin can set `kyc_required_for_withdrawal=false` temporarily |
| 8 | Existing mock-verified users | Reset to unverified after go-live |

---

## Rollback

1. Disable KYC gating:
   ```bash
   # Admin panel → KYC settings → Require KYC for withdrawal = false
   ```

2. Revert backend:
   ```bash
   cd /root/coin-master
   git checkout -- backend/src/services/kyc.ts
   git checkout -- backend/src/routes/kyc.ts
   rm backend/src/services/secret-vault.ts
   rm backend/src/services/minimax-client.ts
   rm backend/src/services/kyc-ocr.ts
   rm backend/src/services/kyc-quality.ts
   rm backend/src/services/kyc-sanctions.ts
   rm backend/src/services/kyc-risk.ts
   rm backend/src/services/kyc-session.ts
   rm backend/migrations/016_create_kyc_settings_and_sessions.sql
   ```

3. Revert frontend:
   ```bash
   git checkout -- frontend/app/kyc/page.tsx
   git checkout -- frontend/app/admin/settings/kyc/page.tsx
   git checkout -- frontend/app/admin/kyc/page.tsx
   ```

4. Rebuild and deploy:
   ```bash
   docker compose up -d --build frontend backend
   ```

---

## What I Will NOT Do

- I will not deploy without a valid MiniMax API key (you provide it, or admin enters it).
- I will not store the MiniMax API key in plaintext.
- I will not store raw KYC images on disk or in DB.
- I will not skip the KYC-required-for-withdrawal check in production unless you explicitly set it off.
- I will not make the KYC flow depend on heavy infrastructure (PaddleOCR, CompreFace, etc.) on cx23.

---

## Awaiting Your `go` / `start` / `do it`

Before I proceed, confirm:
1. **Use MiniMax M3 vision as the primary KYC engine?**
2. **Open-source helpers: tesseract.js + sharp + OpenSanctions API?** (Lightweight, no heavy ML deps.)
3. **Admin panel is where you want to save the MiniMax API key?**
4. **Require KYC before withdrawal?** (yes/no)
5. **Require KYC for bets above a threshold?** (e.g., $500)
6. **Reset existing mock-verified users to unverified after go-live?** (recommended)

Say `go` and I will start with Phase 1 (dependencies + baseline).
