// Post-meeting contract calls used by the dev lab.
//
// The lab talks to the backend directly (no feature API is involved) so it
// can exercise the raw contract, including the shapes the product does not
// consume yet.

import { apiFetch } from "@/shared/api/client";

export interface HistoryRow {
  id: string;
  title: string | null;
  status: string;
  isHost: boolean;
}

export interface ActionItem {
  id: string;
  state: string;
  version: number;
  proposal: { title: string };
  reviewed: { title: string | null; ownerUserId: string | null };
  task: { status: string; taskId?: string; idempotencyKey: string | null };
}

export interface PostMeetingBundle {
  detail: object | null;
  transcript: object | null;
  intelligence: object | null;
  items: ActionItem[];
}

/** The entitled meeting history. */
export function fetchMeetingHistory(): Promise<HistoryRow[]> {
  return apiFetch<{ meetings: HistoryRow[] }>("/meetings?limit=20").then((body) => body.meetings);
}

/**
 * Loads the meeting detail plus the artefacts that hang off its newest
 * recording. The optional reads swallow their errors on purpose: a missing
 * transcript must not hide the action items.
 */
export async function fetchPostMeetingBundle(
  meetingId: string,
  recordingId: string,
): Promise<PostMeetingBundle> {
  const [detail, recordings] = await Promise.all([
    apiFetch<object>(`/meetings/${meetingId}`),
    apiFetch<{ recordings: { id: string }[] }>(`/meetings/${meetingId}/recordings`),
  ]);

  const rid = recordings.recordings?.[0]?.id || recordingId;
  if (!rid) {
    return { detail, transcript: null, intelligence: null, items: [] };
  }

  const [transcript, intelligence, actions] = await Promise.all([
    apiFetch<object>(`/meetings/${meetingId}/recordings/${rid}/transcript`).catch(() => null),
    apiFetch<object>(`/meetings/${meetingId}/recordings/${rid}/intelligence`).catch(() => null),
    apiFetch<{ items: ActionItem[] }>(
      `/meetings/${meetingId}/recordings/${rid}/action-items`,
    ).catch(() => ({ items: [] })),
  ]);

  return { detail, transcript, intelligence, items: actions.items || [] };
}

/** Approves or rejects a proposed action item. */
export function reviewActionItem(
  meetingId: string,
  item: ActionItem,
  action: "approve" | "reject",
): Promise<object> {
  return apiFetch<object>(`/meetings/${meetingId}/action-items/${item.id}`, {
    method: "PATCH",
    body:
      action === "approve"
        ? { action, version: item.version, title: item.proposal.title, confirmUnassigned: true }
        : { action, version: item.version },
  });
}

/** Turns an approved action item into a real task. */
export function createActionItemTask(meetingId: string, item: ActionItem): Promise<object> {
  return apiFetch<object>(`/meetings/${meetingId}/action-items/${item.id}/task`, {
    method: "POST",
    body: {},
  });
}
