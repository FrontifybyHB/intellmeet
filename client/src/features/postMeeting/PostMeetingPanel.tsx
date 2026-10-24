import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, describeApiError } from "@/shared/api/errors";
import { connectMeetingSocket } from "@/shared/realtime/meetingSocket";
import { listMeetingRecordings, type Recording } from "@/features/recordings/api";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Badge } from "@/shared/ui/badge";
import {
  cancelIntelligence,
  cancelTranscription,
  createActionTask,
  fetchActionItemsPage,
  fetchIntelligence,
  fetchTranscriptPage,
  fetchTranscriptionStatus,
  reviewActionItem,
  startIntelligence,
  startTranscription,
  type ActionItem,
  type IntelligenceOutput,
  type IntelligenceResponse,
  type TranscriptSegment,
  type TranscriptionStatus,
} from "@/features/postMeeting/api";

function stateLabel(state: string | null | undefined): string {
  return state ? state.replace(/_/g, " ") : "not started";
}

function evidenceLabel(segmentIds: string[]): string {
  return segmentIds.length ? `Evidence: ${segmentIds.join(", ")}` : "No transcript reference available";
}

function isLive(state: string | null | undefined): boolean {
  return state === "pending_enqueue" || state === "queued" || state === "running" || state === "retrying";
}

