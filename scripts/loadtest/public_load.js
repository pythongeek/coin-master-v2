// CryptoFlip baseline load test — GET /api/public/banner
//
// Purpose: measure baseline Express + Redis latency WITHOUT hitting
// the auth/rate-limiter gates, since /api/public/ has no auth and
// no rate limiter.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const VUS = parseInt(__ENV.VUS || '50', 10);
const DURATION = __ENV.DURATION || '60s';

const getDuration = new Trend('get_duration', true);

export const options = {
  scenarios: {
    public_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '5s',
    },
  },
  thresholds: {
    'get_duration{expected_response:true}': ['p(95)<50'],
  },
};

export default function () {
  const res = http.get(BASE_URL + '/api/public/banner');
  getDuration.add(res.timings.duration);
  check(res, {
    'status is 200': r => r.status === 200,
  });
  // No sleep — VU hammer as fast as they can
}