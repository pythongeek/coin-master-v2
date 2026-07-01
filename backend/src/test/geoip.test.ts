import { Request, Response } from 'express';
import { geoipMiddleware } from '../middleware/geoip';

// Helper function to create mock req, res, next
function createMocks(headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') {
  const req = {
    headers,
    socket: {
      remoteAddress
    }
  } as unknown as Request;

  let statusCode = 200;
  let jsonResponse: any = null;
  let nextCalled = false;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: any) {
      jsonResponse = data;
      return this;
    }
  } as unknown as Response;

  const next = () => {
    nextCalled = true;
  };

  return {
    req,
    res,
    next,
    results: {
      getStatusCode: () => statusCode,
      getResponse: () => jsonResponse,
      wasNextCalled: () => nextCalled
    }
  };
}

async function runTests() {
  console.log('🧪 Starting Geo-IP Blocking Middleware Tests...');
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    // Scenario 1: Private Network Loopback (IPv4)
    console.log('\nScenario 1: Testing IPv4 Loopback bypass...');
    const s1 = createMocks({}, '127.0.0.1');
    geoipMiddleware(s1.req, s1.res, s1.next);
    if (s1.results.wasNextCalled()) {
      console.log('✅ Local IPv4 Loopback successfully bypassed Geo-IP check.');
    } else {
      throw new Error('Failed to bypass IPv4 loopback');
    }

    // Scenario 2: Private Network Loopback (IPv6)
    console.log('\nScenario 2: Testing IPv6 Loopback bypass...');
    const s2 = createMocks({}, '::1');
    geoipMiddleware(s2.req, s2.res, s2.next);
    if (s2.results.wasNextCalled()) {
      console.log('✅ Local IPv6 Loopback successfully bypassed Geo-IP check.');
    } else {
      throw new Error('Failed to bypass IPv6 loopback');
    }

    // Scenario 3: Private Subnet Range (192.168.1.1)
    console.log('\nScenario 3: Testing private network range bypass...');
    const s3 = createMocks({}, '192.168.1.1');
    geoipMiddleware(s3.req, s3.res, s3.next);
    if (s3.results.wasNextCalled()) {
      console.log('✅ Private subnet IP successfully bypassed Geo-IP check.');
    } else {
      throw new Error('Failed to bypass private subnet IP');
    }

    // Scenario 4: Allowed Country IP (Bangladesh Public IP: 103.149.200.1)
    console.log('\nScenario 4: Testing allowed public IP...');
    const s4 = createMocks({}, '103.149.200.1');
    geoipMiddleware(s4.req, s4.res, s4.next);
    if (s4.results.wasNextCalled() && s4.results.getStatusCode() === 200) {
      console.log('✅ Allowed public IP successfully passed.');
    } else {
      throw new Error(`Allowed public IP failed to pass. Status code: ${s4.results.getStatusCode()}`);
    }

    // Scenario 5: Restricted Country IP (US IP: 8.8.8.8)
    console.log('\nScenario 5: Testing restricted public IP blocking...');
    const s5 = createMocks({}, '8.8.8.8');
    geoipMiddleware(s5.req, s5.res, s5.next);
    if (!s5.results.wasNextCalled() && s5.results.getStatusCode() === 403) {
      const resp = s5.results.getResponse();
      if (resp.success === false && resp.countryCode === 'US') {
        console.log('✅ Restricted US IP correctly blocked with 403 and country info.');
      } else {
        throw new Error(`Invalid response details: ${JSON.stringify(resp)}`);
      }
    } else {
      throw new Error(`Expected restricted IP to be blocked, but got: next=${s5.results.wasNextCalled()}, status=${s5.results.getStatusCode()}`);
    }

    // Scenario 6: Test IP Header Override in Development
    console.log('\nScenario 6: Testing test IP override header in development environment...');
    process.env.NODE_ENV = 'development';
    const s6 = createMocks({ 'x-test-ip': '8.8.8.8' }, '127.0.0.1');
    geoipMiddleware(s6.req, s6.res, s6.next);
    if (!s6.results.wasNextCalled() && s6.results.getStatusCode() === 403) {
      console.log('✅ Header override successfully detected in development environment.');
    } else {
      throw new Error('Failed to apply header override in development');
    }

    // Scenario 7: Test IP Header Override Ignored in Production
    console.log('\nScenario 7: Testing test IP override header ignored in production environment...');
    process.env.NODE_ENV = 'production';
    const s7 = createMocks({ 'x-test-ip': '8.8.8.8' }, '127.0.0.1');
    geoipMiddleware(s7.req, s7.res, s7.next);
    if (s7.results.wasNextCalled()) {
      console.log('✅ Header override ignored in production environment as expected.');
    } else {
      throw new Error('Override header was incorrectly honored in production environment');
    }

    console.log('\n🎉 All Geo-IP blocking middleware tests passed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    process.exit(1);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
}

runTests();
