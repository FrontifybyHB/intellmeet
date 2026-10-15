"use strict";

// Real-time publisher registry. Services emit domain events through
// here without requiring the Socket.IO module (which already requires
// services) — no import cycle. meetingSockets registers the live
// implementation at boot; without registration, publish() is a safe
// no-op so HTTP-only tests and workers never crash.
//
// Delivery contract: emits go to the authorized meeting room only.
// After live-room eviction, clients recover via the bounded
// authorized GET history/status endpoints — exactly-once delivery is
// never promised.
let publisher = null;
let roomCloser = null;

function setRealtimePublisher(fn) {
  publisher = typeof fn === "function" ? fn : null;
}

function setRoomCloser(fn) {
  roomCloser = typeof fn === "function" ? fn : null;
}

function publishToMeeting(roomName, event, payload) {
  if (!publisher || typeof roomName !== "string" || !roomName) {
    return false;
  }
  try {
    publisher(roomName, event, payload);
    return true;
  } catch (_unused) {
    return false;
  }
}

function resetForTests() {
  publisher = null;
  roomCloser = null;
}

// Meeting-room eviction for the lifecycle owner (end of meeting):
// removes meeting-room subscriptions without disconnecting sockets
// from unrelated meetings. No-op when sockets are not attached.
function closeMeetingRoom(meetingIdParam, detail) {
  if (!roomCloser || typeof meetingIdParam !== "string" || !meetingIdParam) {
    return 0;
  }
  try {
    return roomCloser(meetingIdParam, detail) || 0;
  } catch (_unused) {
    return 0;
  }
}

module.exports = { setRealtimePublisher, setRoomCloser, publishToMeeting, closeMeetingRoom, resetForTests };
