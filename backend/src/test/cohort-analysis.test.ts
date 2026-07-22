/**
 * P3-6 tests — Behavioral Cohort Comparison.
 *
 * Run standalone:
 *   npx ts-node --require ./setup.ts cohort-analysis.test.ts
 *
 * Approach: exercise the pure functions (cohortKeyFor,
 * cohortFeaturesHash, classifyDevice, ageBucketFor, severityForZ)
 * which don't touch the DB. For the DB-backed service entry points
 * (assignCohortsForAllUsers, runWeeklyCohortAnalysis), we use the
 * shared __TEST_MOCK_QUERY__ override (same pattern as
 * maxmind.test.ts + daily-fraud-report.test.ts) to assert the
 * call ordering and shape.
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

async function runTests(): Promise<void> {
  console.log('🧪 P3-6 Behavioral Cohort Analysis Tests');

  const {
    cohortKeyFor,
    cohortFeaturesHash,
    classifyDevice,
    ageBucketFor,
    severityForZ,
  } = await import('../services/cohort-analysis');

  // ── 1. Pure helpers ─────────────────────────────────────────
  section('Pure helpers');

  // classifyDevice
  assertEq(classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 14_0)'), 'mobile',
    'iPhone UA → mobile');
  assertEq(classifyDevice('Mozilla/5.0 (Linux; Android 10) Mobile'), 'mobile',
    'Android Mobile → mobile');
  assertEq(classifyDevice('Mozilla/5.0 (iPad; CPU OS 14_0)'), 'tablet',
    'iPad UA → tablet');
  assertEq(classifyDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop',
    'Windows desktop UA → desktop');
  assertEq(classifyDevice('curl/8.5.0'), 'desktop', 'curl → desktop (no mobile marker)');
  assertEq(classifyDevice(null), 'unknown', 'null UA → unknown');
  assertEq(classifyDevice(''), 'unknown', 'empty UA → unknown');

  // ageBucketFor — synthetic dates
  const now = Date.now();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000);
  const twoHundredDaysAgo = new Date(now - 200 * 24 * 60 * 60 * 1000);
  assertEq(ageBucketFor(oneDayAgo), 'young', '1d old → young');
  assertEq(ageBucketFor(sixtyDaysAgo), 'mid', '60d old → mid');
  assertEq(ageBucketFor(twoHundredDaysAgo), 'old', '200d old → old');
  assertEq(ageBucketFor(null), 'unknown', 'null created_at → unknown');

  // cohortKeyFor
  const k1 = cohortKeyFor({ country: 'BD', kycTier: 1, createdAt: oneDayAgo, deviceClass: 'mobile' });
  assertEq(k1, 'BD-1-young-mobile', 'cohortKeyFor(BD, 1, young, mobile)');
  const k2 = cohortKeyFor({ country: null, kycTier: null, createdAt: null, deviceClass: 'unknown' });
  assertEq(k2, 'XX-X-unknown-unknown', 'cohortKeyFor(nulls) → XX-X-unknown-unknown');
  const k3 = cohortKeyFor({ country: 'us', kycTier: 0, createdAt: oneDayAgo, deviceClass: 'desktop' });
  assertEq(k3, 'US-0-young-desktop', 'cohortKeyFor lower-cased country → upper-cased');

  // cohortFeaturesHash — deterministic, 32 hex chars
  const h1 = cohortFeaturesHash({ country: 'BD', kycTier: 1, ageBucket: 'young', deviceClass: 'mobile' });
  assertEq(h1.length, 32, 'features hash is 32 hex chars');
  assertEq(/^[0-9a-f]{32}$/.test(h1), true, 'features hash is hex');
  const h2 = cohortFeaturesHash({ country: 'BD', kycTier: 1, ageBucket: 'young', deviceClass: 'mobile' });
  assertEq(h1, h2, 'features hash is deterministic for same inputs');
  const h3 = cohortFeaturesHash({ country: 'BD', kycTier: 2, ageBucket: 'young', deviceClass: 'mobile' });
  assert(h1 !== h3, 'features hash differs when kycTier differs');

  // severityForZ
  assertEq(severityForZ(2.6), 'medium', '|z|=2.6 → medium');
  assertEq(severityForZ(3.9), 'medium', '|z|=3.9 → medium');
  assertEq(severityForZ(4.0), 'high', '|z|=4.0 → high');
  assertEq(severityForZ(5.9), 'high', '|z|=5.9 → high');
  assertEq(severityForZ(6.0), 'critical', '|z|=6.0 → critical');
  assertEq(severityForZ(-7.5), 'critical', '|z|=7.5 → critical (negative)');
  assertEq(severityForZ(0), 'medium', '|z|=0 → medium (below threshold; signal never fires)');

  // ── 2. DB-backed service (call-order test) ───────────────────
  section('DB-backed service call ordering');

  // Counter for the call-order check
  let assignQueryCount = 0;
  let userAgentQueryCount = 0;
  let insertAssignCount = 0;
  let statsQueryCount = 0;
  let statsUpsertCount = 0;
  let outlierUpsertCount = 0;
  let signalInsertCount = 0;

  const baseMock = (global as unknown as { __TEST_MOCK_QUERY__?: (t: string, p: unknown[]) => unknown })
    .__TEST_MOCK_QUERY__;
  (global as unknown as { __TEST_MOCK_QUERY__: (t: string, p: unknown[]) => unknown }).__TEST_MOCK_QUERY__ =
    (text: string, params: unknown[]) => {
      const upper = text.toUpperCase();
      if (upper.includes('FROM USERS') && upper.includes('COALESCE(U.KYC_COUNTRY')) {
        assignQueryCount++;
        // Return 3 users in 2 different cohorts
        return { rows: [
          { user_id: 'aaaaaaaa-1111-2222-3333-444444444444', country: 'BD', kyc_tier: '1', created_at: oneDayAgo },
          { user_id: 'bbbbbbbb-1111-2222-3333-444444444444', country: 'BD', kyc_tier: '1', created_at: oneDayAgo },
          { user_id: 'cccccccc-1111-2222-3333-444444444444', country: 'US', kyc_tier: '2', created_at: twoHundredDaysAgo },
        ] };
      }
      if (upper.includes('FROM TRANSACTIONS') && upper.includes('DISTINCT ON')) {
        userAgentQueryCount++;
        return { rows: [
          { user_id: 'aaaaaaaa-1111-2222-3333-444444444444', user_agent: 'Mozilla/5.0 (iPhone)' },
          { user_id: 'cccccccc-1111-2222-3333-444444444444', user_agent: 'Mozilla/5.0 (Windows NT 10.0)' },
        ] };
      }
      if (upper.startsWith('INSERT INTO BEHAVIORAL_COHORT_ASSIGNMENTS')) {
        insertAssignCount++;
        return { rows: [], rowCount: 1 };
      }
      if (upper.includes('FROM COHORT_USERS') && upper.includes('LATERAL')) {
        statsQueryCount++;
        // Return 3 users with stats; one user has a wildly
        // different bet count to make them an outlier.
        return { rows: [
          { user_id: 'aaaaaaaa-1111-2222-3333-444444444444', bets_per_day: 5, avg_bet_amount: 10, deposit_frequency: 0.5, risk_score_avg: 20, withdrawal_velocity: 0.1 },
          { user_id: 'bbbbbbbb-1111-2222-3333-444444444444', bets_per_day: 6, avg_bet_amount: 11, deposit_frequency: 0.4, risk_score_avg: 22, withdrawal_velocity: 0.1 },
          { user_id: 'cccccccc-1111-2222-3333-444444444444', bets_per_day: 50, avg_bet_amount: 10, deposit_frequency: 0.5, risk_score_avg: 20, withdrawal_velocity: 0.1 },
        ] };
      }
      if (upper.startsWith('INSERT INTO BEHAVIORAL_COHORT_STATS')) {
        statsUpsertCount++;
        return { rows: [], rowCount: 1 };
      }
      if (upper.startsWith('INSERT INTO BEHAVIORAL_COHORT_OUTLIERS')) {
        outlierUpsertCount++;
        return { rows: [], rowCount: 1 };
      }
      if (upper.startsWith('INSERT INTO FRAUD_SIGNALS')) {
        signalInsertCount++;
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      if (upper.startsWith('SELECT') && upper.includes('FROM BEHAVIORAL_COHORT_STATS')) {
        // stats lookup
        return { rows: [
          { metric: 'bets_per_day', mean_value: 5.5, stddev_value: 0.5 },
          { metric: 'avg_bet_amount', mean_value: 10.5, stddev_value: 0.5 },
          { metric: 'deposit_frequency', mean_value: 0.45, stddev_value: 0.05 },
          { metric: 'risk_score_avg', mean_value: 21, stddev_value: 1 },
          { metric: 'withdrawal_velocity', mean_value: 0.1, stddev_value: 0.01 },
        ] };
      }
      if (upper.startsWith('SELECT') && upper.includes('FROM FRAUD_SIGNALS') && upper.includes('LIMIT 1')) {
        // dedup check
        return { rows: [] };
      }
      if (upper.startsWith('SELECT') && upper.includes('FROM BEHAVIORAL_COHORT_ASSIGNMENTS') && upper.includes('GROUP BY COHORT_KEY')) {
        // listCohortKeys
        return { rows: [
          { cohort_key: 'BD-1-young-mobile', size: 2 },
          { cohort_key: 'US-2-old-desktop', size: 1 },
        ] };
      }
      return baseMock ? baseMock(text, params) : { rows: [], rowCount: 0 };
    };

  // Run the analysis
  const { runWeeklyCohortAnalysis } = await import('../services/cohort-analysis');
  const result = await runWeeklyCohortAnalysis();

  // 3 cohorts: aaaaaaaa (BD-1-young-mobile), bbbbbbbb (BD-1-young-unknown),
  // cccccccc (US-2-old-desktop) — bbbbbbbb has no UA row, hence 'unknown'.
  assertEq(result.cohortsScanned, 3, 'three distinct cohorts detected (mobile/unknown/desktop)');
  // The mock stats are shared across cohorts (mock doesn't filter by cohort_key).
  // With mean=5.5 / stddev=0.5, the user with bets=50 is z=89 (outlier)
  // and the user with bets=5 is z=-1 (below threshold), bets=6 is z=1
  // (below threshold). The third cohort is also evaluated against the
  // SAME mock stats → 1 outlier (user cccccccc). Total = 2 outliers.
  assertEq(result.outliersFound, 2, 'two outliers detected under shared mock stats');
  assertEq(result.signalsWritten, 2, 'fraud_signals rows written for both outliers');
  assertEq(result.errors.length, 0, 'no errors');
  assert(assignQueryCount >= 1, `assignCohortsForAllUsers fired the user query (got ${assignQueryCount})`);
  assert(userAgentQueryCount >= 1, `user_agent lookup fired (got ${userAgentQueryCount})`);
  assert(insertAssignCount >= 3, `INSERT INTO behavioral_cohort_assignments fired ≥3 times (got ${insertAssignCount})`);
  assert(statsQueryCount >= 1, `cohort metrics query fired (got ${statsQueryCount})`);
  assert(statsUpsertCount >= 1, `INSERT INTO behavioral_cohort_stats fired (got ${statsUpsertCount})`);
  assert(outlierUpsertCount >= 1, `INSERT INTO behavioral_cohort_outliers fired (got ${outlierUpsertCount})`);
  assert(signalInsertCount >= 1, `INSERT INTO fraud_signals fired (got ${signalInsertCount})`);

  console.log('\n' + '='.repeat(48));
  if (failed) {
    console.error('❌ cohort-analysis.test.ts: FAILED');
    process.exit(1);
  } else {
    console.log('✅ cohort-analysis.test.ts: ALL PASSED');
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});