// Minimal API client for IntellMeet auth + protected resources.
// - Same-origin/cookie transport: credentials "include" so the HttpOnly
//   im_at/im_rt cookies travel automatically. Tokens are NEVER written
//   to localStorage/sessionStorage by this client.
// - CSRF: state-changing requests carry the x-csrf-token header from the
//   last /api/auth/csrf bootstrap (in-memory only).
// - Refresh: ONE bounded single-flight refresh attempt on an expired-auth
//   signal (401 with code UNAUTHORIZED arising from expiry /
//   SESSION_EXPIRED). Only idempotent GETs are retried after refresh;
//   failed POST/PATCH/DELETE surface so the UI can ask the user to retry
//   explicitly (no silent replay of non-idempotent actions). Login and
//   register never trigger a refresh. No retries on 403/503.

const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) ||
  "http://localhost:3000/api";

export type ApiErrorCode = string;

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface SafeUser {
  id: string;
  name: string | null;
  email: string;
  role: string;
}

let csrfToken: string | null = null;
// Single-flight refresh promise shared across tabs-of-this-page so
// concurrent 401s cause exactly one POST /refresh.
let refreshInflight: Promise<boolean> | null = null;

async function readError(res: Response): Promise<ApiError> {
  let code = "UNKNOWN";
  let message = "Request failed.";
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
  } catch {
    // Non-JSON error: keep the generic message (never include bodies).
  }
  return new ApiError(res.status, code, message);
}

export async function fetchCsrf(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/csrf`, {
    credentials: "include",
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { csrfToken: string };
  csrfToken = body.csrfToken;
  return csrfToken;
}

// Login returns a fresh CSRF binding (rotated login context); storing
// it here is in-memory only, never persisted.
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

function isWrite(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function doRefreshOnce(): Promise<boolean> {
  if (!refreshInflight) {
    refreshInflight = (async () => {
      try {
        if (!csrfToken) await fetchCsrf();
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
          },
          body: "{}",
        });
        if (res.ok) {
          // Refresh mints a new access cookie bound by the ORIGINAL
          // absolute login deadline; the CSRF binding (login-context
          // jti) is unchanged, so no client update is needed here.
          return true;
        }
        // Refresh CSRF retry once (stale bootstrap token).
        if (res.status === 403) {
          await fetchCsrf();
          const retry = await fetch(`${API_BASE}/auth/refresh`, {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
            },
            body: "{}",
          });
          return retry.ok;
        }
        return false;
      } catch {
        return false;
      } finally {
        // Release the single-flight slot on the next tick so joiners
        // share exactly one attempt.
        setTimeout(() => {
          refreshInflight = null;
        }, 0);
      }
    })();
  }
  return refreshInflight;
}

const REFRESHABLE_CODES = new Set(["UNAUTHORIZED", "SESSION_EXPIRED"]);

export async function apiFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    allowRefresh?: boolean;
  } = {},
): Promise<T> {
  const method = options.method || "GET";
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(options.body);
  }
  // Cookie-authed writes require the double-submit CSRF header (server
  // csrfProtect exempts Bearer requests). Bootstrap once and attach on
  // every unsafe method, even bodyless POSTs (join/start/stop/end).
  if (isWrite(method)) {
    if (!csrfToken) {
      try {
        await fetchCsrf();
      } catch {
        // CSRF bootstrap failure surfaces as the request error below.
      }
    }
    if (csrfToken) {
      headers["x-csrf-token"] = csrfToken;
    }
  }
  const run = async (): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      method,
      credentials: "include",
      headers,
      body: payload,
    });

  let res = await run();
  if (res.ok) return (await res.json()) as T;

  const err = await readError(res);
  // Bounded refresh: only on expired-auth signals, never for the auth
  // endpoints themselves (login/register/refresh must not recurse), and
  // never on 403/503.
  const isAuthEndpoint =
    path.startsWith("/auth/login") ||
    path.startsWith("/auth/register") ||
    path.startsWith("/auth/refresh");
  if (
    options.allowRefresh !== false &&
    !isAuthEndpoint &&
    res.status === 401 &&
    REFRESHABLE_CODES.has(err.code) &&
    !isWrite(method)
  ) {
    const refreshed = await doRefreshOnce();
    if (refreshed) {
      res = await run();
      if (res.ok) return (await res.json()) as T;
      throw await readError(res);
    }
  }
  throw err;
}

export function clearClientAuthState(): void {
  csrfToken = null;
  refreshInflight = null;
  // Cross-tab logout signal (a timestamp, never a token).
  try {
    localStorage.setItem("im:logout", String(Date.now()));
  } catch {
    // Storage may be unavailable (private mode): same-tab state is
    // still cleared above.
  }
}
