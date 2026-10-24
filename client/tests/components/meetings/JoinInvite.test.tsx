import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JoinInvite } from "@/features/meetings/JoinInvite";
import { ThemeProvider } from "@/shared/ui/theme/theme-provider";

const { apiFetchMock, useAuthMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/shared/api/client", () => ({ apiFetch: apiFetchMock }));
vi.mock("@/features/auth/useAuth", () => ({ useAuth: useAuthMock }));

beforeEach(() => {
  apiFetchMock.mockResolvedValue({
    id: "meeting-1",
    title: "Product planning",
    status: "active",
    admission: "link",
    membership: "host",
  });
  useAuthMock.mockReturnValue({ user: { id: "user-1", name: "Himanshu", email: "h@example.com" } });
});

describe("JoinInvite lobby", () => {
  it("renders the pre-join lobby using the resolved meeting and real identity", async () => {
    render(
      <ThemeProvider>
        <MemoryRouter>
          <JoinInvite code="ABCDEFGHIJKLMNOPQRSTUV" onJoined={vi.fn()} />
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(await screen.findByRole("heading", { name: /ready to join/i })).toBeInTheDocument();
    expect(screen.getByText("Product planning")).toBeInTheDocument();
    expect(screen.getByText("Himanshu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join meeting/i })).toBeInTheDocument();
  });
});
