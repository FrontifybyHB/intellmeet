// Single source of truth for route paths. Keep literal paths out of
// components, guards and tests so a rename happens in one place.

export const ROUTES = {
  home: "/",
  authenticatedHome: "/home",
  login: "/login",
  register: "/register",
  account: "/account",
  meetings: "/meetings",
  recordings: "/recordings",
  newMeeting: "/meetings/new",
  meetingDetail: "/meetings/:id",
  meetingResults: "/meetings/:id/results",
  join: "/join/:code",
  devLab: "/dev/lab",
  devPost: "/dev/post",
  devBench: "/dev/bench",
} as const;

export interface RouteShellMeta {
  title: string;
  breadcrumbs: string[];
}

const SHELL_ROUTES: Array<{ path: string; meta: RouteShellMeta }> = [
  {
    path: ROUTES.authenticatedHome,
    meta: { title: "Overview", breadcrumbs: ["Workspace", "Overview"] },
  },
  {
    path: ROUTES.newMeeting,
    meta: { title: "New meeting", breadcrumbs: ["Workspace", "Meetings", "New meeting"] },
  },
  { path: ROUTES.meetings, meta: { title: "Meetings", breadcrumbs: ["Workspace", "Meetings"] } },
  {
    path: ROUTES.recordings,
    meta: { title: "Recordings", breadcrumbs: ["Workspace", "Recordings"] },
  },
  {
    path: ROUTES.meetingResults,
    meta: { title: "Meeting results", breadcrumbs: ["Workspace", "Meetings", "Results"] },
  },
  { path: ROUTES.account, meta: { title: "Account", breadcrumbs: ["Workspace", "Account"] } },
];

/** Returns the authenticated shell metadata without making layouts know page details. */
export function getRouteShellMeta(pathname: string): RouteShellMeta {
  const exact = SHELL_ROUTES.find(({ path }) => path === pathname);
  if (exact) return exact.meta;

  if (/^\/meetings\/[^/]+\/results$/.test(pathname)) {
    return { title: "Meeting results", breadcrumbs: ["Workspace", "Meetings", "Results"] };
  }

  return { title: "Workspace", breadcrumbs: ["Workspace"] };
}

/** Builds the invite-landing URL for a join code. */
export function joinPath(code: string): string {
  return `/join/${code}`;
}

/** Builds the meeting-detail URL for a meeting id. */
export function meetingPath(id: string): string {
  return `/meetings/${id}`;
}

export function meetingResultsPath(id: string): string {
  return `/meetings/${id}/results`;
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
  return isSafeInternalPath(from) ? from : ROUTES.authenticatedHome;
}
