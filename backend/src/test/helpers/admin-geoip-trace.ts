/**
 * Counter helpers for admin-geoip.test.ts. We instrument the
 * services the route depends on so a counter fires every time the
 * service is called, regardless of how many internal sub-queries
 * the route fires.
 *
 * Pattern: the test calls `install()` once at startup; from then on
 * each `setAdminSetting`, `lookupCountry`, etc. increments the
 * matching counter. `resetCounters()` zeroes everything between
 * sections.
 *
 * The implementation uses module-cache monkey-patching — we save
 * the original exports and overwrite them with counter-wrappers.
 * The wrappers delegate to the originals so the route behaves
 * correctly, but they record the call for assertion.
 */

// Counter objects — exported so tests can read them
export const GET_STATUS_CALLED = { count: 0 };
export const GET_HRC_CALLED = { count: 0 };
export const PUT_HRC_CALLED = { count: 0 };
export const PUT_PROVIDER_CALLED = { count: 0 };
export const PURGE_CALLED = { count: 0 };
export const PROBE_CALLED = { count: 0 };

export function resetCounters(): void {
  GET_STATUS_CALLED.count = 0;
  GET_HRC_CALLED.count = 0;
  PUT_HRC_CALLED.count = 0;
  PUT_PROVIDER_CALLED.count = 0;
  PURGE_CALLED.count = 0;
  PROBE_CALLED.count = 0;
}