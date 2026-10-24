// A small, shared "run an async action" hook.
//
// Every form in the app does the same four things: clear the previous error,
// disable itself while the request is in flight, run the request, and show
// what went wrong. This hook owns that pattern so the features do not each
// re-implement it (and each get the busy-flag and error handling subtly
// different).
//
// The hook is deliberately transport-agnostic: it never knows about the API,
// it only knows how to run a promise-returning function and how to report a
// failure.

import { useCallback, useEffect, useRef, useState } from "react";

import { describeApiError } from "@/shared/api/errors";

export interface AsyncActionOptions {
  /** Message used when the failure carries no usable text. */
  fallbackMessage?: string;
  /** Overrides how a failure is rendered. */
  formatError?: (err: unknown) => string;
}

export interface AsyncAction<Args extends unknown[]> {
  /** True while the action is running. */
  pending: boolean;
  /** The last failure, or null. */
  error: string | null;
  /** Runs the action. Never rejects: failures land in `error`. */
  run: (...args: Args) => Promise<void>;
  /** Clears the current error. */
  reset: () => void;
}

export function useAsyncAction<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>,
  options: AsyncActionOptions = {},
): AsyncAction<Args> {
  const { fallbackMessage = "Something went wrong.", formatError } = options;

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const run = useCallback(
    async (...args: Args) => {
      setPending(true);
      setError(null);
      try {
        await action(...args);
      } catch (err) {
        if (mounted.current) {
          setError(formatError ? formatError(err) : describeApiError(err, fallbackMessage));
        }
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [action, fallbackMessage, formatError],
  );

  const reset = useCallback(() => setError(null), []);

  return { pending, error, run, reset };
}
