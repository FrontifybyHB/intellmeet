import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch, clearClientAuthState } from "@/shared/api/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  clearClientAuthState();
  vi.unstubAllGlobals();
});

describe("apiFetch CSRF handling", () => {
  it("surfaces a CSRF bootstrap failure instead of making a headerless write", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: 503,
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database temporarily unavailable.",
          },
        },
        503,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = apiFetch("/auth/login", { method: "POST", body: {} });
    await expect(request).rejects.toMatchObject<Partial<ApiError>>({
      status: 503,
      code: "DATABASE_UNAVAILABLE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/auth/csrf");
  });

  it("refreshes and retries once when a write is rejected for a stale CSRF token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "token-one" }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            status: 403,
            error: { code: "CSRF_REQUIRED", message: "CSRF token missing." },
          },
          403,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "token-two" }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const request = apiFetch<{ user: { id: string } }>("/auth/login", {
      method: "POST",
      body: {},
    });
    await expect(request).resolves.toEqual({
      user: { id: "u1" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({ "x-csrf-token": "token-two" });
  });
});
