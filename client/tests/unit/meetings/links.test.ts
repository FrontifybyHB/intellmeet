import { describe, expect, it } from "vitest";

import { joinCodeFromLocation, validReturnPath } from "@/features/meetings/links";

const CODE = "abcdefghijklmnopqrstuv";

describe("validReturnPath", () => {
  it("keeps a well-formed invite path", () => {
    expect(validReturnPath(`/join/${CODE}`)).toBe(`/join/${CODE}`);
  });

  it("rejects anything that is not an invite path", () => {
    expect(validReturnPath(null)).toBeNull();
    expect(validReturnPath("")).toBeNull();
    expect(validReturnPath("/meetings")).toBeNull();
    expect(validReturnPath("/account")).toBeNull();
    expect(validReturnPath("//evil.example.com")).toBeNull();
    expect(validReturnPath("https://evil.example.com/join/x")).toBeNull();
  });

  it("rejects a code that does not match the accepted shape", () => {
    expect(validReturnPath("/join/short")).toBeNull();
    expect(validReturnPath(`/join/${CODE}extra`)).toBeNull();
    expect(validReturnPath(`/join/${CODE.toLowerCase()}${"!".repeat(1)}`)).toBeNull();
  });
});

describe("joinCodeFromLocation", () => {
  it("reads the code from the path form", () => {
    window.history.pushState({}, "", `/join/${CODE}`);
    expect(joinCodeFromLocation()).toBe(CODE);
  });

  it("reads the code from the legacy hash form", () => {
    window.history.pushState({}, "", `/home`);
    window.location.hash = `#/join/${CODE}`;
    expect(joinCodeFromLocation()).toBe(CODE);
    window.location.hash = "";
  });

  it("returns null on an unrelated route", () => {
    window.history.pushState({}, "", "/meetings");
    expect(joinCodeFromLocation()).toBeNull();
  });

  it("returns null when the code has the wrong shape", () => {
    window.history.pushState({}, "", "/join/too-short");
    expect(joinCodeFromLocation()).toBeNull();
  });
});
