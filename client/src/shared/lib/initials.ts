/**
 * Short, stable avatar fallback derived from a display name or email.
 * "Ada Lovelace" -> "AL", "ada@example.com" -> "AD".
 */
export function initialsOf(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return "?";
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}
