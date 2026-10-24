// Socket.IO console for the API test bench (dev only).
//
// Owns its own socket and closes it on unmount. The bench is a raw harness:
// every emit is sent on demand and every event is logged verbatim.

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { API_ORIGIN } from "@/shared/config/env";

const WATCHED_EVENTS = [
  "chat:message",
  "reaction:new",
  "hand:updated",
  "meeting:ended",
  "meeting:revoked",
  "recording:status",
  "recording:ready",
  "intelligence:status",
  "intelligence:ready",
  "action-item:updated",
];

function show(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function SocketConsole({
  meetingId,
  chatText,
  clientMessageId,
}: {
  meetingId: string;
  chatText: string;
  clientMessageId: string;
}) {
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState("disconnected");
  const [log, setLog] = useState<string[]>([]);
  const [emoji, setEmoji] = useState("👍");

  const slog = (line: string) =>
    setLog((current) => [`${new Date().toISOString()} ${line}`, ...current].slice(0, 50));

  useEffect(
    () => () => {
      socketRef.current?.close();
      socketRef.current = null;
    },
    [],
  );

  const connect = () => {
    const socket = io(API_ORIGIN, { withCredentials: true, transports: ["websocket"] });
    socketRef.current = socket;
    socket.on("connect", () => {
      setState("connected");
      slog("connected");
    });
    socket.on("disconnect", () => {
      setState("disconnected");
      slog("disconnected");
    });
    for (const event of WATCHED_EVENTS) {
      socket.on(event, (payload: unknown) => slog(`${event} ${show(payload).slice(0, 300)}`));
    }
  };

  const disconnect = () => {
    socketRef.current?.close();
    socketRef.current = null;
  };

  const emit = (event: string, payload: unknown) => {
    socketRef.current?.emit(event, payload, (result: unknown) =>
      slog(`${event}-ack ${show(result).slice(0, 300)}`),
    );
  };

  return (
    <section>
      <h2>Sockets (app events)</h2>
      <p>State: {state}</p>
      <div>
        <label>
          emoji <input value={emoji} onChange={(event) => setEmoji(event.target.value)} size={4} />
        </label>
        <button type="button" onClick={connect}>
          connect
        </button>
        <button type="button" onClick={disconnect}>
          disconnect
        </button>
        <button
          type="button"
          onClick={() => emit("meeting:join", { meetingId })}
        >
          emit meeting:join
        </button>
        <button
          type="button"
          onClick={() => emit("meeting:leave", { meetingId })}
        >
          emit meeting:leave
        </button>
        <button
          type="button"
          onClick={() => emit("chat:send", { meetingId, clientMessageId, text: chatText })}
        >
          emit chat:send
        </button>
        <button type="button" onClick={() => emit("reaction:send", { meetingId, emoji })}>
          emit reaction:send
        </button>
        <button type="button" onClick={() => emit("hand:raise", { meetingId, raised: true })}>
          emit hand:raise
        </button>
      </div>
      <ul>
        {log.map((line, index) => (
          <li key={index}>
            <pre>{line}</pre>
          </li>
        ))}
      </ul>
    </section>
  );
}
