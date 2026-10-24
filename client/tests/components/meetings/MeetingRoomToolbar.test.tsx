import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MeetingRoomToolbar } from "@/features/meetings/MeetingRoomToolbar";

describe("MeetingRoomToolbar", () => {
  it("exposes meeting view controls and host-only end action", () => {
    render(
      <MeetingRoomToolbar
        title="Product planning"
        connected
        participantCount={3}
        viewMode="grid"
        onViewModeChange={vi.fn()}
        onLeave={vi.fn()}
        onEnd={vi.fn()}
        canEnd
      />,
    );

    expect(screen.getByRole("banner")).toHaveTextContent("Product planning");
    expect(screen.getByRole("button", { name: /grid view/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /speaker view/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /presentation view/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /end meeting/i })).toBeInTheDocument();
  });
});
