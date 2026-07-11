# CryptoFlip KYC Implementation Guide

> **Reusable documentation** for the AI-powered KYC system built into CryptoFlip. Follow this guide to implement the same KYC flow in another game or platform.

---

## 1. What This KYC System Does

The KYC system verifies a user's real-world identity by comparing a government-issued ID document with a live selfie. It uses a lightweight, production-ready pipeline that does **not** require heavy self-hosted infrastructure (no PaddleOCR, CompreFace, or Elasticsearch).

### Capabilities

| Feature | How it works |
|---------|--------------|
| **Document upload** | User uploads a passport / national ID / driver's license image. |
| **Selfie capture** | User takes a live selfie in the browser or uploads one. |
| **Image quality checks** | Open-source `sharp` checks resolution, blur, lighting, and file size before spending AI tokens. |
| **OCR** | `tesseract.js` extracts raw text from the document for reference. |
| **AI document + face analysis** | **MiniMax M3 Vision** (or any OpenAI-compatible vision model) decides if the document is real, the selfie is live, and the faces match. |
| **Sanctions/PEP screening** | OpenSanctions API checks the extracted name against public sanctions and politically-exposed-persons lists. |
| **Risk engine** | Combines all signals into a 0–100 risk score and a final decision: `approved`, `review`, or `rejected`. |
| **Admin review** | Super-admins can review borderline cases, approve or reject with a note, and configure thresholds. |
| **Withdrawal gating** | Backend can block withdrawals until KYC status is `approved`. |

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Browser                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  ID Document │  │  Live Selfie │  │  /kyc/page.tsx       │  │
│  │  Upload      │  │  Capture     │  │  (React)             │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└────────────────────┬──────────────────────────────────────────┘
                     │ multipart base64 upload
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CryptoFlip Backend (Node.js)                  │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ kyc.routes.ts   │  │ kyc-session.ts  │  │ kyc-settings.ts │ │
│  │ (HTTP API)      │  │ (orchestrator)  │  │ (admin config)  │ │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────┘ │
│           │                    │                                │
│           ▼                    ▼                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ kyc-quality.ts  │  │ kyc-ocr.ts      │  │ kyc-sanctions.ts│ │
│  │ sharp checks    │  │ tesseract.js    │  │ OpenSanctions   │ │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────┘ │
│           │                    │                                │
│           ▼                    ▼                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ minimax-client.ts (MiniMax M3 Vision)                   │ │
│  │ • document authenticity                                   │ │
│  │ • face match + similarity score                           │ │
│  │ • liveness check                                          │ │
│  │ • fraud signals                                           │ │
│  └────────────────────────┬─────────────────────────────────┘ │
│                          │                                     │
│                          ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ kyc-risk.ts — combines signals into score & decision      │ │
│  └────────────────────────┬─────────────────────────────────┘ │
│                          │                                     │
│                          ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ PostgreSQL — kyc_sessions + users.kyc_status             │ │
│  └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Admin Dashboard                               │
│  ┌─────────────────────────┐  ┌─────────────────────────┐     │
│  │ AdminKycSettings.tsx    │  │ AdminKycReviewPanel.tsx │     │
│  │ (API key + thresholds)  │  │ (approve/reject cases)  │     │
│  └─────────────────────────┘  └─────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15 App Router, React, Tailwind CSS, Lucide icons |
| Backend | Node.js + Express + TypeScript |
| Database | PostgreSQL 16 |
| Image processing | `sharp` |
| OCR | `tesseract.js` with locally cached `eng.traineddata` |
| AI vision | MiniMax M3 via OpenAI-compatible `/chat/completions` endpoint |
| Sanctions | OpenSanctions API (`https://api.opensanctions.org/search`) |
| Encryption | AES-256-GCM for API keys stored in `admin_settings` |
| Rate limiting | `express-rate-limit` (3 attempts per hour per user) |

---

## 4. Database Schema

### `kyc_sessions`

Stores every verification attempt and its results.

```sql
CREATE TABLE IF NOT EXISTS kyc_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'review', 'rejected')),
  provider VARCHAR(20) NOT NULL DEFAULT 'minimax',
  external_session_id VARCHAR(100),
  risk_score INTEGER,
  risk_tier VARCHAR(20),
  final_decision VARCHAR(20),
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

CREATE INDEX idx_kyc_sessions_user_id ON kyc_sessions(user_id, created_at DESC);
CREATE INDEX idx_kyc_sessions_status ON kyc_sessions(status);
CREATE INDEX idx_kyc_sessions_created_at ON kyc_sessions(created_at DESC);
```

