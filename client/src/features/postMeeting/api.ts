import { apiFetch } from "@/shared/api/client";

export type AsyncState =
  | "pending_enqueue"
  | "queued"
  | "running"
  | "retrying"
  | "complete"
  | "failed"
  | "cancelled"
  | "blocked";

export interface TranscriptionStatus {
  recordingId: string;
  transcription: {
    state: AsyncState;
    runId: string | null;
    runVersion: number | null;
    publishedRunVersion: number | null;
    segmentCount: number;
    errorCode: string | null;
  } | null;
}

export interface TranscriptSegment {
  chunkIndex: number;
  ordinal: number;
  startMs: number;
  endMs: number;
  text: string;
  language: string | null;
  speakerLabel: string | null;
}

export interface TranscriptPage {
  segments: TranscriptSegment[];
  hasMore: boolean;
  nextCursor: string | null;
  partial: boolean;
  runVersion: number | null;
}

export interface Evidence {
  segmentIds: string[];
  startMs: number | null;
  endMs: number | null;
}

export interface IntelligenceOutput {
  summaryBullets: { text: string; evidence: Evidence }[];
  decisions: { text: string; evidence: Evidence }[];
  blockers: { text: string; evidence: Evidence }[];
  unresolvedQuestions: { text: string; evidence: Evidence }[];
}

export interface IntelligenceStatus {
  intelligenceId: string;
  recordingId: string;
  state: AsyncState;
  runVersion: number;
  sourceTranscriptRunVersion: number | null;
  errorCode: string | null;
  publishedAt: string | null;
}

export interface IntelligenceResponse {
  state: AsyncState | null;
  intelligence: IntelligenceStatus | null;
  output: IntelligenceOutput | null;
  suggestions: { proposed: number; approved: number; rejected: number };
}

export interface ActionItem {
  id: string;
  runVersion: number;
  state: "proposed" | "approved" | "rejected";
  version: number;
  proposal: {
    title: string;
    detail: string | null;
    proposedOwnerText: string | null;
    proposedDueDateText: string | null;
  };
  evidence: Evidence;
  reviewed: {
    title: string | null;
    detail: string | null;
    dueDateText: string | null;
    ownerUserId: string | null;
  };
  task: { status: string; taskId?: string; idempotencyKey: string | null };
}

export interface ActionItemsPage {
  items: ActionItem[];
  hasMore: boolean;
  nextCursor: string | null;
  runVersion: number | null;
}

const noStore = { cache: "no-store" as const };

export function fetchTranscriptionStatus(meetingId: string, recordingId: string) {
  return apiFetch<TranscriptionStatus>(
    `/meetings/${meetingId}/recordings/${recordingId}/transcription`,
    noStore,
  );
}

export function startTranscription(meetingId: string, recordingId: string) {
  return apiFetch<{ status: TranscriptionStatus; resumed: boolean; pending?: boolean }>(
    `/meetings/${meetingId}/recordings/${recordingId}/transcription`,
    { ...noStore, method: "POST", body: {} },
  );
}

export function cancelTranscription(meetingId: string, recordingId: string) {
  return apiFetch<{ status: TranscriptionStatus; resumed: boolean }>(
    `/meetings/${meetingId}/recordings/${recordingId}/transcription`,
    { ...noStore, method: "DELETE" },
  );
}

export function fetchTranscriptPage(meetingId: string, recordingId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: "100" });
  if (cursor) query.set("cursor", cursor);
  return apiFetch<TranscriptPage>(
    `/meetings/${meetingId}/recordings/${recordingId}/transcript?${query.toString()}`,
    noStore,
  );
}

export function fetchIntelligence(meetingId: string, recordingId: string) {
  return apiFetch<IntelligenceResponse>(
    `/meetings/${meetingId}/recordings/${recordingId}/intelligence`,
    noStore,
  );
}

export function startIntelligence(meetingId: string, recordingId: string) {
  return apiFetch<{ status: IntelligenceStatus; resumed: boolean; pending?: boolean }>(
    `/meetings/${meetingId}/recordings/${recordingId}/intelligence`,
    { ...noStore, method: "POST", body: {} },
  );
}

export function cancelIntelligence(meetingId: string, recordingId: string) {
  return apiFetch<{ status: IntelligenceStatus; resumed: boolean }>(
    `/meetings/${meetingId}/recordings/${recordingId}/intelligence`,
    { ...noStore, method: "DELETE" },
  );
}

export function fetchActionItemsPage(meetingId: string, recordingId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);
  return apiFetch<ActionItemsPage>(
    `/meetings/${meetingId}/recordings/${recordingId}/action-items?${query.toString()}`,
    noStore,
  );
}

export function reviewActionItem(
  meetingId: string,
  item: ActionItem,
  action: "approve" | "edit" | "reject",
  fields: { title?: string; detail?: string; dueDateText?: string },
) {
  return apiFetch<{ item: ActionItem; resumed: boolean }>(
    `/meetings/${meetingId}/action-items/${item.id}`,
    {
      ...noStore,
      method: "PATCH",
      body: {
        action,
        version: item.version,
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
        ...(fields.dueDateText !== undefined ? { dueDateText: fields.dueDateText } : {}),
        ...(action === "approve" ? { confirmUnassigned: true } : {}),
      },
    },
  );
}

export function createActionTask(meetingId: string, item: ActionItem) {
  return apiFetch<{
    task: { id: string; title: string; status: string };
    item: ActionItem;
    resumed: boolean;
  }>(`/meetings/${meetingId}/action-items/${item.id}/task`, {
    ...noStore,
    method: "POST",
    body: {},
  });
}
