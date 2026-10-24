import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateMeeting } from "@/features/meetings/CreateMeeting";

const { createMeetingMock } = vi.hoisted(() => ({ createMeetingMock: vi.fn() }));

vi.mock("@/features/meetings/api", () => ({ createMeeting: createMeetingMock }));

describe("CreateMeeting", () => {
  beforeEach(() => {
    createMeetingMock.mockReset();
    createMeetingMock.mockResolvedValue({
      meetingId: "meeting-1",
      joinUrl: "https://app.example.com/join/invite-code",
    });
  });

  it("keeps the persisted invite available for copying and opening after creation", async () => {
    const user = userEvent.setup();
    render(<CreateMeeting />);

    await user.type(screen.getByLabelText(/title/i), "Design review");
    await user.click(screen.getByRole("button", { name: /create & get link/i }));

    expect(await screen.findByTestId("join-url")).toHaveTextContent("https://app.example.com/join/invite-code");
    expect(screen.getByTestId("invitation-text")).toHaveTextContent("You're invited to \"Design review\"");
    expect(screen.getByRole("button", { name: /copy invitation/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open lobby/i })).toHaveAttribute("href", "https://app.example.com/join/invite-code");
  });
});