### `users` columns

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) DEFAULT 'unverified';
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_verified_at TIMESTAMPTZ;
```

### `admin_settings` keys

| Key | Purpose |
|-----|---------|
| `kyc_provider` | `minimax` or `manual` |
| `kyc_minimax_api_key_encrypted` | Encrypted MiniMax API key |
| `kyc_minimax_model` | e.g. `MiniMax-M3` |
| `kyc_minimax_base_url` | e.g. `https://api.minimax.io/v1` |
| `kyc_required_for_withdrawal` | `true`/`false` |
| `kyc_required_for_bet_above` | Dollar threshold (e.g. `500`) |
| `kyc_auto_approve_threshold` | Risk score < this = auto-approve |
| `kyc_auto_reject_threshold` | Risk score > this = auto-reject |
| `kyc_max_file_size_bytes` | e.g. `10485760` |
| `kyc_allowed_extensions` | `jpg,jpeg,png` |

---

## 5. Backend Flow

### 5.1 Submit verification (`POST /api/kyc/verify`)

1. **Auth middleware** ensures user is logged in.
2. **Rate limiter** allows 3 attempts per hour per user.
3. **Settings check** fails fast if provider is `manual` or API key is missing.
4. **File type validation** checks extension against allowed list.
5. **Image normalization** (`kyc-quality.ts`) resizes, rotates, and compresses to JPEG.
6. **Image quality check** rejects uploads that are too small, blurry, poorly lit, or too large.
7. **OCR** (`kyc-ocr.ts`) extracts raw text from the document.
8. **MiniMax vision** (`minimax-client.ts`) returns:
   - `document_valid`
   - `extracted_fields` (name, DOB, nationality, document number, expiry)
   - `face_match`, `face_similarity_score`
   - `liveness_passed`
   - `fraud_signals`
   - `sanctions_risk`
   - `recommended_decision`
9. **Sanctions screening** (`kyc-sanctions.ts`) queries OpenSanctions with the extracted name.
10. **Risk engine** (`kyc-risk.ts`) calculates score and tier.
11. **Decision logic** maps score + MiniMax recommendation to `approved` / `review` / `rejected`.
12. **Persistence** writes the session and updates `users.kyc_status` / `kyc_verified_at`.

### 5.2 Get status (`GET /api/kyc/status`)

Returns:
- Current `kyc_status` from `users`
- `verifiedAt` timestamp
- Latest `kyc_sessions` record with all AI signals

### 5.3 Admin endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/kyc/admin/settings` | GET | Load current KYC settings |
| `/api/kyc/admin/settings` | POST | Save settings (thresholds, model, provider) |
| `/api/kyc/admin/api-key` | POST | Save encrypted MiniMax API key |
| `/api/kyc/admin/list` | GET | Paginated list of KYC sessions |
| `/api/kyc/admin/review/:id` | POST | Approve/reject with a note |

---

## 6. Risk Engine

The risk engine combines five signals into a score from **0 (low risk)** to **100 (high risk)**.

| Signal | Weight | Notes |
|--------|--------|-------|
| Document validity | 0–30 | `document_valid` from MiniMax |
| Face match | 0–25 | Similarity score >= 0.75 = 0; 0.55–0.75 = 15; < 0.55 = 25 |
| Liveness | 0–20 | `liveness_passed` from MiniMax |
| Sanctions | 0–15 | High risk = 15; medium = 8; low = 0 |
| Image quality | 0–5 | Quality checks from `sharp` |
| OCR confidence | 0–5 | Lower confidence = higher risk |

### Final decision mapping

| Condition | Decision |
|-----------|----------|
| MiniMax recommends `REJECTED` OR score >= 70 | `rejected` |
| MiniMax recommends `APPROVED` AND score < 30 | `approved` |
| Everything else | `review` |

### Thresholds (admin configurable)

| Threshold | Default | Meaning |
|-----------|---------|---------|
| `autoApproveThreshold` | 30 | Scores below this are auto-approved |
| `autoRejectThreshold` | 70 | Scores above this are auto-rejected |

---

## 7. Frontend Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `KYCPage` | `frontend/app/kyc/page.tsx` | User-facing KYC upload/status page |
| `AdminKycSettings` | `frontend/components/dashboard/AdminKycSettings.tsx` | Admin API key + threshold UI |
| `AdminKycReviewPanel` | `frontend/components/dashboard/AdminKycReviewPanel.tsx` | Approve/reject submissions |

