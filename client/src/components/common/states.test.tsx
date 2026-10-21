import { render, screen } from "@testing-library/react";
import { Video } from "lucide-react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { LoadingState } from "@/components/common/LoadingState";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";

describe("PageHeader", () => {
  it("renders a single h1 with optional description and actions", () => {
    render(
      <PageHeader
        title="Account"
        description="Manage your profile."
        actions={<Button type="button">Save</Button>}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Account" })).toBeInTheDocument();
    expect(screen.getByText("Manage your profile.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders its heading, description and action", () => {
    render(
      <EmptyState
        icon={Video}
        title="No meetings yet"
        description="Create a meeting to get a share link."
        action={<Button type="button">New meeting</Button>}
      />,
    );

    expect(screen.getByRole("heading", { name: "No meetings yet" })).toBeInTheDocument();
    expect(screen.getByText("Create a meeting to get a share link.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New meeting" })).toBeInTheDocument();
  });
});

describe("LoadingState", () => {
  it("announces progress through a polite status region", () => {
    render(<LoadingState label="Checking your session…" />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Checking your session");
  });
});

describe("ErrorState", () => {
  it("exposes the failure message as an alert", () => {
    render(<ErrorState title="Invite unavailable" message="This invite has expired." />);

    expect(screen.getByRole("heading", { name: "Invite unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This invite has expired.");
  });
});
