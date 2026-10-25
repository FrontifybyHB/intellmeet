import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/shared/api/errors";
import { RecordingPanel } from "@/features/recordings/RecordingPanel";
import type { Recording } from "@/features/recordings/api";

const { apiFetchMock, connectMeetingSocketMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  connectMeetingSocketMock: vi.fn(),
}));

vi.mock("@/shared/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/client")>();
  return { ...actual, apiFetch: apiFetchMock };
});

vi.mock("@/shared/realtime/meetingSocket", () => ({
  connectMeetingSocket: connectMeetingSocketMock,
}));

const MEETING_ID = "meeting-1";

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: "rec-1",
    meetingId: MEETING_ID,
    sessionId: "session-1",
    providerEgressId: null,
    state: "ready",
    version: 4,
    requesterId: "user-1",
    consentSnapshot: null,
    storage: null,
    output: { durationMs: 61_000, sizeBytes: 2048 },
    errorCode: null,
    providerUpdatedAt: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: null,
    ...overrides,
  };
}

/** Routes are keyed by "METHOD path"; a value that is an Error is thrown. */
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

const consentPath = `GET /meetings/${MEETING_ID}/recording-consent`;
const listPath = `GET /meetings/${MEETING_ID}/recordings?limit=20`;
const startPath = `POST /meetings/${MEETING_ID}/recordings/start`;
const stopPath = `POST /meetings/${MEETING_ID}/recordings/rec-1/stop`;
const consentPostPath = `POST /meetings/${MEETING_ID}/recording-consent`;
const urlPath = `GET /meetings/${MEETING_ID}/recordings/rec-1/url`;

function countCalls(method: string, pathFragment: string): number {
  return apiFetchMock.mock.calls.filter(([path, options]) => {
    const callMethod = (options as { method?: string })?.method ?? "GET";
    return callMethod === method && String(path).includes(pathFragment);
  }).length;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  connectMeetingSocketMock.mockReset();
  connectMeetingSocketMock.mockImplementation(() => vi.fn());
});

