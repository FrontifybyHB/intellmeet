import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PostMeetingPanel } from "@/features/postMeeting/PostMeetingPanel";
import type { Recording } from "@/features/recordings/api";
import type { MeetingSocketHandlers } from "@/shared/realtime/meetingSocket";

const mocks = vi.hoisted(() => ({
  listRecordings: vi.fn(),
  fetchTx: vi.fn(),
  startTx: vi.fn(),
  cancelTx: vi.fn(),
  fetchTranscript: vi.fn(),
  fetchIx: vi.fn(),
  startIx: vi.fn(),
  cancelIx: vi.fn(),
  fetchItems: vi.fn(),
  review: vi.fn(),
  createTask: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@/features/recordings/api", () => ({ listMeetingRecordings: mocks.listRecordings }));
vi.mock("@/features/postMeeting/api", () => ({
  fetchTranscriptionStatus: mocks.fetchTx,
  startTranscription: mocks.startTx,
  cancelTranscription: mocks.cancelTx,
  fetchTranscriptPage: mocks.fetchTranscript,
  fetchIntelligence: mocks.fetchIx,
  startIntelligence: mocks.startIx,
  cancelIntelligence: mocks.cancelIx,
  fetchActionItemsPage: mocks.fetchItems,
  reviewActionItem: mocks.review,
  createActionTask: mocks.createTask,
}));
vi.mock("@/shared/realtime/meetingSocket", () => ({ connectMeetingSocket: mocks.connect }));

const recording: Recording = {
  id: "rec-1", meetingId: "meeting-1", sessionId: "s-1", providerEgressId: null, state: "ready", version: 1,
  requesterId: "host-1", consentSnapshot: null, storage: null, output: null, errorCode: null,
  providerUpdatedAt: null, createdAt: null, updatedAt: null,
};

function setup({ isHost = true } = {}) {
  mocks.listRecordings.mockResolvedValue({ recordings: [recording], hasMore: false });
  mocks.fetchTx.mockResolvedValue({ recordingId: "rec-1", transcription: null });
  mocks.fetchIx.mockResolvedValue({ state: null, intelligence: null, output: null, suggestions: { proposed: 0, approved: 0, rejected: 0 } });
  mocks.fetchTranscript.mockResolvedValue({ segments: [], hasMore: false, nextCursor: null, partial: false, runVersion: null });
  mocks.fetchItems.mockResolvedValue({ items: [], hasMore: false, nextCursor: null, runVersion: null });
  mocks.connect.mockImplementation(() => vi.fn());
  render(<PostMeetingPanel meetingId="meeting-1" isHost={isHost} />);
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe("PostMeetingPanel", () => {
  it("shows the queued summary run immediately after starting it", async () => {
    const user = userEvent.setup();
    mocks.listRecordings.mockResolvedValue({ recordings: [recording], hasMore: false });
    mocks.fetchTx.mockResolvedValue({ recordingId: "rec-1", transcription: { state: "complete", runVersion: 1, publishedRunVersion: 1, segmentCount: 1, errorCode: null } });
    mocks.fetchIx.mockResolvedValue({ state: null, intelligence: null, output: null, suggestions: { proposed: 0, approved: 0, rejected: 0 } });
    mocks.fetchItems.mockResolvedValue({ items: [], hasMore: false, nextCursor: null, runVersion: null });
    mocks.fetchTranscript.mockResolvedValue({ segments: [], hasMore: false, nextCursor: null, runVersion: 1 });
    mocks.startIx.mockResolvedValue({ status: { intelligenceId: "ix-1", recordingId: "rec-1", state: "queued", runVersion: 1 } });
    mocks.connect.mockImplementation(() => vi.fn());
    render(<PostMeetingPanel meetingId="meeting-1" isHost />);
    await user.click(await screen.findByRole("button", { name: "Start intelligence" }));
    expect(await screen.findByText("queued")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
  it("keeps transcription and intelligence writes host-only while allowing member reads", async () => {
    setup({ isHost: false });
    expect(await screen.findByText("Post-meeting processing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start transcription" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start intelligence" })).not.toBeInTheDocument();
    expect(mocks.fetchTx).toHaveBeenCalledWith("meeting-1", "rec-1");
    expect(mocks.fetchIx).toHaveBeenCalledWith("meeting-1", "rec-1");
  });

  it("accepts an async start once and exposes cancellation for the returned run", async () => {
    const user = userEvent.setup();
    let resolveStart: ((value: unknown) => void) | undefined;
    setup();
    mocks.startTx.mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    const start = await screen.findByRole("button", { name: "Start transcription" });
    await user.click(start);
    await user.click(start);
    expect(mocks.startTx).toHaveBeenCalledTimes(1);
    resolveStart?.({ status: { recordingId: "rec-1", transcription: { state: "queued", runVersion: 3, publishedRunVersion: null, segmentCount: 0, errorCode: null } }, resumed: false, pending: true });
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("uses cursor pages and shows the server-returned resumed task", async () => {
    const user = userEvent.setup();
    mocks.listRecordings.mockResolvedValue({ recordings: [recording], hasMore: false });
    mocks.fetchTx.mockResolvedValue({ recordingId: "rec-1", transcription: { state: "complete", runVersion: 4, publishedRunVersion: 4, segmentCount: 1, errorCode: null } });
    mocks.fetchIx.mockResolvedValue({ state: "complete", intelligence: { intelligenceId: "ix-1", recordingId: "rec-1", state: "complete", runVersion: 2, sourceTranscriptRunVersion: 4, errorCode: null, publishedAt: null }, output: null, suggestions: { proposed: 1, approved: 0, rejected: 0 } });
    mocks.fetchItems.mockResolvedValue({ items: [{ id: "item-1", runVersion: 2, state: "proposed", version: 1, proposal: { title: "Send notes", detail: null, proposedOwnerText: null, proposedDueDateText: null }, evidence: { segmentIds: ["seg-2"], startMs: null, endMs: null }, reviewed: { title: null, detail: null, dueDateText: null, ownerUserId: null }, task: { status: "blocked", idempotencyKey: "key-1" } }], hasMore: true, nextCursor: "cursor-1", runVersion: 2 });
    mocks.fetchTranscript.mockResolvedValue({ segments: [{ chunkIndex: 0, ordinal: 0, startMs: 0, endMs: 100, text: "hello", language: "en", speakerLabel: "speaker_1" }], hasMore: false, nextCursor: null, partial: false, runVersion: 4 });
    mocks.connect.mockImplementation(() => vi.fn());
    render(<PostMeetingPanel meetingId="meeting-1" isHost />);
    mocks.createTask.mockResolvedValue({ resumed: true, task: { id: "task-1", title: "Send notes", status: "open" }, item: { id: "item-1", runVersion: 2, state: "approved", version: 2, proposal: { title: "Send notes", detail: null, proposedOwnerText: null, proposedDueDateText: null }, evidence: { segmentIds: ["seg-2"], startMs: null, endMs: null }, reviewed: { title: "Send notes", detail: null, dueDateText: null, ownerUserId: null }, task: { status: "created", taskId: "task-1", idempotencyKey: "key-1" } } });
    expect(await screen.findByText("Send notes")).toBeInTheDocument();
    const handlers = mocks.connect.mock.calls[0][1] as MeetingSocketHandlers;
    handlers.onIntelligenceStatus?.({ meetingId: "meeting-1", intelligence: { intelligenceId: "ix-1", recordingId: "rec-1", state: "running", runVersion: 1, sourceTranscriptRunVersion: 3, errorCode: null, publishedAt: null } });
    expect(screen.getAllByText("complete").length).toBeGreaterThan(0);
    handlers.onActionItemUpdated?.({ meetingId: "meeting-1", actionItem: { id: "item-1", state: "proposed", version: 1, title: "Send notes", taskStatus: "blocked" } });
    expect(screen.getAllByText("Send notes")).toHaveLength(1);
    mocks.review.mockResolvedValue({ item: { id: "item-1", runVersion: 2, state: "approved", version: 2, proposal: { title: "Send notes", detail: null, proposedOwnerText: null, proposedDueDateText: null }, evidence: { segmentIds: ["seg-2"], startMs: null, endMs: null }, reviewed: { title: "Send notes", detail: null, dueDateText: null, ownerUserId: null }, task: { status: "blocked", idempotencyKey: "key-1" } }, resumed: false });
    await user.click(screen.getByRole("button", { name: "Approve unassigned" }));
    mocks.createTask.mockResolvedValue({ resumed: true, task: { id: "task-1", title: "Send notes", status: "open" }, item: { id: "item-1", runVersion: 2, state: "approved", version: 2, proposal: { title: "Send notes", detail: null, proposedOwnerText: null, proposedDueDateText: null }, evidence: { segmentIds: ["seg-2"], startMs: null, endMs: null }, reviewed: { title: "Send notes", detail: null, dueDateText: null, ownerUserId: null }, task: { status: "created", taskId: "task-1", idempotencyKey: "key-1" } } });
    await user.click(await screen.findByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Resumed task: Send notes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more action items" }));
    expect(mocks.fetchItems).toHaveBeenCalledWith("meeting-1", "rec-1", "cursor-1");
  });
});