export function PostMeetingPanel({ meetingId, isHost }: { meetingId: string; isHost: boolean }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [transcription, setTranscription] = useState<TranscriptionStatus | null>(null);
  const [intelligence, setIntelligence] = useState<IntelligenceResponse | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [transcriptCursor, setTranscriptCursor] = useState<string | null>(null);
  const [transcriptMore, setTranscriptMore] = useState(false);
  const [items, setItems] = useState<ActionItem[]>([]);
  const [itemCursor, setItemCursor] = useState<string | null>(null);
  const [itemsMore, setItemsMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskNotice, setTaskNotice] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const recoveryTimer = useRef<number | null>(null);
  const recoveryCount = useRef(0);
  const artifactGeneration = useRef(0);
  const recordingIdRef = useRef<string | undefined>(undefined);
  const transcriptionRef = useRef<TranscriptionStatus | null>(null);
  const intelligenceRef = useRef<IntelligenceResponse | null>(null);
  recordingIdRef.current = recording?.id;
  transcriptionRef.current = transcription;
  intelligenceRef.current = intelligence;

  const readArtifacts = useCallback(async (rid: string, reset = true) => {
    const requestGeneration = ++artifactGeneration.current;
    const [tx, ix, actionPage] = await Promise.all([
      fetchTranscriptionStatus(meetingId, rid),
      fetchIntelligence(meetingId, rid),
      fetchActionItemsPage(meetingId, rid),
    ]);
    if (requestGeneration !== artifactGeneration.current) return;
    setTranscription(tx);
    setIntelligence(ix);
    setItems(actionPage.items);
    setItemCursor(actionPage.nextCursor);
    setItemsMore(actionPage.hasMore);
    if (reset) {
      setSegments([]);
      setTranscriptCursor(null);
      setTranscriptMore(false);
    }
    if (tx.transcription?.state === "complete") {
      const page = await fetchTranscriptPage(meetingId, rid);
      if (requestGeneration !== artifactGeneration.current) return;
      if (page.runVersion === tx.transcription.publishedRunVersion) {
        setSegments(page.segments);
        setTranscriptCursor(page.nextCursor);
        setTranscriptMore(page.hasMore);
      }
    }
  }, [meetingId]);

  const scheduleRecovery = useCallback((rid: string) => {
    if (recoveryTimer.current !== null || recoveryCount.current >= 6) return;
    recoveryTimer.current = window.setTimeout(() => {
      recoveryTimer.current = null;
      recoveryCount.current += 1;
      void readArtifacts(rid, false).catch(() => undefined);
    }, 5000);
  }, [readArtifacts]);

  const refresh = useCallback(async () => {
    const body = await listMeetingRecordings(meetingId, 50);
    const next = body.recordings.find((row) => row.state === "ready") ?? null;
    setRecording(next);
    if (!next) return;
    recoveryCount.current = 0;
    await readArtifacts(next.id);
  }, [meetingId, readArtifacts]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void refresh().catch((err) => {
      if (!cancelled) setError(describeApiError(err, "Post-meeting output is unavailable."));
    });
    return () => {
      cancelled = true;
      if (recoveryTimer.current !== null) window.clearTimeout(recoveryTimer.current);
    };
  }, [refresh]);

  useEffect(() => {
    const teardown = connectMeetingSocket(meetingId, {
      onTranscriptionStatus: ({ transcription: event }) => {
        if (event.recordingId !== recordingIdRef.current) return;
        const current = transcriptionRef.current?.transcription;
        if (current?.runVersion && event.transcription?.runVersion && event.transcription.runVersion < current.runVersion) return;
        setTranscription(event);
        if (event.transcription?.state === "complete") void readArtifacts(event.recordingId).catch(() => undefined);
        else scheduleRecovery(event.recordingId);
      },
      onTranscriptionReady: ({ recordingId }) => {
        if (recordingId === recordingIdRef.current) void readArtifacts(recordingId).catch(() => undefined);
      },
      onIntelligenceStatus: ({ intelligence: event }) => {
        if (event.recordingId !== recordingIdRef.current) return;
        const current = intelligenceRef.current?.intelligence;
        if (current?.runVersion && event.runVersion < current.runVersion) return;
        setIntelligence((previous) => previous ? { ...previous, state: event.state, intelligence: event } : { state: event.state, intelligence: event, output: null, suggestions: { proposed: 0, approved: 0, rejected: 0 } });
        if (event.state === "complete") void readArtifacts(event.recordingId).catch(() => undefined);
        else scheduleRecovery(event.recordingId);
      },
      onIntelligenceReady: ({ intelligenceId }) => {
        if (intelligenceRef.current?.intelligence?.intelligenceId === intelligenceId && recordingIdRef.current) void readArtifacts(recordingIdRef.current).catch(() => undefined);
      },
      onActionItemUpdated: ({ actionItem }) => {
        setItems((current) => current.map((item) => item.id === actionItem.id && actionItem.version >= item.version ? { ...item, state: actionItem.state, version: actionItem.version, task: { ...item.task, status: actionItem.taskStatus } } : item));
      },
    });
    return teardown;
  }, [meetingId, recording?.id, readArtifacts, scheduleRecovery]);

  useEffect(() => {
    if (!recording || transcription?.transcription?.state !== "complete" || intelligence?.state === "complete" || intelligence?.state === "failed" || intelligence?.state === "cancelled") return;
    const timer = window.setInterval(() => {
      void readArtifacts(recording.id, false).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [recording, transcription?.transcription?.state, intelligence?.state, readArtifacts]);

  const runAction = async (key: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try { await work(); } catch (err) { setError(describeApiError(err, "The request failed.")); } finally { setBusy(null); }
  };

  const loadMoreTranscript = () => recording && transcriptCursor
    ? void runAction("transcript-more", async () => {
        const page = await fetchTranscriptPage(meetingId, recording.id, transcriptCursor);
        if (page.runVersion !== transcription?.transcription?.publishedRunVersion) return;
        setSegments((current) => {
          const seen = new Set(current.map((segment) => `${segment.chunkIndex}:${segment.ordinal}`));
          return [...current, ...page.segments.filter((segment) => !seen.has(`${segment.chunkIndex}:${segment.ordinal}`))];
        });
        setTranscriptCursor(page.nextCursor);
        setTranscriptMore(page.hasMore);
      }) : undefined;

  const loadMoreItems = () => recording && itemCursor
    ? void runAction("items-more", async () => {
        const page = await fetchActionItemsPage(meetingId, recording.id, itemCursor);
        if (page.runVersion !== intelligence?.intelligence?.runVersion) return;
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...page.items.filter((item) => !seen.has(item.id))];
        });
        setItemCursor(page.nextCursor);
        setItemsMore(page.hasMore);
      }) : undefined;

  if (error && !recording) {
    return <Card><CardContent className="pt-6"><p role="alert">{error}</p><Button variant="outline" onClick={() => void runAction("refresh", refresh)}>Try again</Button></CardContent></Card>;
  }
  if (!recording) return <Card><CardContent className="pt-6 text-sm text-muted-foreground">No recording is available for post-meeting processing.</CardContent></Card>;

  const tx = transcription?.transcription;
  const ix = intelligence?.intelligence;
  const output: IntelligenceOutput | null = intelligence?.output ?? null;
  return (
    <div className="space-y-6" data-testid="post-meeting-panel">
      <Card>
        <CardHeader><CardTitle>Post-meeting processing</CardTitle><CardDescription>Member reads are available after publication. Host actions are server-enforced and return 202 while work is queued.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-3"><span>Transcription</span><Badge variant="outline">{stateLabel(tx?.state)}</Badge>
            {isHost && !isLive(tx?.state) && tx?.state !== "complete" ? <Button size="sm" onClick={() => void runAction("start-tx", async () => { const result = await startTranscription(meetingId, recording.id); setTranscription(result.status); if (result.status.transcription && isLive(result.status.transcription.state)) scheduleRecovery(recording.id); })} disabled={busy !== null}>Start transcription</Button> : null}
            {isHost && isLive(tx?.state) ? <Button size="sm" variant="outline" onClick={() => void runAction("cancel-tx", async () => setTranscription((await cancelTranscription(meetingId, recording.id)).status))} disabled={busy !== null}>Cancel</Button> : null}
          </div>
          {tx?.errorCode ? <p className="text-sm text-destructive">Transcription: {tx.errorCode}</p> : null}
          <div className="flex flex-wrap items-center gap-3"><span>Intelligence</span><Badge variant="outline">{stateLabel(ix?.state)}</Badge>
            {isHost && tx?.state === "complete" && !isLive(ix?.state) && ix?.state !== "complete" ? <Button size="sm" onClick={() => void runAction("start-ix", async () => { const result = await startIntelligence(meetingId, recording.id); setIntelligence((current) => ({ state: result.status.state, intelligence: result.status, output: current?.output ?? null, suggestions: current?.suggestions ?? { proposed: 0, approved: 0, rejected: 0 } })); if (isLive(result.status.state)) scheduleRecovery(recording.id); })} disabled={busy !== null}>Start intelligence</Button> : null}
            {isHost && isLive(ix?.state) ? <Button size="sm" variant="outline" onClick={() => void runAction("cancel-ix", async () => { const result = await cancelIntelligence(meetingId, recording.id); setIntelligence((current) => current ? { ...current, state: result.status.state, intelligence: result.status, output: null } : null); })} disabled={busy !== null}>Cancel</Button> : null}
          </div>
          {ix?.errorCode ? <p className="text-sm text-destructive">Intelligence: {ix.errorCode}</p> : null}
        </CardContent>
      </Card>

      {output ? <Card><CardHeader><CardTitle>Meeting notes</CardTitle></CardHeader><CardContent className="space-y-4"><OutputGroup title="Summary and key points" entries={output.summaryBullets} /><OutputGroup title="Decisions" entries={output.decisions} /><OutputGroup title="Blockers" entries={output.blockers} /><OutputGroup title="Open questions" entries={output.unresolvedQuestions} /></CardContent></Card> : null}

      <Card><CardHeader><CardTitle>Transcript</CardTitle><CardDescription>{segments.length ? `${segments.length} published segments loaded` : "Published transcript segments appear here."}</CardDescription></CardHeader><CardContent className="space-y-2">{segments.map((segment) => <p key={`${segment.chunkIndex}:${segment.ordinal}`} className="text-sm"><span className="mr-2 text-muted-foreground">{segment.speakerLabel ?? "speaker"}</span>{segment.text}</p>)}{transcriptMore ? <Button variant="outline" onClick={loadMoreTranscript} disabled={busy !== null}>Load more transcript</Button> : null}</CardContent></Card>

      <Card><CardHeader><CardTitle>Action items</CardTitle><CardDescription>Owners are not selectable until the server supplies eligible meeting members. Approving here confirms unassigned ownership.</CardDescription></CardHeader><CardContent className="space-y-4">{items.map((item) => <ActionItemRow key={item.id} item={item} edit={edits[item.id] ?? item.proposal.title} setEdit={(value) => setEdits((current) => ({ ...current, [item.id]: value }))} busy={busy !== null} onAction={(action) => void runAction(`item-${item.id}`, async () => { try { const result = await reviewActionItem(meetingId, item, action, { title: edits[item.id] ?? item.proposal.title }); setItems((current) => current.map((row) => row.id === item.id ? result.item : row)); } catch (err) { if (err instanceof ApiError && err.code === "VERSION_CONFLICT") await readArtifacts(recording.id, false); throw err; } })} onTask={() => void runAction(`task-${item.id}`, async () => { const result = await createActionTask(meetingId, item); setTaskNotice(`${result.resumed ? "Resumed" : "Created"} task: ${result.task.title}`); setItems((current) => current.map((row) => row.id === item.id ? result.item : row)); })} />)}{itemsMore ? <Button variant="outline" onClick={loadMoreItems} disabled={busy !== null}>Load more action items</Button> : null}{!items.length ? <p className="text-sm text-muted-foreground">No published action items.</p> : null}{taskNotice ? <p role="status" className="text-sm">{taskNotice}</p> : null}</CardContent></Card>
    </div>
  );
}

