#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  test-group-bet-config.sh — runner for gp-2-04 (Day 8 Phase 2)
#  ════════════════════════════════════════════════════════
#
#  Same pattern as Day-2-6 test runners: auto-socat forwarders for
#  pg (127.0.0.1:55432) + redis (127.0.0.1:6379), source .env for the
#  password, optionally promote 1 test creator to KYC tier 1 if
#  TEST_CREATOR_ID is set, and run the test with the right env.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── 1. Ensure host→postgres + host→redis port-forwards ───────────
if ! nc -z 127.0.0.1 55432 2>/dev/null; then
  echo "[setup] starting socat forward 127.0.0.1:55432 → postgres:5432 …"
  NETWORK=$(docker inspect coin-master-postgres-1 --format '{{json .NetworkSettings.Networks}}' 2>/dev/null | python3 -c "
import json, sys
nets = json.load(sys.stdin)
if nets: print(list(nets.keys())[0])
" 2>/dev/null || echo "coin-master_cryptoflip-network")
  docker run -d --rm --name gp-pg-fwd --network "$NETWORK" -p 55432:5432 alpine/socat TCP-LISTEN:5432,fork TCP:postgres:5432 \
    >/dev/null 2>&1 || true
fi
if ! nc -z 127.0.0.1 6379 2>/dev/null; then
  echo "[setup] starting socat forward 127.0.0.1:6379 → redis:6379 …"
  NETWORK=$(docker inspect coin-master-redis-1 --format '{{json .NetworkSettings.Networks}}' 2>/dev/null | python3 -c "
import json, sys
nets = json.load(sys.stdin)
if nets: print(list(nets.keys())[0])
" 2>/dev/null || echo "coin-master_cryptoflip-network")
  docker run -d --rm --name gp-redis-fwd --network "$NETWORK" -p 6379:6379 alpine/socat TCP-LISTEN:6379,fork TCP:redis:6379 \
    >/dev/null 2>&1 || true
fi

# ── 2. Source password from .env (shell-quoted) ────────────────
USER_=$(grep "^POSTGRES_USER" .env | cut -d= -f2 | tr -d '\n\r')
DB=$(grep "^POSTGRES_DB" .env | cut -d= -f2 | tr -d '\n\r')
PW=$(grep "^POSTGRES_PASSWORD" .env | cut -d= -f2 | tr -d '\n\r')
export DATABASE_URL="postgresql://$USER_:$PW@127.0.0.1:55432/$DB"
export REDIS_HOST=127.0.0.1

# ── 3. Optional test-creator setup (re-uses Day-1-6 test users) ──
CREATOR=$(grep -oE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" /tmp/pg.txt 2>/dev/null | head -1)
if [ -z "$CREATOR" ]; then
  CREATOR=$(docker exec coin-master-postgres-1 psql -U "$USER_" -d "$DB" -tA -c "SELECT id FROM users WHERE is_active=true ORDER BY id LIMIT 1 OFFSET 0" | tr -d ' \n\r')
  echo "$CREATOR" > /tmp/pg.txt
fi
export TEST_CREATOR_ID="$CREATOR"

# Pick 2 more test members (offset 1 and offset 2)
M1=$(docker exec coin-master-postgres-1 psql -U "$USER_" -d "$DB" -tA -c "SELECT id FROM users WHERE is_active=true ORDER BY id LIMIT 1 OFFSET 1" | tr -d ' \n\r')
M2=$(docker exec coin-master-postgres-1 psql -U "$USER_" -d "$DB" -tA -c "SELECT id FROM users WHERE is_active=true ORDER BY id LIMIT 1 OFFSET 2" | tr -d ' \n\r')
if [ -z "$M1" ] || [ -z "$M2" ]; then
  echo "FATAL: need at least 3 active users for this test"
  exit 2
fi
export TEST_MEMBER1_ID="$M1"
export TEST_MEMBER2_ID="$M2"

# Promote creator + 2 members to KYC tier 1 + ensure $50 lifetime deposits
docker exec coin-master-postgres-1 psql -U "$USER_" -d "$DB" >/dev/null 2>&1 <<EOF
UPDATE users SET kyc_tier='1' WHERE id IN ('$CREATOR', '$M1', '$M2') AND kyc_tier::int < 1;
INSERT INTO transactions (user_id, type, amount, currency, direction, status)
SELECT '$CREATOR', 'deposit', 100, 'USD', 'credit', 'confirmed'
WHERE NOT EXISTS (
  SELECT 1 FROM transactions WHERE user_id = '$CREATOR' AND type = 'deposit' AND status = 'confirmed'
);
EOF

echo "[run] CREATOR=$CREATOR  M1=$M1  M2=$M2  (kyc promoted to tier 1)"

# ── 4. Run the test ─────────────────────────────────────────────
cd "$ROOT/backend"
exec npx ts-node ./src/test/gp-2-04-invite.test.ts