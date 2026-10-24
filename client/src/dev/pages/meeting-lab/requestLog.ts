// Request/error log model shared by the meeting-lab panels.
//
// The lab records every contract call it makes so a failure can be read
// without opening the network panel. The model is pure so it can be reused
// by any panel without pulling in React.

import { ApiError } from "@/shared/api/errors";

export interface RequestLogEntry {
  at: string;
  method: string;
  path: string;
  status: number | string;
  message: string;
}

/** The newest entries first, capped so a long session cannot grow unbounded. */
export type RequestLog = RequestLogEntry[];

/** Builds one log entry from a failed contract call. */
export function requestLogEntry(
  method: string,
  path: string,
  err: unknown,
): RequestLogEntry {
  const status = err instanceof ApiError ? err.status : "ERR";
  const message =
    err instanceof ApiError
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : "failed";
  return { at: new Date().toISOString(), method, path, status, message };
}

/** Prepends an entry and keeps the log bounded. */
export function appendRequestLog(log: RequestLog, entry: RequestLogEntry): RequestLog {
  return [entry, ...log].slice(0, 30);
}
