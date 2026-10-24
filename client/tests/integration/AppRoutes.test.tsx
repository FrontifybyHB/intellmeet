import type { SafeUser } from "@/features/auth/types";
import { ThemeProvider } from "@/shared/ui/theme/theme-provider";
import { AppRoutes } from "@/app/AppRoutes";
import { ROUTES, meetingPath } from "@/app/paths";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Auth is mocked so these routing tests need no server and no network: the
// session bootstrap (GET /auth/me) would otherwise run on mount.
const { useAuthMock, apiFetchMock } = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  apiFetchMock: vi.fn(),
}));

vi.mock("@/features/auth/useAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/auth/useAuth")>();
  return { ...actual, useAuth: useAuthMock };
});

vi.mock("@/shared/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/client")>();
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
  it("renders the sign-in screen on the login route", async () => {
    renderApp(ROUTES.login);

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
  });

  it("renders the register screen on the register route", async () => {
    renderApp(ROUTES.register);

    expect(await screen.findByRole("heading", { name: /register/i })).toBeInTheDocument();
  });

  it("redirects unauthenticated visitors from a protected route to login", async () => {
    renderApp(ROUTES.account);

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^account$/i })).not.toBeInTheDocument();
  });

  it("shows the session gate while the session is loading", () => {
    mockAuth(null, true);

    renderApp(ROUTES.authenticatedHome);

    expect(screen.getByText(/checking your session/i)).toBeInTheDocument();
  });

  it("renders the home screen for an authenticated user", async () => {
    mockAuth(authedUser);

    renderApp(ROUTES.authenticatedHome);

    expect(
      await screen.findByRole("heading", { name: /overview/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("route-shell-title")).toHaveTextContent("Overview");
    expect(screen.getByRole("navigation", { name: /breadcrumb/i })).toHaveTextContent(
      "Workspace / Overview",
    );
  });

  it("redirects authenticated users away from the login route", async () => {
    mockAuth(authedUser);

    renderApp(ROUTES.login);

    expect(
      await screen.findByRole("heading", { name: /overview/i }),
    ).toBeInTheDocument();
  });

  it("renders the public landing without session or API data", () => {
    mockAuth(null, true);

    renderApp(ROUTES.home);

    expect(screen.getByRole("heading", { name: /meet clearly/i })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /from initial hello to team follow-through/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /from raw conversation to structured execution/i })).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("renders the meeting creation route", async () => {
    mockAuth(authedUser);

    renderApp(ROUTES.newMeeting);

    expect(await screen.findByRole("heading", { name: /new meeting/i })).toBeInTheDocument();
  });

  it("renders the meeting detail route with the meeting id", async () => {
    mockAuth(authedUser);
    apiFetchMock.mockResolvedValueOnce({
      meeting: {
        id: "meeting-42",
        title: "Design review",
        status: "ended",
        isHost: true,
        scheduledAt: null,
        endedAt: null,
        joinUrl: null,
      },
      recording: null,
      transcription: null,
      intelligence: null,
      suggestions: { proposed: 0, approved: 0, rejected: 0 },
    });

    renderApp(meetingPath("meeting-42"));

    expect(await screen.findByTestId("meeting-id")).toHaveTextContent("meeting-42");
    expect(screen.queryByRole("navigation", { name: /primary/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open navigation menu/i })).not.toBeInTheDocument();
  });

  it("does not redirect a guest meeting entry through account navigation", async () => {
    renderApp(meetingPath("guest-meeting"));

    expect(await screen.findByTestId("meeting-id")).toHaveTextContent("guest-meeting");
    expect(screen.queryByRole("heading", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("renders the invite landing for a signed-out visitor", async () => {
    renderApp("/join/ABCDEFGHIJKLMNOPQRSTUV");

    expect(await screen.findByRole("heading", { name: /design review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join meeting/i })).toBeInTheDocument();
  });

  it("renders the 404 screen for an unknown route", async () => {
    mockAuth(authedUser);

    renderApp("/this-route-does-not-exist");

    expect(await screen.findByRole("heading", { name: /page not found/i })).toBeInTheDocument();
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
