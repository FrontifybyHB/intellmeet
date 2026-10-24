// Invite-link parsing for the meetings feature.
//
// Pure helpers only: no React, no transport. Both the router (hash-style
// legacy links) and the invite landing screen read the code from here, so
// the accepted code shape is defined in exactly one place.

const CODE_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Allowlists same-app return paths (prevents open redirects).
 * Only /join/<code> is preserved across login/register.
 */
export function validReturnPath(path: string | null): string | null {
  if (!path) return null;
  const m = /^\/join\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (!m || !CODE_RE.test(m[1])) return null;
  return `/join/${m[1]}`;
}

/**
 * Reads the invite code from the current location, accepting both the
 * path form (/join/<code>) and the legacy hash form (#/join/<code>).
 */
export function joinCodeFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname;
  const pm = /^\/join\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (pm && CODE_RE.test(pm[1])) return pm[1];
  const hash = window.location.hash;
  const hm = /^#\/join\/([A-Za-z0-9_-]{1,64})$/.exec(hash);
  if (hm && CODE_RE.test(hm[1])) return hm[1];
  return null;
}
