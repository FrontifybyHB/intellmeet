import { useCallback, useEffect, useState } from "react";
import { ApiError, apiFetch } from "../services/api";
import { useAuth } from "../auth/AuthContext";
import { LoginPage, RegisterPage } from "./AuthPages";

const CODE_RE = /^[A-Za-z0-9_-]{22}$/;

// Allowlisted same-app return paths only (prevents open redirects).
// Only /join/<code> is preserved across login/register.
export function validReturnPath(path: string | null): string | null {
  if (!path) return null;
  const m = /^\/join\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (!m || !CODE_RE.test(m[1])) return null;
  return `/join/${m[1]}`;
}

export function joinCodeFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname;
  const pm = /^\/join\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (pm && CODE_RE.test(pm[1])) return pm[1];
  const hash = window.location.hash;
  const hm = /^#\/join\/([A-Za-z0-9_-]{1,64})$/.exec(hash);
  if (hm && CODE_RE.test(hm[1])) return hm[1];
  return null;
}

interface ResolveInfo {
  meetingId: string;
  title: string | null;
  status: string;
  admission: string;
  membership: string;
}

interface JoinResult {
  meetingId: string;
  title: string | null;
  roomName: string;
  token: string;
  permissions: { isHost: boolean; canRecord: boolean; canScreenShare: boolean };
}

// Title-only creation: shows the returned URL with copy + fallback.
export function CreateMeeting({ onCreated }: { onCreated?: (meetingId: string) => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ meetingId: string; joinUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(null);
    try {
      const body = await apiFetch<{ meetingId: string; joinUrl: string }>("/meetings", {
        method: "POST",
        body: { title },
      });
      setResult(body);
      onCreated?.(body.meetingId);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Creation failed.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.joinUrl);
      setCopied("Copied.");
    } catch {
      // Clipboard unavailable (permissions/insecure context): select fallback.
      try {
        const ta = document.createElement("textarea");
        ta.value = result.joinUrl;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied("Copied.");
      } catch {
        setCopied("Copy failed — select the link manually.");
      }
    }
  };

  return (
    <main>
      <h2>New meeting</h2>
      <form onSubmit={submit}>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create & get link"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <section>
          <p>Share this link:</p>
          <p data-testid="join-url">{result.joinUrl}</p>
          <button type="button" onClick={() => void copy()}>
            Copy link
          </button>
          {copied && <p>{copied}</p>}
        </section>
      )}
    </main>
  );
}

// Invite landing: resolve → explicit Join. Logged-out users sign in
// first with only the validated same-app path preserved.
export function JoinView({ code, onJoined }: { code: string; onJoined: (meetingId: string) => void }) {
  const { user } = useAuth();
  const [info, setInfo] = useState<ResolveInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [mode, setMode] = useState<"join" | "login" | "register">("join");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiFetch<ResolveInfo>(`/meeting-links/${code}`);
      setInfo(body);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMode("login");
      } else {
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Could not load invite.");
      }
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  // After sign-in inside this flow, return to the exact invite.
  useEffect(() => {
    if (user && mode !== "join") {
      setMode("join");
      void load();
    }
  }, [user, mode, load]);

  const join = async () => {
    setJoining(true);
    setError(null);
    try {
      const body = await apiFetch<JoinResult>(`/meeting-links/${code}/join`, {
        method: "POST",
        body: {},
      });
      onJoined(body.meetingId);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Join failed.");
    } finally {
      setJoining(false);
    }
  };

  if (mode !== "join") {
    return (
      <main>
        <h2>Sign in to join</h2>
        <p>This invite needs an IntellMeet account. After sign-in you return here.</p>
        {mode === "login" ? (
          <LoginPage onSwitch={() => setMode("register")} />
        ) : (
          <RegisterPage onSwitch={() => setMode("login")} />
        )}
        <button type="button" onClick={() => { setMode("join"); void load(); }}>
          I already signed in — continue
        </button>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  }

  if (loading) {
    return (
      <main>
        <p>Loading invite…</p>
      </main>
    );
  }

  if (error || !info) {
    return (
      <main>
        <h2>Invite unavailable</h2>
        <p role="alert">{error || "Unknown invite."}</p>
        <button type="button" onClick={() => void load()}>
          Retry
        </button>
      </main>
    );
  }

  if (info.status === "ended") {
    return (
      <main>
        <h2>{info.title || "Meeting"}</h2>
        <p>This meeting has ended.</p>
      </main>
    );
  }

  if (info.admission !== "link") {
    return (
      <main>
        <h2>{info.title || "Meeting"}</h2>
        <p>This meeting does not accept link joins. Ask the host to admit you.</p>
      </main>
    );
  }

  if (info.membership === "removed") {
    return (
      <main>
        <h2>{info.title || "Meeting"}</h2>
        <p>You cannot join this meeting.</p>
      </main>
    );
  }

  return (
    <main>
      <h2>{info.title || "Meeting"}</h2>
      {info.membership === "admitted" || info.membership === "host" ? (
        <p>You are already a member.</p>
      ) : (
        <p>You are invited as a participant.</p>
      )}
      <button type="button" onClick={() => void join()} disabled={joining}>
        {joining ? "Joining…" : "Join meeting"}
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
