import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HomeDashboard } from "@/features/home/HomeDashboard";

const { fetchHistory, useAuthMock } = vi.hoisted(() => ({
  fetchHistory: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/features/meetings/api", () => ({ fetchMeetingHistory: fetchHistory }));
vi.mock("@/features/auth/useAuth", () => ({ useAuth: useAuthMock }));

describe("HomeDashboard", () => {
  beforeEach(() => {
    fetchHistory.mockReset();
    useAuthMock.mockReturnValue({ user: { id: "u-1", name: "Himanshu", email: "h@example.com", role: "user" } });
  });

  it("renders the overview with verified meeting history", async () => {
    fetchHistory.mockResolvedValueOnce({
      meetings: [
        { id: "m-live", title: "Product planning", status: "live", isHost: true, scheduledAt: null, endedAt: null },
        { id: "m-next", title: "Design sync", status: "scheduled", isHost: false, scheduledAt: "2026-10-24T11:30:00.000Z", endedAt: null },
        { id: "m-old", title: "API review", status: "ended", isHost: true, scheduledAt: null, endedAt: "2026-10-23T15:15:00.000Z" },
      ],
      hasMore: false,
      nextCursor: null,
    });

    render(
      <MemoryRouter>
        <HomeDashboard />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByText("Product planning")).toBeInTheDocument();
    expect(screen.getByText("Design sync")).toBeInTheDocument();
    expect(screen.getByText("API review")).toBeInTheDocument();
    expect(screen.getByText("Meetings loaded")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("128")).not.toBeInTheDocument();
  });
});
