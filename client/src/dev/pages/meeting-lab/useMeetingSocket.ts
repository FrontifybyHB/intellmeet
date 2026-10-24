// Socket.IO ownership for the contract lab.
//
// One hook owns one socket for the whole screen: it connects, joins the
// meeting room, and is closed on unmount. The chat panel and the consent
// panel consume the events through props, so no consumer can open a second
// connection and race the first one for the same room.
//
// This is dev-only code: the product meeting surface owns its session through
// the product realtime client (src/shared/realtime/meetingSocket.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { API_ORIGIN } from "@/shared/config/env";

export interface ChatMessage {
  id: string;
  text: string;
  userId?: string;
  createdAt?: string;
}

export type SocketState =
  | "disconnected"
  | "connected"
  | "meeting-ended"
  | "revoked";

export interface MeetingSocketController {
  state: SocketState;
  /** Recent chat and reaction traffic, oldest first. */
  messages: ChatMessage[];
  /** User ids that currently have a raised hand. */
  presence: string[];
  /** The latest recording / intelligence / action-item payload. */
  aiStatus: object | null;
  /** Connects the socket (idempotent while connected). */
  connect: () => void;
  /** Closes the socket. */
  close: () => void;
  /** Joins the meeting room; reports a rejected join through onError. */
  joinRoom: (meetingId: string) => void;
  /** Sends a chat message. */
  sendChat: (meetingId: string, text: string) => void;
  /** Raises the local user's hand. */
  raiseHand: (meetingId: string) => void;
  /** Sends a reaction. */
  sendReaction: (meetingId: string, emoji: string) => void;
}

export function useMeetingSocket(onError: (message: string) => void): MeetingSocketController {
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<SocketState>("disconnected");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [presence, setPresence] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState<object | null>(null);

  const append = useCallback((message: ChatMessage) => {
    setMessages((current) => [...current, message].slice(-50));
  }, []);

  const connect = useCallback(() => {
    if (socketRef.current) return;
    const socket = io(API_ORIGIN, { withCredentials: true, transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => setState("connected"));
    socket.on("disconnect", () => setState("disconnected"));

    // Server contract names (see server/src/sockets/meetingSockets.js).
    socket.on("chat:message", (message: ChatMessage) => append(message));
    socket.on("reaction:new", (reaction: { emoji: string; userId: string }) =>
      append({
        id: `reaction-${Date.now()}`,
        text: `${reaction.userId}: ${reaction.emoji}`,
      }),
    );
    socket.on("hand:updated", (hand: { userId: string; raised: boolean }) =>
      setPresence((current) =>
        hand.raised && !current.includes(hand.userId) ? [...current, hand.userId] : current,
      ),
    );
    socket.on("meeting:ended", () => setState("meeting-ended"));
    socket.on("meeting:revoked", () => setState("revoked"));

    for (const event of [
      "recording:status",
      "recording:ready",
      "intelligence:status",
      "intelligence:ready",
      "action-item:updated",
    ]) {
      socket.on(event, (payload: object) => setAiStatus(payload));
    }
  }, [append]);

  const close = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    setState("disconnected");
  }, []);

  const joinRoom = useCallback(
    (meetingId: string) => {
      socketRef.current?.emit(
        "meeting:join",
        { meetingId },
        (result: { ok: boolean; error?: string } | undefined) => {
          if (!result?.ok) onError(result?.error || "socket join rejected");
        },
      );
    },
    [onError],
  );

  const sendChat = useCallback(
    (meetingId: string, text: string) => {
      socketRef.current?.emit(
        "chat:send",
        {
          meetingId,
          clientMessageId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          text,
        },
        (result: { ok: boolean; message?: ChatMessage; error?: string } | undefined) => {
          if (result?.ok && result.message) {
            append(result.message);
          } else {
            onError(result?.error || "chat rejected");
          }
        },
      );
    },
    [append, onError],
  );

  const raiseHand = useCallback((meetingId: string) => {
    socketRef.current?.emit("hand:raise", { meetingId, raised: true });
  }, []);

  const sendReaction = useCallback((meetingId: string, emoji: string) => {
    socketRef.current?.emit("reaction:send", { meetingId, emoji });
  }, []);

  // Unmount teardown: no orphan socket behind a closed lab screen.
  useEffect(
    () => () => {
      socketRef.current?.close();
      socketRef.current = null;
    },
    [],
  );

  return {
    state,
    messages,
    presence,
    aiStatus,
    connect,
    close,
    joinRoom,
    sendChat,
    raiseHand,
    sendReaction,
  };
}
