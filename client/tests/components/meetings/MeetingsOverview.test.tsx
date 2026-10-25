import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MeetingsOverview } from "@/features/meetings/MeetingsOverview";

const { fetchHistory } = vi.hoisted(() => ({ fetchHistory: vi.fn() }));

vi.mock("@/features/meetings/api", () => ({ fetchMeetingHistory: fetchHistory }));

function renderPage() {
  return render(
    <MemoryRouter>
      <MeetingsOverview />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchHistory.mockReset();
});

describe("MeetingsOverview", () => {
  it("loads entitled meetings and follows the server cursor", async () => {
    fetchHistory
      .mockResolvedValueOnce({
        meetings: [
          {
            id: "m-1",
            title: "First",
            status: "ended",
            isHost: true,
            scheduledAt: null,
            endedAt: null,
          },
        ],
        hasMore: true,
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        meetings: [
          {
            id: "m-2",
            title: "Second",
            status: "live",
            isHost: false,
            scheduledAt: null,
            endedAt: null,
          },
        ],
        hasMore: false,
        nextCursor: null,
      });

    renderPage();
    expect(await screen.findByText("First")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByText("Second")).toBeInTheDocument();
    expect(fetchHistory).toHaveBeenNthCalledWith(2, "cursor-1");
    expect(screen.getByRole("link", { name: /second/i })).toHaveAttribute("href", "/meetings/m-2");
  });

  it("shows a real history error instead of an empty success state", async () => {
    fetchHistory.mockRejectedValueOnce(new Error("history unavailable"));

    renderPage();

    expect(await screen.findByText("history unavailable")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("No meetings yet")).not.toBeInTheDocument());
  });
});
