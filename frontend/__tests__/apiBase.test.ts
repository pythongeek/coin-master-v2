import { getApiBase } from '@/lib/api/base';

describe('getApiBase', () => {
  const originalWindow = globalThis.window;
  const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

  afterEach(() => {
    // restore env
    if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = originalApiUrl;

    if (originalWindow === undefined) {
      // @ts-ignore — delete to simulate SSR
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  });

  it('returns /api when in the browser with no NEXT_PUBLIC_API_URL set', () => {
    // @ts-ignore — force a browser-like env
    (globalThis as any).window = {};
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getApiBase()).toBe('/api');
  });

  it('honours NEXT_PUBLIC_API_URL when set, even in the browser', () => {
    // @ts-ignore
    (globalThis as any).window = {};
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com';
    expect(getApiBase()).toBe('https://api.example.com');
  });

  it('falls back to localhost during SSR (no window, no env)', () => {
    // @ts-ignore
    delete (globalThis as any).window;
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getApiBase()).toBe('http://localhost:4000');
  });

  it('never embeds localhost in the client bundle unless env explicitly points there', () => {
    // @ts-ignore
    (globalThis as any).window = {};
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000';
    expect(getApiBase()).toBe('http://localhost:4000');
    // sanity: when no env is set the browser never reaches the fallback
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getApiBase()).not.toContain('localhost');
  });
});