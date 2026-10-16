"use strict";

const mongoose = require("mongoose");

const AppError = require("../utils/AppError");
const { HTTP_STATUS } = require("../constants/httpStatus");
const {
  INTELLIGENCE_LIMITS,
  ACTION_ITEM_STATES,
} = require("../constants/intelligenceLimits");

function badRequest(reason, code) {
  return new AppError(HTTP_STATUS.BAD_REQUEST, reason, code || "VALIDATION_ERROR");
}

function validateObjectIdParam(value, name) {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest(`Invalid ${name || "id"}.`, "INVALID_MEETING_ID");
  }
  return value;
}

function validateActionItemIdParam(value) {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest("Invalid action-item id.", "VALIDATION_ERROR");
  }
  return value;
}

function validateActionCursor(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || value.length > 64) {
    throw badRequest("Invalid cursor.", "VALIDATION_ERROR");
  }
  if (!/^[0-9a-fA-F]{24}$/.test(value)) {
    throw badRequest("Invalid cursor.", "VALIDATION_ERROR");
  }
  return value;
}

function validateActionLimit(value) {
  if (value === undefined || value === null || value === "") {
    return INTELLIGENCE_LIMITS.ACTION_PAGE_DEFAULT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest("Invalid limit.", "VALIDATION_ERROR");
  }
  return Math.min(parsed, INTELLIGENCE_LIMITS.ACTION_PAGE_MAX);
}

function validateActionStateFilter(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const allowed = new Set([
    ACTION_ITEM_STATES.PROPOSED,
    ACTION_ITEM_STATES.APPROVED,
    ACTION_ITEM_STATES.REJECTED,
  ]);
  if (typeof value !== "string" || !allowed.has(value)) {
    throw badRequest("Invalid state filter.", "VALIDATION_ERROR");
  }
  return value;
}

function asBoundedText(value, { max, field, required }) {
  if (value === undefined || value === null) {
    if (required) {
      throw badRequest(`${field} is required.`, "VALIDATION_ERROR");
    }
    return null;
  }
  if (typeof value !== "string") {
    throw badRequest(`Invalid ${field}.`, "VALIDATION_ERROR");
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) {
    throw badRequest(`${field} is required.`, "VALIDATION_ERROR");
  }
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > max) {
    throw badRequest(`${field} is too long.`, "VALIDATION_ERROR");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) {
    throw badRequest(`${field} contains control characters.`, "VALIDATION_ERROR");
  }
  return trimmed;
}

// Review payload: { action: approve|reject|edit, version, title?,
// detail?, dueDateText?, ownerUserId? }. approve requires an explicit
// verified owner choice or an explicitly supported unassigned state
// (ownerUserId null + confirmUnassigned true); silent fuzzy matching
// of model-proposed names is never performed here.
function validateReviewBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Invalid review body.", "VALIDATION_ERROR");
  }
  const { action, version, title, detail, dueDateText, ownerUserId, confirmUnassigned } = body;
  if (action !== "approve" && action !== "reject" && action !== "edit") {
    throw badRequest("Invalid review action.", "VALIDATION_ERROR");
  }
  if (!Number.isInteger(version) || version < 0) {
    throw badRequest("Review version is required.", "VERSION_CONFLICT");
  }
  let owner = null;
  let unassigned = false;
  if (ownerUserId !== undefined && ownerUserId !== null) {
    if (typeof ownerUserId !== "string" || !mongoose.Types.ObjectId.isValid(ownerUserId)) {
      throw badRequest("Invalid owner.", "OWNER_INELIGIBLE");
    }
    owner = ownerUserId;
  } else if (confirmUnassigned === true) {
    unassigned = true;
  }
  if (action === "approve" && owner === null && unassigned !== true) {
    throw badRequest("Approval requires an explicit owner or confirmed unassigned.", "OWNER_INELIGIBLE");
  }
  if (action === "reject" && (title !== undefined || detail !== undefined || dueDateText !== undefined || owner !== null)) {
    throw badRequest("Reject carries no edits.", "VALIDATION_ERROR");
  }
  const cleanTitle = asBoundedText(title, {
    max: INTELLIGENCE_LIMITS.ACTION_TITLE_MAX,
    field: "title",
    required: action !== "reject" && title !== undefined,
  });
  const cleanDetail = asBoundedText(detail, {
    max: INTELLIGENCE_LIMITS.ACTION_DETAIL_MAX,
    field: "detail",
    required: false,
  });
  const cleanDue = asBoundedText(dueDateText, {
    max: INTELLIGENCE_LIMITS.DUEDATE_TEXT_MAX,
    field: "dueDateText",
    required: false,
  });
  if (action === "edit" && cleanTitle === null && cleanDetail === null && cleanDue === null && owner === null && unassigned !== true) {
    throw badRequest("Edit requires at least one change.", "VALIDATION_ERROR");
  }
  return { action, version, title: cleanTitle, detail: cleanDetail, dueDateText: cleanDue, ownerUserId: owner, confirmUnassigned: unassigned };
}

