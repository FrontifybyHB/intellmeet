// Meeting endpoints owned by the meetings feature. Every call goes through
// the shared HTTP transport so cookie/CSRF/refresh behaviour stays identical
// to the auth calls.
import { apiFetch } from "@/shared/api/client";

export interface MeetingPermissions {
  isHost: boolean;
  canRecord: boolean;
  canScreenShare: boolean;
}

export interface MeetingSummary {
  id: string;
  title: string | null;
  status: string;
  admission: string;
  membership: string;
}

export interface MeetingHistoryRow {
  id: string;
  title: string | null;
  status: string;
  isHost: boolean;
  scheduledAt: string | null;
  endedAt: string | null;
}

export interface MeetingHistoryPage {
  meetings: MeetingHistoryRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface CreateMeetingResult {
  meetingId: string;
  joinUrl: string;
}

export interface JoinResult {
  meetingId: string;
  title: string | null;
  roomName: string;
  livekitUrl: string;
  token: string;
  permissions: MeetingPermissions;
}

// Short-lived in-memory handoff: room credentials never enter URLs, router
// state, persistent storage, logs, or query caches.
const joinHandoffs = new Map<string, JoinResult>();

export function putJoinHandoff(result: JoinResult): void {
  joinHandoffs.set(result.meetingId, result);
}

export function takeJoinHandoff(meetingId: string): JoinResult | null {
  const result = joinHandoffs.get(meetingId) || null;
  joinHandoffs.delete(meetingId);
  return result;
}

/** Creates a title-only meeting and returns its share link. */
export function createMeeting(title: string): Promise<CreateMeetingResult> {
  return apiFetch<CreateMeetingResult>("/meetings", {
    method: "POST",
    body: { title },
  });
}

/** Entitled meeting history, newest first, using the server cursor contract. */
export function fetchMeetingHistory(cursor?: string | null): Promise<MeetingHistoryPage> {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return apiFetch<MeetingHistoryPage>(`/meetings?${query.toString()}`, { cache: "no-store" });
}

/** Resolves an invite code into the meeting it points at. */
export function resolveMeetingLink(code: string): Promise<MeetingSummary> {
  return apiFetch<MeetingSummary>(`/meeting-links/${code}`);
}

/** Joins a meeting through its invite link. */
export function joinMeetingLink(code: string): Promise<JoinResult> {
  return apiFetch<JoinResult>(`/meeting-links/${code}/join`, {
    method: "POST",
    body: {},
  });
}

export function joinMeeting(meetingId: string): Promise<JoinResult> {
  return apiFetch<JoinResult>(`/meetings/${meetingId}/join`, {
    method: "POST",
    body: {},
  });
}

export function endMeeting(meetingId: string): Promise<{ meeting: { status: string } }> {
  return apiFetch(`/meetings/${meetingId}/end`, { method: "POST", body: {} });
}

export function deleteMeeting(meetingId: string): Promise<{ meeting: { status: string }; alreadyDeleted: boolean }> {
  return apiFetch(`/meetings/${meetingId}`, { method: "DELETE" });
}

/**
 * Meeting detail: summary plus status pointers for recording, transcription
 * and intelligence. The pointers are deliberately small — the content
 * behind them loads through its own bounded endpoints.
 */
export interface MeetingDetail {
  meeting: {
    id: string;
    title: string | null;
    status: string;
    isHost: boolean;
    scheduledAt: string | null;
    endedAt: string | null;
    joinUrl: string | null;
  };
  recording: { recordingId: string; state: string; version: number } | null;
  transcription: {
    recordingId: string;
    state: string | null;
    runVersion: number | null;
    publishedRunVersion: number | null;
    segmentCount: number;
    errorCode: string | null;
  } | null;
  intelligence: {
    intelligenceId: string;
    recordingId: string;
    state: string;
    runVersion: number;
    errorCode: string | null;
    sourceTranscriptRunVersion: number | null;
    publishedAt: string | null;
  } | null;
  suggestions: { proposed: number; approved: number; rejected: number };
}

export function fetchMeetingDetail(meetingId: string): Promise<MeetingDetail> {
  return apiFetch<MeetingDetail>(`/meetings/${meetingId}`, { cache: "no-store" });
}
