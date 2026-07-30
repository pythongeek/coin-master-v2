#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  test-group-bet-fraud-admin.sh — runner for gp-1-05 (Day 4)
#  ═══════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ── 1. Ensure host→postgres + host→redis port-forwards ────────────
if ! nc -z 127.0.0.1 55432 2>/dev/null; then
  echo "[setup] starting socat forward 127.0.0.1:55432 → postgres:5432 …"
  NETWORK=$(docker inspect coin-master-postgres-1 \
    --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' \
    | head -1)
  docker run -d --rm --name gp-pg-fwd \
    --network "$NETWORK" \
    -p 55432:5432 \
    alpine/socat TCP-LISTEN:5432,fork TCP:postgres:5432 \
    > /dev/null
  for i in 1 2 3 4 5; do
    if nc -z 127.0.0.1 55432 2>/dev/null; then break; fi
    sleep 1
  done
fi
if ! nc -z 127.0.0.1 6379 2>/dev/null; then
  echo "[setup] starting socat forward 127.0.0.1:6379 → redis:6379 …"
  NETWORK=$(docker inspect coin-master-redis-1 \
    --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' \
    | head -1)
  docker run -d --rm --name gp-redis-fwd \
    --network "$NETWORK" \
    -p 6379:6379 \
    alpine/socat TCP-LISTEN:6379,fork TCP:redis:6379 \
    > /dev/null
  for i in 1 2 3 4 5; do
    if nc -z 127.0.0.1 6379 2>/dev/null; then break; fi
    sleep 1
  done
fi

# ── 2. Export DATABASE_URL ───────────────────────────────────────
PW=$(grep "^POSTGRES_PASSWORD" "$ROOT/.env" | cut -d= -f2 | tr -d '\n\r')
USER_=$(grep "^POSTGRES_USER" "$ROOT/.env" | cut -d= -f2 | tr -d '\n\r')
DB=$(grep "^POSTGRES_DB" "$ROOT/.env" | cut -d= -f2 | tr -d '\n\r')
export DATABASE_URL="postgresql://$USER_:$PW@127.0.0.1:55432/$DB"

# ── 3. Pick 3 ACTIVE users + promote to kyc_tier=1 ───────────────
PSQL=(docker exec coin-master-postgres-1 psql -U "$USER_" -d "$DB" -tA)

CREATOR_ID=$("${PSQL[@]}" -c "SELECT id FROM users WHERE is_active=true AND COALESCE(withdrawable_balance_coins,0) >= 1000 ORDER BY id LIMIT 1 OFFSET 0")
MEMBER1_ID=$("${PSQL[@]}" -c "SELECT id FROM users WHERE is_active=true AND COALESCE(withdrawable_balance_coins,0) >= 1000 ORDER BY id LIMIT 1 OFFSET 1")
MEMBER2_ID=$("${PSQL[@]}" -c "SELECT id FROM users WHERE is_active=true AND COALESCE(withdrawable_balance_coins,0) >= 1000 ORDER BY id LIMIT 1 OFFSET 2")

if [ -z "$CREATOR_ID" ] || [ -z "$MEMBER1_ID" ] || [ -z "$MEMBER2_ID" ]; then
  echo "FATAL: need 3 ACTIVE users with balance ≥ \$1000."
  exit 2
fi

# Snapshot original kyc_tier
CREATOR_KYC=$("${PSQL[@]}" -c "SELECT COALESCE(kyc_tier, '0') FROM users WHERE id = '$CREATOR_ID'")

# Promote for the duration of the test
"${PSQL[@]}" -c "UPDATE users SET kyc_tier='1' WHERE id IN ('$CREATOR_ID','$MEMBER1_ID','$MEMBER2_ID')" > /dev/null

export TEST_CREATOR_ID="$CREATOR_ID"
export TEST_MEMBER1_ID="$MEMBER1_ID"
export TEST_MEMBER2_ID="$MEMBER2_ID"

echo "[run] CREATOR=$CREATOR_ID  M1=$MEMBER1_ID  M2=$MEMBER2_ID  (kyc promoted to tier 1)"
echo

# ── 4. Run the test ─────────────────────────────────────────────
export REDIS_HOST=127.0.0.1
export REDIS_PORT=6379
cd "$ROOT/backend"
set +e
exec npx ts-node ./src/test/gp-1-05-group-bet-fraud-admin.test.ts
RC=$?

# Restore kyc_tier regardless of test outcome
"${PSQL[@]}" -c "UPDATE users SET kyc_tier='$CREATOR_KYC' WHERE id = '$CREATOR_ID'" > /dev/null 2>&1 || true
"${PSQL[@]}" -c "UPDATE users SET kyc_tier='0' WHERE id IN ('$MEMBER1_ID','$MEMBER2_ID') AND id <> '$CREATOR_ID'" > /dev/null 2>&1 || true

exit $RC
