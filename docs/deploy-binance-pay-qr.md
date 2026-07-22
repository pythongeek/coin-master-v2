# Binance Pay QR Deposit — Deployment Runbook

## TL;DR

Five one-time setup commands + a backend restart = the whole flow goes live.

## Pre-flight checklist

| Item | Where to get it | Where it goes |
|---|---|---|
| BEP20 USDT deposit address | Binance app → Wallet → Deposit → USDT → BSC network → copy `0x...` | `BINANCE_DEPOSIT_ADDRESS` in `backend/.env` |
| Binance Spot API Key (read-only, IP-restricted) | binance.com → Account → API Management → Create → System generated → Read only → IP-restricted to `46.62.247.167` | `BINANCE_API_KEY` in `backend/.env` |
| Binance Spot API Secret | Shown ONCE during key creation | `BINANCE_API_SECRET` in `backend/.env` — **never paste in chat** |
| (Optional) MiniMax API key | platform.minimaxi.com → API Keys | `MINIMAX_API_KEY` in `backend/.env` |

## 1. Configure backend env

Edit `/root/coin-master/backend/.env` and add/update:

```bash
# Required — BEP20 USDT deposit address (the one customers send to)
BINANCE_DEPOSIT_ADDRESS=0xYourActualBEP20USDTAddressHere
BINANCE_DEPOSIT_NETWORK=BSC
BINANCE_DEPOSIT_TOKEN=USDT
BINANCE_QR_EXPIRY_MIN=30

# Required — Binance Spot API (READ-ONLY, IP-restricted to 46.62.247.167)
BINANCE_API_KEY=YourPublicKey
BINANCE_API_SECRET=YourSecretKey_NEVER_PASTE_IN_CHAT
BINANCE_API_BASE=https://api.binance.com
BINANCE_LEDGER_POLL_INTERVAL_MS=15000

# Optional — MiniMax (LLM scorer; falls back to rule-only if missing)
MINIMAX_API_KEY=
MINIMAX_MODEL=MiniMax-M3
LLM_SCORER_ENABLED=true
LLM_TIMEOUT_MS=8000

# Required — receipt upload directory (gitignored; mounted as Docker volume in prod)
RECEIPT_UPLOAD_DIR=/opt/cryptoflip/uploads/deposit-receipts
```

**Confirm with:** `grep -E 'BINANCE_DEPOSIT_ADDRESS|BINANCE_API_KEY' /root/coin-master/backend/.env`

## 2. Apply the database migration

```bash
docker exec -i coin-master-postgres-1 \
  psql -U cryptoflip -d cryptoflip \
  < /root/coin-master/backend/migrations/018_binance_pay_qr.sql
```

**Expected output:** `ALTER TABLE`, `CREATE INDEX`, `CREATE TABLE` lines (no errors).

**Verify:**
```bash
docker exec coin-master-postgres-1 psql -U cryptoflip -d cryptoflip \
  -c "\d payment_orders" | grep -E "qr_memo|llm_verdict|detected_tx_hash"
```

Should show the new columns.

## 3. Create the receipt upload directory

```bash
mkdir -p /opt/cryptoflip/uploads/deposit-receipts
chown -R 1001:1001 /opt/cryptoflip/uploads  # match the non-root user inside the backend container
chmod 750 /opt/cryptoflip/uploads/deposit-receipts
```

## 4. Rebuild + restart backend

```bash
cd /root/coin-master
docker compose build backend
docker compose up -d backend
```

**Watch the boot log for:**
```
[binance-ledger-monitor] starting poll loop, interval=15000ms
```

If you see `BINANCE_API_KEY/SECRET missing — loop NOT started`, the env vars didn't reach the container. Run:
```bash
docker exec coin-master-backend-1 env | grep BINANCE
```

## 5. Verify the endpoints

