import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Recording } from "@/features/recordings/api";
import { useMeetingRecordings } from "@/features/recordings/useMeetingRecordings";

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
    state: "active",
    version: 2,
    requesterId: "user-1",
    consentSnapshot: null,
    storage: null,
    output: null,
    errorCode: null,
    providerUpdatedAt: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: null,
    ...overrides,
  };
}

type SocketHandlers = {
  onRecordingStatus?: (payload: { meetingId: string; recording: Recording }) => void;
  onRecordingReady?: (payload: { meetingId: string; recordingId: string; state: string }) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
};

let handlers: SocketHandlers = {};

function listCalls(): number {
  return apiFetchMock.mock.calls.filter(([path]) =>
    String(path).includes(`/meetings/${MEETING_ID}/recordings?`),
  ).length;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  connectMeetingSocketMock.mockReset();
  handlers = {};
  connectMeetingSocketMock.mockImplementation((_id: string, next: SocketHandlers) => {
    handlers = next;
    return vi.fn();
  });
  apiFetchMock.mockImplementation(async (path: string) => {
    if (String(path).includes("/recording-consent")) {
      return { noticeVersion: "v1", consent: null };
    }
    if (String(path).includes("/recordings?")) {
      return { recordings: [], hasMore: false };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});

describe("useMeetingRecordings realtime", () => {
  it("applies a recording:status event to the list", async () => {
    const { result } = renderHook(() => useMeetingRecordings({ meetingId: MEETING_ID }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      handlers.onRecordingStatus?.({
        meetingId: MEETING_ID,
        recording: makeRecording({ state: "active" }),
      });
    });

    await waitFor(() => expect(result.current.recordings).toHaveLength(1));
    expect(result.current.recordings[0].state).toBe("active");
  });

  it("ignores an event for another meeting", async () => {
    const { result } = renderHook(() => useMeetingRecordings({ meetingId: MEETING_ID }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      handlers.onRecordingStatus?.({
        meetingId: "other-meeting",
        recording: makeRecording(),
      });
    });

    expect(result.current.recordings).toHaveLength(0);
  });

  it("recovers a recording it has not seen through an authoritative read", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (String(path).includes("/recording-consent")) {
        return { noticeVersion: "v1", consent: null };
      }
      if (String(path).includes("/recordings/rec-9")) {
        return { recording: makeRecording({ id: "rec-9", state: "ready" }) };
      }
      if (String(path).includes("/recordings?")) {
        return { recordings: [], hasMore: false };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const { result } = renderHook(() => useMeetingRecordings({ meetingId: MEETING_ID }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      handlers.onRecordingStatus?.({
        meetingId: MEETING_ID,
        recording: makeRecording({ id: "rec-9", state: "ready" }),
      });
    });

    await waitFor(() => expect(result.current.recordings).toHaveLength(1));
    expect(result.current.recordings[0].id).toBe("rec-9");
    expect(
      apiFetchMock.mock.calls.some(([path]) => String(path).includes("/recordings/rec-9")),
    ).toBe(true);
  });

  it("reads the recording again when only the ready event arrives", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (String(path).includes("/recording-consent")) {
        return { noticeVersion: "v1", consent: null };
      }
      if (String(path).includes("/recordings/rec-1")) {
        return { recording: makeRecording({ state: "ready", version: 3 }) };
      }
      if (String(path).includes("/recordings?")) {
        return { recordings: [], hasMore: false };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const { result } = renderHook(() => useMeetingRecordings({ meetingId: MEETING_ID }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      handlers.onRecordingReady?.({
        meetingId: MEETING_ID,
        recordingId: "rec-1",
        state: "ready",
      });
    });

    await waitFor(() => expect(result.current.recordings).toHaveLength(1));
    expect(result.current.recordings[0].state).toBe("ready");
  });

  it("does not let a stale list read regress a newer socket state", async () => {
    let resolveList: ((value: unknown) => void) | undefined;
    apiFetchMock.mockImplementation((path: string) => {
      if (String(path).includes("/recording-consent")) {
        return Promise.resolve({ noticeVersion: "v1", consent: null });
      }
      if (String(path).includes("/recordings?")) {
        return new Promise((resolve) => {
          resolveList = resolve;
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const { result } = renderHook(() => useMeetingRecordings({ meetingId: MEETING_ID }));
    await waitFor(() => expect(connectMeetingSocketMock).toHaveBeenCalled());

    act(() => {
      handlers.onRecordingStatus?.({
        meetingId: MEETING_ID,
        recording: makeRecording({ state: "active", version: 2 }),
      });
    });

    await act(async () => {
      resolveList?.({
        recordings: [makeRecording({ state: "starting", version: 1 })],
        hasMore: false,
      });
    });

    await waitFor(() => expect(result.current.recordings[0]?.state).toBe("active"));
  });
});

describe("useMeetingRecordings bounded polling", () => {
  it("stops polling after the budget is spent", async () => {
    vi.useFakeTimers();
    try {
      apiFetchMock.mockImplementation(async (path: string) => {
        if (String(path).includes("/recording-consent")) {
          return { noticeVersion: "v1", consent: null };
        }
        if (String(path).includes("/recordings?")) {
          return { recordings: [makeRecording({ state: "active" })], hasMore: false };
        }
        throw new Error(`Unexpected request: ${path}`);
      });

      const { result } = renderHook(() =>
        useMeetingRecordings({
          meetingId: MEETING_ID,
          pollIntervalMs: 1_000,
          maxPollAttempts: 2,
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });

      const initial = listCalls();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(listCalls()).toBe(initial + 2);

      // The budget is exhausted: further time produces no more requests.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(listCalls()).toBe(initial + 2);
      expect(result.current.pollingStopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll at all when no attempt is in flight", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useMeetingRecordings({ meetingId: MEETING_ID, pollIntervalMs: 1_000 }),
      );

      await act(async () => {
        await Promise.resolve();
      });

      const initial = listCalls();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(listCalls()).toBe(initial);
      expect(result.current.pollingStopped).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
