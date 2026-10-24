// Minimal Socket.IO client for meeting-room events.
//
// The backend publishes recording lifecycle events to the meeting room
// (`meeting_<id>`), and a socket only receives them after it has joined that
// room through the `meeting:join` handshake (server/src/sockets/
// meetingSockets.js). Credentials travel in the HttpOnly cookie on the
// handshake — never in the URL, never in a payload.
//
// socket.io-client is loaded lazily: the meeting surface pulls it in when it
// mounts instead of putting the transport in the product entry bundle.
//
// Delivery is best-effort by design. The server never promises exactly-once
// delivery, and it evicts meeting rooms when a meeting ends, so every
// consumer must be able to recover the authoritative state through the
// bounded HTTP reads instead of trusting the event stream.

import { API_ORIGIN } from "@/shared/config/env";
import { refreshAuthForRealtime } from "@/shared/api/client";
import type { Recording } from "@/features/recordings/api";
import type { ActionItem, IntelligenceStatus, TranscriptionStatus } from "@/features/postMeeting/api";

export interface RecordingStatusEvent {
  meetingId: string;
  recording: Recording;
}

export interface RecordingReadyEvent {
  meetingId: string;
  recordingId: string;
  state: string;
}

export interface TranscriptionStatusEvent {
  meetingId: string;
  transcription: TranscriptionStatus;
}

export interface IntelligenceStatusEvent {
  meetingId: string;
  intelligence: IntelligenceStatus;
}

export interface ActionItemUpdatedEvent {
  meetingId: string;
  actionItem: Pick<ActionItem, "id" | "state" | "version"> & { title: string; taskStatus: string };
}

export interface MeetingSocketHandlers {
  onRecordingStatus?: (payload: RecordingStatusEvent) => void;
  onRecordingReady?: (payload: RecordingReadyEvent) => void;
  onTranscriptionStatus?: (payload: TranscriptionStatusEvent) => void;
  onTranscriptionReady?: (payload: { meetingId: string; recordingId: string; runVersion: number }) => void;
  onIntelligenceStatus?: (payload: IntelligenceStatusEvent) => void;
  onIntelligenceReady?: (payload: { meetingId: string; intelligenceId: string; runVersion: number }) => void;
  onActionItemUpdated?: (payload: ActionItemUpdatedEvent) => void;
  onMeetingEnded?: (payload: { meetingId: string }) => void;
  onMeetingRevoked?: (payload: { meetingId: string; reason?: string }) => void;
  /** Fired after the socket joined the meeting room. */
  onConnected?: () => void;
  onDisconnected?: () => void;
  /** Fired when the socket could not be established or joined. */
  onError?: (message: string) => void;
  onChatHistory?: (messages: ChatMessage[]) => void;
  onChatMessage?: (message: ChatMessage) => void;
  onChatReady?: (send: (text: string) => Promise<void>) => void;
  onPermissions?: (payload: { meetingId: string; userId: string; canRecord: boolean }) => void;
}

export interface ChatMessage {
  id: string;
  meetingId?: string;
  senderId?: string;
  senderName?: string;
  clientMessageId?: string;
  text: string;
  createdAt?: string;
}

type SocketLike = {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler?: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  connected: boolean;
  disconnect: () => void;
  connect: () => void;
};

let socketModule: Promise<typeof import("socket.io-client")> | null = null;

function loadSocketModule(): Promise<typeof import("socket.io-client")> {
  if (!socketModule) {
    socketModule = import("socket.io-client");
  }
  return socketModule;
}

/**
 * Connects to the backend and joins the meeting room.
 *
 * Returns a teardown function that leaves the room and closes the socket.
 * The teardown is safe to call before the connection finished: the pending
 * connect is cancelled instead of leaving an orphan socket behind.
 */
