/**
 * Determine the API base URL.
 *
 * Resolved by the shared helper in ./base so all callers agree.
 */
import { getApiBase } from './base';
const BASE = getApiBase();

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
  put: (path: string, token: string | undefined | null, body?: unknown) => request('PUT', path, token, body),
  patch: (path: string, token: string | undefined | null, body?: unknown) => request('PATCH', path, token, body),
  delete: (path: string, token: string | undefined | null) => request('DELETE', path, token),
};
