import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { THEME_STORAGE_KEY } from "@/components/theme/theme-context";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { ThemeToggle } from "@/components/theme/theme-toggle";

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});

describe("theme provider", () => {
  it("applies the persisted dark theme on mount", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    renderToggle();

    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("falls back to the system theme for unknown stored values", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");

    renderToggle();

    // The matchMedia stub reports a light OS preference.
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("persists the selected theme and updates the document", async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.click(screen.getByRole("button", { name: /switch theme/i }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));

    expect(document.documentElement).toHaveClass("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("switches back to light from the menu", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const user = userEvent.setup();
    renderToggle();

    await user.click(screen.getByRole("button", { name: /switch theme/i }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Light" }));

    expect(document.documentElement).not.toHaveClass("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("marks the stored preference as the selected radio item", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    const user = userEvent.setup();
    renderToggle();

    await user.click(screen.getByRole("button", { name: /switch theme/i }));

    expect(await screen.findByRole("menuitemradio", { name: "System" })).toBeChecked();
  });
});
