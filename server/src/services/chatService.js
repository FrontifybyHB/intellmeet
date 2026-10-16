"use strict";

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const ChatMessage = require("../models/ChatMessage");
const { authorizeMeetingAccess } = require("./meetingAccessService");
const {
  validateClientMessageId,
  validateText,
  validateLimit,
  validateDirection,
  decodeCursor,
  encodeCursor,
} = require("../validation/chatValidation");

const HISTORY_PROJECTION = {
  meetingId: 1,
  senderId: 1,
  clientMessageId: 1,
  text: 1,
  createdAt: 1,
};

function serializeMessage(doc) {
  return {
    id: String(doc._id),
    meetingId: String(doc.meetingId),
    senderId: String(doc.senderId),
    clientMessageId: doc.clientMessageId,
    text: doc.text,
    createdAt: new Date(doc.createdAt).toISOString(),
  };
}

function isDuplicateKeyError(err) {
  return Boolean(err) && (err.code === 11000 || err.code === "11000");
}

// Persist-then-publish chat send with DB-backed idempotency.
// - Validates identifiers and payload BEFORE any DB/provider work.
// - Authorizes against the live membership row on every send.
// - The unique (meetingId, senderId, clientMessageId) index is the
//   dedup authority: simultaneous duplicates collapse to one row.
// - Same id + same text  -> canonical stored message, duplicate: true
//   (the caller must NOT rebroadcast; the insert winner already did).
// - Same id + different text -> 409 MESSAGE_CONFLICT, stored row kept.
// - Any other DB failure -> 500 DB_ERROR, fail closed: no success ack,
//   no broadcast, no phantom message.
// - Crash after commit but before ack/broadcast: the row is durable, so
//   retry with the same id recovers it and history repairs delivery.
//   Live delivery itself is best effort; history is the repair path.
async function sendMessage({ meetingIdParam, userId, clientMessageId, text }) {
  const cleanId = validateClientMessageId(clientMessageId);
  const cleanText = validateText(text);
  const { meetingId } = await authorizeMeetingAccess({
    meetingIdParam,
    userId,
  });

  let doc;
  try {
    doc = await ChatMessage.create({
      meetingId,
      senderId: userId,
      clientMessageId: cleanId,
      text: cleanText,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const canonical = await ChatMessage.findOne(
        { meetingId, senderId: userId, clientMessageId: cleanId },
        HISTORY_PROJECTION
      ).lean();
      if (!canonical) {
        throw new AppError(
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          "Could not send the message.",
          "DB_ERROR"
        );
      }
      if (canonical.text !== cleanText) {
        throw new AppError(
          HTTP_STATUS.CONFLICT,
          "This message id was already used with different content.",
          "MESSAGE_CONFLICT"
        );
      }
      return { message: serializeMessage(canonical), duplicate: true };
    }
    throw new AppError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      "Could not send the message.",
      "DB_ERROR"
    );
  }
  return { message: serializeMessage(doc.toObject()), duplicate: false };
}

// Bounded authorized history over the stable (createdAt, _id) order.
// direction "older": page before `cursor` (latest page when omitted),
// direction "newer": catch-up after `cursor` (required). limit+1 probe
// drives hasMore; no skip, no total count, projection + lean, and the
// (meetingId, createdAt, _id) index serves both directions.
async function getHistory({ meetingIdParam, userId, limit, cursor, direction }) {
  const { meetingId } = await authorizeMeetingAccess({
    meetingIdParam,
    userId,
  });
  const pageSize = validateLimit(limit);
  const dir = validateDirection(direction);
  const bound = cursor === undefined || cursor === null || cursor === ""
    ? null
    : decodeCursor(cursor);
  if (dir === "newer" && !bound) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      "A cursor is required for forward catch-up.",
      "INVALID_CURSOR"
    );
  }

  const filter = { meetingId };
  if (bound) {
    const edge =
      dir === "older"
        ? {
            $or: [
              { createdAt: { $lt: bound.createdAt } },
              { createdAt: bound.createdAt, _id: { $lt: bound.id } },
            ],
          }
        : {
            $or: [
              { createdAt: { $gt: bound.createdAt } },
              { createdAt: bound.createdAt, _id: { $gt: bound.id } },
            ],
          };
    Object.assign(filter, edge);
  }
  const sort = dir === "older" ? { createdAt: -1, _id: -1 } : { createdAt: 1, _id: 1 };

  const rows = await ChatMessage.find(filter, HISTORY_PROJECTION)
    .sort(sort)
    .limit(pageSize + 1)
    .lean();
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  // Responses are always oldest-first so clients can append directly.
  if (dir === "older") {
    page.reverse();
  }
  const messages = page.map(serializeMessage);
  // nextCursor continues in the same direction: oldest edge for older
  // pages, newest edge for forward catch-up. newestCursor always marks
  // the newest message in this page (null when empty) so a client that
  // just loaded the latest page can resume forward catch-up from it.
  const edgeMessage =
    messages.length === 0
      ? null
      : dir === "older"
        ? messages[0]
        : messages[messages.length - 1];
  const newestMessage =
    messages.length === 0 ? null : messages[messages.length - 1];
  return {
    messages,
    nextCursor: edgeMessage
      ? encodeCursor(edgeMessage.createdAt, edgeMessage.id)
      : null,
    hasMore,
    newestCursor: newestMessage
      ? encodeCursor(newestMessage.createdAt, newestMessage.id)
      : null,
  };
}

module.exports = { sendMessage, getHistory, serializeMessage };
