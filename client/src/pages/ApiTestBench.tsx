import { useRef, useState } from "react";
import { Room } from "livekit-client";
import { io, type Socket } from "socket.io-client";
import { API_ORIGIN } from "@/config/env";
import { ApiError, apiFetch } from "../services/api";

function show(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function useOut() {
  const [out, setOut] = useState("Not run yet.");
  const run = async (fn: () => Promise<unknown>) => {
    setOut("Loading...");
    try {
      const r = await fn();
      setOut(show(r));
    } catch (e) {
      setOut(e instanceof ApiError ? `ERROR ${e.status} ${e.code}: ${e.message}` : `ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return [out, run] as const;
}

// Raw skeleton test bench for every backend API. No styling on
// purpose. All calls go through the shared apiFetch/API_ORIGIN config
// (VITE_API_URL override; same-origin proxy by default).
export function ApiTestBench() {
  // shared ids
  const [meetingId, setMeetingId] = useState("");
  const [recordingId, setRecordingId] = useState("");
  const [itemId, setItemId] = useState("");
  const [cursor, setCursor] = useState("");
  const [limit, setLimit] = useState("20");

  // auth inputs
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // consent inputs
  const [decision, setDecision] = useState("approved");
  const [noticeVersion, setNoticeVersion] = useState("v1");
  const [aiTransfer, setAiTransfer] = useState("approved");

  // review inputs
  const [reviewAction, setReviewAction] = useState("approve");
  const [reviewVersion, setReviewVersion] = useState("0");
  const [reviewTitle, setReviewTitle] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");

  // chat inputs
  const [chatText, setChatText] = useState("hello");
  const [clientMessageId, setClientMessageId] = useState("test-1");
  const [emoji, setEmoji] = useState("👍");

  // create inputs
  const [newTitle, setNewTitle] = useState("demo meeting");
  const [admitUserId, setAdmitUserId] = useState("");
  const [joinCode, setJoinCode] = useState("");

  const [healthOut, healthRun] = useOut();
  const [manageOut, manageRun] = useOut();
  const [authOut, authRun] = useOut();
  const [historyOut, historyRun] = useOut();
  const [joinOut, joinRun] = useOut();
  const [msgOut, msgRun] = useOut();
  const [consentOut, consentRun] = useOut();
  const [recOut, recRun] = useOut();
  const [endOut, endRun] = useOut();
  const [txOut, txRun] = useOut();
  const [ixOut, ixRun] = useOut();
  const [labOut, labRun] = useOut();

  // sockets
  const sockRef = useRef<Socket | null>(null);
  const [sockState, setSockState] = useState("disconnected");
  const [sockLog, setSockLog] = useState<string[]>([]);
  const slog = (s: string) => setSockLog((l) => [`${new Date().toISOString()} ${s}`, ...l].slice(0, 50));

  // livekit
  const roomRef = useRef<Room | null>(null);
  const [lkState, setLkState] = useState("disconnected");
  const [lkInfo, setLkInfo] = useState("Not connected.");

  const qs = (extra = "") => {
    const p = new URLSearchParams();
    if (cursor) p.set("cursor", cursor);
    if (limit) p.set("limit", limit);
    const q = p.toString();
    return (q ? `?${q}` : "") + extra;
  };

  return (
    <div className="space-y-4">
      <h1>API Test Bench (raw)</h1>
      <div>
        <label>meetingId <input value={meetingId} onChange={(e) => setMeetingId(e.target.value)} size={30} /></label>
        <label> recordingId <input value={recordingId} onChange={(e) => setRecordingId(e.target.value)} size={30} /></label>
        <label> itemId <input value={itemId} onChange={(e) => setItemId(e.target.value)} size={30} /></label>
        <label> cursor <input value={cursor} onChange={(e) => setCursor(e.target.value)} size={20} /></label>
        <label> limit <input value={limit} onChange={(e) => setLimit(e.target.value)} size={5} /></label>
      </div>
      <hr />

      <section>
        <h2>Health</h2>
        <button onClick={() => void healthRun(() => apiFetch("/health"))}>GET /api/health</button>
        <pre>{healthOut}</pre>
      </section>
      <hr />

      <section>
        <h2>Meetings: create + admit (start here)</h2>
        <div>
          <label>title <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} /></label>
          <label> admit userId <input value={admitUserId} onChange={(e) => setAdmitUserId(e.target.value)} size={30} /></label>
        </div>
        <div>
          <button onClick={() => void manageRun(() => apiFetch("/meetings", { method: "POST", body: { title: newTitle } }))}>POST create meeting</button>
          <button onClick={() => void manageRun(() => apiFetch(`/meetings/${meetingId}/members`, { method: "POST", body: { userId: admitUserId } }))}>POST admit member</button>
        </div>
        <p>Copy the returned id into meetingId above, share it, admit the other user by their id (from /auth/me), then they join.</p>
        <div>
          <label>joinCode <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} size={30} /></label>
          <button onClick={() => void manageRun(() => apiFetch(`/meeting-links/${joinCode}`))}>GET resolve link</button>
          <button onClick={() => void manageRun(() => apiFetch(`/meeting-links/${joinCode}/join`, { method: "POST", body: {} }))}>POST link join</button>
        </div>
        <pre>{manageOut}</pre>
      </section>
      <hr />

      <section>
        <h2>Auth (/api/auth)</h2>
        <div>
          <label>name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label> email <input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label> password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label> newPassword <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></label>
        </div>
        <div>
          <button onClick={() => void authRun(() => apiFetch("/auth/register", { method: "POST", body: { name, email, password } }))}>POST register</button>
          <button onClick={() => void authRun(() => apiFetch("/auth/login", { method: "POST", body: { email, password } }))}>POST login</button>
          <button onClick={() => void authRun(() => apiFetch("/auth/me"))}>GET me</button>
          <button onClick={() => void authRun(() => apiFetch("/auth/csrf"))}>GET csrf</button>
          <button onClick={() => void authRun(() => apiFetch("/auth/refresh", { method: "POST", body: {} }))}>POST refresh</button>
          <button onClick={() => void authRun(() => apiFetch("/auth/logout", { method: "POST", body: {} }))}>POST logout</button>
          <button onClick={() => void authRun(() => apiFetch("/auth/logout-all", { method: "POST", body: {} }))}>POST logout-all</button>
          <button onClick={() => void authRun(() => apiFetch("/auth/change-password", { method: "PATCH", body: { currentPassword: password, newPassword } }))}>PATCH change-password</button>
        </div>
        <pre>{authOut}</pre>
      </section>
      <hr />

      <section>
        <h2>History (/api/meetings)</h2>
        <button onClick={() => void historyRun(() => apiFetch(`/meetings${qs()}`))}>GET list</button>
        <button onClick={() => void historyRun(() => apiFetch(`/meetings/${meetingId}`))}>GET detail</button>
        <pre>{historyOut}</pre>
      </section>
      <hr />

      <section>
        <h2>Join</h2>
        <button onClick={() => void joinRun(() => apiFetch(`/meetings/${meetingId}/join`, { method: "POST", body: {} }))}>POST /:id/join</button>
        <pre>{joinOut}</pre>
      </section>
      <hr />

      <section>
        <h2>Messages</h2>
        <div>
          <label>text <input value={chatText} onChange={(e) => setChatText(e.target.value)} /></label>
          <label> clientMessageId <input value={clientMessageId} onChange={(e) => setClientMessageId(e.target.value)} /></label>
        </div>
        <button onClick={() => void msgRun(() => apiFetch(`/meetings/${meetingId}/messages${qs()}`))}>GET messages</button>
        <pre>{msgOut}</pre>
      </section>
      <hr />

      <section>
        <h2>Consent</h2>
        <div>
          <label>decision <input value={decision} onChange={(e) => setDecision(e.target.value)} /></label>
          <label> noticeVersion <input value={noticeVersion} onChange={(e) => setNoticeVersion(e.target.value)} /></label>
          <label> aiTransfer <input value={aiTransfer} onChange={(e) => setAiTransfer(e.target.value)} /></label>
        </div>
        <button onClick={() => void consentRun(() => apiFetch(`/meetings/${meetingId}/recording-consent`, { method: "POST", body: { decision, noticeVersion, aiTransfer } }))}>POST consent</button>
        <button onClick={() => void consentRun(() => apiFetch(`/meetings/${meetingId}/recording-consent`))}>GET consent</button>
        <pre>{consentOut}</pre>
      </section>
      <hr />

      <section>
        <h2>Recordings</h2>
        <button onClick={() => void recRun(() => apiFetch(`/meetings/${meetingId}/recordings/start`, { method: "POST", body: {} }))}>POST start</button>
        <button onClick={() => void recRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}/stop`, { method: "POST", body: {} }))}>POST stop</button>
        <button onClick={() => void recRun(() => apiFetch(`/meetings/${meetingId}/recordings`))}>GET list</button>
        <button onClick={() => void recRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}`))}>GET one</button>
        <button onClick={() => void recRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}/url`))}>GET url</button>
        <pre>{recOut}</pre>
      </section>
      <hr />

      <section>
        <h2>End meeting</h2>
        <button onClick={() => void endRun(() => apiFetch(`/meetings/${meetingId}/end`, { method: "POST", body: {} }))}>POST /:id/end</button>
        <pre>{endOut}</pre>
      </section>
      <hr />

      <section>
        <h2>Transcription</h2>
        <button onClick={() => void txRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}/transcription`, { method: "POST", body: {} }))}>POST start</button>
        <button onClick={() => void txRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}/transcription`))}>GET status</button>
        <button onClick={() => void txRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}/transcript${qs()}`))}>GET transcript</button>
        <button onClick={() => void txRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}/transcription`, { method: "DELETE" }))}>DELETE cancel</button>
        <pre>{txOut}</pre>
      </section>
      <hr />

      <section>
        <h2>Intelligence + action items + tasks</h2>
        <div>
          <label>action <input value={reviewAction} onChange={(e) => setReviewAction(e.target.value)} /></label>
          <label> version <input value={reviewVersion} onChange={(e) => setReviewVersion(e.target.value)} /></label>
          <label> title <input value={reviewTitle} onChange={(e) => setReviewTitle(e.target.value)} /></label>
          <label> ownerUserId <input value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)} /></label>
        </div>
        <div>
          <button onClick={() => void ixRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}/intelligence`, { method: "POST", body: {} }))}>POST start ix</button>
          <button onClick={() => void ixRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}/intelligence`))}>GET ix status</button>
          <button onClick={() => void ixRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}/intelligence`, { method: "DELETE" }))}>DELETE ix cancel</button>
          <button onClick={() => void ixRun(() => apiFetch(`/meetings/${meetingId}/recordings/${recordingId}/action-items${qs()}`))}>GET action-items</button>
          <button onClick={() => void ixRun(() => apiFetch(`/meetings/${meetingId}/action-items/${itemId}`, { method: "PATCH", body: { action: reviewAction, version: Number(reviewVersion), ...(reviewTitle ? { title: reviewTitle } : {}), ...(ownerUserId ? { ownerUserId } : { confirmUnassigned: true }) } }))}>PATCH review item</button>
          <button onClick={() => void ixRun(() => apiFetch(`/meetings/${meetingId}/action-items/${itemId}/task`, { method: "POST", body: {} }))}>POST create task</button>
        </div>
        <pre>{ixOut}</pre>
      </section>
      <hr />

      <section>
        <h2>Dev lab</h2>
        <button onClick={() => void labRun(() => fetch(`${API_ORIGIN}/dev/meeting-lab`, { credentials: "include" }).then((r) => r.json()))}>GET /dev/meeting-lab</button>
        <pre>{labOut}</pre>
      </section>
      <hr />

      <section>
        <h2>Sockets (app events)</h2>
        <p>State: {sockState}</p>
        <div>
          <label>
            emoji <input value={emoji} onChange={(e) => setEmoji(e.target.value)} size={4} />
          </label>
          <button onClick={() => {
            const s = io(API_ORIGIN, { withCredentials: true, transports: ["websocket"] });
            sockRef.current = s;
            s.on("connect", () => { setSockState("connected"); slog("connected"); });
            s.on("disconnect", () => { setSockState("disconnected"); slog("disconnected"); });
            for (const ev of ["chat:message", "reaction:new", "hand:updated", "meeting:ended", "meeting:revoked", "recording:status", "recording:ready", "intelligence:status", "intelligence:ready", "action-item:updated"]) {
              s.on(ev, (p: unknown) => slog(`${ev} ${show(p).slice(0, 300)}`));
            }
          }}>connect</button>
          <button onClick={() => { sockRef.current?.close(); sockRef.current = null; }}>disconnect</button>
          <button onClick={() => sockRef.current?.emit("meeting:join", { meetingId }, (r: unknown) => slog(`join-ack ${show(r).slice(0, 300)}`))}>emit meeting:join</button>
          <button onClick={() => sockRef.current?.emit("meeting:leave", { meetingId }, (r: unknown) => slog(`leave-ack ${show(r).slice(0, 300)}`))}>emit meeting:leave</button>
          <button onClick={() => sockRef.current?.emit("chat:send", { meetingId, clientMessageId, text: chatText }, (r: unknown) => slog(`chat-ack ${show(r).slice(0, 300)}`))}>emit chat:send</button>
          <button onClick={() => sockRef.current?.emit("reaction:send", { meetingId, emoji }, (r: unknown) => slog(`reaction-ack ${show(r).slice(0, 300)}`))}>emit reaction:send</button>
          <button onClick={() => sockRef.current?.emit("hand:raise", { meetingId, raised: true }, (r: unknown) => slog(`hand-ack ${show(r).slice(0, 300)}`))}>emit hand:raise</button>
        </div>
        <ul>{sockLog.map((l, i) => <li key={i}><pre>{l}</pre></li>)}</ul>
      </section>
      <hr />

      <section>
        <h2>LiveKit (media)</h2>
        <p>State: {lkState}</p>
        <div>
          <button onClick={() => void (async () => {
            try {
              const j = await apiFetch<{ livekitUrl: string; token: string }>(`/meetings/${meetingId}/join`, { method: "POST", body: {} });
              const room = new Room();
              roomRef.current = room;
              await room.connect(j.livekitUrl, j.token);
              setLkState("connected");
              setLkInfo(`room participants: ${room.remoteParticipants.size + 1}`);
            } catch (e) {
              setLkState("failed");
              setLkInfo(e instanceof Error ? e.message : String(e));
            }
          })()}>connect with join token</button>
          <button onClick={() => void (async () => { await roomRef.current?.disconnect(); roomRef.current = null; setLkState("disconnected"); })()}>disconnect</button>
          <button onClick={() => void (async () => { try { await roomRef.current?.localParticipant.setCameraEnabled(true); setLkInfo("camera enabled"); } catch (e) { setLkInfo(e instanceof Error ? e.message : String(e)); } })()}>camera on</button>
          <button onClick={() => void (async () => { try { await roomRef.current?.localParticipant.setMicrophoneEnabled(true); setLkInfo("mic enabled"); } catch (e) { setLkInfo(e instanceof Error ? e.message : String(e)); } })()}>mic on</button>
          <button onClick={() => void (async () => { try { await roomRef.current?.localParticipant.setScreenShareEnabled(true); setLkInfo("screen on"); } catch (e) { setLkInfo(e instanceof Error ? e.message : String(e)); } })()}>screen on</button>
        </div>
        <pre>{lkInfo}</pre>
      </section>
    </div>
  );
}
