// Post-meeting lab screen (dev only).
//
// Renders history/status pointers, transcript, intelligence output, and
// reviewable action items → one real Task. The screen owns the contract
// calls; the panels below it are presentational.

import { useCallback, useState } from "react";

import { ApiError } from "@/shared/api/errors";
import { ActionItemReview } from "@/dev/pages/post-meeting/ActionItemReview";
import { MeetingHistoryList } from "@/dev/pages/post-meeting/MeetingHistoryList";
import { TranscriptPanel } from "@/dev/pages/post-meeting/TranscriptPanel";
import {
  createActionItemTask,
  fetchMeetingHistory,
  fetchPostMeetingBundle,
  reviewActionItem,
  type ActionItem,
  type HistoryRow,
} from "@/dev/pages/post-meeting/api";

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
      setMeetings(await fetchMeetingHistory());
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "history failed");
    }
  }, []);

  const loadDetail = useCallback(async () => {
    setError(null);
    try {
      const bundle = await fetchPostMeetingBundle(meetingId, recordingId);
      setDetail(bundle.detail);
      setTranscript(bundle.transcript);
      setIntel(bundle.intelligence);
      setItems(bundle.items);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "detail failed");
    }
  }, [meetingId, recordingId]);

  const review = useCallback(
    async (item: ActionItem, action: "approve" | "reject") => {
      setError(null);
      try {
        await reviewActionItem(meetingId, item, action);
        await loadDetail();
      } catch (err) {
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "review failed");
      }
    },
    [meetingId, loadDetail],
  );

  const createTask = useCallback(
    async (item: ActionItem) => {
      setError(null);
      try {
        await createActionItemTask(meetingId, item);
        await loadDetail();
      } catch (err) {
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "task failed");
      }
    },
    [meetingId, loadDetail],
  );

  return (
    <div className="space-y-4">
      <h2>Post-meeting</h2>
      <button type="button" onClick={() => void loadHistory()}>
        Load history
      </button>
      <MeetingHistoryList
        meetings={meetings}
        onSelect={(id) => {
          setMeetingId(id);
          setRecordingId("");
        }}
      />
      <label>
        Meeting ID{" "}
        <input value={meetingId} onChange={(event) => setMeetingId(event.target.value)} />
      </label>
      <button type="button" onClick={() => void loadDetail()} disabled={!meetingId}>
        Load detail
      </button>
      {error && <p role="alert">{error}</p>}
      {detail && <pre>{JSON.stringify(detail, null, 2).slice(0, 3000)}</pre>}
      <TranscriptPanel transcript={transcript} intelligence={intel} />
      <ActionItemReview
        items={items}
        onReview={(item, action) => void review(item, action)}
        onCreateTask={(item) => void createTask(item)}
      />
    </div>
  );
}
