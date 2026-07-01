import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../config/database';
import { kycService } from '../services/kyc';
import { getStatus, postToken, postWebhook, postSimulateSuccess, postVerifyAI, AuthRequest } from '../routes/kyc';

// Mock database state variables
let mockKycStatus = 'unverified';
let mockKycVerifiedAt: Date | null = null;
let mockKycApplicantId: string | null = null;

// Mock pool.query and pool.connect directly to isolate tests from running database instances
(db as any).query = async (text: string, params?: any[]): Promise<any> => {
  const queryStr = text.trim().replace(/\s+/g, ' ');

  if (queryStr.includes('SELECT kyc_status, kyc_verified_at, kyc_applicant_id')) {
    return {
      rows: [{
        kyc_status: mockKycStatus,
        kyc_verified_at: mockKycVerifiedAt,
        kyc_applicant_id: mockKycApplicantId
      }]
    };
  }

  if (queryStr.includes('SELECT email, username, kyc_applicant_id, kyc_status')) {
    return {
      rows: [{
        email: 'test@example.com',
        username: 'test_user',
        kyc_applicant_id: mockKycApplicantId,
        kyc_status: mockKycStatus
      }]
    };
  }

  if (queryStr.includes('UPDATE users SET kyc_applicant_id = $1, kyc_status = $2')) {
    mockKycApplicantId = params?.[0] || null;
    mockKycStatus = params?.[1] || 'unverified';
    return { rows: [] };
  }

  if (queryStr.includes("UPDATE users SET kyc_status = 'verified'")) {
    mockKycStatus = 'verified';
    mockKycVerifiedAt = new Date();
    if (params && params.length > 0) {
      mockKycApplicantId = params[0];
    }
    return { rows: [] };
  }

  if (queryStr.includes("UPDATE users SET kyc_status = 'rejected'")) {
    mockKycStatus = 'rejected';
    if (params && params.length > 0) {
      mockKycApplicantId = params[0];
    }
    return { rows: [] };
  }

  if (queryStr.includes("UPDATE users SET kyc_status = 'pending'")) {
    mockKycStatus = 'pending';
    return { rows: [] };
  }

  if (queryStr.includes('UPDATE users SET kyc_status = $1, kyc_verified_at = NOW()')) {
    mockKycStatus = params?.[0] || 'verified';
    mockKycVerifiedAt = new Date();
    return { rows: [] };
  }

  if (queryStr.includes('UPDATE users SET kyc_status = $1 WHERE id =')) {
    mockKycStatus = params?.[0] || 'rejected';
    return { rows: [] };
  }

  return { rows: [] };
};

// Mock pool connect method
(db as any).connect = async (): Promise<any> => {
  return {
    query: db.query,
    release: () => {},
  };
};

// Mock Express req, res generators
function createMockRequest(userId?: string, body: any = {}, headers: Record<string, string> = {}): AuthRequest {
  const req = {
    body,
    headers,
    user: userId ? { userId, username: 'test_user', isAdmin: false } : undefined,
  } as unknown as AuthRequest;
  return req;
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
    results: {
      getStatusCode: () => statusCode,
      getResponse: () => jsonResponse,
    },
  };
}

