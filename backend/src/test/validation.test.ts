import { Request, Response, NextFunction } from 'express';
import { validateBody, validateQuery, validateParams } from '../middleware/validation';
import {
  registerSchema,
  loginSchema,
  walletAuthSchema,
  betSchema,
  verifySchema,
  depositAddressSchema,
  depositMerchantSchema,
  withdrawSchema,
  verifyAISchema,
  adminSettingsSchema
} from '../schemas';

// Express Mock generators
function createMockRequest(body: any = {}, query: any = {}, params: any = {}): Request {
  return {
    body,
    query,
    params,
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
  let called = false;
  const next = (() => {
    called = true;
  }) as NextFunction;
  return {
    next,
    wasCalled: () => called,
  };
}

async function runTests() {
  console.log('🧪 Starting Zod Request Validation Schema Integration Tests...');

  try {
    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 1: Auth Validation Rules
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 1: Testing Register and Auth Schemas...');

    // 1.1 Test missing fields in registration
    const middleware1 = validateBody(registerSchema);
    const req1 = createMockRequest({});
    const m1 = createMockResponse();
    const n1 = createMockNext();
    await middleware1(req1, m1.res, n1.next);

    if (m1.getStatusCode() === 400) {
      const resp = m1.getResponse();
      if (!resp.success && resp.error.includes('ভ্যালিডেশন ব্যর্থ')) {
        console.log('✅ Validation failed correctly on empty registration payload.');
      } else {
        throw new Error(`Unexpected failure response: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error(`Expected status 400 but got ${m1.getStatusCode()}`);
    }

    // 1.2 Test invalid inputs in registration (username too short, password too short)
    const req2 = createMockRequest({ username: 'ab', password: '123' });
    const m2 = createMockResponse();
    const n2 = createMockNext();
    await middleware1(req2, m2.res, n2.next);

    if (m2.getStatusCode() === 400) {
      const resp = m2.getResponse();
      const fields = resp.details.map((d: any) => d.field);
      if (fields.includes('username') && fields.includes('password')) {
        console.log('✅ Correctly flagged short username and short password fields.');
      } else {
        throw new Error(`Expected validations for username and password: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error('Expected validation error but passed.');
    }

    // 1.3 Test invalid username pattern (non-alphanumeric/underscore characters)
    const req3 = createMockRequest({ username: 'user-name!', password: 'password123' });
    const m3 = createMockResponse();
    const n3 = createMockNext();
    await middleware1(req3, m3.res, n3.next);

    if (m3.getStatusCode() === 400) {
      const resp = m3.getResponse();
      const userErr = resp.details.find((d: any) => d.field === 'username');
      if (userErr && userErr.message.includes('ইংরেজি অক্ষর, সংখ্যা')) {
        console.log('✅ Correctly rejected invalid character pattern in username.');
      } else {
        throw new Error(`Expected pattern failure for username: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error('Expected validation error on invalid username characters.');
    }

    // 1.4 Test valid payload and coercion/transformation
    const req4 = createMockRequest({ username: 'valid_user_123', password: 'secure_password', email: '' });
    const m4 = createMockResponse();
    const n4 = createMockNext();
    await middleware1(req4, m4.res, n4.next);

    if (n4.wasCalled() && req4.body.email === undefined) {
      console.log('✅ Successfully passed valid registration and transformed empty email to undefined.');
    } else {
      throw new Error(`Valid registration failed or email not transformed: ${JSON.stringify(req4.body)}`);
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 2: Game Bet Validation Rules
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 2: Testing Game Bet Schemas and Coercion...');

    const middleware2 = validateBody(betSchema);

    // 2.1 Test invalid bet parameters (UUID, choice, amount range)
    const req5 = createMockRequest({
      userId: 'not-a-uuid',
      choice: 'draw',
      amount: 0.001,
      targetMultiplier: 0.5
    });
    const m5 = createMockResponse();
    const n5 = createMockNext();
    await middleware2(req5, m5.res, n5.next);

    if (m5.getStatusCode() === 400) {
      const resp = m5.getResponse();
      const fields = resp.details.map((d: any) => d.field);
      if (
        fields.includes('userId') &&
        fields.includes('choice') &&
        fields.includes('amount') &&
        fields.includes('targetMultiplier')
      ) {
        console.log('✅ Correctly flagged invalid UUID, invalid choice, out-of-range amount, and out-of-range multiplier.');
      } else {
        throw new Error(`Expected validations for userId, choice, amount, targetMultiplier: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error('Expected validation error on game bet but passed.');
    }

    // 2.2 Test numeric coercion
    const req6 = createMockRequest({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      choice: 'heads',
      amount: '12.50',
      targetMultiplier: '3.14'
    });
    const m6 = createMockResponse();
    const n6 = createMockNext();
    await middleware2(req6, m6.res, n6.next);

    if (n6.wasCalled() && typeof req6.body.amount === 'number' && req6.body.amount === 12.5) {
      console.log('✅ Correctly coerced string amount and multiplier to number values in req.body.');
    } else {
      throw new Error(`Coercion check failed: ${JSON.stringify(req6.body)}`);
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 3: Wallet Withdrawal Validation Rules
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 3: Testing Wallet Withdrawal Schemas...');

    const middleware3 = validateBody(withdrawSchema);

    // 3.1 Test out-of-range / short outputs
    const req7 = createMockRequest({
      walletId: '123e4567-e89b-12d3-a456-426614174000',
      toAddress: 'shorty',
      amount: -10
    });
    const m7 = createMockResponse();
    const n7 = createMockNext();
    await middleware3(req7, m7.res, n7.next);

    if (m7.getStatusCode() === 400) {
      const resp = m7.getResponse();
      const fields = resp.details.map((d: any) => d.field);
      if (fields.includes('toAddress') && fields.includes('amount')) {
        console.log('✅ Correctly identified short address and negative amount for withdrawal.');
      } else {
        throw new Error(`Expected validations for toAddress and amount: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error('Expected validation error on withdrawal but passed.');
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 4: Admin Config settings updates
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 4: Testing Admin Settings updates validation...');

    const middleware4 = validateBody(adminSettingsSchema);

    // 4.1 Test out of range options (houseEdgePercent > 10)
    const req8 = createMockRequest({
      houseEdgePercent: 12.5,
      minBetAmount: 0.005
    });
    const m8 = createMockResponse();
    const n8 = createMockNext();
    await middleware4(req8, m8.res, n8.next);

    if (m8.getStatusCode() === 400) {
      const resp = m8.getResponse();
      const fields = resp.details.map((d: any) => d.field);
      if (fields.includes('houseEdgePercent') && fields.includes('minBetAmount')) {
        console.log('✅ Correctly identified out-of-bounds config settings.');
      } else {
        throw new Error(`Expected validations for houseEdgePercent and minBetAmount: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error('Expected validation error on config update but passed.');
    }

    // 4.2 Test correct options with coercion
    const req9 = createMockRequest({
      houseEdgePercent: '2.5',
      minBetAmount: '0.1',
      rainEnabled: true,
      maintenanceMessage: 'System update in progress.'
    });
    const m9 = createMockResponse();
    const n9 = createMockNext();
    await middleware4(req9, m9.res, n9.next);

    if (
      n9.wasCalled() &&
      req9.body.houseEdgePercent === 2.5 &&
      req9.body.minBetAmount === 0.1 &&
      req9.body.rainEnabled === true &&
      req9.body.maintenanceMessage === 'System update in progress.'
    ) {
      console.log('✅ Correctly validated and coerced settings updates.');
    } else {
      throw new Error(`Config validation or coercion check failed: ${JSON.stringify(req9.body)}`);
    }

    console.log('\n🎉 All request validation integration tests passed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    process.exit(1);
  }
}

runTests();