```bash
# Health check (public)
curl -s https://crazycoin.duckdns.org/api/health | jq

# Auth-required: log in first
TOKEN=$(curl -s -X POST https://crazycoin.duckdns.org/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"youruser","password":"yourpass"}' | jq -r '.token')

# Initiate a $50 deposit
curl -s -X POST https://crazycoin.duckdns.org/api/wallet/deposit/qr/initiate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amountUsdt":50}' | jq

# Check status
curl -s https://crazycoin.duckdns.org/api/wallet/deposit/qr/cf_ORDERID \
  -H "Authorization: Bearer $TOKEN" | jq

# Admin review queue (needs admin token)
curl -s https://crazycoin.duckdns.org/api/admin/payments/review-queue \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# LLM stats
curl -s https://crazycoin.duckdns.org/api/admin/payments/llm-stats \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

## 6. Smoke test end-to-end

1. Visit `https://crazycoin.duckdns.org/wallet/deposit` in browser
2. Pick amount ($20 preset for fastest test)
3. Click "Generate QR"
4. Open Binance app on phone → tap [Pay] → [Scan]
5. Scan the QR displayed on the page
6. Binance app pre-fills: send $20 USDT on BSC to `0x...` with memo `ABC12345`
7. Tap Confirm
8. Wait 15–60 seconds — page should auto-update to "Credited ✓"
9. Verify backend log: `[binance-ledger-monitor] tick=N scanned=1 ledger=N matches=1 credited=1 ...`

## Rollback

If something breaks:
```bash
# Stop the ledger monitor (orders will still be creatable, just won't auto-credit)
docker compose exec backend sh -c "kill -TERM 1"

# Or revert via migration
docker exec -i coin-master-postgres-1 psql -U cryptoflip -d cryptoflip \
  -c "UPDATE payment_orders SET status='failed', status_message='Rolled back migration 018' WHERE gateway='binance_pay_qr';"

# Nuclear option: drop the new tables (PRESERVES old data)
docker exec coin-master-postgres-1 psql -U cryptoflip -d cryptoflip <<'EOF'
DROP TABLE IF EXISTS payment_review_decisions CASCADE;
DROP TABLE IF EXISTS deposit_receipt_files CASCADE;
-- Don't drop columns from payment_orders — they're harmless if unused
EOF
```

## Monitoring checklist (first 24h)

- [ ] Backend logs every 15s with `[binance-ledger-monitor]` prefix
- [ ] No 5xx errors in `/api/wallet/deposit/qr/*` responses
- [ ] At least 1 successful test deposit credits correctly
- [ ] Admin review queue UI shows the test deposit during 'verifying' state (if LLM held it)
- [ ] `falseAutoCount` in `/api/admin/payments/llm-stats` stays at 0
- [ ] `disagreementRate` < 20% (otherwise rule vs LLM have divergent heuristics worth tuning)

## Files changed in this rollout

| File | Status |
|---|---|
| `backend/migrations/018_binance_pay_qr.sql` | NEW |
| `backend/src/services/binance-pay-qr.service.ts` | NEW |
| `backend/src/services/binance-pay-ledger-monitor.service.ts` | NEW |
| `backend/src/services/llm-scorer.service.ts` | NEW |
| `backend/src/routes/wallet-deposit-qr.ts` | NEW |
| `backend/src/routes/admin-payments-qr.ts` | NEW |
| `backend/src/schemas/index.ts` | EDITED (added 2 schemas) |
| `backend/src/services/payment-gateways/types.ts` | EDITED (added 'binance_pay_qr' to enum) |
| `backend/src/services/payment-gateways/index.ts` | EDITED (added stub provider) |
| `backend/src/services/payment.ts` | EDITED (added provider name) |
| `backend/src/index.ts` | EDITED (mounted 2 new routers) |
| `backend/.env` | EDITED (added 13 new env vars) |
| `frontend/lib/api/wallet.ts` | EDITED (added QR types + 3 functions) |
| `frontend/app/wallet/deposit/page.tsx` | NEW |
| `frontend/components/dashboard/AdminQrReviewQueue.tsx` | NEW |
| `frontend/components/dashboard/AdminClientShell.tsx` | EDITED (added 'deposits' tab) |
| `frontend/components/dashboard/RecentQrDeposits.tsx` | NEW |
| `frontend/app/dashboard/page.tsx` | EDITED (added widget) |

**Total:** 6 new files, 8 edited files. Zero existing files deleted. All existing endpoints unchanged.

## Known limitations (Phase 1)

- No multi-chain support yet — only BSC (BEP20). Adding TRC20/ERC20 needs only env vars + new memo strategies.
- LLM scorer uses MiniMax free tier (~3 RPS); upgrade to paid tier if deposit volume exceeds 10/min.
- Receipt upload is best-effort OCR; admin still reviews any amount that doesn't match expected.
- No Socket.IO push yet — UI polls every 5s. Adding a `payment:{userId}` socket event is Phase 2.
- Admin review queue page is `/admin/payments/deposits` (added as tab in AdminClientShell).