// --- Provider output validation --------------------------------------
// JSON shape alone proves nothing: strict unknown-field rejection,
// bounded strings/arrays, evidence segment-id membership against the
// pinned source, timestamps derived from stored segments (never model
// values), and no model-generated User/Task IDs or role grants.
const EVIDENCE_ID_RE = /^[0-9]+:[0-9]+$/;

function rejectUnknown(raw, allowed, what) {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      const err = new Error(`Unknown ${what} field: ${key}.`);
      err.code = "OUTPUT_MALFORMED";
      throw err;
    }
  }
}

function cleanClaimText(value, max, field) {
  if (typeof value !== "string") {
    const err = new Error(`Invalid ${field}.`);
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    const err = new Error(`Invalid ${field} length.`);
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) {
    const err = new Error(`Invalid ${field} characters.`);
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  return trimmed;
}

function cleanOptionalHint(value, max, field) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    const err = new Error(`Invalid ${field}.`);
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > max) {
    const err = new Error(`Invalid ${field} length.`);
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) {
    const err = new Error(`Invalid ${field} characters.`);
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  return trimmed;
}

// Evidence: { segmentIds: ["chunk:ordinal", ...] }. Timestamps are
// derived server-side from stored segments; the model never supplies
// times, user ids, or task ids.
function validateEvidence(raw, validIds, maxRefs) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const err = new Error("Evidence must be an object.");
    err.code = "EVIDENCE_INVALID";
    throw err;
  }
  rejectUnknown(raw, new Set(["segmentIds"]), "evidence");
  if (!Array.isArray(raw.segmentIds)) {
    const err = new Error("Evidence segmentIds must be an array.");
    err.code = "EVIDENCE_INVALID";
    throw err;
  }
  if (raw.segmentIds.length > maxRefs) {
    const err = new Error("Too many evidence references.");
    err.code = "EVIDENCE_INVALID";
    throw err;
  }
  const ids = [];
  for (const id of raw.segmentIds) {
    if (typeof id !== "string" || !EVIDENCE_ID_RE.test(id) || !validIds.has(id)) {
      const err = new Error("Unknown or cross-source evidence reference.");
      err.code = "EVIDENCE_INVALID";
      throw err;
    }
    ids.push(id);
  }
  return { segmentIds: ids };
}

function validateClaimList(raw, { validIds, maxItems, maxChars, maxRefs, field }) {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    const err = new Error(`Invalid ${field}.`);
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  if (raw.length > maxItems) {
    const err = new Error(`Too many ${field}.`);
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      const err = new Error(`Invalid ${field} entry.`);
      err.code = "OUTPUT_MALFORMED";
      throw err;
    }
    rejectUnknown(entry, new Set(["text", "segmentIds", "evidence"]), field);
    const text = cleanClaimText(entry.text, maxChars, field);
    const evRaw = entry.evidence !== undefined ? entry.evidence : { segmentIds: entry.segmentIds || [] };
    const evidence = validateEvidence(evRaw && typeof evRaw === "object" && !Array.isArray(evRaw) ? evRaw : { segmentIds: [] }, validIds, maxRefs);
    if (evidence.segmentIds.length === 0) {
      const err = new Error(`${field} entry lacks evidence.`);
      err.code = "EVIDENCE_INVALID";
      throw err;
    }
    return { text, evidence };
  });
}

