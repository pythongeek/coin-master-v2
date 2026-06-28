import Module from 'module';

// ============================================================================
// 0. Intercept ioredis before anything else is loaded
// ============================================================================
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'ioredis') {
    return class MockRedis {
      on(event: string, callback: any) {
        // immediately trigger connect to simulate successful connection
        if (event === 'connect') {
          setTimeout(callback, 0);
        }
        return this;
      }
      set() { return 'OK'; }
      get() { return null; }
      incr() { return 1; }
      del() {}
      expire() {}
    };
  }
  return originalRequire.apply(this, arguments as any);
};

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';

// ============================================================================
// 1. Mock database config BEFORE importing auth router
// ============================================================================
const mockUsers: any[] = [
  {
    id: 'test-user-id',
    username: 'testuser',
    email: 'testuser@example.com',
    password_hash: '', // will be set in runTests
    balance: '100.00',
    is_admin: true,
    role: 'super_admin',
    two_factor_secret: null,
    two_factor_enabled: false,
    two_factor_temp_secret: null,
    is_active: true,
  }
];

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');
  
  if (normalized.includes('SELECT id, username, email, password_hash, balance, is_admin, role, two_factor_enabled FROM users WHERE username = $1')) {
    const username = params[0];
    const user = mockUsers.find(u => u.username === username && u.is_active);
    return { rows: user ? [user] : [] };
  }
  
  if (normalized.includes('SELECT id, username, balance, is_admin, role, two_factor_enabled FROM users WHERE wallet_address = $1')) {
    return { rows: [] };
  }
  
  if (normalized.includes('SELECT email FROM users WHERE id = $1')) {
    const id = params[0];
    const user = mockUsers.find(u => u.id === id);
    return { rows: user ? [{ email: user.email }] : [] };
  }
  
  if (normalized.includes('UPDATE users SET two_factor_temp_secret = $1 WHERE id = $2')) {
    const secret = params[0];
    const id = params[1];
    const user = mockUsers.find(u => u.id === id);
    if (user) {
      user.two_factor_temp_secret = secret;
    }
    return { rows: [] };
  }
  
  if (normalized.includes('SELECT two_factor_temp_secret FROM users WHERE id = $1')) {
    const id = params[0];
    const user = mockUsers.find(u => u.id === id);
    return { rows: user ? [{ two_factor_temp_secret: user.two_factor_temp_secret }] : [] };
  }
  
  if (normalized.includes('UPDATE users SET two_factor_secret = two_factor_temp_secret, two_factor_enabled = true, two_factor_temp_secret = NULL WHERE id = $1')) {
    const id = params[0];
    const user = mockUsers.find(u => u.id === id);
    if (user) {
      user.two_factor_secret = user.two_factor_temp_secret;
      user.two_factor_enabled = true;
      user.two_factor_temp_secret = null;
    }
    return { rows: [] };
  }
  
  if (normalized.includes('SELECT two_factor_secret, two_factor_enabled FROM users WHERE id = $1')) {
    const id = params[0];
    const user = mockUsers.find(u => u.id === id);
    return { rows: user ? [{ two_factor_secret: user.two_factor_secret, two_factor_enabled: user.two_factor_enabled }] : [] };
  }
  
  if (normalized.includes('UPDATE users SET two_factor_secret = NULL, two_factor_enabled = false WHERE id = $1')) {
    const id = params[0];
    const user = mockUsers.find(u => u.id === id);
    if (user) {
      user.two_factor_secret = null;
      user.two_factor_enabled = false;
    }
    return { rows: [] };
  }

  if (normalized.includes('SELECT id, username, balance, is_admin, role, two_factor_secret, two_factor_enabled FROM users WHERE id = $1 AND is_active = true')) {
    const id = params[0];
    const user = mockUsers.find(u => u.id === id && u.is_active);
    return { rows: user ? [user] : [] };
  }
  
  return { rows: [] };
}

import * as dbModule from '../config/database';
const mockDb = {
  connect: async () => ({
    query: async (text: string, params: any[]) => mockQuery(text, params),
    release: () => {}
  }),
  query: async (text: string, params: any[]) => mockQuery(text, params)
};
(dbModule as any).db = mockDb;
(dbModule as any).query = mockQuery;

// ============================================================================
// 2. Real Imports
// ============================================================================
import { base32Decode, generateHotp, verifyTotp, generateTotpSecret, encryptSecret, decryptSecret } from '../utils/totp';
import router from '../routes/auth';