export function connectMeetingSocket(
  meetingId: string,
  handlers: MeetingSocketHandlers,
): () => void {
  let socket: SocketLike | null = null;
  let cancelled = false;
  let newestCursor: string | undefined;
  let joinTimer: number | null = null;
  let authRefreshAttempted = false;
  let authRevoked = false;

  const retryAfterAuthRefresh = (created: SocketLike) => {
    if (authRefreshAttempted) return false;
    authRefreshAttempted = true;
    void refreshAuthForRealtime().then((refreshed) => {
      if (!cancelled && refreshed) {
        created.disconnect();
        created.connect();
      } else if (!cancelled) {
        handlers.onError?.("Chat authentication expired. Sign in again.");
      }
    });
    return true;
  };

  const teardown = () => {
    cancelled = true;
    if (joinTimer !== null) window.clearTimeout(joinTimer);
    const current = socket;
    socket = null;
    if (!current) return;
    try {
      if (current.connected) {
        current.emit("meeting:leave", { meetingId });
      }
    } catch {
      // Leaving is best-effort: the server revokes room membership anyway.
    }
    try {
      current.disconnect();
    } catch {
      // A closed socket is already disconnected.
    }
  };

  void (async () => {
    let io: typeof import("socket.io-client").io;
    try {
      ({ io } = await loadSocketModule());
    } catch {
      if (!cancelled) handlers.onError?.("Live updates are unavailable in this browser.");
      return;
    }
    if (cancelled) return;

    let created: SocketLike;
    try {
      created = io(API_ORIGIN || undefined, {
        withCredentials: true,
      }) as unknown as SocketLike;
    } catch {
      handlers.onError?.("Live updates are unavailable in this browser.");
      return;
    }
    socket = created;

    created.on("connect", () => {
      authRefreshAttempted = false;
      // Joining the room is what makes the server publish recording
      // events to this socket. The server acknowledges the join, so the
      // "live" claim is based on the server's answer, not on the transport
      // alone.
      if (joinTimer !== null) window.clearTimeout(joinTimer);
      joinTimer = window.setTimeout(() => {
        joinTimer = null;
        handlers.onDisconnected?.();
        handlers.onError?.("Chat could not join the meeting. Check your connection and reload the page.");
      }, 10000);
      created.emit(
        "meeting:join",
        { meetingId, ...(newestCursor ? { lastCursor: newestCursor } : {}) },
        (ack: unknown) => {
        if (joinTimer !== null) window.clearTimeout(joinTimer);
        joinTimer = null;
        if (cancelled || !created.connected) return;
        const response = ack as
            | { ok?: boolean; code?: string; message?: string; error?: string; newestCursor?: string | null }
          | undefined;
        if (response?.ok !== true) {
          handlers.onDisconnected?.();
          if (response?.code === "UNAUTHORIZED" && retryAfterAuthRefresh(created)) return;
          handlers.onError?.(
            response?.message || "Live updates were refused by the server.",
          );
          return;
        }
        const send = (text: string) => new Promise<void>((resolve, reject) => {
          const clientMessageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const timeout = window.setTimeout(() => reject(new Error("Message delivery timed out. Check the chat history before retrying.")), 10000);
          created.emit("chat:send", { meetingId, clientMessageId, text }, (result: unknown) => {
            window.clearTimeout(timeout);
            const response = result as { ok?: boolean; message?: ChatMessage | string; error?: string; code?: string } | undefined;
            if (response?.ok && response.message && typeof response.message !== "string") {
              handlers.onChatMessage?.(response.message);
              resolve();
            } else {
              reject(new Error(typeof response?.message === "string" ? response.message : response?.error || response?.code || "Message was not sent."));
            }
          });
        });
        if (typeof response?.newestCursor === "string") {
          newestCursor = response.newestCursor;
        }
        const history = response as { messages?: ChatMessage[] };
        if (Array.isArray(history.messages)) handlers.onChatHistory?.(history.messages);
        handlers.onChatReady?.(send);
        handlers.onConnected?.();
        },
      );
    });

    created.on("disconnect", () => {
      if (joinTimer !== null) window.clearTimeout(joinTimer);
      joinTimer = null;
      handlers.onDisconnected?.();
      if (authRevoked) {
        authRevoked = false;
        if (retryAfterAuthRefresh(created)) return;
      }
      handlers.onError?.("Chat disconnected. Reconnecting…");
    });

    created.on("auth:revoked", () => { authRevoked = true; });

    created.on("chat:message", (payload: unknown) => {
      const message = payload as ChatMessage | undefined;
      if (message && typeof message.text === "string") handlers.onChatMessage?.(message);
    });

    created.on("connect_error", (error: unknown) => {
      if (joinTimer !== null) window.clearTimeout(joinTimer);
      joinTimer = null;
      handlers.onDisconnected?.();
      const authCode = (error as { data?: { code?: string } } | null)?.data?.code;
      if (authCode === "UNAUTHORIZED" && retryAfterAuthRefresh(created)) return;
      const message =
        error instanceof Error ? error.message : "Live updates could not connect.";
      handlers.onError?.(message);
    });

    created.on("recording:status", (payload: unknown) => {
      const event = payload as RecordingStatusEvent | undefined;
      if (event && typeof event.meetingId === "string" && event.recording) {
        handlers.onRecordingStatus?.(event);
      }
    });

    created.on("participant:permissions", (payload: unknown) => {
      const event = payload as { meetingId?: string; userId?: string; canRecord?: boolean } | undefined;
      if (event && typeof event.meetingId === "string" && typeof event.userId === "string" && typeof event.canRecord === "boolean") {
        handlers.onPermissions?.({ meetingId: event.meetingId, userId: event.userId, canRecord: event.canRecord });
      }
    });

    created.on("recording:ready", (payload: unknown) => {
      const event = payload as RecordingReadyEvent | undefined;
      if (event && typeof event.meetingId === "string") {
        handlers.onRecordingReady?.(event);
      }
    });

    created.on("transcription:status", (payload: unknown) => {
      const event = payload as TranscriptionStatusEvent | undefined;
      if (event && typeof event.meetingId === "string" && event.transcription) {
        handlers.onTranscriptionStatus?.(event);
      }
    });

    created.on("transcription:ready", (payload: unknown) => {
      const event = payload as { meetingId?: string; recordingId?: string; runVersion?: number } | undefined;
      if (event && typeof event.meetingId === "string" && typeof event.recordingId === "string" && typeof event.runVersion === "number") {
        handlers.onTranscriptionReady?.({ meetingId: event.meetingId, recordingId: event.recordingId, runVersion: event.runVersion });
      }
    });

    created.on("intelligence:status", (payload: unknown) => {
      const event = payload as IntelligenceStatusEvent | undefined;
      if (event && typeof event.meetingId === "string" && event.intelligence) {
        handlers.onIntelligenceStatus?.(event);
      }
    });

    created.on("intelligence:ready", (payload: unknown) => {
      const event = payload as { meetingId?: string; intelligenceId?: string; runVersion?: number } | undefined;
      if (event && typeof event.meetingId === "string" && typeof event.intelligenceId === "string" && typeof event.runVersion === "number") {
        handlers.onIntelligenceReady?.({ meetingId: event.meetingId, intelligenceId: event.intelligenceId, runVersion: event.runVersion });
      }
    });

    created.on("action-item:updated", (payload: unknown) => {
      const event = payload as ActionItemUpdatedEvent | undefined;
      if (event && typeof event.meetingId === "string" && event.actionItem) {
        handlers.onActionItemUpdated?.(event);
      }
    });

    created.on("meeting:ended", (payload: unknown) => {
      const event = payload as { meetingId?: string } | undefined;
      if (event && typeof event.meetingId === "string") {
        handlers.onMeetingEnded?.({ meetingId: event.meetingId });
      }
    });

    created.on("meeting:revoked", (payload: unknown) => {
      const event = payload as { meetingId?: string; reason?: string } | undefined;
      if (event && typeof event.meetingId === "string") {
        handlers.onMeetingRevoked?.({
          meetingId: event.meetingId,
          ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
        });
      }
    });
  })();

  return teardown;
}
