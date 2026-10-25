import { describe, expect, it } from "vitest";

import { isLiveKitAuthFailure } from "@/features/meetings/livekitAuth";

describe("LiveKit connection authentication handling", () => {
  it("recognizes provider auth failures for the single fresh-token retry", () => {
    expect(isLiveKitAuthFailure({ status: 401 })).toBe(true);
    expect(isLiveKitAuthFailure(new Error("LiveKit unauthorized (401)"))).toBe(true);
  });

  it("does not classify application authorization errors by message alone", () => {
    expect(
      isLiveKitAuthFailure({ code: "UNAUTHORIZED", message: "Authentication has expired." }),
    ).toBe(false);
    expect(isLiveKitAuthFailure(new Error("Network connection failed"))).toBe(false);
  });
});