function validateSuggestedActions(raw, { validIds, maxItems, maxRefs }) {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    const err = new Error("Invalid suggestedActions.");
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  if (raw.length > maxItems) {
    const err = new Error("Too many suggestedActions.");
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      const err = new Error("Invalid action entry.");
      err.code = "OUTPUT_MALFORMED";
      throw err;
    }
    rejectUnknown(
      entry,
      new Set(["title", "detail", "segmentIds", "evidence", "proposedOwnerText", "dueDateText"]),
      "action"
    );
    const title = cleanClaimText(entry.title, INTELLIGENCE_LIMITS.ACTION_TITLE_MAX, "action title");
    const detail = cleanOptionalHint(entry.detail, INTELLIGENCE_LIMITS.ACTION_DETAIL_MAX, "action detail");
    const proposedOwnerText = cleanOptionalHint(entry.proposedOwnerText, INTELLIGENCE_LIMITS.OWNER_TEXT_MAX, "proposedOwnerText");
    const dueDateText = cleanOptionalHint(entry.dueDateText, INTELLIGENCE_LIMITS.DUEDATE_TEXT_MAX, "dueDateText");
    const evRaw = entry.evidence !== undefined ? entry.evidence : { segmentIds: entry.segmentIds || [] };
    const evidence = validateEvidence(evRaw && typeof evRaw === "object" && !Array.isArray(evRaw) ? evRaw : { segmentIds: [] }, validIds, maxRefs);
    if (evidence.segmentIds.length === 0) {
      const err = new Error("Action entry lacks evidence.");
      err.code = "EVIDENCE_INVALID";
      throw err;
    }
    return { title, detail, proposedOwnerText, dueDateText, evidence };
  });
}

function validateIntelligencePayload(payload, { validIds }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const err = new Error("Malformed provider output.");
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  rejectUnknown(
    payload,
    new Set(["summaryBullets", "decisions", "blockers", "unresolvedQuestions", "suggestedActions"]),
    "intelligence"
  );
  const L = INTELLIGENCE_LIMITS;
  // Summaries are evidence-linked claims (schema s2): a bullet without
  // supporting segment IDs is rejected, so a fabricated summary can
  // never publish on shape alone. IDs prove provenance and presence;
  // judging negation/uncertainty/support stays a human-review duty.
  const summaryBullets = validateClaimList(payload.summaryBullets, {
    validIds,
    maxItems: L.SUMMARY_BULLETS_MAX_DEFAULT,
    maxChars: L.BULLET_CHARS_MAX,
    maxRefs: L.EVIDENCE_PER_ITEM_MAX_DEFAULT,
    field: "summaryBullets",
  });
  const decisions = validateClaimList(payload.decisions, {
    validIds,
    maxItems: L.DECISIONS_MAX_DEFAULT,
    maxChars: L.DECISION_CHARS_MAX,
    maxRefs: L.EVIDENCE_PER_ITEM_MAX_DEFAULT,
    field: "decisions",
  });
  const blockers = validateClaimList(payload.blockers, {
    validIds,
    maxItems: L.BLOCKERS_MAX_DEFAULT,
    maxChars: L.BLOCKER_CHARS_MAX,
    maxRefs: L.EVIDENCE_PER_ITEM_MAX_DEFAULT,
    field: "blockers",
  });
  const unresolvedQuestions = validateClaimList(payload.unresolvedQuestions, {
    validIds,
    maxItems: L.QUESTIONS_MAX_DEFAULT,
    maxChars: L.QUESTION_CHARS_MAX,
    maxRefs: L.EVIDENCE_PER_ITEM_MAX_DEFAULT,
    field: "unresolvedQuestions",
  });
  const suggestedActions = validateSuggestedActions(payload.suggestedActions, {
    validIds,
    maxItems: L.ACTIONS_MAX_DEFAULT,
    maxRefs: L.EVIDENCE_PER_ITEM_MAX_DEFAULT,
  });
  const bytes =
    JSON.stringify({ summaryBullets, decisions, blockers, unresolvedQuestions, suggestedActions }).length;
  if (bytes > L.MAX_OUTPUT_BYTES_DEFAULT) {
    const err = new Error("Provider output too large.");
    err.code = "OUTPUT_MALFORMED";
    throw err;
  }
  return { summaryBullets, decisions, blockers, unresolvedQuestions, suggestedActions };
}

module.exports = {
  validateObjectIdParam,
  validateActionItemIdParam,
  validateActionCursor,
  validateActionLimit,
  validateActionStateFilter,
  validateReviewBody,
  validateEvidence,
  validateIntelligencePayload,
};
