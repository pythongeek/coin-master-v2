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
