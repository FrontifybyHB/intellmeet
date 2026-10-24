import { describe, expect, it } from "vitest";

import type { Recording } from "@/features/recordings/api";
import {
  canStopRecording,
  formatBytes,
  formatDuration,
  isIntegrationBlocker,
  latestRecording,
  liveRecording,
  mergeRecording,
  recordingErrorMessage,
  recordingPhase,
  recordingPhaseLabel,
} from "@/features/recordings/state";

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: "rec-1",
    meetingId: "meeting-1",
    sessionId: "session-1",
    providerEgressId: null,
    state: "requested",
    version: 1,
    requesterId: "user-1",
    consentSnapshot: null,
    storage: null,
    output: null,
    errorCode: null,
    providerUpdatedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    ...overrides,
  };
}

describe("recordingPhase", () => {
  it("maps every durable state to a product phase", () => {
    expect(recordingPhase("requested")).toBe("pending");
    expect(recordingPhase("starting")).toBe("starting");
    expect(recordingPhase("active")).toBe("recording");
    expect(recordingPhase("stopping")).toBe("stopping");
    expect(recordingPhase("verifying")).toBe("verifying");
    expect(recordingPhase("ready")).toBe("ready");
    expect(recordingPhase("failed")).toBe("failed");
    expect(recordingPhase("aborted")).toBe("aborted");
    expect(recordingPhase("unknown")).toBe("unknown");
  });

  it("keeps an unresolved provider outcome distinct from a failure", () => {
    expect(recordingPhaseLabel("unknown")).not.toBe(recordingPhaseLabel("failed"));
  });
});

describe("mergeRecording", () => {
  it("puts an unknown recording at the head of the newest-first list", () => {
    const list = mergeRecording([], makeRecording({ id: "rec-2" }));
    expect(list.map((row) => row.id)).toEqual(["rec-2"]);
  });

  it("never regresses a terminal recording", () => {
    const ready = makeRecording({ state: "ready", version: 5 });
    const list = mergeRecording([ready], makeRecording({ state: "active", version: 6 }));

    expect(list[0].state).toBe("ready");
  });

  it("drops a stale event whose version is behind", () => {
    const active = makeRecording({ state: "active", version: 7 });
    const list = mergeRecording([active], makeRecording({ state: "starting", version: 6 }));

    expect(list[0].state).toBe("active");
  });

  it("applies a newer event", () => {
    const active = makeRecording({ state: "active", version: 7 });
    const list = mergeRecording([active], makeRecording({ state: "stopping", version: 8 }));

    expect(list[0].state).toBe("stopping");
  });

  it("does not duplicate an existing recording", () => {
    const list = mergeRecording(
      [makeRecording({ id: "rec-1" })],
      makeRecording({ id: "rec-1", state: "active" }),
    );

    expect(list).toHaveLength(1);
    expect(list[0].state).toBe("active");
  });
});

describe("recording selection", () => {
  it("finds the attempt that is still in flight", () => {
    const list = [
      makeRecording({ id: "rec-1", state: "ready" }),
      makeRecording({ id: "rec-2", state: "active" }),
    ];

    expect(liveRecording(list)?.id).toBe("rec-2");
    expect(latestRecording(list)?.id).toBe("rec-1");
  });

  it("reports no live attempt when everything is final", () => {
    expect(liveRecording([makeRecording({ state: "ready" })])).toBeNull();
  });

  it("allows stopping only while the server can still transition to stopping", () => {
    expect(canStopRecording("requested")).toBe(true);
    expect(canStopRecording("starting")).toBe(true);
    expect(canStopRecording("active")).toBe(true);
    expect(canStopRecording("unknown")).toBe(true);
    // A stop was already requested: another one would be a server no-op.
    expect(canStopRecording("stopping")).toBe(false);
    expect(canStopRecording("verifying")).toBe(false);
    expect(canStopRecording("ready")).toBe(false);
    expect(canStopRecording("failed")).toBe(false);
  });
});

describe("recordingErrorMessage", () => {
  it("explains the whitelisted provider and consent codes", () => {
    expect(recordingErrorMessage("PROVIDER_TIMEOUT_UNKNOWN")).toContain("did not answer");
    expect(recordingErrorMessage("CONSENT_WITHDRAWN")).toContain("quarantined");
    expect(recordingErrorMessage("INTEGRATION_BLOCKER")).toContain("not configured");
  });

  it("falls back to the raw code for an unknown failure", () => {
    expect(recordingErrorMessage("SOMETHING_NEW")).toContain("SOMETHING_NEW");
  });

  it("has no message when there is no error", () => {
    expect(recordingErrorMessage(null)).toBeNull();
  });

  it("flags the server-side integration blocker", () => {
    expect(isIntegrationBlocker("INTEGRATION_BLOCKER")).toBe(true);
    expect(isIntegrationBlocker("PROVIDER_FAILED")).toBe(false);
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });

  it("formats sizes", () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