describe("RecordingPanel consent", () => {
  it("sends the caller's own decision with the current notice version", async () => {
    const user = userEvent.setup();
    routeApi({
      [consentPath]: { noticeVersion: "v2", consent: null },
      [listPath]: { recordings: [], hasMore: false },
      [consentPostPath]: {
        consent: {
          meetingId: MEETING_ID,
          userId: "user-1",
          noticeVersion: "v2",
          recording: "approved",
          aiTransfer: "undecided",
          updatedAt: null,
        },
      },
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost={false} />);

    await user.click(await screen.findByTestId("consent-approve"));

    await waitFor(() => expect(countCalls("POST", "/recording-consent")).toBe(1));
    const postCall = apiFetchMock.mock.calls.find(
      ([path, options]) =>
        (options as { method?: string })?.method === "POST" &&
        String(path).includes("/recording-consent"),
    );
    expect(postCall?.[1]).toMatchObject({
      body: { decision: "approved", noticeVersion: "v2", aiTransfer: "undecided" },
    });
  });

  it("keeps the AI-transfer answer when only the recording decision changes", async () => {
    const user = userEvent.setup();
    routeApi({
      [consentPath]: {
        noticeVersion: "v1",
        consent: {
          meetingId: MEETING_ID,
          userId: "user-1",
          noticeVersion: "v1",
          recording: "approved",
          aiTransfer: "approved",
          updatedAt: null,
        },
      },
      [listPath]: { recordings: [], hasMore: false },
      [consentPostPath]: {
        consent: {
          meetingId: MEETING_ID,
          userId: "user-1",
          noticeVersion: "v1",
          recording: "declined",
          aiTransfer: "approved",
          updatedAt: null,
        },
      },
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost={false} />);

    await user.click(await screen.findByTestId("consent-decline"));

    await waitFor(() => expect(countCalls("POST", "/recording-consent")).toBe(1));
    const postCall = apiFetchMock.mock.calls.find(
      ([path, options]) =>
        (options as { method?: string })?.method === "POST" &&
        String(path).includes("/recording-consent"),
    );
    expect(postCall?.[1]).toMatchObject({
      body: { decision: "declined", aiTransfer: "approved" },
    });
  });

  it("re-reads the notice when the server rejects a stale decision", async () => {
    const user = userEvent.setup();
    routeApi({
      [consentPath]: { noticeVersion: "v1", consent: null },
      [listPath]: { recordings: [], hasMore: false },
      [consentPostPath]: new ApiError(
        409,
        "NOTICE_VERSION_MISMATCH",
        "The recording notice changed. Review the current notice and decide again.",
      ),
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost={false} />);

    await user.click(await screen.findByTestId("consent-approve"));

    expect(await screen.findByTestId("consent-notice-changed")).toBeInTheDocument();
    expect(screen.getByText(/The recording notice changed/)).toBeInTheDocument();
    // The notice is read again so the next decision uses the current version.
    expect(countCalls("GET", "/recording-consent")).toBeGreaterThan(1);
  });

  it("does not offer the AI-transfer control before a recording decision", async () => {
    routeApi({
      [consentPath]: { noticeVersion: "v1", consent: null },
      [listPath]: { recordings: [], hasMore: false },
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost={false} />);

    expect(await screen.findByTestId("consent-ai-approve")).toBeDisabled();
  });
});

describe("RecordingPanel host controls", () => {
  it("hides the host controls from participants", async () => {
    routeApi({
      [consentPath]: { noticeVersion: "v1", consent: null },
      [listPath]: { recordings: [], hasMore: false },
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost={false} />);

    await screen.findByTestId("consent-approve");
    expect(screen.queryByTestId("host-recording-controls")).not.toBeInTheDocument();
    expect(screen.queryByTestId("start-recording")).not.toBeInTheDocument();
  });

  it("sends exactly one start request when the button is clicked repeatedly", async () => {
    const user = userEvent.setup();
    routeApi({
      [consentPath]: { noticeVersion: "v1", consent: null },
      [listPath]: { recordings: [], hasMore: false },
      [startPath]: { recording: makeRecording({ state: "active" }), resumed: false },
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost />);

    const start = await screen.findByTestId("start-recording");
    await user.click(start);
    await user.click(start);
    await user.click(start);

    await waitFor(() => expect(countCalls("POST", "/recordings/start")).toBe(1));
  });

  it("reports an unconfigured provider as a server-side gap", async () => {
    const user = userEvent.setup();
    routeApi({
      [consentPath]: { noticeVersion: "v1", consent: null },
      [listPath]: { recordings: [], hasMore: false },
      [startPath]: new ApiError(
        503,
        "INTEGRATION_BLOCKER",
        "Recording provider is not configured on this server.",
      ),
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost />);

    await user.click(await screen.findByTestId("start-recording"));

    expect(await screen.findByText(/not configured on the server/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was recorded/)).toBeInTheDocument();
    // No recording is invented when the server refuses to start one.
    expect(screen.queryByTestId("recording-row")).not.toBeInTheDocument();
  });

  it("keeps a server-enforced non-host denial as an action failure", async () => {
    const user = userEvent.setup();
    routeApi({
      [consentPath]: { noticeVersion: "v1", consent: null },
      [listPath]: { recordings: [], hasMore: false },
      [startPath]: new ApiError(403, "NOT_HOST", "Only the host can perform this action."),
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost />);
    await user.click(await screen.findByTestId("start-recording"));

    expect(
      await screen.findByText(/NOT_HOST: Only the host can perform this action/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("recording-row")).not.toBeInTheDocument();
  });

  it("shows the live attempt and stops it once", async () => {
    const user = userEvent.setup();
    routeApi({
      [consentPath]: { noticeVersion: "v1", consent: null },
      [listPath]: {
        recordings: [makeRecording({ state: "active", version: 2 })],
        hasMore: false,
      },
      [stopPath]: { recording: makeRecording({ state: "stopping", version: 3 }), resumed: false },
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost />);

    expect(await screen.findByTestId("live-recording-state")).toHaveTextContent("Recording");
    const stop = screen.getByTestId("stop-recording");
    await user.click(stop);
    await user.click(stop);

    await waitFor(() => expect(countCalls("POST", "/recordings/rec-1/stop")).toBe(1));
  });
});

describe("RecordingPanel list and playback", () => {
  it("shows the recordings the API returned and an honest note about paging", async () => {
    routeApi({
      [consentPath]: { noticeVersion: "v1", consent: null },
      [listPath]: {
        recordings: [
          makeRecording(),
          makeRecording({ id: "rec-2", state: "failed", errorCode: "PROVIDER_FAILED" }),
        ],
        hasMore: true,
      },
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost={false} />);

    const rows = await screen.findAllByTestId("recording-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId("recordings-truncated")).toBeInTheDocument();
    expect(screen.getByText(/provider failed during the capture/)).toBeInTheDocument();
  });

  it("mints the playback link only when playback is requested", async () => {
    const user = userEvent.setup();
    routeApi({
      [consentPath]: { noticeVersion: "v1", consent: null },
      [listPath]: { recordings: [makeRecording()], hasMore: false },
      [urlPath]: {
        url: "https://storage.example/recording.mp4?token=abc",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    render(<RecordingPanel meetingId={MEETING_ID} isHost={false} />);

    await screen.findByTestId("recording-row");
    expect(countCalls("GET", "/url")).toBe(0);

    await user.click(screen.getByRole("button", { name: /play/i }));

    await waitFor(() => expect(countCalls("GET", "/url")).toBe(1));
    const player = await screen.findByTestId("recording-player");
    expect(player).toHaveAttribute("src", "https://storage.example/recording.mp4?token=abc");
  });
});
