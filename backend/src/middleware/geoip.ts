import { Request, Response, NextFunction } from 'express';
import geoip from 'geoip-lite';

// Restricted country codes (ISO 3166-1 alpha-2)
const BLOCKED_COUNTRIES = new Set([
  'US', // United States
  'UM', // US Minor Outlying Islands
  'CU', // Cuba
  'IR', // Iran
  'KP', // North Korea
  'SY', // Syria
]);

/**
 * Checks if an IP address is a private/local network address
 */
function isPrivateIP(ip: string): boolean {
  // Normalize IPv6 mapped IPv4 addresses
  const normalized = ip.replace(/^::ffff:/, '');

  if (normalized === '127.0.0.1' || normalized === '::1') {
    return true;
  }

  // IPv4 Private networks:
  // 10.0.0.0 – 10.255.255.255
  // 172.16.0.0 – 172.31.255.255
  // 192.168.0.0 – 192.168.255.255
  const parts = normalized.split('.').map(Number);
  if (parts.length === 4 && !parts.some(isNaN)) {
    const [p0, p1] = parts;
    if (p0 === 10) return true;
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
    if (p0 === 192 && p1 === 168) return true;
  }

  return false;
}

/**
 * Geo-IP Blocking Middleware
 */
export function geoipMiddleware(req: Request, res: Response, next: NextFunction) {
  // 1. Get client IP address
  let ip = (req.headers['cf-connecting-ip'] as string) ||
           (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
           req.socket.remoteAddress || '';

  // 2. Allow manual IP override via header in development mode for easy testing
  if (process.env.NODE_ENV === 'development' && req.headers['x-test-ip']) {
    ip = req.headers['x-test-ip'] as string;
  }

  // 3. Bypass geo check for local/private networks
  if (!ip || isPrivateIP(ip)) {
    return next();
  }

  // 3b. Bypass geo check for IPs in the developer allowlist
  // (CSV env var). Use this to grant specific IPs access despite
  // their apparent jurisdiction. Useful for testing from a proxy
  // whose exit IP geo-locates to a restricted region even though
  // the operator is legitimate.
  const allowlist = (process.env.GEOIP_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    // Normalize IPv6-mapped IPv4 addresses so the allowlist entry
    // '46.62.247.167' matches '::ffff:46.62.247.167' that Node.js
    // sockets report when behind a dual-stack listener.
    .map((s) => s.replace(/^::ffff:/, ''))
    .filter(Boolean);
  const normalizedIp = ip.replace(/^::ffff:/, '');
  if (allowlist.includes(normalizedIp)) {
    (req as any).countryCode = 'ALLOWLIST';
    return next();
  }
  // Update ip to the normalized form so geoip-lite resolves it
  // correctly (otherwise `::ffff:1.2.3.4` returns null).
  ip = normalizedIp;

  // 4. Resolve country code from IP
  const lookup = geoip.lookup(ip);
  if (lookup && lookup.country) {
    const country = lookup.country.toUpperCase();
    
    // Attach country code to request for down-stream context or audit logging
    (req as any).countryCode = country;

    if (BLOCKED_COUNTRIES.has(country)) {
      return res.status(403).json({
        success: false,
        error: `Access denied: Prohibited jurisdiction (${country}).`,
        countryCode: country,
      });
    }
  }

  next();
}
