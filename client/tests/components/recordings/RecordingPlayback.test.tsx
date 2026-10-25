import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/shared/api/errors";
import { PlayRecordingButton } from "@/features/recordings/RecordingPlayback";

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}));

vi.mock("@/shared/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/client")>();
  return { ...actual, apiFetch: apiFetchMock };
});

const MEETING_ID = "meeting-1";
const RECORDING_ID = "rec-1";
const urlPath = `GET /meetings/${MEETING_ID}/recordings/${RECORDING_ID}/url`;

function routeApi(routes: Record<string, unknown>) {
  apiFetchMock.mockImplementation(async (path: string, options: { method?: string } = {}) => {
    const key = `${options.method ?? "GET"} ${path}`;
    const value = routes[key];
    if (value === undefined) {
      throw new Error(`Unexpected request: ${key}`);
    }
    if (value instanceof Error) throw value;
    return value;
  });
}

function countCalls(method: string, pathFragment: string): number {
  return apiFetchMock.mock.calls.filter(([path, options]) => {
    const callMethod = (options as { method?: string })?.method ?? "GET";
    return callMethod === method && String(path).includes(pathFragment);
  }).length;
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("RecordingPlayback URL expiry and refresh", () => {
  it("opens a recording selected by a shared results link", async () => {
    routeApi({
      [urlPath]: {
        url: "https://storage.example/recording.mp4?token=shared",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    render(<PlayRecordingButton meetingId={MEETING_ID} recordingId={RECORDING_ID} autoOpen />);
    expect(await screen.findByTestId("recording-player")).toHaveAttribute(
      "src",
      "https://storage.example/recording.mp4?token=shared",
    );
  });
  it("mints the link on demand when opened and does not fetch when closed", async () => {
    const user = userEvent.setup();
    routeApi({
      [urlPath]: {
        url: "https://storage.example/recording.mp4?token=abc",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    render(<PlayRecordingButton meetingId={MEETING_ID} recordingId={RECORDING_ID} />);

    expect(countCalls("GET", "/url")).toBe(0);

    await user.click(screen.getByRole("button", { name: /play/i }));

    await waitFor(() => expect(countCalls("GET", "/url")).toBe(1));
    expect(await screen.findByTestId("recording-player")).toHaveAttribute(
      "src",
      "https://storage.example/recording.mp4?token=abc",
    );
  });

  it("refreshes the link on demand and does not persist it", async () => {
    const user = userEvent.setup();
    routeApi({
      [urlPath]: {
        url: "https://storage.example/recording.mp4?token=first",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    render(<PlayRecordingButton meetingId={MEETING_ID} recordingId={RECORDING_ID} />);

    await user.click(screen.getByRole("button", { name: /play/i }));
    await waitFor(() => expect(countCalls("GET", "/url")).toBe(1));

    // Change the response for next call
    routeApi({
      [urlPath]: {
        url: "https://storage.example/recording.mp4?token=second",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    await user.click(screen.getByRole("button", { name: /refresh link/i }));

    await waitFor(() => expect(countCalls("GET", "/url")).toBe(2));
    expect(await screen.findByTestId("recording-player")).toHaveAttribute(
      "src",
      "https://storage.example/recording.mp4?token=second",
    );
  });

  it("shows expiry state and allows re-minting when link expires", async () => {
    let calls = 0;
    apiFetchMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? {
            url: "https://storage.example/recording.mp4?token=expired",
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          }
        : {
            url: "https://storage.example/recording.mp4?token=new",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
    });

    render(<PlayRecordingButton meetingId={MEETING_ID} recordingId={RECORDING_ID} />);

    fireEvent.click(screen.getByRole("button", { name: /play/i }));
    expect(await screen.findByText(/Link expired/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /issue a new link/i }));
    await waitFor(() => expect(calls).toBe(2));
    expect(await screen.findByTestId("recording-player")).toHaveAttribute(
      "src",
      "https://storage.example/recording.mp4?token=new",
    );
  });

  it("reports URL fetch errors without exposing provider details as success", async () => {
    const user = userEvent.setup();
    routeApi({
      [urlPath]: new ApiError(409, "RECORDING_NOT_FOUND", "Recording is not ready."),
    });

    render(<PlayRecordingButton meetingId={MEETING_ID} recordingId={RECORDING_ID} />);

    await user.click(screen.getByRole("button", { name: /play/i }));

    expect(await screen.findByText(/Playback unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/Recording is not ready/i)).toBeInTheDocument();
    expect(screen.queryByTestId("recording-player")).not.toBeInTheDocument();
  });

  it("treats a provider playback error as expired and offers a refresh", async () => {
    const user = userEvent.setup();
    routeApi({
      [urlPath]: {
        url: "https://storage.example/recording.mp4?token=expired",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    render(<PlayRecordingButton meetingId={MEETING_ID} recordingId={RECORDING_ID} />);
    await user.click(screen.getByRole("button", { name: /play/i }));
    const player = await screen.findByTestId("recording-player");

    fireEvent.error(player);

    expect(await screen.findByText(/Link expired/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /issue a new link/i })).toBeInTheDocument();
  });
});
