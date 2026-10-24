import { validReturnPath } from "@/features/meetings/links";

/** Returns only an allowlisted, same-app invite path. */
export function resolveJoinDestination(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]{22}$/.test(raw)) return `/join/${raw}`;
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    return validReturnPath(parsed.pathname);
  } catch {
    return null;
  }
}
