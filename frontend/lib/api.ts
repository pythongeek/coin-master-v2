/**
 * ═══════════════════════════════════════════════════════════════
 *  API CLIENT — single fetch wrapper with credentials: 'include'
 * ═══════════════════════════════════════════════════════════════
 *
 *  PR-1B: replaces the per-component pattern of
 *    const token = localStorage.getItem('cf_token');
 *    fetch(url, { headers: { Authorization: `Bearer ${token}` } });
 *
 *  With:
 *    await apiGet('/api/admin/users');
 *
 *  The browser auto-attaches the httpOnly `cf_token` cookie on
 *  same-origin requests, so we never read the raw JWT from JS.
 *  The browser handles the CORS / credentials handshake.
 *
 *  Base URL resolution rules live in ./api/base (getApiBase);
 *  in the browser we prefer the same-origin /api proxy so the
 *  nginx → frontend → backend chain works without exposing :4000.
 *
 *  Legacy `api.get/post/...` helpers are re-exported at the bottom
 *  for the 31 unrelated callers that still pass a token param
 *  directly. New code should use apiGet/apiPost/apiPut/apiDelete.
 * ═══════════════════════════════════════════════════════════════
 */

import { getApiBase } from './api/base';

export const API_BASE = getApiBase();

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // The browser MUST send the httpOnly cf_token cookie for these
  // calls to auth-gated /api endpoints. `credentials: 'include'`
  // is the only thing that opts the request into that behaviour.
  // Same-origin /api proxy routes make this safe (no third-party
  // cookie sharing).
  return fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
}

export const apiGet = (path: string): Promise<Response> =>
  apiFetch(path, { method: 'GET' });

export const apiPost = (
  path: string,
  body?: unknown,
): Promise<Response> =>
  apiFetch(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

export const apiPut = (
  path: string,
  body?: unknown,
): Promise<Response> =>
  apiFetch(path, {
    method: 'PUT',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

export const apiDelete = (path: string): Promise<Response> =>
  apiFetch(path, { method: 'DELETE' });

// ─────────────────────────────────────────────────────────────────
//  Legacy helpers (`api.get(path, token)`-style) — kept for the 31
//  callers that have not migrated yet. They still take a token
//  argument and emit `Authorization: Bearer`. New code MUST NOT use
//  these; switch to apiGet/apiPost which use credentials: 'include'.
//
//  TODO-PR1B-followup: migrate the remaining callers (search for
//  `import { api } from '@/lib/api'`) and delete this re-export.
// ─────────────────────────────────────────────────────────────────
export { api } from './api/index';
