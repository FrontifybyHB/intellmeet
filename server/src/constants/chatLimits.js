"use strict";

// Centralized Phase 2 chat/socket limits. Every value is a deliberate
// default: message text stays small enough for cheap indexed rows,
// pages stay bounded so reconnect catch-up cannot load full history,
// and socket budgets bound per-process work without punishing
// legitimate reconnects or shared-IP users (no IP dimension anywhere).
const CHAT_LIMITS = {
  // History pagination: 50/page default, hard cap 100. No skip, no
  // total-count query per page (limit+1 probe instead).
  PAGE_DEFAULT: 50,
  PAGE_MAX: 100,
  // Message content: 2,000 Unicode characters AND 8,000 UTF-8 bytes.
  // Both bounds apply so multi-byte text cannot blow up row size.
  MESSAGE_MAX_CHARS: 2000,
  MESSAGE_MAX_BYTES: 8000,
  // clientMessageId: opaque client uuid, strict charset, capped length.
  CLIENT_MESSAGE_ID_MAX: 64,
  // Send budget per authenticated user across all of their sockets:
  // 5 sends/sec sustained with burst 10. Retries reuse the same id so
  // legitimate recovery traffic stays inside the budget.
  SEND_PER_SEC: 5,
  SEND_BURST: 10,
  // Socket hygiene: rooms per socket, total sockets per process,
  // in-flight chat:send per socket (backpressure), engine packet cap.
  MAX_ROOMS_PER_SOCKET: 20,
  MAX_SOCKETS: 2000,
  MAX_INFLIGHT_SENDS: 10,
  PACKET_MAX_BYTES: 16 * 1024,
};

module.exports = { CHAT_LIMITS };

// Live limits: validated env overrides when configured, literal
// defaults otherwise. Lazy-requires env access so this module never
// creates a load-time cycle; safe to call per request (cached read).
function resolveChatLimits() {
  let env = null;
  try {
    env = require("../config/env").getEnv();
  } catch (_unused) {
    env = null;
  }
  const pick = (value, fallback) =>
    Number.isInteger(value) ? value : fallback;
  if (!env) {
    return { ...CHAT_LIMITS };
  }
  return {
    PAGE_DEFAULT: pick(env.chatPageDefault, CHAT_LIMITS.PAGE_DEFAULT),
    PAGE_MAX: pick(env.chatPageMax, CHAT_LIMITS.PAGE_MAX),
    MESSAGE_MAX_CHARS: pick(env.chatMaxChars, CHAT_LIMITS.MESSAGE_MAX_CHARS),
    MESSAGE_MAX_BYTES: pick(env.chatMaxBytes, CHAT_LIMITS.MESSAGE_MAX_BYTES),
    CLIENT_MESSAGE_ID_MAX: CHAT_LIMITS.CLIENT_MESSAGE_ID_MAX,
    SEND_PER_SEC: pick(env.chatSendPerSec, CHAT_LIMITS.SEND_PER_SEC),
    SEND_BURST: pick(env.chatSendBurst, CHAT_LIMITS.SEND_BURST),
    MAX_ROOMS_PER_SOCKET: pick(
      env.chatMaxRoomsPerSocket,
      CHAT_LIMITS.MAX_ROOMS_PER_SOCKET
    ),
    MAX_SOCKETS: pick(env.chatMaxSockets, CHAT_LIMITS.MAX_SOCKETS),
    MAX_INFLIGHT_SENDS: CHAT_LIMITS.MAX_INFLIGHT_SENDS,
    PACKET_MAX_BYTES: pick(
      env.socketPacketMaxBytes,
      CHAT_LIMITS.PACKET_MAX_BYTES
    ),
  };
}

module.exports.resolveChatLimits = resolveChatLimits;
