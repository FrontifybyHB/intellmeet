"use strict";

const { Server } = require("socket.io");

const { getEnv } = require("../config/env");
const logger = require("../config/logger");
const { verifyHs256Jwt } = require("../middleware/requireAuth");
const { roomNameFor } = require("../services/meetingJoinService");
const { authorizeMeetingAccess } = require("../services/meetingAccessService");
const { sendMessage, getHistory } = require("../services/chatService");
const { validateMeetingIdParam } = require("../validation/chatValidation");
const { takeSendBudget } = require("./sendBudget");
const { setRealtimePublisher, setRoomCloser } = require("./realtime");
const chatMetrics = require("../utils/chatMetrics");
const { resolveChatLimits } = require("../constants/chatLimits");

// Single Socket.IO server attached to the existing HTTP bootstrap (no
// extra listener). App events and chat only — media stays on LiveKit and
// AI stays in later post-meeting workers.
//
// Event contract (documented; ack objects always carry ok + code):
//   meeting:join  { meetingId, lastCursor? }
//     -> { ok: true, room, messages, nextCursor, hasMore, newestCursor }
//        (catch-up failure after join: same shape + catchUpError, client
//        repairs via GET /messages)
//   meeting:leave { meetingId } -> { ok: true }
//   chat:send     { meetingId, clientMessageId, text }
//     -> { ok: true, message, duplicate } | { ok: false, code, message }
//   server emits chat:message { id, meetingId, senderId,
//     clientMessageId, text, createdAt } to the meeting room, and
//     meeting:revoked { meetingId, reason } when the lifecycle owner
//     revokes access through revokeMeetingAccess().
//   Phase 3 adds server emits to the meeting room only (authorized
//   members): meeting:ended { meetingId, endedAt },
//   recording:status { meetingId, recording }, and recording:ready
//   { meetingId, recordingId, state }. Missed events are recovered via
//   the authorized GET status/history endpoints; exactly-once delivery
//   is never promised.
//
// Deliberate single-instance default: the in-process adapter fans out to
// sockets on this process only. Horizontal readiness needs
// @socket.io/redis-adapter + Redis + sticky routing for long-polling —
// identified as a deployment-owner prerequisite, not claimed here.
// connectionStateRecovery is intentionally NOT enabled: replay must not
// bypass membership revalidation, so DB history (not packet replay) is
// the reconnect repair path.

function handshakeError(code, message) {
  const err = new Error(message);
  err.data = { code };
  return err;
}

function resolveToken(socket) {
  const auth = socket.handshake && socket.handshake.auth;
  if (auth && typeof auth.token === "string" && auth.token.length > 0) {
    return auth.token;
  }
  const headers = socket.handshake && socket.handshake.headers;
  const header =
    headers && (headers.authorization || headers.Authorization);
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) {
      return token;
    }
  }
  return null;
}

function ackError(ack, code, message) {
  if (typeof ack === "function") {
    ack({ ok: false, code, message });
  }
}

function authExpired(socket) {
  const exp = socket.data && socket.data.authExp;
  if (typeof exp !== "number") {
    return false;
  }
  return Math.floor(Date.now() / 1000) >= exp;
}

