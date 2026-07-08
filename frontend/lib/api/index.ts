/**
 * Determine the API base URL.
 *
 * When the app is served from a non-localhost host (production or a public
 * tunnel), we route API calls through the Next.js frontend's `/api/*`
 * catch-all proxy. This avoids the browser trying to connect to
 * localhost:4000 on the user's machine.
 */
const BASE =
  typeof window !== 'undefined' && !process.env.NEXT_PUBLIC_API_URL
    ? '/api'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

async function request(method: string, path: string, token?: string | null, body?: unknown): Promise<Record<string, any>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return data || {};
}

export const api = {
  get: (path: string, token?: string | null) => request('GET', path, token),
  post: (path: string, token: string | undefined | null, body?: unknown) => request('POST', path, token, body),
  patch: (path: string, token: string | undefined | null, body?: unknown) => request('PATCH', path, token, body),
  delete: (path: string, token: string | undefined | null) => request('DELETE', path, token),
};
