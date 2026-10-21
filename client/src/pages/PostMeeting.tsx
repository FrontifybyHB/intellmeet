import { useCallback, useState } from "react";
import { ApiError, apiFetch } from "../services/api";

interface HistoryRow {
  id: string;
  title: string | null;
  status: string;
  isHost: boolean;
}

interface ActionItem {
  id: string;
  state: string;
  version: number;
  proposal: { title: string };
  reviewed: { title: string | null; ownerUserId: string | null };
  task: { status: string; taskId?: string; idempotencyKey: string | null };
}

// Post-meeting UI: entitled history, status pointers, transcript,
// intelligence output, and reviewable action items → one real Task.
export function PostMeeting() {
  const [meetings, setMeetings] = useState<HistoryRow[]>([]);
  const [meetingId, setMeetingId] = useState("");
  const [recordingId, setRecordingId] = useState("");
  const [detail, setDetail] = useState<object | null>(null);
  const [transcript, setTranscript] = useState<object | null>(null);
  const [intel, setIntel] = useState<object | null>(null);
  const [items, setItems] = useState<ActionItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setError(null);
    try {
      const body = await apiFetch<{ meetings: HistoryRow[] }>("/meetings?limit=20");
      setMeetings(body.meetings);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "history failed");
    }
  }, []);

  const loadDetail = useCallback(async () => {
    setError(null);
    try {
      const [d, recs] = await Promise.all([
        apiFetch<object>(`/meetings/${meetingId}`),
        apiFetch<{ recordings: { id: string }[] }>(`/meetings/${meetingId}/recordings`),
      ]);
      setDetail(d);
      const rid = recs.recordings?.[0]?.id || recordingId;
      if (rid) {
        setRecordingId(rid);
        const [tx, ix, acts] = await Promise.all([
          apiFetch<object>(`/meetings/${meetingId}/recordings/${rid}/transcript`).catch(() => null),
          apiFetch<object>(`/meetings/${meetingId}/recordings/${rid}/intelligence`).catch(() => null),
          apiFetch<{ items: ActionItem[] }>(`/meetings/${meetingId}/recordings/${rid}/action-items`).catch(() => ({ items: [] })),
        ]);
        setTranscript(tx);
        setIntel(ix);
        setItems(acts.items || []);
      }
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "detail failed");
    }
  }, [meetingId, recordingId]);

  const review = useCallback(
    async (item: ActionItem, action: "approve" | "reject") => {
      setError(null);
      try {
        await apiFetch<object>(`/meetings/${meetingId}/action-items/${item.id}`, {
          method: "PATCH",
          body: action === "approve"
            ? { action, version: item.version, title: item.proposal.title, confirmUnassigned: true }
            : { action, version: item.version },
        });
        await loadDetail();
      } catch (err) {
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "review failed");
      }
    },
    [meetingId, loadDetail]
  );

  const createTask = useCallback(
    async (item: ActionItem) => {
      setError(null);
      try {
        await apiFetch<object>(`/meetings/${meetingId}/action-items/${item.id}/task`, { method: "POST", body: {} });
        await loadDetail();
      } catch (err) {
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "task failed");
      }
    },
    [meetingId, loadDetail]
  );

  return (
    <div className="space-y-4">
      <h2>Post-meeting</h2>
      <button type="button" onClick={() => void loadHistory()}>Load history</button>
      <ul>
        {meetings.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => setMeetingId(m.id)}>
              {m.title || m.id} ({m.status})
            </button>
          </li>
        ))}
      </ul>
      <label>
        Meeting ID <input value={meetingId} onChange={(e) => setMeetingId(e.target.value)} />
      </label>
      <button type="button" onClick={() => void loadDetail()} disabled={!meetingId}>
        Load detail
      </button>
      {error && <p role="alert">{error}</p>}
      {detail && <pre>{JSON.stringify(detail, null, 2).slice(0, 3000)}</pre>}
      {transcript && <pre>transcript: {JSON.stringify(transcript, null, 2).slice(0, 2000)}</pre>}
      {intel && <pre>intelligence: {JSON.stringify(intel, null, 2).slice(0, 3000)}</pre>}
      <ul>
        {items.map((it) => (
          <li key={it.id}>
            {it.proposal.title} [{it.state}] task:{it.task.status}
            {it.state === "proposed" && (
              <>
                <button type="button" onClick={() => void review(it, "approve")}>Approve</button>
                <button type="button" onClick={() => void review(it, "reject")}>Reject</button>
              </>
            )}
            {it.state === "approved" && it.task.status !== "created" && (
              <button type="button" onClick={() => void createTask(it)}>Create task</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
