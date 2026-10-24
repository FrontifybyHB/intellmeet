// Auth endpoints owned by the auth feature. Every call goes through the
// shared transport, so CSRF/refresh/cookie handling is identical to the
// other features.
import { apiFetch } from "@/shared/api/client";
import type { SafeUser } from "@/features/auth/types";

export interface AuthSessionResponse {
  user: SafeUser;
  /** Present on login only: the rotated CSRF binding for this session. */
  csrfToken?: string;
}

/** Reads the current session. Rejects with a 401 ApiError when signed out. */
export function fetchSession(): Promise<AuthSessionResponse> {
  return apiFetch<AuthSessionResponse>("/auth/me");
}

export function loginRequest(
  email: string,
  password: string,
): Promise<AuthSessionResponse> {
  return apiFetch<AuthSessionResponse>("/auth/login", {
    method: "POST",
    body: { email, password },
  });
}

/**
 * Registers an account. Registration deliberately does NOT sign the user
 * in (enumeration-neutral flow): the user signs in explicitly afterwards.
 */
export function registerRequest(
  name: string,
  email: string,
  password: string,
): Promise<{ user: SafeUser }> {
  return apiFetch<{ user: SafeUser }>("/auth/register", {
    method: "POST",
    body: { name, email, password },
  });
}

export function logoutRequest(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/auth/logout", {
    method: "POST",
    body: {},
  });
}

/** Invalidates every active session for this account, this browser included. */
export function logoutAllRequest(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/auth/logout-all", {
    method: "POST",
    body: {},
  });
}

/**
 * Changes the password. The server invalidates every credential on
 * success, so the caller must sign the user in again.
 */
export function changePasswordRequest(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; requireRelogin: boolean }> {
  return apiFetch<{ ok: boolean; requireRelogin: boolean }>("/auth/change-password", {
    method: "PATCH",
    body: { currentPassword, newPassword },
  });
}
