# CryptoFlip k6 Load Test

Scripts that exercise the live backend with k6 v2.1+ to measure
end-to-end latency under load. The pre-launch checklist requires:

> k6 load test: 50 VU × 60s, p95 placeBet latency < 250ms

## Files

| File | Purpose |
|---|---|
| `seed_bulk_users.py` | Seed 50 test users (`k6test_0`..`k6test_49`) into the live DB. |
| `placebet_load.js` | k6 script that fires `POST /api/game/bet` from N VUs. |
| `public_load.js` | k6 baseline against `GET /api/public/banner` (no auth). |

## Usage

```bash
# 1. Install k6 (Linux x86_64)
curl -L -o /tmp/k6.tar.gz https://github.com/grafana/k6/releases/download/v2.1.0/k6-v2.1.0-linux-amd64.tar.gz
tar xzf /tmp/k6.tar.gz && cp k6-v2.1.0-linux-amd64/k6 /usr/local/bin/

# 2. Seed 50 test users with 100000 coins + 100000 withdrawable
python3 scripts/loadtest/seed_bulk_users.py

# 3. Wait ~90s for the authLimiter (5/min/IP) to reset after seeding
sleep 90

# 4. Run the placeBet load test
USER_ID=$(python3 -c 'import json; print(json.load(open("/tmp/k6_users.json"))["k6test_0"])')
k6 run scripts/loadtest/placebet_load.js \
  --vus 50 \
  --duration 60s \
  -e K6_USER_ID=$USER_ID
```

## Caveats

- The backend has hard rate limits (`globalLimiter` 100/15min, `authLimiter` 5/min, `gameLimiter` 60/min, session cap 30 bets/min/user). Spreading load across 50 users is the easiest way to test the full hot path without hitting them. A single-user load test will report 99%+ 429s — that's expected behavior, not a regression.
- Login is rate-limited per IP. Run setup() once (1 login) before the VU phase, or wait between logins.
- All seeded users are tagged with `username LIKE 'k6test_%'` so they're easy to clean up later: `DELETE FROM users WHERE username LIKE 'k6test_%';`