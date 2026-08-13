/**
 * ===============================================================
 *  AUTH COOKIES -- server-only (PR-1B)
 * ===============================================================
 *
 *  The $'\143\146\137\164\157\153\145\156' cookie is now set server-side by Express as a
 *  httpOnly cookie. Client JS cannot and MUST NOT read or write
 *  it -- that would defeat the purpose of httpOnly.
 *
 *  All three functions below are no-ops that exist only so old
 *  imports compile. Removing them is deferred to a follow-up PR
 *  that migrates the remaining call-sites.
 *
 *  To get user data: GET /api/auth/me (cookie sent automatically).
 *  To clear: POST /api/auth/logout (cookie cleared server-side).
 */

export const TOKEN_COOKIE_NAME='cf_token';

/** @deprecated Cookie is now set server-side (httpOnly). This is a no-op. */
export const setTokenCookie = (_token: string): void => {
  /* no-op */
};

/** @deprecated Use /api/auth/me instead. Always returns null. */
export const getTokenFromCookie = (): null => null;

/** @deprecated Cookie is cleared by POST /api/auth/logout. This is a no-op. */
export const removeTokenCookie = (): void => {
  /* no-op */
};
