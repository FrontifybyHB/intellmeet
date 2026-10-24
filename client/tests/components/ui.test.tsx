import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Button } from "@/shared/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";

describe("Button", () => {
  it("renders the default brand variant", () => {
    render(<Button type="button">Save</Button>);

    expect(screen.getByRole("button", { name: "Save" })).toHaveClass("bg-primary");
  });

  it("renders the destructive variant", () => {
    render(
      <Button type="button" variant="destructive">
        Delete
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("bg-destructive");
  });

  it("renders a link when composed with asChild", () => {
    render(
      <Button asChild>
        <a href="/meetings">Meetings</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Meetings" });
    expect(link).toHaveAttribute("href", "/meetings");
    expect(link).toHaveClass("bg-primary");
  });

  it("can be disabled", () => {
    render(
      <Button type="button" disabled>
        Saving
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Saving" })).toBeDisabled();
  });
});

describe("Tabs", () => {
  it("exposes tab semantics and switches panels", async () => {
    const user = userEvent.setup();

    render(
      <Tabs defaultValue="overview">
        <TabsList aria-label="Meeting sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview panel</TabsContent>
        <TabsContent value="activity">Activity panel</TabsContent>
      </Tabs>,
    );

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Overview panel")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Activity" }));

    expect(await screen.findByText("Activity panel")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("Tooltip", () => {
  it("shows its content on hover", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline">
              Details
            </Button>
          </TooltipTrigger>
          <TooltipContent>Meeting details</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole("button", { name: "Details" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Meeting details");
  });
});
