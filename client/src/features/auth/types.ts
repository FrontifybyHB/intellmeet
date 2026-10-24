// The authenticated user shape returned by /auth/me, /auth/login and
// /auth/register. It carries only fields that are safe to hold in the
// browser (no tokens, no credential material).

export interface SafeUser {
  id: string;
  name: string | null;
  email: string;
  role: string;
}
