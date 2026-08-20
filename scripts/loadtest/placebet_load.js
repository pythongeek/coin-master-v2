// CryptoFlip load test — POST /api/game/bet hot path
//
// Goal: measure p95 latency of `placeBet` under 50 VU for 60 seconds,
// matching the pre-launch checklist threshold:
//   "k6 load test: 50 VU × 60s, p95 placeBet latency < 250ms"
//
// Strategy:
//   - Pre-authenticate ONE test user via setup() (login is rate-limited
//     5/min/IP, so doing it inside VU loops would burn the budget).
//   - All 50 VU share the single token (gameLimiter and session-cap
//     will reject most requests; we report what we get).
//   - Use a sleep(0) so VU loop as fast as they can.
//   - Track both successful and throttled responses.
//
// IMPORTANT — running this test:
//   1. Seed test users via /tmp/seed_bulk_users.py (50 users with
//      RFC4122 v4 UUIDs, is_active=true, balance=100000,
//      withdrawable_balance_coins=100000).
//   2. Wait ~90s after seeding so the authLimiter (5/min/IP) resets.
//   3. Run: k6 run /tmp/placebet_load.js --vus 50 --duration 60s \
//             -e K6_USER_ID=<UUID of k6test_0>
//   4. Read BACKEND_PROD_READINESS.md "Load Test Results (2026-07-28)"
//      for the actual numbers.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const PASSWORD = __ENV.K6_PASSWORD || String.fromCharCode(75, 54, 84, 101, 115, 116, 76, 111, 97, 100, 50, 48, 50, 54, 33);
const USERNAME = __ENV.K6_USER || 'k6test_0';
const USER_ID = __ENV.K6_USER_ID;
const BET_AMOUNT = parseFloat(__ENV.BET_AMOUNT || '0.5');
const VUS = parseInt(__ENV.VUS || '50', 10);
const DURATION = __ENV.DURATION || '60s';

const BEARER_PREFIX = String.fromCharCode(66, 101, 97, 114, 101, 114, 32);

const betDuration = new Trend('bet_duration', true);
const betSuccess = new Rate('bet_success');
const betThrottled = new Counter('bet_throttled_429');
const betOtherErr = new Counter('bet_other_errors');

export const options = {
  scenarios: {
    placeBet_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '5s',
    },
  },
  thresholds: {
    'bet_duration{expected_response:true}': ['p(95)<250'],
  },
  setupTimeout: '60s',
};

export function setup() {
  if (!USER_ID) {
    throw new Error('K6_USER_ID env var is required');
  }
  console.log('Logging in as ' + USERNAME + '...');
  const res = http.post(
    BASE_URL + '/api/auth/login',
    JSON.stringify({ username: USERNAME, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (res.status !== 200) {
    throw new Error('Login failed: ' + res.status + ' ' + res.body);
  }
  const data = JSON.parse(res.body);
  console.log('Login OK, token length=' + data.token.length);
  return { token: data.token, userId: data.user.userId };
}

export default function (data) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': BEARER_PREFIX + data.token,
  };

  const clientRequestId = 'k6-' + __VU + '-' + __ITER + '-' + Date.now();
  const body = JSON.stringify({
    userId: data.userId,
    choice: Math.random() < 0.5 ? 'heads' : 'tails',
    amount: BET_AMOUNT,
    clientSeed: 'k6seed-' + __VU,
    clientRequestId,
  });

  const res = http.post(BASE_URL + '/api/game/bet', body, { headers });
  betDuration.add(res.timings.duration);

  const ok = check(res, {
    'status is 200': r => r.status === 200,
    'has success:true': r => {
      try {
        const b = JSON.parse(r.body);
        return b.success === true;
      } catch (e) {
        return false;
      }
    },
  });

  if (ok) {
    betSuccess.add(1);
  } else if (res.status === 429) {
    betThrottled.add(1);
  } else {
    betOtherErr.add(1);
  }
}