async function runTests() {
  console.log('🧪 Starting Mocked KYC Service & Routes Integration Tests...');
  const testUserId = uuidv4();

  try {
    // 1. Test KYC Service Mock Mode checks
    console.log('\nScenario 1: Testing KYC Service Mock Mode...');
    const isMock = kycService.isMockMode();
    console.log(`ℹ️ KYC Service is running in Mock Mode: ${isMock}`);
    if (isMock) {
      const applicant = await kycService.createApplicant(testUserId, 'test@example.com');
      if (applicant.applicantId.startsWith('mock_applicant_')) {
        console.log('✅ Mock applicant creation succeeded.');
      } else {
        throw new Error('Failed to generate mock applicant ID');
      }

      const token = await kycService.getAccessToken(testUserId);
      if (token.startsWith('mock_sdk_token_')) {
        console.log('✅ Mock access token generation succeeded.');
      } else {
        throw new Error('Failed to generate mock access token');
      }
    } else {
      console.log('⚠️ Running in real mode. Skipping mock assertions.');
    }

    // 2. Test GET /status route
    console.log('\nScenario 2: Testing GET /status route handler...');
    mockKycStatus = 'unverified';
    mockKycApplicantId = null;
    mockKycVerifiedAt = null;

    const req1 = createMockRequest(testUserId);
    const m1 = createMockResponse();
    await getStatus(req1, m1.res);

    if (m1.results.getStatusCode() === 200) {
      const resp = m1.results.getResponse();
      if (resp.success && resp.kycStatus === 'unverified') {
        console.log('✅ Initial status is correctly unverified.');
      } else {
        throw new Error(`Unexpected status response: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error(`Status route failed with code ${m1.results.getStatusCode()}`);
    }

    // 3. Test POST /token route
    console.log('\nScenario 3: Testing POST /token route handler...');
    const req2 = createMockRequest(testUserId);
    const m2 = createMockResponse();
    await postToken(req2, m2.res);

    if (m2.results.getStatusCode() === 200) {
      const resp = m2.results.getResponse();
      if (resp.success && resp.token) {
        console.log('✅ Token response contains access token.');
        if (mockKycStatus === 'pending' && mockKycApplicantId) {
          console.log('✅ User updated to pending status and applicant id registered in mock database.');
        } else {
          throw new Error(`User status not updated in mock DB: ${mockKycStatus}, ${mockKycApplicantId}`);
        }
      } else {
        throw new Error(`Token endpoint returned error: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error(`Token route failed with code ${m2.results.getStatusCode()}`);
    }

    // 4. Test POST /verify-ai route (Mock mode verify-ai check)
    console.log('\nScenario 4: Testing POST /verify-ai route handler...');
    // Reset status to unverified
    mockKycStatus = 'unverified';
    mockKycApplicantId = null;

    const req3 = createMockRequest(testUserId, {
      document: 'data:image/jpeg;base64,mockdocdata',
      selfie: 'data:image/jpeg;base64,mockselfiedata'
    });
    const m3 = createMockResponse();
    await postVerifyAI(req3, m3.res);

    if (m3.results.getStatusCode() === 200) {
      const resp = m3.results.getResponse();
      if (resp.success && resp.verified) {
        console.log('✅ AI verification route handler successfully completed.');
        if (mockKycStatus === 'verified' && mockKycApplicantId === `ai_${testUserId}`) {
          console.log('✅ User status correctly transitioned to verified in mock DB.');
        } else {
          throw new Error(`User status was not updated correctly in mock DB: ${mockKycStatus}`);
        }
      } else {
        throw new Error(`AI verification endpoint returned fail: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error(`AI verification route failed with code ${m3.results.getStatusCode()}`);
    }

    // 5. Test POST /simulate-success route
    console.log('\nScenario 5: Testing POST /simulate-success route handler...');
    // Reset status to unverified
    mockKycStatus = 'unverified';
    mockKycApplicantId = null;

    const req5 = createMockRequest(testUserId);
    const m5 = createMockResponse();
    await postSimulateSuccess(req5, m5.res);

    if (m5.results.getStatusCode() === 200) {
      const resp = m5.results.getResponse();
      if (resp.success) {
        console.log('✅ Simulation success endpoint succeeded.');
        if (mockKycStatus === 'verified') {
          console.log('✅ User KYC updated to verified in the mock database.');
        } else {
          throw new Error('Simulation failed to update mock DB');
        }
      } else {
        throw new Error(`Simulation route returned error: ${JSON.stringify(resp)}`);
      }
    } else {
      // If we are in real mode, it's expected to return 403
      if (kycService.isMockMode()) {
        throw new Error(`Simulation route failed with code ${m5.results.getStatusCode()}`);
      } else {
        console.log('✅ Simulation endpoint correctly forbidden in production mode.');
      }
    }

    // 6. Test POST /webhook route
    console.log('\nScenario 6: Testing POST /webhook route handler...');
    mockKycStatus = 'unverified';
    mockKycVerifiedAt = null;

    const webhookPayload = {
      applicantId: 'mock_app_123',
      externalUserId: testUserId,
      reviewStatus: 'completed',
      reviewResult: {
        reviewAnswer: 'GREEN',
      },
    };
    const req6 = createMockRequest(undefined, webhookPayload);
    const m6 = createMockResponse();
    await postWebhook(req6, m6.res);

    if (m6.results.getStatusCode() === 200) {
      const resp = m6.results.getResponse();
      if (resp.success) {
        if (mockKycStatus === 'verified') {
          console.log('✅ Webhook status update correctly processed and user is verified.');
        } else {
          throw new Error('User status not updated by webhook');
        }
      } else {
        throw new Error(`Webhook endpoint returned error: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error(`Webhook route failed with code ${m6.results.getStatusCode()}`);
    }

    console.log('\n🎉 All KYC integration tests passed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    process.exit(1);
  }
}

runTests();
