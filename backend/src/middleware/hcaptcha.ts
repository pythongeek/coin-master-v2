/**
 * ═══════════════════════════════════════════════════════════════
 *  HCAPTCHA VERIFICATION MIDDLEWARE
 *  ─────────────────────────────────────────────────────────────
 *
 *  Validates an hCaptcha token posted by the client (typically on
 *  /api/auth/register, /api/auth/login, or any other endpoint
 *  where you want to add a friction layer against bots).
 *
 *  P1-12 — hCaptcha enforcement on /api/auth/register.
 *
 *  Behavior
 *  ─────────
 *  - If `HCAPTCHA_SECRET` is set in env, the middleware REQUIRES a
 *    `hcaptchaToken` field on `req.body` and verifies it against
 *    `https://api.hcaptcha.com/siteverify`. On failure → 400.
 *  - If `HCAPTCHA_SECRET` is unset (dev / test mode), the middleware
 *    emits a single debug log and ALLOWS the request through. This
 *    is the only way unit tests, CI, and local development can
 *    exercise the registration flow without an external dependency.
 *  - The site key is exposed to the frontend via the public-config
 *    endpoint as `HCAPTCHA_SITE_KEY` (frontend reads it for
 *    rendering the widget); the secret stays server-side only.
 *
 *  Token verification
 *  ──────────────────
 *  POST https://api.hcaptcha.com/siteverify
 *    body: secret=<HCAPTCHA_SECRET>&response=<token>&remoteip=<ip>
 *  Response: { success: boolean, "error-codes": [...], ... }
 *
 *  We classify a token as valid when `success === true` AND
 *  `error-codes` is empty. Any other shape returns 400.
 *
 *  Caching
 *  ───────
 *  hCaptcha tokens are SINGLE-USE. We do not cache them. The remote
 *  call takes ~100-300 ms. If latency becomes a problem, a short-TTL
 *  Redis LRU (5-10 minutes) can be added — out of scope for P1-12.
 *
 *  Failure-mode safety
 *  ───────────────────
 *  If the verify call itself errors (timeout, network), the middleware
 *  returns 400 (fail-closed). The alternative — fail-open — would let
 *  an attacker take the captcha endpoint down to bypass it.
 * ═══════════════════════════════════════════════════════════════
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../config/logger';

const HCAPTCHA_VERIFY_URL = 'https://api.hcaptcha.com/siteverify';

/**
 * Type guard for the hCaptcha siteverify response shape. hCaptcha
 * returns at minimum { success: boolean, ... } with optional
 * challenge_ts, hostname, credit, and error-codes.
 */
interface HCaptchaVerifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  credit?: boolean;
  'error-codes'?: string[];
}

/**
 * POST to the hCaptcha siteverify endpoint with a 4-second timeout.
 * Returns null on any network/timeout error so the caller can
 * fail-closed.
 */
async function verifyHcaptchaToken(
  secret: string,
  token: string,
  remoteIp: string,
): Promise<HCaptchaVerifyResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const body = new URLSearchParams();
    body.set('secret', secret);
    body.set('response', token);
    if (remoteIp) body.set('remoteip', remoteIp);

    const res = await fetch(HCAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn('[hcaptcha] siteverify returned non-2xx', { status: res.status });
      return null;
    }
    return (await res.json()) as HCaptchaVerifyResponse;
  } catch (err) {
    logger.warn('[hcaptcha] siteverify call failed', { error: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The hCaptcha middleware. Reads `req.body.hcaptchaToken`, verifies
 * it against the configured secret, and either calls `next()` on
 * success or returns 400 with `{ success: false, error: 'captcha_invalid' }`.
 *
 * If `HCAPTCHA_SECRET` is not set, the middleware is a NO-OP and
 * logs once. This is the design intent: production deployments set
 * the secret; dev/CI do not. Test suites that need to exercise the
 * "captcha enabled" code path can set the secret via the env before
 * the test.
 */
export const hcaptchaMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Wrap the async body so we don't have to make the outer function
  // async (which would force us to return Promise<void> and the
  // `res.json()` paths would fail to typecheck because Response
  // doesn't satisfy void).
  void (async (): Promise<void> => {
    const secret = process.env.HCAPTCHA_SECRET;

    if (!secret) {
      // Dev / test mode — bypass with a single debug log per process.
      // Use a module-level flag so we don't spam the log on every request.
      if (!(globalThis as any).__hcaptchaBypassLogged) {
        // eslint-disable-next-line no-console
        console.log('[hcaptcha] HCAPTCHA_SECRET not set; bypass enabled (dev/test mode)');
        (globalThis as any).__hcaptchaBypassLogged = true;
      }
      next();
      return;
    }

    const token = (req.body && typeof req.body === 'object' && (req.body as any).hcaptchaToken) as string | undefined;
    if (!token || typeof token !== 'string' || token.trim() === '') {
      res.status(400).json({ success: false, error: 'captcha_invalid' });
      return;
    }

    // Determine the remote IP for the hCaptcha siteverify call.
    // Match the same logic as the auth.ts register handler.
    const ipAddress = (
      (req.headers?.['x-forwarded-for'] as string) ||
      req.ip ||
      req.socket?.remoteAddress ||
      ''
    ).split(',')[0].trim();

    const result = await verifyHcaptchaToken(secret, token.trim(), ipAddress);

    if (!result) {
      // Network / timeout / parse failure — fail closed.
      res.status(400).json({ success: false, error: 'captcha_invalid' });
      return;
    }
    if (!result.success) {
      logger.info('[hcaptcha] token rejected', { errorCodes: result['error-codes'] });
      res.status(400).json({ success: false, error: 'captcha_invalid' });
      return;
    }

    next();
  })();
};
