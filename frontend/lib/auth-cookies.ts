/**
 * ═══════════════════════════════════════════════════════════════
 *  AUTH COOKIES — client-side cookie mirror of the JWT token
 * ═══════════════════════════════════════════════════════════════
 *
 *  The backend still validates the JWT from the Authorization
 *  header. We keep a cookie copy so the Next.js server component
 *  can read the token and gate the admin shell before any HTML is
 *  sent to the browser.
 *
 *  NOTE: this cookie is NOT httpOnly because the frontend bundle
 *  needs to read/write it. The important security property for the
 *  admin page is that the server validates the token with the
 *  backend; a forged or missing cookie simply results in a 403 UI.
 * ═══════════════════════════════════════════════════════════════
 */

export const TOKEN_COOKIE_NAME = 'cf_token';

function getCookieDomain(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const hostname = window.location.hostname;
  // Don't set a domain for localhost; domain cookies on "localhost" are
  // rejected by browsers. Production IP/hostnames get a domain-wide cookie
  // so the same token works on both :3002 (public) and :3003 (admin gateway).
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
    return undefined;
  }
  return hostname;
}

export function setTokenCookie(token: string) {
  if (typeof window === 'undefined') return;
  const domain = getCookieDomain();
  const maxAge = 60 * 60 * 24 * 7; // 7 days, matching JWT expiry
  const parts = [
    `${TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'path=/',
    `max-age=${maxAge}`,
    'SameSite=Lax',
  ];
  if (domain) parts.push(`domain=${domain}`);
  document.cookie = parts.join('; ');
}

export function clearTokenCookie() {
  if (typeof window === 'undefined') return;
  const domain = getCookieDomain();
  const parts = [
    `${TOKEN_COOKIE_NAME}=`,
    'path=/',
    'max-age=0',
    'SameSite=Lax',
  ];
  if (domain) parts.push(`domain=${domain}`);
  document.cookie = parts.join('; ');
}

export function getTokenCookie(): string | null {
  if (typeof window === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${TOKEN_COOKIE_NAME}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