### User flow

1. Navigate to `/kyc`.
2. If already `approved`, show success.
3. If `rejected`, show reason and allow retry after a cooldown (rate-limited).
4. Upload document image.
5. Take or upload selfie.
6. Submit → backend returns `sessionId`, `status`, `riskScore`, and AI signals.
7. Show result card.

### API client helpers

Frontend uses standard `fetch` with the user's `cf_token` in the `Authorization` header.

```ts
const API = getApiBase(); // returns /api in production

// Get status
fetch(`${API}/kyc/status`, { headers: { Authorization: `Bearer ${token}` }});

// Submit verification
fetch(`${API}/kyc/verify`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ document: base64Doc, selfie: base64Selfie }),
});
```

---

## 8. Environment Variables

Add these to the backend `.env`:

```bash
# KYC
KYC_SECRET_ENCRYPTION_KEY=        # 32-byte key for AES-256-GCM
MINIMAX_API_BASE_URL=https://api.minimax.io/v1
```

The actual MiniMax API key is stored in the database (`admin_settings`) and encrypted, so it can be rotated from the admin panel without redeploying.

---

## 9. How to Port This KYC to Another Game

### 9.1 Copy the backend modules

Copy these files into your new project's backend:

```
backend/src/routes/kyc.ts
backend/src/services/kyc-session.ts
backend/src/services/kyc-settings.ts
backend/src/services/kyc-ocr.ts
backend/src/services/kyc-quality.ts
backend/src/services/kyc-risk.ts
backend/src/services/kyc-sanctions.ts
backend/src/services/minimax-client.ts
backend/src/services/secret-vault.ts
backend/migrations/016_kyc_custom_minimax.sql
```

### 9.2 Install dependencies

```bash
npm install tesseract.js sharp uuid
npm install --save-dev @types/uuid
```

### 9.3 Add the database migration

Run the SQL from `016_kyc_custom_minimax.sql` (or equivalent) in your database.

### 9.4 Mount the routes

In your Express app entry file:

```ts
import kycRoutes from './routes/kyc';
app.use('/api/kyc', kycRoutes);
```

### 9.5 Add the auth middleware

Your `authMiddleware` must attach `req.user` with at least:

```ts
interface AuthPayload {
  userId: string;
  username: string;
  role: 'user' | 'admin' | 'super_admin';
}
```

### 9.6 Ensure `admin_settings` table exists

The settings system expects a table like:

```sql
CREATE TABLE admin_settings (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

If your project uses a different settings table, adapt `kyc-settings.ts` or wrap your existing helpers.

### 9.7 Copy the frontend components

Copy into your new frontend:

```
frontend/app/kyc/page.tsx
frontend/components/dashboard/AdminKycSettings.tsx
frontend/components/dashboard/AdminKycReviewPanel.tsx
```

### 9.8 Provide the API helper

Your frontend must have `getApiBase()` that returns `/api` or your backend base URL:

```ts
// frontend/lib/api/base.ts
export function getApiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL || '/api';
}
```

### 9.9 Add a `kyc_status` gate to withdrawals

Wherever you process withdrawals, add:

```ts
const userResult = await query('SELECT kyc_status FROM users WHERE id = $1', [userId]);
if (userResult.rows[0].kyc_status !== 'approved') {
  return res.status(403).json({ success: false, error: 'KYC required before withdrawal' });
}
```

### 9.10 Add a KYC gate to high-value bets

```ts
const settings = await getKycSettings();
if (settings.requiredForBetAbove && betAmount > settings.requiredForBetAbove) {
  const userResult = await query('SELECT kyc_status FROM users WHERE id = $1', [userId]);
  if (userResult.rows[0].kyc_status !== 'approved') {
    return res.status(403).json({ success: false, error: 'KYC required for bets above $' + settings.requiredForBetAbove });
  }
}
```

---

## 10. Security & Compliance Notes

| Concern | How it's handled |
|---------|------------------|
| **API key storage** | MiniMax key is encrypted at rest with AES-256-GCM. |
| **Image transmission** | Images travel as base64 inside an HTTPS request. For large-scale production, consider direct S3/R2 presigned uploads. |
| **Image storage** | Only the AI analysis result is stored. The raw base64 images are **not** persisted by default (unless you choose to store them). |
| **Rate limiting** | 3 verification attempts per hour per user. |
| **Admin access** | KYC routes require `authMiddleware` + `roleMiddleware('super_admin')` for admin endpoints. |
| **Audit trail** | KYC actions are written to `audit_logs` for compliance review. |
| **Sanctions data** | Uses OpenSanctions public API; results are not legal advice. For regulated jurisdictions, subscribe to a commercial screening provider. |
| **Data retention** | Define your own retention policy. CryptoFlip keeps `kyc_sessions` records indefinitely but does not store raw images. |

---

## 11. Testing Checklist

### Backend

- [ ] `npm install` completes without errors.
- [ ] Database migration runs successfully.
- [ ] `GET /api/kyc/status` returns `unverified` for a new user.
- [ ] With `kyc_provider = manual`, `POST /api/kyc/verify` returns a clear error.
- [ ] Admin can save the MiniMax API key.
- [ ] Submitting a valid ID + selfie returns `approved` or `review`.
- [ ] Submitting a screenshot instead of a real ID returns `review` or `rejected`.
- [ ] Submitting a mismatched selfie returns `rejected` or high-risk `review`.
- [ ] After approval, `users.kyc_status` is `approved` and `kyc_verified_at` is set.
- [ ] Withdrawal is blocked when `kyc_status !== 'approved'` (if configured).

### Frontend

- [ ] `/kyc` loads the upload form for unverified users.
- [ ] Upload preview works for document and selfie.
- [ ] Submitting shows progress steps.
- [ ] Result card shows status, risk score, and reasoning.
- [ ] Admin KYC settings page loads and saves thresholds.
- [ ] Admin review panel lists submissions and approve/reject works.

### Integration

- [ ] End-to-end test with a real passport and selfie.
- [ ] Rate limit triggers after 3 attempts.
- [ ] OpenSanctions API responds successfully in the logs.

---

## 12. Files Reference

| File | Responsibility |
|------|----------------|
| `backend/src/routes/kyc.ts` | HTTP routes: status, verify, admin settings, admin review, admin list |
| `backend/src/services/kyc-session.ts` | Main orchestrator: image quality → OCR → MiniMax → sanctions → risk → persistence |
| `backend/src/services/kyc-settings.ts` | Load/save KYC configuration from `admin_settings` |
| `backend/src/services/kyc-ocr.ts` | `tesseract.js` worker with local language model |
| `backend/src/services/kyc-quality.ts` | `sharp`-based image validation and normalization |
| `backend/src/services/kyc-risk.ts` | Combines signals into score, tier, and decision |
| `backend/src/services/kyc-sanctions.ts` | OpenSanctions API integration |
| `backend/src/services/minimax-client.ts` | OpenAI-compatible vision call to MiniMax M3 |
| `backend/src/services/secret-vault.ts` | AES-256-GCM encryption for admin secrets |
| `frontend/app/kyc/page.tsx` | User-facing KYC page |
| `frontend/components/dashboard/AdminKycSettings.tsx` | Admin configuration UI |
| `frontend/components/dashboard/AdminKycReviewPanel.tsx` | Admin review queue |
| `backend/migrations/016_kyc_custom_minimax.sql` | Database schema + default settings |
| `docs/plans/kyc-custom-minimax-plan.md` | Original planning document |

---

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `KYC provider is set to manual` | No API key configured | Add MiniMax API key in admin settings |
| `eng.traineddata` download error | OCR language model missing | Include `eng.traineddata` in `backend/tesseract-lang` or allow CDN download on first run |
| MiniMax timeout | API key invalid or region blocked | Check key, base URL, and network |
| OpenSanctions timeout | API rate limit or network | Retry logic already present; consider API key subscription |
| High risk score on good images | Low OCR confidence | Ensure image is high-resolution and well-lit |
| Frontend upload fails | Base64 too large | Reduce max upload size or switch to multipart/S3 |
| Withdrawals not gated | Missing KYC check | Add `kyc_status` check in withdrawal handler |

---

## 14. Future Improvements

- **Direct image upload to S3/R2**: Remove large base64 payloads from application memory.
- **Video liveness**: Replace static selfie with a short challenge-response video.
- **Document type expansion**: Add support for residence permits, driver's licenses, and utility bills.
- **Commercial sanctions provider**: For regulated markets, replace OpenSanctions with Dow Jones, Refinitiv, or ComplyAdvantage.
- **Webhook support**: Notify external systems when a user's KYC status changes.
- **Re-verification**: Require re-KYC after document expiry or high-risk behavior.

---

*Last updated: July 2026*
*Maintainer: CryptoFlip engineering team*
