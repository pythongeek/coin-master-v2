import { Request, Response, NextFunction } from 'express';
import { roleMiddleware, AuthPayload } from '../middleware/auth';

// Express Mock generators
function createMockRequest(user: AuthPayload): Request {
  return {
    user,
  } as unknown as Request;
}

function createMockResponse() {
  let statusCode = 200;
  let jsonResponse: any = null;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: any) {
      jsonResponse = data;
      return this;
    },
  } as unknown as Response;

  return {
    res,
    getStatusCode: () => statusCode,
    getResponse: () => jsonResponse,
  };
}

function createMockNext() {
  let called = 0;
  const next = (() => {
    called += 1;
  }) as NextFunction;
  return {
    next,
    getCalls: () => called,
  };
}

async function runTests() {
  console.log('🧪 Starting Role-Based Access Control (RBAC) Middleware Tests...');

  try {
    // Define middleware configurations
    const superAdminOnly = roleMiddleware(['super_admin']);
    const readOnlyAdmin = roleMiddleware(['super_admin', 'finance', 'auditor']);
    const supportOrAdmin = roleMiddleware(['super_admin', 'support', 'finance', 'auditor']);

    // Define test users
    const superAdminUser: AuthPayload = { userId: '1', username: 'super_admin', isAdmin: true, role: 'super_admin' };
    const supportUser: AuthPayload = { userId: '2', username: 'support_staff', isAdmin: false, role: 'support' };
    const auditorUser: AuthPayload = { userId: '3', username: 'auditor_staff', isAdmin: false, role: 'auditor' };
    const financeUser: AuthPayload = { userId: '4', username: 'finance_staff', isAdmin: false, role: 'finance' };
    const normalUser: AuthPayload = { userId: '5', username: 'normal_player', isAdmin: false, role: 'user' };
    const legacyAdminUser = { userId: '6', username: 'legacy_admin', isAdmin: true } as AuthPayload; // missing role

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 1: Super Admin Permissions (Full Access)
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 1: Testing Super Admin access permissions...');

    const req1 = createMockRequest(superAdminUser);
    const m1 = createMockResponse();
    const n1 = createMockNext();
    await superAdminOnly(req1, m1.res, n1.next);

    if (n1.getCalls() === 1 && m1.getStatusCode() === 200) {
      console.log('✅ Super Admin allowed access to highly restricted endpoint.');
    } else {
      throw new Error(`Expected Super Admin to pass. Code: ${m1.getStatusCode()}`);
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 2: Support Staff Permissions (Restricted config edits, allowed stats)
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 2: Testing Support staff restrictions...');

    // Block config edit
    const req2a = createMockRequest(supportUser);
    const m2a = createMockResponse();
    const n2a = createMockNext();
    await superAdminOnly(req2a, m2a.res, n2a.next);

    if (n2a.getCalls() === 0 && m2a.getStatusCode() === 403) {
      const resp = m2a.getResponse();
      if (!resp.success && resp.error.includes('অনুমতি নেই')) {
        console.log('✅ Support staff correctly blocked from config edits with 403 Bengali error.');
      } else {
        throw new Error(`Unexpected block payload: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error('Expected support staff to be blocked from config edits.');
    }

    // Allow stats check
    const req2b = createMockRequest(supportUser);
    const m2b = createMockResponse();
    const n2b = createMockNext();
    await supportOrAdmin(req2b, m2b.res, n2b.next);

    if (n2b.getCalls() === 1 && m2b.getStatusCode() === 200) {
      console.log('✅ Support staff successfully allowed access to live statistics.');
    } else {
      throw new Error(`Expected support to access stats. Code: ${m2b.getStatusCode()}`);
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 3: Auditor Permissions (Read config allowed, edit blocked)
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 3: Testing Auditor permissions...');

    // Allow config read
    const req3a = createMockRequest(auditorUser);
    const m3a = createMockResponse();
    const n3a = createMockNext();
    await readOnlyAdmin(req3a, m3a.res, n3a.next);

    if (n3a.getCalls() === 1 && m3a.getStatusCode() === 200) {
      console.log('✅ Auditor allowed to read configuration configurations.');
    } else {
      throw new Error(`Expected auditor to read config. Code: ${m3a.getStatusCode()}`);
    }

    // Block config edit
    const req3b = createMockRequest(auditorUser);
    const m3b = createMockResponse();
    const n3b = createMockNext();
    await superAdminOnly(req3b, m3b.res, n3b.next);

    if (n3b.getCalls() === 0 && m3b.getStatusCode() === 403) {
      console.log('✅ Auditor correctly blocked from modifying configs.');
    } else {
      throw new Error('Expected auditor to be blocked from config edits.');
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 4: Finance staff permissions
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 4: Testing Finance staff permissions...');

    // Allow config read
    const req4a = createMockRequest(financeUser);
    const m4a = createMockResponse();
    const n4a = createMockNext();
    await readOnlyAdmin(req4a, m4a.res, n4a.next);

    if (n4a.getCalls() === 1 && m4a.getStatusCode() === 200) {
      console.log('✅ Finance staff allowed to read configuration.');
    } else {
      throw new Error(`Expected finance staff to read config. Code: ${m4a.getStatusCode()}`);
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 5: Normal User Blocked
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 5: Testing Normal user access restrictions...');

    const req5 = createMockRequest(normalUser);
    const m5 = createMockResponse();
    const n5 = createMockNext();
    await supportOrAdmin(req5, m5.res, n5.next);

    if (n5.getCalls() === 0 && m5.getStatusCode() === 403) {
      console.log('✅ Normal player correctly blocked from administrative routes.');
    } else {
      throw new Error('Expected normal user to be blocked.');
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 6: Legacy/Backward Compatibility Fallback
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 6: Testing backward compatibility fallback (isAdmin: true mapping)...');

    const req6 = createMockRequest(legacyAdminUser);
    const m6 = createMockResponse();
    const n6 = createMockNext();
    await superAdminOnly(req6, m6.res, n6.next);

    if (n6.getCalls() === 1 && m6.getStatusCode() === 200) {
      console.log('✅ Legacy token with only isAdmin: true successfully fallback-mapped to super_admin.');
    } else {
      throw new Error(`Expected legacy admin to pass. Code: ${m6.getStatusCode()}`);
    }

    console.log('\n🎉 All RBAC middleware integration tests passed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    process.exit(1);
  }
}

runTests();
