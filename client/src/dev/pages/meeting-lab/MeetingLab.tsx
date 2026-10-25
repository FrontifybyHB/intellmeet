// Meeting Lab (contract test screen, dev only).
//
// Exercises every backend contract from §7 — join/token view, LiveKit room
// state, device toggles, screen share, socket chat/presence/hand/reaction,
// host recording + end, AI timeline, and a request/error panel. Secrets are
// never printed: only token expiry + permissions are shown.
//
// The screen is the single owner of the lab's room and socket; the panels
// below it are presentational and never open a connection themselves.

import { useCallback, useState } from "react";

import { apiFetch } from "@/shared/api/client";
import { ChatPanel } from "@/dev/pages/meeting-lab/ChatPanel";
import { ConsentPanel, type HostAction } from "@/dev/pages/meeting-lab/ConsentPanel";
import { MeetingControls } from "@/dev/pages/meeting-lab/MeetingControls";
import { RequestLogPanel } from "@/dev/pages/meeting-lab/RequestLogPanel";
import {
  appendRequestLog,
  requestLogEntry,
  type RequestLog,
} from "@/dev/pages/meeting-lab/requestLog";
import { useParticipantMedia } from "@/dev/pages/meeting-lab/useParticipantMedia";
import { useMeetingRoom } from "@/dev/pages/meeting-lab/useMeetingRoom";
import { useMeetingSocket } from "@/dev/pages/meeting-lab/useMeetingSocket";

interface JoinResponse {
  roomName: string;
  livekitUrl: string;
  token: string;
  permissions: { isHost: boolean; canRecord: boolean; canScreenShare: boolean };
}

export function MeetingLab({ initialMeetingId }: { initialMeetingId?: string }) {
  const [meetingId, setMeetingId] = useState(initialMeetingId || "");
  const [join, setJoin] = useState<JoinResponse | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [chatText, setChatText] = useState("");
  const [log, setLog] = useState<RequestLog>([]);
  // The socket publishes the live payload; the HTTP read below fills the
  // panel when no socket event has arrived yet.
  const [fetchedAiStatus, setFetchedAiStatus] = useState<object | null>(null);

  const record = useCallback((method: string, path: string, err: unknown) => {
    setLog((current) => appendRequestLog(current, requestLogEntry(method, path, err)));
  }, []);

  const room = useMeetingRoom();
  const media = useParticipantMedia(room.room);
  const socket = useMeetingSocket((message) => setDeviceError(message));

  const doJoin = useCallback(async () => {
    setDeviceError(null);
    try {
      const body = await apiFetch<JoinResponse>(`/meetings/${meetingId}/join`, {
        method: "POST",
        body: {},
      });
      setJoin(body);
    } catch (err) {
      record("POST", `/meetings/${meetingId}/join`, err);
    }
  }, [meetingId, record]);

  const connectRoom = useCallback(async () => {
    if (!join) return;
    try {
      await room.connect(join.livekitUrl, join.token);
    } catch (err) {
      setDeviceError(
        err instanceof Error ? err.message : "LiveKit connect failed (needs server + media perms).",
      );
      record("LIVEKIT", "room.connect", err);
    }
  }, [join, record, room]);

  const joinSocketRoom = useCallback(() => {
    socket.joinRoom(meetingId);
  }, [meetingId, socket]);

  const sendChat = useCallback(() => {
    if (!chatText.trim()) return;
    socket.sendChat(meetingId, chatText);
    setChatText("");
  }, [chatText, meetingId, socket]);

  const hostAction = useCallback(
    async (kind: HostAction) => {
      try {
        if (kind === "consent") {
          await apiFetch(`/meetings/${meetingId}/recording-consent`, {
            method: "POST",
            body: { decision: "approved", noticeVersion: "v1", aiTransfer: "approved" },
          });
        } else if (kind === "start") {
          await apiFetch(`/meetings/${meetingId}/recordings/start`, { method: "POST", body: {} });
        } else if (kind === "end") {
          await apiFetch(`/meetings/${meetingId}/end`, { method: "POST", body: {} });
        } else if (kind === "intelligence") {
          const recs = await apiFetch<{ recordings: { id: string }[] }>(
            `/meetings/${meetingId}/recordings`,
          );
          const rid = recs.recordings?.[0]?.id;
          if (!rid) throw new Error("no recording yet");
          await apiFetch<object>(`/meetings/${meetingId}/recordings/${rid}/intelligence`, {
            method: "POST",
            body: {},
          });
          const status = await apiFetch<object>(
            `/meetings/${meetingId}/recordings/${rid}/intelligence`,
          );
          setFetchedAiStatus(status);
        }
      } catch (err) {
        record("POST", kind, err);
      }
    },
    [meetingId, record],
  );

  return (
    <div className="space-y-4">
      <h2>Meeting Lab (contract test screen)</h2>
      {deviceError && <p role="alert">{deviceError}</p>}
      <section>
        <label>
          Meeting ID{" "}
          <input
            data-testid="meeting-id"
            value={meetingId}
            onChange={(event) => setMeetingId(event.target.value)}
          />
        </label>
        <button type="button" data-testid="join-btn" onClick={() => void doJoin()}>
          POST /join
        </button>
        <button type="button" onClick={() => void connectRoom()} disabled={!join}>
          LiveKit connect
        </button>
        <button type="button" onClick={() => void room.disconnect()}>
          Leave
        </button>
      </section>
      {join && (
        <section data-testid="token-view">
          <p>Room: {join.roomName}</p>
          <p>
            Host: {String(join.permissions.isHost)} · Record: {String(join.permissions.canRecord)} ·
            Share: {String(join.permissions.canScreenShare)}
          </p>
          <p>Token: issued (expiry enforced server-side; secret never exposed)</p>
        </section>
      )}
      <MeetingControls roomState={room.state} participants={room.participants} media={media} />
      <ChatPanel
        socketState={socket.state}
        messages={socket.messages}
        presence={socket.presence}
        chatText={chatText}
        onChatTextChange={setChatText}
        onConnect={socket.connect}
        onJoinRoom={joinSocketRoom}
        onSend={sendChat}
        onRaiseHand={() => socket.raiseHand(meetingId)}
        onReact={() => socket.sendReaction(meetingId, "👍")}
      />
      <ConsentPanel
        aiStatus={socket.aiStatus ?? fetchedAiStatus}
        onHostAction={(action) => void hostAction(action)}
      />
      <RequestLogPanel log={log} />
    </div>
  );
}