// Express Mock generators
function createMockRequest(body: any = {}, userPayload?: any): Request {
  return {
    body,
    user: userPayload,
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

function getRouteHandler(path: string, method: string): any {
  const route = router.stack.find((s: any) => s.route && s.route.path === path && s.route.methods[method]);
  if (!route) throw new Error(`Route not found for path: ${path}`);
  const handlers = (route as any).route.stack;
  return handlers[handlers.length - 1].handle;
}

// ============================================================================
// 3. Test Execution
// ============================================================================
async function runTests() {
  console.log('🧪 Starting Time-Based One-Time Password (TOTP) 2FA Integration Tests...');
  
  try {
    // Hash password for mock database
    mockUsers[0].password_hash = await bcrypt.hash('password123', 12);
    
    // ══════════════════════════════════════════════════════════════
    //  PART 1: Cryptographic & Utility Tests
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- 1. Testing Cryptographic Utilities ---');
    
    // Test base32 decoding (Hello = JBSWY3DP)
    const decodedHello = base32Decode('JBSWY3DP').toString();
    if (decodedHello === 'Hello') {
      console.log('✅ Base32 decoding verified ("JBSWY3DP" decoded to "Hello").');
    } else {
      throw new Error(`Base32 decoding failed. Expected "Hello", got "${decodedHello}"`);
    }
    
    // Test encryption / decryption
    const testSecret = 'MY_SUPER_SECRET_KEY';
    const encrypted = encryptSecret(testSecret);
    const decrypted = decryptSecret(encrypted);
    if (decrypted === testSecret) {
      console.log('✅ Secret encryption and decryption verified.');
    } else {
      throw new Error(`Encryption failed. Expected "${testSecret}", got "${decrypted}"`);
    }
    
    // Test TOTP verification
    const { secret, otpauthUrl } = generateTotpSecret('testuser@coinmaster.internal');
    if (secret && otpauthUrl.includes('secret=' + secret)) {
      console.log('✅ TOTP secret and otpauthUrl generated successfully.');
    } else {
      throw new Error('TOTP secret generation failed.');
    }
    
    const currentStep = Math.floor(Date.now() / 1000 / 30);
    const correctCode = generateHotp(secret, currentStep);
    
    if (verifyTotp(secret, correctCode)) {
      console.log('✅ TOTP verification succeeded for the correct code.');
    } else {
      throw new Error('TOTP verification failed for correct code.');
    }
    
    if (!verifyTotp(secret, '999999')) {
      console.log('✅ TOTP verification correctly rejected invalid code.');
    } else {
      throw new Error('TOTP verification accepted invalid code.');
    }

    // ══════════════════════════════════════════════════════════════
    //  PART 2: Endpoint Integration Tests
    // ══════════════════════════════════════════════════════════════
    console.log('\n--- 2. Testing Endpoint Route Handlers ---');
    
    const loginHandler = getRouteHandler('/login', 'post');
    const setupHandler = getRouteHandler('/2fa/setup', 'post');
    const verifyHandler = getRouteHandler('/2fa/verify', 'post');
    const disableHandler = getRouteHandler('/2fa/disable', 'post');
    const faLoginHandler = getRouteHandler('/2fa/login', 'post');
    const mockNext = () => {};
    
    // Scenario A: Login when 2FA is NOT enabled
    console.log('\nScenario A: Logging in with 2FA disabled...');
    const reqA = createMockRequest({ username: 'testuser', password: 'password123' });
    const resA = createMockResponse();
    await loginHandler(reqA, resA.res, mockNext);
    
    const respA = resA.getResponse();
    if (resA.getStatusCode() === 200 && respA.success && respA.token && !respA.require2FA) {
      console.log('✅ User logged in directly and received full auth token.');
    } else {
      throw new Error(`Login failed when 2FA is disabled: ${JSON.stringify(respA)}`);
    }
    
    // Scenario B: Starting 2FA setup onboarding
    console.log('\nScenario B: Onboarding 2FA (Setup & Verify)...');
    const reqB1 = createMockRequest({}, { userId: 'test-user-id', username: 'testuser' });
    const resB1 = createMockResponse();
    await setupHandler(reqB1, resB1.res, mockNext);
    
    const respB1 = resB1.getResponse();
    if (resB1.getStatusCode() === 200 && respB1.success && respB1.secret) {
      console.log('✅ 2FA setup initiated successfully.');
    } else {
      throw new Error(`2FA setup initiation failed: ${JSON.stringify(respB1)}`);
    }
    
    // Verification with incorrect token
    const reqB2 = createMockRequest({ token: '000000' }, { userId: 'test-user-id' });
    const resB2 = createMockResponse();
    await verifyHandler(reqB2, resB2.res, mockNext);
    
    if (resB2.getStatusCode() === 400 && !resB2.getResponse().success) {
      console.log('✅ Setup verification failed correctly with a wrong token.');
    } else {
      throw new Error('Setup verification should have failed with wrong token.');
    }
    
    // Verification with correct token
    const correctSetupCode = generateHotp(respB1.secret, Math.floor(Date.now() / 1000 / 30));
    const reqB3 = createMockRequest({ token: correctSetupCode }, { userId: 'test-user-id' });
    const resB3 = createMockResponse();
    await verifyHandler(reqB3, resB3.res, mockNext);
    
    if (resB3.getStatusCode() === 200 && resB3.getResponse().success) {
      console.log('✅ Setup verification succeeded with correct token. 2FA enabled.');
      if (mockUsers[0].two_factor_enabled === true && mockUsers[0].two_factor_secret) {
        console.log('✅ User database record successfully updated to enabled state.');
      } else {
        throw new Error('User record not updated in mock database.');
      }
    } else {
      throw new Error(`Setup verification failed with correct token: ${JSON.stringify(resB3.getResponse())}`);
    }

    // Scenario C: Logging in with 2FA enabled
    console.log('\nScenario C: Logging in with 2FA enabled...');
    const reqC1 = createMockRequest({ username: 'testuser', password: 'password123' });
    const resC1 = createMockResponse();
    await loginHandler(reqC1, resC1.res, mockNext);
    
    const respC1 = resC1.getResponse();
    let tempToken = '';
    if (resC1.getStatusCode() === 200 && respC1.require2FA && respC1.tempToken && !respC1.token) {
      console.log('✅ Login intercepted. require2FA flag set, and tempToken returned.');
      tempToken = respC1.tempToken;
    } else {
      throw new Error(`Login interception failed: ${JSON.stringify(respC1)}`);
    }
    
    // Verify 2FA login with incorrect code
    const reqC2 = createMockRequest({ tempToken, token: '000000' });
    const resC2 = createMockResponse();
    await faLoginHandler(reqC2, resC2.res, mockNext);
    
    if (resC2.getStatusCode() === 401 && !resC2.getResponse().success) {
      console.log('✅ 2FA login rejected correctly with incorrect code.');
    } else {
      throw new Error('2FA login should have been rejected with incorrect code.');
    }
    
    // Verify 2FA login with correct code
    const rawSecret = decryptSecret(mockUsers[0].two_factor_secret!);
    const correctLoginCode = generateHotp(rawSecret, Math.floor(Date.now() / 1000 / 30));
    
    const reqC3 = createMockRequest({ tempToken, token: correctLoginCode });
    const resC3 = createMockResponse();
    await faLoginHandler(reqC3, resC3.res, mockNext);
    
    const respC3 = resC3.getResponse();
    if (resC3.getStatusCode() === 200 && respC3.success && respC3.token) {
      console.log('✅ 2FA login completed successfully. Full authorization token returned.');
    } else {
      throw new Error(`2FA login failed: ${JSON.stringify(respC3)}`);
    }

    // Scenario D: Disabling 2FA
    console.log('\nScenario D: Disabling 2FA...');
    const correctDisableCode = generateHotp(rawSecret, Math.floor(Date.now() / 1000 / 30));
    const reqD = createMockRequest({ token: correctDisableCode }, { userId: 'test-user-id' });
    const resD = createMockResponse();
    await disableHandler(reqD, resD.res, mockNext);
    
    if (resD.getStatusCode() === 200 && resD.getResponse().success) {
      console.log('✅ 2FA disabled successfully using correct token.');
      if (mockUsers[0].two_factor_enabled === false && mockUsers[0].two_factor_secret === null) {
        console.log('✅ User database record successfully updated to disabled state.');
      } else {
        throw new Error('User record was not reset in mock database.');
      }
    } else {
      throw new Error(`Disabling 2FA failed: ${JSON.stringify(resD.getResponse())}`);
    }
    
    console.log('\n🎉 All TOTP 2FA tests passed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    process.exit(1);
  }
}

runTests();
