import { query } from '../config/database';

/**
 * Check if an IP address is in the admin-managed whitelist.
 * Whitelisted IPs bypass fraud detection (multi-account IP checks
 * and fraud-guard blocks for flagged accounts).
 *
 * P3-7-fix: normalizes IPv4-mapped IPv6 forms (::ffff:46.62.247.167)
 * to their bare IPv4 representation (46.62.247.167) before lookup, so
 * `46.62.247.167` in ip_whitelist matches `::ffff:46.62.247.167` from
 * a Node.js request handler (Node reports IPv4-in-IPv6 when the
 * connection lands on a dual-stack socket).
 */
export async function isIpWhitelisted(ipAddress: string): Promise<boolean> {
  if (!ipAddress || ipAddress === '127.0.0.1' || ipAddress === '::1') {
    return false;
  }
  const normalized = ipAddress.startsWith('::ffff:')
    ? ipAddress.slice('::ffff:'.length)
    : ipAddress;
  try {
    const result = await query(
      'SELECT 1 FROM ip_whitelist WHERE ip_address IN ($1, $2) LIMIT 1',
      [normalized, ipAddress],
    );
    return result.rows.length > 0;
  } catch {
    // If table doesn't exist yet, treat as not whitelisted
    return false;
  }
}

/**
 * Get all whitelisted IPs with metadata.
 */
export async function getWhitelistedIps(): Promise<any[]> {
  const result = await query(
    `SELECT w.id, w.ip_address, w.reason, w.created_by, w.created_at,
            u.username as created_by_username
     FROM ip_whitelist w
     LEFT JOIN users u ON w.created_by = u.id
     ORDER BY w.created_at DESC`
  );
  return result.rows;
}

/**
 * Add an IP to the whitelist.
 */
export async function addIpToWhitelist(
  ipAddress: string,
  reason: string | undefined,
  createdBy: string | null
): Promise<any> {
  const result = await query(
    `INSERT INTO ip_whitelist (ip_address, reason, created_by)
     VALUES ($1, $2, $3)
     RETURNING id, ip_address`,
    [ipAddress, reason || null, createdBy]
  );
  return result.rows[0];
}

/**
 * Remove an IP from the whitelist.
 */
export async function removeIpFromWhitelist(ipAddress: string): Promise<boolean> {
  const result = await query(
    'DELETE FROM ip_whitelist WHERE ip_address = $1',
    [ipAddress]
  );
  return (result.rowCount ?? 0) > 0;
}
