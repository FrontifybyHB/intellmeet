// Error conventions shared by every API caller.
//
// The server answers with `{ status, error: { code, message } }`. The transport
// turns that into an ApiError so features can branch on `status`/`code`
// without re-parsing response bodies, and use one shared helper for the
// "code: message" string the UI shows.

export type ApiErrorCode = string;

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode;
  /**
   * The parsed error body, when the server attached more than the
   * `{ error }` envelope. Some endpoints (recording start) attach the
   * durable attempt to the failure so the client can reconcile instead of
   * assuming nothing happened.
   */
  body?: unknown;
  constructor(status: number, code: ApiErrorCode, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (body !== undefined) this.body = body;
  }
}

/** Renders an API failure as "CODE: message", or the fallback if unknown. */
export function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
