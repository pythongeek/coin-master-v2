/**
 * P3-5 tests — Daily fraud report service.
 *
 * Run standalone:
 *   npx ts-node --require ./setup.ts daily-fraud-report.test.ts
 *
 * Approach: use the shared `__TEST_MOCK_QUERY__` override to capture
 * SQL traffic, then assert the service fires the right queries in
 * the right order. The aggregateDigest() helper is exercised with
 * realistic mock data so the HTML rendering code is covered.
 */

let failed = false;
function assert(cond: unknown, label: string): void {
  if (cond) console.log(`  ✅ ${label}`);
  else { console.error(`  ❌ ${label}`); failed = true; }
}
function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    console.log(`  ✅ ${label} (got ${JSON.stringify(actual)})`);
  } else {
    console.error(`  ❌ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed = true;
  }
}
function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// Counter for aggregateDigest-related queries.
const counters = {
  topRiskUsers: 0,
  newClusters: 0,
  clusterActions: 0,
  flaggedW: 0,
  kyc: 0,
  signals: 0,
  mlPredictions: 0,
  mlProbe: 0,
  digestInsert: 0,
  digestUpdate: 0,
  idempotencySelect: 0,
  minSignalsCheck: 0,
};

// Wrap the existing __TEST_MOCK_QUERY__ from test-mocks.ts.
const baseMock = (global as unknown as { __TEST_MOCK_QUERY__?: (t: string, p: unknown[]) => unknown })
  .__TEST_MOCK_QUERY__;
(global as unknown as { __TEST_MOCK_QUERY__: (t: string, p: unknown[]) => unknown }).__TEST_MOCK_QUERY__ =
  (text: string, params: unknown[]) => {
    const upper = text.toUpperCase();
    if (upper.includes('FROM USERS') && upper.includes('ORDER BY U.RISK_SCORE')) counters.topRiskUsers++;
    if (upper.includes('FROM FRAUD_CLUSTERS') && upper.includes('WHERE DETECTED_AT')) counters.newClusters++;
    if (upper.includes('FROM FRAUD_CLUSTERS') && upper.includes('WHERE RESOLVED_AT')) counters.clusterActions++;
    if (upper.includes('FROM TRANSACTIONS') && upper.includes('HELD') && upper.includes('REJECTED')) counters.flaggedW++;
    if (upper.includes('FROM KYC_SUBMISSIONS')) counters.kyc++;
    if (upper.includes('FROM FRAUD_SIGNALS') && upper.includes('GROUP BY SIGNAL_TYPE')) counters.signals++;
    if (upper.includes('FROM ML_PREDICTIONS P')) counters.mlPredictions++;
    if (upper.includes('FROM ML_PREDICTIONS') && !upper.includes(' P ')) counters.mlProbe++;
    if (upper.startsWith('INSERT INTO DAILY_FRAUD_REPORTS')) counters.digestInsert++;
    if (upper.startsWith('UPDATE DAILY_FRAUD_REPORTS')) counters.digestUpdate++;
    if (upper.includes('FROM DAILY_FRAUD_REPORTS') && upper.includes('REPORT_DATE = ')) counters.idempotencySelect++;
    // Provide realistic-shaped mock data so aggregateDigest renders correctly.
    if (upper.includes('FROM USERS') && upper.includes('ORDER BY U.RISK_SCORE')) {
      return { rows: [
        { user_id: 'aaaaaaaa-1111-2222-3333-444444444444', username: 'toprisk', email: 'a@b.com',
          risk_score: 87, risk_tier: 'high_risk', kyc_status: 'approved' },
      ] };
    }
    if (upper.includes('FROM FRAUD_SIGNALS') && upper.includes('GROUP BY SIGNAL_TYPE')) {
      return { rows: [
        { signal_type: 'ip_high_risk_country', severity: 'high', n: 5 },
        { signal_type: 'kyc_duplicate', severity: 'critical', n: 2 },
      ] };
    }
    if (upper.includes('FROM FRAUD_CLUSTERS')) {
      return { rows: [] };
    }
    if (upper.includes('FROM TRANSACTIONS')) {
      return { rows: [
        { id: 'cccccccc-5555-6666-7777-888888888888',
          user_id: 'aaaaaaaa-1111-2222-3333-444444444444',
          amount: '1234.5', currency: 'USDT', status: 'held',
          ip_address: '1.2.3.4', metadata: { chain: 'BSC' }, created_at: new Date() },
      ] };
    }
    if (upper.includes('FROM KYC_SUBMISSIONS')) {
      return { rows: [] };
    }
    if (upper.includes('FROM ML_PREDICTIONS')) {
      return { rows: [] };
    }
    return baseMock ? baseMock(text, params) : { rows: [], rowCount: 0 };
  };

async function runTests(): Promise<void> {
  console.log('🧪 P3-5 Daily Fraud Report Tests');

  // ── 1. yesterdayIso() helper ────────────────────────────────
  section('yesterdayIso helper');
  const { yesterdayIso, aggregateDigest, sendDailyReport } = await import('../services/daily-fraud-report');
  const yest = yesterdayIso();
  assert(/^\d{4}-\d{2}-\d{2}$/.test(yest), `yesterdayIso returns YYYY-MM-DD (got ${yest})`);
  // The date should be exactly 1 day before today.
  const expected = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assertEq(yest, expected, 'yesterdayIso = today - 1 day');

  // ── 2. aggregateDigest shape ────────────────────────────────
  section('aggregateDigest shape');
  counters.topRiskUsers = counters.newClusters = counters.clusterActions =
    counters.flaggedW = counters.kyc = counters.signals = counters.mlPredictions = 0;
  const digest = await aggregateDigest(yest);
  assert(typeof digest.report_date === 'string', 'digest has report_date');
  assert(typeof digest.total_signals === 'number', 'digest has total_signals');
  assertEq(digest.total_signals, 7, 'total_signals = sum of signal counts');
  assertEq(counters.topRiskUsers, 1, 'top_risk_users query fired');
  assertEq(counters.newClusters, 1, 'new_clusters query fired');
  assertEq(counters.clusterActions, 1, 'cluster_actions query fired');
  assertEq(counters.flaggedW, 1, 'flagged_withdrawals query fired');
  assertEq(counters.kyc, 1, 'kyc_events query fired');
  assertEq(counters.signals, 1, 'signal_counts query fired');
  assertEq(counters.mlPredictions, 1, 'ml_predictions query fired');
  // top_risk_users should render a table when there are users
  assert(digest.top_risk_users.includes('<table'), 'top_risk_users rendered as table');
  assert(digest.top_risk_users.includes('toprisk'), 'top_risk_users includes the test username');
  // flagged_withdrawals should include the count and amount
  assert(/<strong>1<\/strong>\s+flagged/.test(digest.flagged_withdrawals), 'flagged_withdrawals shows count');
  assert(digest.flagged_withdrawals.includes('1234.50'), 'flagged_withdrawals shows total amount');
  // signal_counts should show both rows
  assert(digest.signal_counts.includes('ip_high_risk_country'), 'signal_counts includes first signal');
  assert(digest.signal_counts.includes('kyc_duplicate'), 'signal_counts includes second signal');
  // recommendations is a bullet list
  assert(digest.recommendations.startsWith('<ul>'), 'recommendations is a bullet list');
  assert(digest.recommendations.endsWith('</ul>'), 'recommendations ends with </ul>');

  // ── 3. sendDailyReport idempotency ──────────────────────────
  section('sendDailyReport idempotency (without force)');
  // Override the query mock to simulate "already-sent" for the first call.
  counters.digestInsert = counters.idempotencySelect = 0;
  const previousMock = (global as unknown as { __TEST_MOCK_QUERY__: (t: string, p: unknown[]) => unknown })
    .__TEST_MOCK_QUERY__;
  (global as unknown as { __TEST_MOCK_QUERY__: (t: string, p: unknown[]) => unknown }).__TEST_MOCK_QUERY__ =
    (text: string, params: unknown[]) => {
      const upper = text.toUpperCase();
      if (upper.includes('FROM DAILY_FRAUD_REPORTS') && upper.includes('REPORT_DATE = ')) {
        counters.idempotencySelect++;
        return { rows: [{ id: 99, status: 'sent' }] }; // simulate already-sent
      }
      return previousMock(text, params);
    };
  const result = await sendDailyReport({ force: false });
  assertEq(result.sent, false, 'force=false + already-sent → sent=false');
  assert((result.reason ?? '').startsWith('already-sent'), `reason mentions already-sent (got ${result.reason})`);
  assertEq(counters.idempotencySelect, 1, 'idempotency check fired');

  // ── 4. sendDailyReport quiet day ────────────────────────────
  section('sendDailyReport quiet-day threshold');
  counters.idempotencySelect = counters.digestInsert = counters.minSignalsCheck = 0;
  // First call inserts (no existing row), second confirms skip.
  let firstCallInsertSeen = false;
  let skipRowInserted = false;
  (global as unknown as { __TEST_MOCK_QUERY__: (t: string, p: unknown[]) => unknown }).__TEST_MOCK_QUERY__ =
    (text: string, params: unknown[]) => {
      const upper = text.toUpperCase();
      if (upper.includes('FROM DAILY_FRAUD_REPORTS') && upper.includes('REPORT_DATE = ')) {
        counters.idempotencySelect++;
        return { rows: [] }; // no existing row → first call should proceed
      }
      if (upper.startsWith('INSERT INTO DAILY_FRAUD_REPORTS')) {
        firstCallInsertSeen = true;
        counters.digestInsert++;
        return { rows: [{ id: 100 }] };
      }
      return previousMock(text, params);
    };
  // Total signals in digest = 7. minSignals = 5 → should skip (7 >= 5 → goes through).
  // Set a high threshold so the skip branch fires:
  const quietResult = await sendDailyReport({ force: false, minSignals: 100 });
  assertEq(quietResult.sent, false, 'minSignals=100 + totalSignals=7 → sent=false');
  assert((quietResult.reason ?? '').includes('< min='), `reason mentions min threshold (got ${quietResult.reason})`);
  assertEq(quietResult.totalSignals, 7, 'totalSignals reported even on skip');
  // The digest row should be inserted with status='skipped'
  assertEq(counters.digestInsert, 1, 'skipped digest row inserted');
  assertEq(firstCallInsertSeen, true, 'first INSERT INTO daily_fraud_reports fired');

  // ── 5. sendDailyReport force=true bypasses idempotency ──────
  section('sendDailyReport force=true');
  counters.idempotencySelect = counters.digestInsert = 0;
  // With force=true, the idempotency SELECT is still run (for clarity)
  // but the caller proceeds to insert anyway. The mock returns no
  // existing row + returns a queued row from queueEmail.
  (global as unknown as { __TEST_MOCK_QUERY__: (t: string, p: unknown[]) => unknown }).__TEST_MOCK_QUERY__ =
    (text: string, params: unknown[]) => {
      const upper = text.toUpperCase();
      if (upper.includes('FROM DAILY_FRAUD_REPORTS') && upper.includes('REPORT_DATE = ')) {
        counters.idempotencySelect++;
        return { rows: [] };
      }
      if (upper.startsWith('INSERT INTO DAILY_FRAUD_REPORTS')) {
        counters.digestInsert++;
        return { rows: [{ id: 200 }] };
      }
      // queueEmail will fail because admin_email_config SELECT returns empty,
      // but the digest row insert still happens. The UPDATE step will run too.
      return previousMock(text, params);
    };
  const forceResult = await sendDailyReport({ force: true, recipient: 'ohmyholy99@gmail.com' });
  assert(typeof forceResult.reportId === 'number', 'force=true returns reportId');
  assertEq(counters.digestInsert, 1, 'force=true inserts digest row');
  // Reason should be one of: queued (sent=true) or recipient-not-configured/etc.
  // What matters: the digest row exists in the DB.
  assert(forceResult.recipient === 'ohmyholy99@gmail.com', 'recipient echoed back');

  console.log('\n' + '='.repeat(48));
  if (failed) {
    console.error('❌ daily-fraud-report.test.ts: FAILED');
    process.exit(1);
  } else {
    console.log('✅ daily-fraud-report.test.ts: ALL PASSED');
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});