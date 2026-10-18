import { lazy, Suspense, useEffect } from "react";
import {
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";

import { NotFound } from "@/components/NotFound";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { PublicRoute } from "@/components/PublicRoute";
import { IS_DEV } from "@/config/env";
import { AppLayout } from "@/layouts/AppLayout";
import { AuthLayout } from "@/layouts/AuthLayout";
import { AccountPage } from "@/pages/AccountPage";
import { LoginPage, RegisterPage } from "@/pages/AuthPages";
import { HomePage } from "@/pages/HomePage";
import { MeetingDetailPage } from "@/pages/MeetingDetailPage";
import { MeetingsPage } from "@/pages/MeetingsPage";
import { CreateMeeting, JoinView, joinCodeFromLocation } from "@/pages/ShareLinks";
import { ROUTES, joinPath, meetingPath, resolveRedirectTarget } from "@/routes/paths";

// Contract-test tools. They are loaded on demand and only when the dev routes
// are registered, so their large media/socket dependencies never ship in a
// production entry bundle.
const MeetingLab = lazy(() =>
  import("@/pages/MeetingLab").then((module) => ({ default: module.MeetingLab })),
);
const PostMeeting = lazy(() =>
  import("@/pages/PostMeeting").then((module) => ({ default: module.PostMeeting })),
);
const ApiTestBench = lazy(() =>
  import("@/pages/ApiTestBench").then((module) => ({ default: module.ApiTestBench })),
);

function RouteLoadingFallback() {
  return (
    <main>
      <p>Loading…</p>
    </main>
  );
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

function LoginRoute() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <LoginPage
      onSwitch={(view) => navigate(view === "register" ? ROUTES.register : ROUTES.login)}
      onSuccess={() => navigate(resolveRedirectTarget(location.state), { replace: true })}
    />
  );
}

function RegisterRoute() {
  const navigate = useNavigate();

  return (
    <RegisterPage
      onSwitch={(view) => navigate(view === "register" ? ROUTES.register : ROUTES.login)}
    />
  );
}

function JoinRoute() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  return (
    <JoinView
      code={code ?? ""}
      onJoined={(meetingId) => navigate(meetingPath(meetingId), { replace: true })}
    />
  );
}

function DevLabRoute() {
  const [params] = useSearchParams();

  return <MeetingLab initialMeetingId={params.get("meetingId") ?? undefined} />;
}

const DEV_ROUTES = [
  { path: ROUTES.devLab, element: <DevLabRoute /> },
  { path: ROUTES.devPost, element: <PostMeeting /> },
  { path: ROUTES.devBench, element: <ApiTestBench /> },
];

/**
 * Route table. `dev` defaults to the compile-time Vite DEV flag, so the
 * contract tools are never registered in a production build and those paths
 * fall through to 404. The prop exists so both behaviours stay unit-testable.
 */
export function AppRoutes({ dev = IS_DEV }: { dev?: boolean }) {
  return (
    <>
      <HashJoinRedirect />
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          {/* Signed-out routes. */}
          <Route element={<AuthLayout />}>
            <Route
              path={ROUTES.login}
              element={
                <PublicRoute>
                  <LoginRoute />
                </PublicRoute>
              }
            />
            <Route
              path={ROUTES.register}
              element={
                <PublicRoute>
                  <RegisterRoute />
                </PublicRoute>
              }
            />
            {/* The invite landing stays reachable signed in and signed out;
                sign-in happens inline and returns to the same invite. */}
            <Route path={ROUTES.join} element={<JoinRoute />} />
          </Route>

          {/* Authenticated application shell. */}
          <Route
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<HomePage />} />
            <Route path={ROUTES.newMeeting} element={<CreateMeeting />} />
            <Route path={ROUTES.meetings} element={<MeetingsPage />} />
            <Route path={ROUTES.meetingDetail} element={<MeetingDetailPage />} />
            <Route path={ROUTES.account} element={<AccountPage />} />

            {dev &&
              DEV_ROUTES.map((route) => (
                <Route key={route.path} path={route.path} element={route.element} />
              ))}
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </>
  );
}
