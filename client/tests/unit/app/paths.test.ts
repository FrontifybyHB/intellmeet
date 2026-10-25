import { describe, expect, it } from "vitest";

import {
  ROUTES,
  isSafeInternalPath,
  joinPath,
  meetingPath,
  resolveRedirectTarget,
} from "@/app/paths";

describe("joinPath", () => {
  it("builds the invite-landing path", () => {
    expect(joinPath("abc")).toBe("/join/abc");
  });
});

describe("meetingPath", () => {
  it("builds the meeting-detail path", () => {
    expect(meetingPath("m-42")).toBe("/meetings/m-42");
  });
});

describe("isSafeInternalPath", () => {
  it("accepts same-app absolute paths", () => {
    expect(isSafeInternalPath("/meetings")).toBe(true);
    expect(isSafeInternalPath("/join/abc")).toBe(true);
  });

  it("rejects protocol-relative and absolute URLs", () => {
    expect(isSafeInternalPath("//evil.example.com")).toBe(false);
    expect(isSafeInternalPath("https://evil.example.com")).toBe(false);
  });

  it("rejects backslash paths and non-strings", () => {
    expect(isSafeInternalPath("/\\evil.example.com")).toBe(false);
    expect(isSafeInternalPath("")).toBe(false);
    expect(isSafeInternalPath(undefined)).toBe(false);
    expect(isSafeInternalPath(null)).toBe(false);
    expect(isSafeInternalPath(42)).toBe(false);
  });
});

describe("resolveRedirectTarget", () => {
  it("keeps a safe path written by a guard", () => {
    expect(resolveRedirectTarget({ from: "/meetings" })).toBe("/meetings");
  });

  it("falls back to the authenticated home route for unsafe or missing state", () => {
    expect(resolveRedirectTarget({ from: "//evil.example.com" })).toBe(ROUTES.authenticatedHome);
    expect(resolveRedirectTarget({ from: "https://evil.example.com" })).toBe(
      ROUTES.authenticatedHome,
    );
    expect(resolveRedirectTarget({})).toBe(ROUTES.authenticatedHome);
    expect(resolveRedirectTarget(null)).toBe(ROUTES.authenticatedHome);
    expect(resolveRedirectTarget(undefined)).toBe(ROUTES.authenticatedHome);
  });
});

describe("ROUTES", () => {
  it("points the invite route at the join path shape", () => {
    expect(ROUTES.join).toBe("/join/:code");
    expect(ROUTES.meetingDetail).toBe("/meetings/:id");
    expect(ROUTES.home).toBe("/");
  });
});
