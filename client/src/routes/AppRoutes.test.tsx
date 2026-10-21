import type { SafeUser } from "@/services/api";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { AppRoutes } from "@/routes/AppRoutes";
import { ROUTES, meetingPath } from "@/routes/paths";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Auth is mocked so these routing tests need no server and no network: the
// session bootstrap (GET /auth/me) would otherwise run on mount.
const { useAuthMock, apiFetchMock } = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  apiFetchMock: vi.fn(),
}));

vi.mock("@/auth/AuthContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth/AuthContext")>();
  return { ...actual, useAuth: useAuthMock };
});

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return { ...actual, apiFetch: apiFetchMock };
});

// livekit-client is browser-only and irrelevant to routing.
vi.mock("livekit-client", () => ({ Room: class {}, RoomEvent: {} }));

const authedUser: SafeUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  role: "user",
};

function mockAuth(user: SafeUser | null, loading = false) {
  useAuthMock.mockReturnValue({
    user,
    loading,
    error: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  });
}

function renderApp(path: string, options: { dev?: boolean } = {}) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes dev={options.dev} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  mockAuth(null);
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({
    meetingId: "meeting-1",
    title: "Design review",
    status: "scheduled",
    admission: "link",
    membership: "invited",
  });
});

describe("AppRoutes", () => {
  it("renders the sign-in screen on the login route", () => {
    renderApp(ROUTES.login);

    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
  });

  it("renders the register screen on the register route", () => {
    renderApp(ROUTES.register);

    expect(screen.getByRole("heading", { name: /register/i })).toBeInTheDocument();
  });

  it("redirects unauthenticated visitors from a protected route to login", () => {
    renderApp(ROUTES.account);

    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^account$/i })).not.toBeInTheDocument();
  });

  it("shows the session gate while the session is loading", () => {
    mockAuth(null, true);

    renderApp(ROUTES.home);

    expect(screen.getByText(/checking your session/i)).toBeInTheDocument();
  });

  it("renders the home screen for an authenticated user", () => {
    mockAuth(authedUser);

    renderApp(ROUTES.home);

    expect(screen.getByRole("heading", { name: /welcome to intellmeet/i })).toBeInTheDocument();
  });

  it("redirects authenticated users away from the login route", () => {
    mockAuth(authedUser);

    renderApp(ROUTES.login);

    expect(screen.getByRole("heading", { name: /welcome to intellmeet/i })).toBeInTheDocument();
  });

  it("renders the meeting creation route", () => {
    mockAuth(authedUser);

    renderApp(ROUTES.newMeeting);

    expect(screen.getByRole("heading", { name: /new meeting/i })).toBeInTheDocument();
  });

  it("renders the meeting detail route with the meeting id", () => {
    mockAuth(authedUser);

    renderApp(meetingPath("meeting-42"));

    expect(screen.getByTestId("meeting-id")).toHaveTextContent("meeting-42");
  });

  it("renders the invite landing for a signed-out visitor", async () => {
    renderApp("/join/ABCDEFGHIJKLMNOPQRSTUV");

    expect(await screen.findByRole("heading", { name: /design review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join meeting/i })).toBeInTheDocument();
  });

  it("renders the 404 screen for an unknown route", () => {
    mockAuth(authedUser);

    renderApp("/this-route-does-not-exist");

    expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument();
  });

  it("mounts dev-only routes in development", async () => {
    mockAuth(authedUser);

    renderApp(ROUTES.devBench, { dev: true });

    // The dev tools are code-split, so the route resolves asynchronously.
    expect(
      await screen.findByRole("heading", { name: /api test bench/i }, { timeout: 15_000 }),
    ).toBeInTheDocument();
  });

  it("does not mount dev-only routes in production", async () => {
    mockAuth(authedUser);

    renderApp(ROUTES.devBench, { dev: false });

    expect(await screen.findByRole("heading", { name: /page not found/i })).toBeInTheDocument();
  });
});
