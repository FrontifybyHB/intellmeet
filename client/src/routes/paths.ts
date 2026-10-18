// Single source of truth for route paths. Keep literal paths out of
// components, guards and tests so a rename happens in one place.

export const ROUTES = {
  home: "/",
  login: "/login",
  register: "/register",
  account: "/account",
  meetings: "/meetings",
  newMeeting: "/meetings/new",
  meetingDetail: "/meetings/:id",
  join: "/join/:code",
  devLab: "/dev/lab",
  devPost: "/dev/post",
  devBench: "/dev/bench",
} as const;

/** Builds the invite-landing URL for a join code. */
export function joinPath(code: string): string {
  return `/join/${code}`;
}

/** Builds the meeting-detail URL for a meeting id. */
export function meetingPath(id: string): string {
  return `/meetings/${id}`;
}

/**
 * Guard against open redirects: only same-app absolute paths are honoured as
 * a post-login/post-redirect destination.
 */
export function isSafeInternalPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\")
  );
}

/**
 * Reads the location state a guard wrote when it redirected an unauthenticated
 * visitor away from a protected route, falling back to the home route.
 */
export function resolveRedirectTarget(state: unknown): string {
  const from = (state as { from?: unknown } | null | undefined)?.from;
  return isSafeInternalPath(from) ? from : ROUTES.home;
}