function attachMeetingSockets(httpServer) {
  const env = getEnv();
  const limits = resolveChatLimits();
  const maxSockets = limits.MAX_SOCKETS;
  const maxRooms = limits.MAX_ROOMS_PER_SOCKET;
  const packetMax = limits.PACKET_MAX_BYTES;

  const io = new Server(httpServer, {
    // Credentials travel in handshake auth, never in the URL: nothing
    // secret lands in query strings, URLs, or logs.
    cors: env.clientUrl ? { origin: env.clientUrl } : undefined,
    maxHttpBufferSize: packetMax,
  });

  // Handshake authentication with the team's real JWT verification.
  // A LiveKit room token is NOT accepted here: Socket.IO app auth is the
  // session/user JWT only.
  io.use((socket, next) => {
    if (io.engine.clientsCount > maxSockets) {
      next(handshakeError("OVERLOADED", "The server is at capacity."));
      return;
    }
    const secret = env.jwtSecret;
    if (!secret) {
      next(handshakeError("INTERNAL_ERROR", "Authentication is not configured."));
      return;
    }
    const token = resolveToken(socket);
    if (!token) {
      next(handshakeError("UNAUTHORIZED", "Authentication required."));
      return;
    }
    let payload;
    try {
      payload = verifyHs256Jwt(token, secret);
    } catch (_unused) {
      next(handshakeError("UNAUTHORIZED", "Invalid or expired token."));
      return;
    }
    const userId = payload.sub || payload.userId || payload.id;
    if (typeof userId !== "string" || userId.length === 0) {
      next(handshakeError("UNAUTHORIZED", "Invalid or expired token."));
      return;
    }
    socket.data.userId = userId;
    socket.data.authExp =
      typeof payload.exp === "number" ? payload.exp : null;
    socket.data.rooms = new Set();
    socket.data.inflight = 0;
    next();
  });

  io.on("connection", (socket) => {
    chatMetrics.socketConnected();

    socket.on("disconnect", () => {
      // Room membership is per-socket: the engine drops this socket's
      // rooms only. Other tabs/devices of the same user are unaffected,
      // and socket.id is never treated as user identity.
      chatMetrics.socketDisconnected();
    });

    socket.on("meeting:join", async (payload, ack) => {
      const meetingIdParam =
        payload && typeof payload === "object" ? payload.meetingId : undefined;
      const lastCursor =
        payload && typeof payload === "object" ? payload.lastCursor : undefined;
      try {
        validateMeetingIdParam(meetingIdParam);
      } catch (err) {
        chatMetrics.observeReject(err.code);
        ackError(ack, err.code || "VALIDATION_ERROR", "Invalid meeting id.");
        return;
      }
      if (authExpired(socket)) {
        chatMetrics.observeReject("UNAUTHORIZED");
        ackError(ack, "UNAUTHORIZED", "Authentication has expired.");
        socket.disconnect(true);
        return;
      }
      if (socket.data.rooms.size >= maxRooms && !socket.data.rooms.has(meetingIdParam)) {
        chatMetrics.observeReject("TOO_MANY_ROOMS");
        ackError(ack, "TOO_MANY_ROOMS", "Too many joined rooms.");
        return;
      }
      let history = { messages: [], nextCursor: null, hasMore: false, newestCursor: null };
      // Subscribe-then-catch-up: authorize, join the room, THEN read
      // newer-than-cursor so messages sent during the race still reach
      // the socket live; the client dedupes live vs stored by message
      // id. getHistory re-authorizes (one extra indexed read) rather
      // than trusting the pre-join check across the await boundary.
      try {
        await authorizeMeetingAccess({
          meetingIdParam,
          userId: socket.data.userId,
        });
      } catch (err) {
        const code =
          err && typeof err.code === "string" ? err.code : "INTERNAL_ERROR";
        chatMetrics.observeReject(code);
        if (code === "DB_ERROR" || code === "INTERNAL_ERROR") {
          chatMetrics.observeDbError();
        }
        ackError(ack, code, err && err.message ? err.message : "Could not join.");
        return;
      }
      const room = roomNameFor(meetingIdParam);
      try {
        await socket.join(room);
      } catch (_unused) {
        chatMetrics.observeReject("INTERNAL_ERROR");
        ackError(ack, "INTERNAL_ERROR", "Could not join.");
        return;
      }
      socket.data.rooms.add(meetingIdParam);
      chatMetrics.observeRoomJoin();
      if (
        lastCursor !== undefined &&
        lastCursor !== null &&
        lastCursor !== ""
      ) {
        try {
          history = await getHistory({
            meetingIdParam,
            userId: socket.data.userId,
            limit: undefined,
            cursor: lastCursor,
            direction: "newer",
          });
        } catch (err) {
          const code =
            err && typeof err.code === "string" ? err.code : "INTERNAL_ERROR";
          chatMetrics.observeReject(code);
          // Joined but catch-up failed: report explicitly so the client
          // repairs via the history endpoint instead of assuming sync.
          if (typeof ack === "function") {
            ack({ ok: true, room, messages: [], nextCursor: null, hasMore: true, newestCursor: null, catchUpError: code });
          }
          return;
        }
      }
      if (typeof ack === "function") {
        ack({
          ok: true,
          room,
          messages: history.messages,
          nextCursor: history.nextCursor,
          hasMore: history.hasMore,
          newestCursor: history.newestCursor,
        });
      }
    });

    socket.on("meeting:leave", async (payload, ack) => {
      const meetingIdParam =
        payload && typeof payload === "object" ? payload.meetingId : undefined;
      try {
        validateMeetingIdParam(meetingIdParam);
      } catch (err) {
        ackError(ack, err.code || "VALIDATION_ERROR", "Invalid meeting id.");
        return;
      }
      // Leaving is idempotent and never revokes membership or touches
      // other tabs: only this socket leaves the room.
      try {
        await socket.leave(roomNameFor(meetingIdParam));
      } catch (_unused) {
        ackError(ack, "INTERNAL_ERROR", "Could not leave.");
        return;
      }
      socket.data.rooms.delete(meetingIdParam);
      if (typeof ack === "function") {
        ack({ ok: true });
      }
    });

    socket.on("chat:send", async (payload, ack) => {
      chatMetrics.observeSendReceived();
      const body = payload && typeof payload === "object" ? payload : {};
      // Shape + auth-expiry gates run before any DB/provider work.
      if (typeof body.meetingId !== "string") {
        chatMetrics.observeReject("VALIDATION_ERROR");
        ackError(ack, "VALIDATION_ERROR", "Invalid meeting id.");
        return;
      }
      if (authExpired(socket)) {
        chatMetrics.observeReject("UNAUTHORIZED");
        ackError(ack, "UNAUTHORIZED", "Authentication has expired.");
        socket.disconnect(true);
        return;
      }
      if (socket.data.inflight >= limits.MAX_INFLIGHT_SENDS) {
        // Backpressure: durable sends are never dropped — the client
        // retries with the same id. Only ephemeral overflow is refused.
        chatMetrics.observeReject("OVERLOADED");
        ackError(ack, "OVERLOADED", "Too many sends in flight.");
        return;
      }
      if (!takeSendBudget(socket.data.userId)) {
        chatMetrics.observeReject("RATE_LIMITED");
        ackError(ack, "RATE_LIMITED", "Slow down and retry.");
        return;
      }
      socket.data.inflight += 1;
      const started = process.hrtime.bigint();
      try {
        const { message, duplicate } = await sendMessage({
          meetingIdParam: body.meetingId,
          userId: socket.data.userId,
          clientMessageId: body.clientMessageId,
          text: body.text,
        });
        const persistMs = Number(process.hrtime.bigint() - started) / 1e6;
        chatMetrics.observeSendAccepted(persistMs, duplicate);
        if (!duplicate) {
          // Persist-then-publish: only the insert winner broadcasts, to
          // the meeting room only (never global).
          io.to(roomNameFor(body.meetingId)).emit("chat:message", message);
        }
        if (typeof ack === "function") {
          ack({ ok: true, message, duplicate });
        }
      } catch (err) {
        const code =
          err && typeof err.code === "string" ? err.code : "INTERNAL_ERROR";
        chatMetrics.observeReject(code);
        if (code === "DB_ERROR" || code === "INTERNAL_ERROR") {
          // DB failure: no success ack and no broadcast — no phantom chat.
          chatMetrics.observeDbError();
        }
        ackError(ack, code, err && err.message ? err.message : "Could not send.");
      } finally {
        socket.data.inflight -= 1;
      }
    });
  });

  // Revocation hook for the meeting-lifecycle owner (removal writer).
  // Emits meeting:revoked and force-leaves affected sockets on THIS
  // process. Meeting end uses closeMeetingRoomById() instead (emits
  // meeting:ended via the lifecycle service before eviction).
  // MULTI-INSTANCE GAP: cross-replica eviction needs the Redis
  // adapter + sticky routing (deployment-owner prerequisite, not
  // claimed here) — already-joined sockets on other replicas are
  // denied on their next join/send/history action but may still
  // receive live broadcasts meanwhile.
  // O(all sockets) scan, but only on rare lifecycle revocations —
  // never on the message path.
  function revokeMeetingAccess({ meetingIdParam, userId, reason }) {
    let room;
    try {
      validateMeetingIdParam(meetingIdParam);
      room = roomNameFor(meetingIdParam);
    } catch (_unused) {
      return 0;
    }
    const targets = [];
    for (const [, s] of io.sockets.sockets) {
      if (!s.rooms.has(room)) {
        continue;
      }
      if (userId !== undefined && s.data.userId !== String(userId)) {
        continue;
      }
      targets.push(s);
    }
    for (const s of targets) {
      try {
        s.leave(room);
      } catch (_unused) {
        // Leave failures must not block remaining revocations.
      }
      if (s.data.rooms) {
        s.data.rooms.delete(meetingIdParam);
      }
      s.emit("meeting:revoked", {
        meetingId: meetingIdParam,
        reason: reason || "ACCESS_REVOKED",
      });
    }
    logger.info("meeting_access_revoked", {
      revoked: targets.length,
      hasUserFilter: userId !== undefined,
    });
    return targets.length;
  }

  async function close() {
    // Verified against socket.io 4.8.4: io.close() also closes the
    // attached HTTP server, so callers must guard httpServer.close()
    // with a listening check.
    await new Promise((resolve) => {
      try {
        io.close(() => resolve());
      } catch (_unused) {
        resolve();
      }
    });
  }

  // Phase 3 lifecycle wiring: the services publish domain events
  // through the realtime registry without importing this module.
  // meeting:ended is published by the lifecycle service BEFORE this
  // eviction runs, so evicted sockets still receive it.
  function closeMeetingRoomById(meetingIdParam) {
    let room;
    try {
      validateMeetingIdParam(meetingIdParam);
      room = roomNameFor(meetingIdParam);
    } catch (_unused) {
      return 0;
    }
    let removed = 0;
    for (const [, s] of io.sockets.sockets) {
      if (!s.rooms.has(room)) {
        continue;
      }
      try {
        s.leave(room);
        removed += 1;
      } catch (_unused) {
        // Leave failures must not block remaining evictions.
      }
      if (s.data.rooms) {
        s.data.rooms.delete(meetingIdParam);
      }
    }
    logger.info("meeting_room_closed", { removed });
    return removed;
  }

  setRealtimePublisher((room, event, payload) => {
    io.to(room).emit(event, payload);
  });
  setRoomCloser((meetingIdParam) => closeMeetingRoomById(meetingIdParam));

  return { io, close, revokeMeetingAccess, closeMeetingRoomById };
}

module.exports = { attachMeetingSockets };
