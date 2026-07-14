import { query } from '../config/database';

export async function getAdminSetting(key: string, defaultValue?: string): Promise<string | undefined> {
  const result = await query('SELECT value FROM admin_settings WHERE key = $1', [key]);
  if (result.rows.length === 0) return defaultValue;
  return result.rows[0].value;
}

export async function getAdminSettingBool(key: string, defaultValue: boolean): Promise<boolean> {
  const value = await getAdminSetting(key, defaultValue ? 'true' : 'false');
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * Numeric admin setting parser. Returns default if missing or non-numeric.
 * Accepts decimal strings ("1.5"); integer-clamped to floor when isInt=true.
 */
export async function getAdminSettingNumber(
  key: string,
  defaultValue: number,
  isInt = false,
): Promise<number> {
  const raw = await getAdminSetting(key, String(defaultValue));
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultValue;
  return isInt ? Math.floor(n) : n;
}

export async function setAdminSetting(key: string, value: string, description?: string): Promise<void> {
  await query(
    `INSERT INTO admin_settings (key, value, description, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = COALESCE(EXCLUDED.description, admin_settings.description), updated_at = NOW()`,
    [key, value, description || null]
  );
}
