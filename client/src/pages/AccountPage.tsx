import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { ApiError, apiFetch } from "../services/api";

export function AccountPage() {
  const { user, logout } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const logoutAll = async () => {
    setMessage(null);
    try {
      await apiFetch<{ ok: boolean }>("/auth/logout-all", {
        method: "POST",
        body: {},
      });
      await logout();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not sign out everywhere.");
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch<{ ok: boolean; requireRelogin: boolean }>(
        "/auth/change-password",
        { method: "PATCH", body: { currentPassword, newPassword } },
      );
      // Server invalidates all credentials on password change: sign in again.
      await logout();
      setMessage("Password changed. Please sign in again.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CURRENT_PASSWORD") {
        setMessage("Current password is incorrect.");
      } else {
        setMessage(err instanceof Error ? err.message : "Could not change password.");
      }
    } finally {
      setBusy(false);
      setCurrentPassword("");
      setNewPassword("");
    }
  };

  return (
    <main>
      <h1>Account</h1>
      {user && (
        <p>
          Signed in as {user.name || user.email} ({user.email})
        </p>
      )}
      {message && <p role="status">{message}</p>}

      <section>
        <h2>Change password</h2>
        <form onSubmit={changePassword}>
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </label>
          <label>
            New password (15+ characters)
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={15}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Changing…" : "Change password"}
          </button>
        </form>
      </section>

      <section>
        <h2>Sessions</h2>
        <p>
          Signing out here clears this browser&apos;s cookies. Other browsers
          stay signed in until you choose “Sign out everywhere”, which
          invalidates all credentials for this account.
        </p>
        <button type="button" onClick={() => void logoutAll()}>
          Sign out everywhere
        </button>
      </section>

      <button type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </main>
  );
}
