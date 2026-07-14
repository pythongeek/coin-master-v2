/**
 * Auto-loaded by services that need BINANCE_API_SECRET or other secrets
 * that may live in backend/.env rather than the repo-root .env that
 * docker-compose uses for env_file.
 *
 * Walks well-known .env file locations, parses them, and only sets vars
 * that are NOT already in process.env (so docker-compose env vars win
 * for everything that IS already set).
 *
 * This exists because:
 *   - docker-compose reads /root/coin-master/.env into the container
 *   - But operators may also put secrets in /root/coin-master/backend/.env
 *     which is gitignored and not mounted into the container
 *
 * The fix: at service-boot time, we re-read the on-disk file from the
 * container's perspective and inject any missing keys.
 */

import fs from 'fs';
import path from 'path';

const CANDIDATE_FILES = [
  '/root/coin-master/.env',                  // repo root - mounted by compose
  '/app/.env',                                // repo root inside container (fallback)
  path.resolve(__dirname, '../../.env'),      // backend/.env relative
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../.env'),
];

export function loadEnvFromDisk(): { loaded: number; files: string[] } {
  const result = { loaded: 0, files: [] };
  for (const file of CANDIDATE_FILES) {
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const parsed = parseDotenv(content);
      let n = 0;
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined || process.env[key] === '') {
          process.env[key] = value;
          n += 1;
        }
      }
      if (n > 0) {
        result.loaded += n;
        (result.files as string[]).push(file);
      }
    } catch (err) {
      console.warn(`[env-loader] failed to parse ${file}: ${(err as Error).message}`);
    }
  }
  return result;
}

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Strip inline comments
    const hashIdx = value.indexOf(' #');
    if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    if (key) out[key] = value;
  }
  return out;
}
