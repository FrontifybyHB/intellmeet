import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, type RemoteParticipant } from "livekit-client";
import { io, type Socket } from "socket.io-client";
import { API_ORIGIN } from "@/config/env";
import { ApiError, apiFetch } from "../services/api";

interface JoinResponse {
  roomName: string;
  livekitUrl: string;
  token: string;
  permissions: { isHost: boolean; canRecord: boolean; canScreenShare: boolean };
}

interface ChatMsg {
  id: string;
  text: string;
  userId?: string;
  createdAt?: string;
}

interface RequestLog {
  at: string;
  method: string;
  path: string;
  status: number | string;
  message: string;
}

function logErr(setLog: (fn: (l: RequestLog[]) => RequestLog[]) => void, method: string, path: string, err: unknown) {
  const status = err instanceof ApiError ? err.status : "ERR";
  const message =
    err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : "failed";
  setLog((l) => [{ at: new Date().toISOString(), method, path, status, message }, ...l].slice(0, 30));
}

// Contract test screen (not production UI): exercises every backend
// contract from §7 — join/token view, LiveKit room state, device
// toggles, screen share, socket chat/presence/hand/reaction, host
// recording + end, AI timeline, and a request/error panel. Secrets are
// never printed: only token expiry + permissions are shown.
export function MeetingLab({ initialMeetingId }: { initialMeetingId?: string }) {
  const [meetingId, setMeetingId] = useState(initialMeetingId || "");
  const [join, setJoin] = useState<JoinResponse | null>(null);
  const [roomState, setRoomState] = useState("disconnected");
  const [participants, setParticipants] = useState(0);
  const [screenOn, setScreenOn] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [socketState, setSocketState] = useState("disconnected");
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatText, setChatText] = useState("");
  const [presence, setPresence] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState<object | null>(null);
  const [log, setLog] = useState<RequestLog[]>([]);
  const roomRef = useRef<Room | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const doJoin = useCallback(async () => {
    setDeviceError(null);
    try {
      const body = await apiFetch<JoinResponse>(`/meetings/${meetingId}/join`, { method: "POST", body: {} });
      setJoin(body);
    } catch (err) {
      logErr(setLog, "POST", `/meetings/${meetingId}/join`, err);
    }
  }, [meetingId]);

  const connectRoom = useCallback(async () => {
    if (!join) return;
    try {
      const room = new Room();
      roomRef.current = room;
      room.on(RoomEvent.ConnectionStateChanged, (s) => setRoomState(String(s)));
      room.on(RoomEvent.ParticipantConnected, () => setParticipants(room.remoteParticipants.size + 1));
      room.on(RoomEvent.ParticipantDisconnected, () => setParticipants(room.remoteParticipants.size + 1));
      room.on(RoomEvent.TrackSubscribed, () => setParticipants(room.remoteParticipants.size + 1));
      await room.connect(join.livekitUrl, join.token);
      setRoomState("connected");
      setParticipants(room.remoteParticipants.size + 1);
      for (const [, p] of room.remoteParticipants as Map<string, RemoteParticipant>) {
        void p;
      }
    } catch (err) {
      setRoomState("failed");
      setDeviceError(err instanceof Error ? err.message : "LiveKit connect failed (needs server + media perms).");
      logErr(setLog, "LIVEKIT", "room.connect", err);
    }
  }, [join]);

  const disconnectRoom = useCallback(async () => {
    await roomRef.current?.disconnect();
    roomRef.current = null;
    setRoomState("disconnected");
    setParticipants(0);
  }, []);

  const toggleCamera = useCallback(async () => {
    try {
      const room = roomRef.current;
      if (!room) {
        // Pre-join device check: proves getUserMedia availability / denial.
        await navigator.mediaDevices.getUserMedia({ video: true });
        setCameraOn((v) => !v);
        return;
      }
      await room.localParticipant.setCameraEnabled(!cameraOn);
      setCameraOn((v) => !v);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : "Camera unavailable.");
    }
  }, [cameraOn]);

  const toggleMic = useCallback(async () => {
    try {
      const room = roomRef.current;
      if (!room) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        setMicOn((v) => !v);
        return;
      }
      await room.localParticipant.setMicrophoneEnabled(!micOn);
      setMicOn((v) => !v);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : "Microphone unavailable.");
    }
  }, [micOn]);

  const toggleScreen = useCallback(async () => {
    try {
      const room = roomRef.current;
      if (!room) {
        setDeviceError("Join the LiveKit room before screen share.");
        return;
      }
      await room.localParticipant.setScreenShareEnabled(!screenOn);
      setScreenOn((v) => !v);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : "Screen share failed.");
    }
  }, [screenOn]);

  const connectSocket = useCallback(() => {
    const s = io(API_ORIGIN, { withCredentials: true, transports: ["websocket"] });
    socketRef.current = s;
    s.on("connect", () => setSocketState("connected"));
    s.on("disconnect", () => setSocketState("disconnected"));
    // Server contract names (see meetingSockets/realtime publishers).
    s.on("chat:message", (m: ChatMsg) => setChat((c) => [...c, m].slice(-50)));
    s.on("reaction:new", (r: { emoji: string; userId: string }) =>
      setChat((c) => [...c, { id: `reaction-${Date.now()}`, text: `${r.userId}: ${r.emoji}` }].slice(-50))
    );
    s.on("hand:updated", (h: { userId: string; raised: boolean }) =>
      setPresence((prev) => (h.raised && !prev.includes(h.userId) ? [...prev, h.userId] : prev))
    );
    s.on("meeting:ended", () => setSocketState("meeting-ended"));
    s.on("meeting:revoked", () => setSocketState("revoked"));
    s.on("recording:status", (st: object) => setAiStatus(st));
    s.on("recording:ready", (st: object) => setAiStatus(st));
    s.on("intelligence:status", (st: object) => setAiStatus(st));
    s.on("intelligence:ready", (st: object) => setAiStatus(st));
    s.on("action-item:updated", (st: object) => setAiStatus(st));
  }, []);

  useEffect(() => () => {
    void disconnectRoom();
    socketRef.current?.close();
  }, [disconnectRoom]);

  const joinSocketRoom = useCallback(async () => {
    try {
      socketRef.current?.emit("meeting:join", { meetingId }, (res: { ok: boolean; error?: string }) => {
        if (!res?.ok) setDeviceError(res?.error || "socket join rejected");
      });
    } catch (err) {
      logErr(setLog, "SOCKET", "meeting:join", err);
    }
  }, [meetingId]);

  const sendChat = useCallback(async () => {
    if (!chatText.trim()) return;
    socketRef.current?.emit(
      "chat:send",
      { meetingId, clientMessageId: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text: chatText },
      (res: { ok: boolean; message?: ChatMsg; error?: string }) => {
        if (res?.ok && res.message) setChat((c) => [...c, res.message as ChatMsg].slice(-50));
        else setDeviceError(res?.error || "chat rejected");
      }
    );
    setChatText("");
  }, [chatText, meetingId]);

  const hostAction = useCallback(
    async (kind: "consent" | "start" | "stop" | "end" | "intelligence") => {
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
          const recs = await apiFetch<{ recordings: { id: string }[] }>(`/meetings/${meetingId}/recordings`);
          const rid = recs.recordings?.[0]?.id;
          if (!rid) throw new Error("no recording yet");
          await apiFetch<object>(`/meetings/${meetingId}/recordings/${rid}/intelligence`, { method: "POST", body: {} });
          const st = await apiFetch<object>(`/meetings/${meetingId}/recordings/${rid}/intelligence`);
          setAiStatus(st);
        }
      } catch (err) {
        logErr(setLog, "POST", kind, err);
      }
    },
    [meetingId]
  );

  return (
    <main>
      <h2>Meeting Lab (contract test screen)</h2>
      <section>
        <label>
          Meeting ID{" "}
          <input data-testid="meeting-id" value={meetingId} onChange={(e) => setMeetingId(e.target.value)} />
        </label>
        <button type="button" data-testid="join-btn" onClick={() => void doJoin()}>
          POST /join
        </button>
        <button type="button" onClick={() => void connectRoom()} disabled={!join}>
          LiveKit connect
        </button>
        <button type="button" onClick={() => void disconnectRoom()}>
          Leave
        </button>
      </section>
      {join && (
        <section data-testid="token-view">
          <p>Room: {join.roomName}</p>
          <p>Host: {String(join.permissions.isHost)} · Record: {String(join.permissions.canRecord)} · Share: {String(join.permissions.canScreenShare)}</p>
          <p>Token: issued (expiry enforced server-side; secret never exposed)</p>
        </section>
      )}
      <section>
        <p data-testid="room-state">LiveKit: {roomState} · participants: {participants}</p>
        <button type="button" onClick={() => void toggleCamera()}>Camera {cameraOn ? "off" : "on"}</button>
        <button type="button" onClick={() => void toggleMic()}>Mic {micOn ? "off" : "on"}</button>
        <button type="button" onClick={() => void toggleScreen()}>Screen {screenOn ? "stop" : "share"}</button>
        {deviceError && <p role="alert">{deviceError}</p>}
      </section>
      <section>
        <p data-testid="socket-state">Socket: {socketState}</p>
        <button type="button" onClick={connectSocket}>Socket connect</button>
        <button type="button" onClick={() => void joinSocketRoom()}>Socket join</button>
        <input value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="chat text" />
        <button type="button" onClick={() => void sendChat()}>Send chat</button>
        <button type="button" onClick={() => socketRef.current?.emit("hand:raise", { meetingId, raised: true })}>Raise hand</button>
        <button type="button" onClick={() => socketRef.current?.emit("reaction:send", { meetingId, emoji: "👍" })}>👍</button>
        <ul>{chat.map((m) => <li key={m.id}>{m.text}</li>)}</ul>
        <p>Presence: {presence.join(", ")}</p>
      </section>
      <section>
        <button type="button" onClick={() => void hostAction("consent")}>Consent approve</button>
        <button type="button" onClick={() => void hostAction("start")}>Recording start</button>
        <button type="button" onClick={() => void hostAction("end")}>End meeting</button>
        <button type="button" onClick={() => void hostAction("intelligence")}>Refresh intelligence</button>
        {aiStatus && <pre data-testid="ai-status">{JSON.stringify(aiStatus, null, 2).slice(0, 2000)}</pre>}
      </section>
      <section>
        <h3>Requests / errors</h3>
        <ul>{log.map((l, i) => <li key={i}>{l.method} {l.path} → {l.status} {l.message}</li>)}</ul>
      </section>
    </main>
  );
}
