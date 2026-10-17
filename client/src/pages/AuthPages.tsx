import { useState } from "react";
import { useAuth } from "../auth/AuthContext";

export function LoginPage({
  onSwitch,
  onSuccess,
}: {
  onSwitch: (view: string) => void;
  /** Called after a successful sign-in; lets a route redirect the user. */
  onSuccess?: () => void;
}) {
  const { login, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLocalError(null);
    try {
      await login(email, password);
      onSuccess?.();
    } catch {
      setLocalError("Invalid email or password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {(localError || error) && <p role="alert">{localError || error}</p>}
      <p>
        No account?{" "}
        <button type="button" onClick={() => onSwitch("register")}>
          Register
        </button>
      </p>
    </main>
  );
}

export function RegisterPage({
  onSwitch,
}: {
  onSwitch: (view: string) => void;
}) {
  const { register, error } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLocalError(null);
    try {
      await register(name, email, password);
      setDone(true);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <main>
        <h1>Account created</h1>
        <p>Please sign in with your new credentials.</p>
        <button type="button" onClick={() => onSwitch("login")}>
          Go to sign in
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>Register</h1>
      <form onSubmit={submit}>
        <label>
          Name
          <input
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password (15+ characters)
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={15}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Registering…" : "Register"}
        </button>
      </form>
      {(localError || error) && <p role="alert">{localError || error}</p>}
      <p>
        Have an account?{" "}
        <button type="button" onClick={() => onSwitch("login")}>
          Sign in
        </button>
      </p>
    </main>
  );
}
