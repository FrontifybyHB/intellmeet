import { describe, expect, it, vi } from "vitest";

import type { Recording } from "@/features/recordings/api";

const { ioMock, socketMock, socketHandlers, refreshMock } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(),
  };
  return {
    ioMock: vi.fn(() => socket),
    socketMock: socket,
    socketHandlers: handlers,
    refreshMock: vi.fn(),
  };
});

vi.mock("socket.io-client", () => ({ io: ioMock }));
vi.mock("@/shared/api/client", () => ({ refreshAuthForRealtime: refreshMock }));

import { connectMeetingSocket } from "@/shared/realtime/meetingSocket";

function recording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: "rec-1",
    meetingId: "meeting-1",
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
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("connectMeetingSocket", () => {
  it("renews an expired cookie and reconnects the chat socket", async () => {
    refreshMock.mockResolvedValueOnce(true);
    const teardown = connectMeetingSocket("meeting-1", {});
    await vi.waitFor(() => expect(ioMock).toHaveBeenCalled());
    socketHandlers.get("connect_error")?.({ data: { code: "UNAUTHORIZED" } });
    await vi.waitFor(() => expect(socketMock.connect).toHaveBeenCalled());
    expect(refreshMock).toHaveBeenCalledTimes(1);
    teardown();
  });
  it("delivers a sent chat message after the server acknowledges it", async () => {
    const onChatMessage = vi.fn();
    const onChatReady = vi.fn();
    const teardown = connectMeetingSocket("meeting-1", { onChatMessage, onChatReady });
    await vi.waitFor(() => expect(ioMock).toHaveBeenCalled());
    socketHandlers.get("connect")?.();
    const joinCall = socketMock.emit.mock.calls.find(([event]) => event === "meeting:join");
    (joinCall?.[2] as (response: unknown) => void)?.({ ok: true, messages: [] });
    const send = onChatReady.mock.calls[0][0] as (text: string) => Promise<void>;
    const sending = send("Hello everyone");
    const sendCall = socketMock.emit.mock.calls.find(([event]) => event === "chat:send");
    expect(sendCall?.[1]).toMatchObject({ meetingId: "meeting-1", text: "Hello everyone" });
    (sendCall?.[2] as (response: unknown) => void)?.({ ok: true, message: { id: "msg-1", text: "Hello everyone" } });
    await sending;
    expect(onChatMessage).toHaveBeenCalledWith({ id: "msg-1", text: "Hello everyone" });
    teardown();
  });
  it("joins the meeting room on connect so recording events are delivered", async () => {
    const teardown = connectMeetingSocket("meeting-1", {});

    await vi.waitFor(() => expect(ioMock).toHaveBeenCalled());
    socketHandlers.get("connect")?.();

    expect(socketMock.emit).toHaveBeenCalledWith(
      "meeting:join",
      { meetingId: "meeting-1" },
      expect.any(Function),
    );

    teardown();
  });

  it("forwards recording events to the handlers", async () => {
    const onRecordingStatus = vi.fn();
    const onRecordingReady = vi.fn();

    const teardown = connectMeetingSocket("meeting-1", { onRecordingStatus, onRecordingReady });

    await vi.waitFor(() => expect(ioMock).toHaveBeenCalled());

    socketHandlers.get("recording:status")?.({
      meetingId: "meeting-1",
      recording: recording(),
    });
    socketHandlers.get("recording:ready")?.({
      meetingId: "meeting-1",
      recordingId: "rec-1",
      state: "ready",
    });

    expect(onRecordingStatus).toHaveBeenCalledTimes(1);
    expect(onRecordingReady).toHaveBeenCalledTimes(1);

    teardown();
  });

  it("ignores a malformed payload", async () => {
    const onRecordingStatus = vi.fn();
    const teardown = connectMeetingSocket("meeting-1", { onRecordingStatus });

    await vi.waitFor(() => expect(ioMock).toHaveBeenCalled());

    socketHandlers.get("recording:status")?.({ meetingId: "meeting-1" });

    expect(onRecordingStatus).not.toHaveBeenCalled();

    teardown();
  });

  it("reports the room as joined only once the server acknowledges it", async () => {
    const onConnected = vi.fn();
    const teardown = connectMeetingSocket("meeting-1", { onConnected });

    await vi.waitFor(() => expect(ioMock).toHaveBeenCalled());
    socketHandlers.get("connect")?.();

    const joinCall = socketMock.emit.mock.calls.find(([event]) => event === "meeting:join");
    const ack = joinCall?.[2] as (response: unknown) => void;
    ack?.({ ok: true, room: "meeting_meeting-1" });

    expect(onConnected).toHaveBeenCalledTimes(1);

    teardown();
  });

  it("surfaces a refused room join", async () => {
    const onError = vi.fn();
    const onConnected = vi.fn();
    const teardown = connectMeetingSocket("meeting-1", { onError, onConnected });

    await vi.waitFor(() => expect(ioMock).toHaveBeenCalled());
    socketHandlers.get("connect")?.();

    const joinCall = socketMock.emit.mock.calls.find(([event]) => event === "meeting:join");
    const ack = joinCall?.[2] as (response: unknown) => void;
    ack?.({ ok: false, code: "NOT_ADMITTED", message: "Meeting membership required." });

    expect(onError).toHaveBeenCalledWith("Meeting membership required.");
    expect(onConnected).not.toHaveBeenCalled();

    teardown();
  });

  it("keeps chat unavailable when the join acknowledgement is malformed", async () => {
    const onChatReady = vi.fn();
    const onError = vi.fn();
    const teardown = connectMeetingSocket("meeting-1", { onChatReady, onError });
    await vi.waitFor(() => expect(ioMock).toHaveBeenCalled());
    socketHandlers.get("connect")?.();
    const joinCall = socketMock.emit.mock.calls.find(([event]) => event === "meeting:join");
    (joinCall?.[2] as (response: unknown) => void)?.({});
    expect(onChatReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Live updates were refused by the server.");
    teardown();
  });

  it("leaves the room and disconnects on teardown", async () => {
    const teardown = connectMeetingSocket("meeting-1", {});

    await vi.waitFor(() => expect(ioMock).toHaveBeenCalled());

    teardown();

    expect(socketMock.emit).toHaveBeenCalledWith("meeting:leave", { meetingId: "meeting-1" });
    expect(socketMock.disconnect).toHaveBeenCalled();
  });

  it("cancels a connection that was torn down before it settled", async () => {
    const teardown = connectMeetingSocket("meeting-1", {});
    teardown();

    await vi.waitFor(() => expect(ioMock).not.toHaveBeenCalled());
  });
});