function OutputGroup({ title, entries }: { title: string; entries: { text: string; evidence: { segmentIds: string[] } }[] }) {
  if (!entries.length) return null;
  return <section><h3 className="font-medium">{title}</h3><ul className="list-disc space-y-1 pl-5 text-sm">{entries.map((entry, index) => <li key={`${title}-${index}`}>{entry.text}<span className="ml-2 text-xs text-muted-foreground">{evidenceLabel(entry.evidence.segmentIds)}</span></li>)}</ul></section>;
}

function ActionItemRow({ item, edit, setEdit, busy, onAction, onTask }: { item: ActionItem; edit: string; setEdit: (value: string) => void; busy: boolean; onAction: (action: "approve" | "edit" | "reject") => void; onTask: () => void }) {
  return <div className="space-y-2 rounded-md border p-3"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{item.state}</Badge><span className="font-medium">{item.proposal.title}</span></div><p className="text-sm text-muted-foreground">{item.proposal.detail || "No detail provided."}</p><p className="text-xs text-muted-foreground">{evidenceLabel(item.evidence.segmentIds)}</p>{item.state === "proposed" ? <><Input value={edit} onChange={(event) => setEdit(event.target.value)} aria-label={`Edit ${item.proposal.title}`} /><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => onAction("approve")} disabled={busy}>Approve unassigned</Button><Button size="sm" variant="outline" onClick={() => onAction("edit")} disabled={busy}>Save edit</Button><Button size="sm" variant="ghost" onClick={() => onAction("reject")} disabled={busy}>Reject</Button></div></> : null}{item.state === "approved" && item.task.status !== "created" ? <Button size="sm" onClick={onTask} disabled={busy}>Create task</Button> : null}{item.task.status === "created" ? <p className="text-sm" role="status">Task created: {item.task.taskId ?? "returned by server"}</p> : null}</div>;
}
