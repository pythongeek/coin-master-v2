import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },   // Ramp up to 50 users
    { duration: '1m', target: 50 },    // Stay at 50 users
    { duration: '30s', target: 150 },  // Spike to 150 users
    { duration: '1m', target: 150 },   // Stay at 150 users
    { duration: '30s', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<400'],  // 95% of requests must complete under 400ms
    http_req_failed: ['rate<0.02'],    // Error rate must be less than 2%
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';

export default function () {
  const username = `k6_user_${__VU}_${__ITER}_${Math.floor(Math.random() * 100000)}`;

  // 1. Dynamic Register
  const registerPayload = JSON.stringify({
    username: username,
    password: 'password123',
    email: `${username}@test.com`
  });

  const registerRes = http.post(`${BASE_URL}/api/auth/register`, registerPayload, {
    headers: { 'Content-Type': 'application/json' },
  });

  const registerOk = check(registerRes, {
    'register status is 201': (r) => r.status === 201,
    'has token': (r) => r.json('token') !== undefined,
  });

  if (!registerOk) {
    sleep(1);
    return;
  }

  const token = registerRes.json('token');
  const userId = registerRes.json('user.userId');

  // 2. Place multiple bets using welcome balance
  for (let i = 0; i < 5; i++) {
    const betPayload = JSON.stringify({
      userId: userId,
      choice: Math.random() > 0.5 ? 'heads' : 'tails',
      amount: 0.10, // $0.10 bet
      clientSeed: `k6_seed_${__VU}_${__ITER}_${i}`,
      targetMultiplier: 2.0
    });

    const betRes = http.post(`${BASE_URL}/api/game/bet`, betPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
    });

    check(betRes, {
      'bet status is 200': (r) => r.status === 200,
      'bet successful': (r) => r.json('success') === true,
      'bet completes under 250ms': (r) => r.timings.duration < 250,
    });

    sleep(Math.random() * 1.5 + 0.5); // wait 0.5 - 2s between bets
  }
}
