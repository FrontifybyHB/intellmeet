import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { Button } from "@/shared/ui/button";

function setup(onConfirm = vi.fn()) {
  render(
    <ConfirmationDialog
      destructive
      trigger={<Button type="button">Remove meeting</Button>}
      title="Remove this meeting?"
      description="Every participant will be disconnected. This cannot be undone."
      confirmLabel="Remove for everyone"
      onConfirm={onConfirm}
    />,
  );
  return onConfirm;
}

describe("ConfirmationDialog", () => {
  it("opens with an accessible name and description", async () => {
    const user = userEvent.setup();
    setup();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove meeting" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove this meeting?" });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByText("Every participant will be disconnected. This cannot be undone."),
    ).toBeInTheDocument();
  });

  it("runs the confirm handler and closes", async () => {
    const user = userEvent.setup();
    const onConfirm = setup();

    await user.click(screen.getByRole("button", { name: "Remove meeting" }));
    await user.click(await screen.findByRole("button", { name: "Remove for everyone" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("cancels without calling the handler", async () => {
    const user = userEvent.setup();
    const onConfirm = setup();

    await user.click(screen.getByRole("button", { name: "Remove meeting" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onConfirm = setup();

    await user.click(screen.getByRole("button", { name: "Remove meeting" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows a recoverable error", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValue(new Error("Meeting could not be ended."));
    setup(onConfirm);

    await user.click(screen.getByRole("button", { name: "Remove meeting" }));
    await user.click(await screen.findByRole("button", { name: "Remove for everyone" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Meeting could not be ended.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
