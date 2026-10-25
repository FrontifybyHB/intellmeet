export function isLiveKitAuthFailure(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: number; code?: number | string; message?: string };
  return (
    candidate.status === 401 ||
    candidate.code === 401 ||
    /(?:\b401\b|unauthorized|invalid token|authentication failed)/i.test(candidate.message || "")
  );
}
