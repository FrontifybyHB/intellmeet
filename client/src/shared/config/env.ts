// Canonical frontend configuration for backend endpoints.
//
// VITE_API_URL is the ONLY configurable API base. When it is unset the app
// calls the same-origin "/api" path, which the Vite dev server proxies to the
// backend (see vite.config.ts). That keeps requests first-party: no CORS
// workarounds and HttpOnly auth cookies behave exactly as they will in
// production.
//
// Import API_BASE / API_ORIGIN from here. Never recompute a base URL inside a
// component or page.

const DEFAULT_API_BASE = "/api";
const API_SUFFIX = "/api";

function normalizeApiBase(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return DEFAULT_API_BASE;
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

/** API base including the "/api" suffix, e.g. "/api" or "http://host:3000/api". */
export const API_BASE = normalizeApiBase(import.meta.env.VITE_API_URL);

/**
 * Origin serving everything that is not under /api: the Socket.IO endpoint
 * (default Engine.IO path "/socket.io") and the backend's protected dev-only
 * lab route (/dev/meeting-lab). Derived from API_BASE so no caller has to
 * strip the suffix itself; an empty string means "same origin as the app".
 */
export const API_ORIGIN = API_BASE.endsWith(API_SUFFIX)
  ? API_BASE.slice(0, -API_SUFFIX.length)
  : API_BASE;

function normalizePublicOrigin(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

/** Optional production origin used for canonical and social metadata. */
export const PUBLIC_ORIGIN = normalizePublicOrigin(import.meta.env.VITE_PUBLIC_ORIGIN);

/** True during `vite dev` / `vitest`; false in a production build. */
export const IS_DEV = import.meta.env.DEV;
