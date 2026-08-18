#!/bin/bash
set -uo pipefail
BASE=http://localhost:4000
H1="Content-Type: application/json"

K0_TOK=$(curl -sS -m 8 -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"k6test_0","password":"K6TestLoad2026!"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
K0_HDR="Authorization: Bearer *** $(docker exec -i coin-master-postgres-1 psql -U cryptoflip -d cryptoflip -Atc "UPDATE users SET kyc_country='BD', total_deposited_coins=100 WHERE id='0fd1b26a-d82c-4968-a370-46198fd945cc';" >/dev/null)

NEWIDREQ="gap11-$(date +%s)"
GRES=$(curl -sS -m 8 -X POST $BASE/api/group-bet/ -H 'Content-Type: application/json' -H "$K0_HDR" -d "{\"creatorChoice\":\"heads\",\"creatorStake\":1,\"perMemberStake\":1,\"minMembers\":2,\"maxMembers\":5,\"payoutMode\":\"equal\",\"turnMode\":\"creator\",\"autoFlipSeconds\":5,\"clientRequestId\":\"$NEWIDREQ\"}")
GID=$(echo "$GRES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('id',''))")
echo "Created: $GID"

q_count() {
  docker exec coin-master-postgres-1 psql -U cryptoflip -d cryptoflip -Atc "SELECT spectator_count FROM group_bet WHERE id='$GID';"
}

echo BEFORE:
echo "DB: $(q_count)"

echo SPECT1-NOAUTH:
curl -sS -m 5 "$BASE/api/group-bet/$GID/spectate"
echo
sleep 0.5
echo "DB: $(q_count)"

echo SPECT2-NOAUTH:
curl -sS -m 5 "$BASE/api/group-bet/$GID/spectate"
echo
sleep 0.5
echo "DB: $(q_count)"

echo SPECT3-AUTHED:
curl -sS -m 5 -H "$K0_HDR" "$BASE/api/group-bet/$GID/spectate"
echo
sleep 0.5
echo "DB: $(q_count)"

echo LEAVE1:
curl -sS -m 5 -X POST "$BASE/api/group-bet/$GID/spectate/leave"
echo
sleep 0.5
echo "DB: $(q_count)"

echo CLAMP:
for i in 1 2 3 4 5; do
  curl -sS -m 5 -X POST "$BASE/api/group-bet/$GID/spectate/leave" >/dev/null
done
sleep 0.5
echo "DB clamped: $(q_count)"

# Cleanup
docker exec coin-master-postgres-1 psql -U cryptoflip -d cryptoflip -Atc "UPDATE users SET kyc_country=NULL WHERE id='0fd1b26a-d82c-4968-a370-46198fd945cc';"
docker exec coin-master-postgres-1 psql -U cryptoflip -d cryptoflip -Atc "DELETE FROM group_bet_member WHERE group_id='$GID';"
docker exec coin-master-postgres-1 psql -U cryptoflip -d cryptoflip -Atc "DELETE FROM group_bet WHERE id='$GID';"
echo "[cleaned up]"
