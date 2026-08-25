import { getApiBase } from '@/lib/api/base';

describe('getApiBase', () => {
  const originalWindow = globalThis.window;
  const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
  const originalInternalApiUrl = process.env.INTERNAL_API_URL;

  afterEach(() => {
    // restore env
    if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = originalApiUrl;

    if (originalInternalApiUrl === undefined) delete process.env.INTERNAL_API_URL;
    else process.env.INTERNAL_API_URL = originalInternalApiUrl;

    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  });

  it('returns /api when in the browser with no NEXT_PUBLIC_API_URL set', () => {
    (globalThis as any).window = {};
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getApiBase()).toBe('/api');
  });

  it('honours NEXT_PUBLIC_API_URL when set, even in the browser', () => {
    (globalThis as any).window = {};
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com';
    expect(getApiBase()).toBe('https://api.example.com');
  });

  it('falls back to localhost during SSR (no window, no env)', () => {
    delete (globalThis as any).window;
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.INTERNAL_API_URL;
    expect(getApiBase()).toBe('http://localhost:4000');
  });

  it('honours INTERNAL_API_URL on the server before NEXT_PUBLIC_API_URL (SSR)', () => {
    delete (globalThis as any).window;
    process.env.INTERNAL_API_URL = 'http://backend:4000';
    process.env.NEXT_PUBLIC_API_URL = 'https://wrong.example.com';
    expect(getApiBase()).toBe('http://backend:4000');
    delete process.env.INTERNAL_API_URL;
  });

  it('never embeds localhost in the client bundle unless env explicitly points there', () => {
    (globalThis as any).window = {};
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000';
    expect(getApiBase()).toBe('http://localhost:4000');
    // sanity: when no env is set the browser never reaches the fallback
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getApiBase()).not.toContain('localhost');
  });
});