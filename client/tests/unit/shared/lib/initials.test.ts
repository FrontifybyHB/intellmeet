import { describe, expect, it } from "vitest";

import { initialsOf } from "@/shared/lib/initials";

describe("initialsOf", () => {
  it("uses the first letter of the first two words", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
  });

  it("falls back to the first two characters of a single word", () => {
    expect(initialsOf("ada")).toBe("AD");
  });

  it("derives initials from an email address", () => {
    expect(initialsOf("ada@example.com")).toBe("AD");
  });

  it("returns a placeholder for an empty label", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });

  it("ignores extra whitespace between words", () => {
    expect(initialsOf("  Ada   Lovelace  ")).toBe("AL");
  });
});
