import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecordingsOverview } from "@/features/recordings/RecordingsOverview";

const { fetchHistory, listRecordings } = vi.hoisted(() => ({
  fetchHistory: vi.fn(),
  listRecordings: vi.fn(),
}));

vi.mock("@/features/meetings/api", () => ({ fetchMeetingHistory: fetchHistory }));
vi.mock("@/features/recordings/api", () => ({ listMeetingRecordings: listRecordings }));

beforeEach(() => {
  fetchHistory.mockReset();
  listRecordings.mockReset();
});

describe("RecordingsOverview", () => {
  it("loads recordings only for entitled ended meetings", async () => {
    fetchHistory.mockResolvedValueOnce({
      meetings: [
        { id: "m-1", title: "Architecture review", status: "ended", isHost: true, scheduledAt: null, endedAt: "2026-10-23T10:00:00Z" },
        { id: "m-2", title: "Live room", status: "live", isHost: false, scheduledAt: null, endedAt: null },
      ],
      hasMore: false,
      nextCursor: null,
    });
    listRecordings.mockResolvedValueOnce({
      recordings: [{ id: "r-1", meetingId: "m-1", state: "ready", createdAt: "2026-10-23T10:00:00Z", output: { durationMs: 2520000, sizeBytes: 1000 } }],
      hasMore: false,
    });

    render(<MemoryRouter><RecordingsOverview /></MemoryRouter>);

    expect(await screen.findByText("Architecture review")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Recordings loaded")).toBeInTheDocument();
    expect(listRecordings).toHaveBeenCalledWith("m-1", 20);
    expect(listRecordings).not.toHaveBeenCalledWith("m-2", 20);
  });

  it("reports history failures instead of showing fake recordings", async () => {
    fetchHistory.mockRejectedValueOnce(new Error("history unavailable"));

    render(<MemoryRouter><RecordingsOverview /></MemoryRouter>);

    expect(await screen.findByText("history unavailable")).toBeInTheDocument();
    expect(screen.queryByText("18 completed meetings")).not.toBeInTheDocument();
  });
});
