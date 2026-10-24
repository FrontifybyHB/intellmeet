import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { PublicLanding } from "@/features/public/PublicLanding";
import { resolveJoinDestination } from "@/features/public/links";
import { ThemeProvider } from "@/shared/ui/theme/theme-provider";

function renderLanding() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <PublicLanding />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("PublicLanding", () => {
  it("allowlists invite destinations", () => {
    expect(resolveJoinDestination("https://example.com/join/ABCDEFGHIJKLMNOPQRSTUV")).toBeNull();
    expect(resolveJoinDestination("/join/ABCDEFGHIJKLMNOPQRSTUV")).toBe("/join/ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("presents the product workflow and existing navigation CTAs", () => {
    renderLanding();

    expect(screen.getByRole("heading", { name: /meet clearly/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /from initial hello to team follow-through/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: /get started/i })).toHaveAttribute("href", "/register");
  });

  it("does not navigate for an invalid invite and navigates for a valid same-app invite", async () => {
    const user = userEvent.setup();
    renderLanding();
    const input = screen.getByRole("textbox", { name: /meeting link/i });

    await user.type(input, "https://example.com/join/ABCDEFGHIJKLMNOPQRSTUV");
    await user.click(screen.getByRole("button", { name: /^join$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/valid intellmeet invite/i);

    await user.clear(input);
    await user.type(input, "/join/ABCDEFGHIJKLMNOPQRSTUV");
    await user.click(screen.getByRole("button", { name: /^join$/i }));
    expect(screen.getByTestId("landing-route-marker")).toHaveTextContent("/join/ABCDEFGHIJKLMNOPQRSTUV");
  });
});
