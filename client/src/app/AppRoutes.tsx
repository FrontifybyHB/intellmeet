import { lazy, Suspense, useEffect } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { LoadingState } from "@/shared/ui/LoadingState";
import { ProtectedRoute } from "@/features/auth/ProtectedRoute";
import { PublicRoute } from "@/features/auth/PublicRoute";
import { IS_DEV, PUBLIC_ORIGIN } from "@/shared/config/env";
import { AppLayout } from "@/layouts/AppLayout";
import { AuthLayout } from "@/layouts/AuthLayout";
import { MeetingLayout } from "@/layouts/MeetingLayout";
import { PublicLanding } from "@/features/public/PublicLanding";
import { joinCodeFromLocation } from "@/features/meetings/links";
import { ROUTES, joinPath } from "@/app/paths";

// Private and auth route compositions stay out of the marketing entry chunk.
// Meeting detail is intentionally its own boundary because it owns recording,
// transcript and intelligence integrations.
const AccountPage = lazy(() =>
  import("@/pages/AccountPage").then((module) => ({ default: module.AccountPage })),
);
const HomePage = lazy(() =>
  import("@/pages/HomePage").then((module) => ({ default: module.HomePage })),
);
const JoinPage = lazy(() =>
  import("@/pages/JoinPage").then((module) => ({ default: module.JoinPage })),
);
const LoginPage = lazy(() =>
  import("@/pages/LoginPage").then((module) => ({ default: module.LoginPage })),
);
const MeetingDetailPage = lazy(() =>
  import("@/pages/MeetingDetailPage").then((module) => ({ default: module.MeetingDetailPage })),
);
const MeetingResultsPage = lazy(() =>
  import("@/pages/MeetingResultsPage").then((module) => ({ default: module.MeetingResultsPage })),
);
const MeetingsPage = lazy(() =>
  import("@/pages/MeetingsPage").then((module) => ({ default: module.MeetingsPage })),
);
const RecordingsPage = lazy(() =>
  import("@/pages/RecordingsPage").then((module) => ({ default: module.RecordingsPage })),
);
const NewMeetingPage = lazy(() =>
  import("@/pages/NewMeetingPage").then((module) => ({ default: module.NewMeetingPage })),
);
const NotFoundPage = lazy(() =>
  import("@/pages/NotFoundPage").then((module) => ({ default: module.NotFoundPage })),
);
const RegisterPage = lazy(() =>
  import("@/pages/RegisterPage").then((module) => ({ default: module.RegisterPage })),
);

// The contract tools are dev-only. The import is behind `import.meta.env.DEV`,
// which Vite replaces with `false` in a production build: the module — and
// with it the LiveKit / Socket.IO chunks the labs need — is then eliminated
// instead of being emitted as a lazy chunk that nothing can reach.
const DevRoutes = import.meta.env.DEV ? lazy(() => import("@/dev/DevRoutes")) : null;

function RouteLoadingFallback() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4">
      <LoadingState label="Loading…" />
    </main>
  );
}

function RouteRobotsPolicy() {
  const location = useLocation();

  useEffect(() => {
    const meta = document.querySelector('meta[name="robots"]');
    if (!meta) return;
    meta.setAttribute(
      "content",
      location.pathname === ROUTES.home ? "index,follow" : "noindex,nofollow",
    );
    document.title =
      location.pathname === ROUTES.home
        ? "IntellMeet · Clearer meetings, useful follow-through"
        : "IntellMeet";
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical && PUBLIC_ORIGIN) {
      canonical.href = `${PUBLIC_ORIGIN}${location.pathname === ROUTES.home ? "/" : location.pathname}`;
    }
  }, [location.pathname]);

  return null;
}

/**
 * Preserves the previous hash-style invite links (#/join/<code>) by rewriting
 * them to the real route. Path-style /join/<code> needs no help.
 */
function HashJoinRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    const pick = () => {
      if (!window.location.hash.startsWith("#/join/")) {
        return;
      }
      const code = joinCodeFromLocation();
      if (code) {
        navigate(joinPath(code), { replace: true });
      }
    };

    pick();
    window.addEventListener("hashchange", pick);
    return () => window.removeEventListener("hashchange", pick);
  }, [navigate]);

  return null;
}

/**
 * Route table. `dev` defaults to the compile-time Vite DEV flag, so the
 * contract tools are never registered in a production build and those paths
 * fall through to 404. The prop exists so both behaviours stay unit-testable.
 */
export function AppRoutes({ dev = IS_DEV }: { dev?: boolean }) {
  return (
    <>
      <RouteRobotsPolicy />
      <HashJoinRedirect />
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route path={ROUTES.home} element={<PublicLanding />} />
          {/* Signed-out routes. */}
          <Route element={<AuthLayout />}>
            <Route
              path={ROUTES.login}
              element={
                <PublicRoute>
                  <LoginPage />
                </PublicRoute>
              }
            />
            <Route
              path={ROUTES.register}
              element={
                <PublicRoute>
                  <RegisterPage />
                </PublicRoute>
              }
            />
            {/* The invite landing stays reachable signed in and signed out;
                sign-in happens inline and returns to the same invite. */}
            <Route path={ROUTES.join} element={<JoinPage />} />
          </Route>

          {/* Meeting room: full-viewport shell, no app chrome. */}
          <Route element={<MeetingLayout />}>
            <Route path={ROUTES.meetingDetail} element={<MeetingDetailPage />} />
          </Route>

          {/* Authenticated application shell. */}
          <Route
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route path="home" element={<HomePage />} />
            <Route path={ROUTES.newMeeting} element={<NewMeetingPage />} />
            <Route path={ROUTES.meetings} element={<MeetingsPage />} />
            <Route path={ROUTES.recordings} element={<RecordingsPage />} />
            <Route path={ROUTES.meetingResults} element={<MeetingResultsPage />} />
            <Route path={ROUTES.account} element={<AccountPage />} />

            {/* Dev tools live under /dev/* and are declared as children of
                that route, so their own paths are relative to the prefix. */}
            {dev && DevRoutes ? <Route path="/dev/*" element={<DevRoutes />} /> : null}
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </>
  );
}
