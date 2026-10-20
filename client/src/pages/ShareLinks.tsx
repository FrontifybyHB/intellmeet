import { Copy } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { useAuth } from "@/auth/AuthContext";
import { ErrorState } from "@/components/common/ErrorState";
import { LoadingState } from "@/components/common/LoadingState";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoginPage, RegisterPage } from "@/pages/AuthPages";
import { ApiError, apiFetch } from "@/services/api";

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
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <PageHeader
        title="New meeting"
        description="Create a meeting and share the invite link with participants."
      />

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="meeting-title">Title</Label>
              <Input
                id="meeting-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
                placeholder="Weekly design review"
              />
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}

            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create & get link"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold tracking-tight">Share this link</h2>
            <CardDescription>Anyone with the link can request to join.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p
              className="rounded-lg border bg-muted/60 px-3 py-2 font-mono text-xs break-all"
              data-testid="join-url"
            >
              {result.joinUrl}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
                <Copy aria-hidden="true" />
                Copy link
              </Button>
              {copied && <span className="text-sm text-muted-foreground">{copied}</span>}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Shared frame for the invite landing states. */
function InviteCard({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight text-balance">{title}</h2>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children ? <CardContent className="space-y-3">{children}</CardContent> : null}
    </Card>
  );
}

// Invite landing: resolve → explicit Join. Logged-out users sign in
// first with only the validated same-app path preserved.
export function JoinView({
  code,
  onJoined,
}: {
  code: string;
  onJoined: (meetingId: string) => void;
}) {
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
        setError(
          err instanceof ApiError ? `${err.code}: ${err.message}` : "Could not load invite.",
        );
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
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-1 text-center">
          <h2 className="text-lg font-semibold tracking-tight">Sign in to join</h2>
          <p className="text-sm text-pretty text-muted-foreground">
            This invite needs an IntellMeet account. After sign-in you return here.
          </p>
        </div>
        {mode === "login" ? (
          <LoginPage onSwitch={() => setMode("register")} />
        ) : (
          <RegisterPage onSwitch={() => setMode("login")} />
        )}
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => {
            setMode("join");
            void load();
          }}
        >
          I already signed in — continue
        </Button>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="w-full max-w-md">
        <Card>
          <CardContent>
            <LoadingState label="Loading invite…" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="w-full max-w-md">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <ErrorState title="Invite unavailable" message={error || "Unknown invite."} />
            <Button type="button" variant="outline" className="w-full" onClick={() => void load()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (info.status === "ended") {
    return (
      <div className="w-full max-w-md">
        <InviteCard title={info.title || "Meeting"} description="This meeting has ended." />
      </div>
    );
  }

  if (info.admission !== "link") {
    return (
      <div className="w-full max-w-md">
        <InviteCard
          title={info.title || "Meeting"}
          description="This meeting does not accept link joins. Ask the host to admit you."
        />
      </div>
    );
  }

  if (info.membership === "removed") {
    return (
      <div className="w-full max-w-md">
        <InviteCard title={info.title || "Meeting"} description="You cannot join this meeting." />
      </div>
    );
  }

  return (
    <div className="w-full max-w-md">
      <InviteCard
        title={info.title || "Meeting"}
        description={
          info.membership === "admitted" || info.membership === "host"
            ? "You are already a member."
            : "You are invited as a participant."
        }
      >
        <Button type="button" className="w-full" onClick={() => void join()} disabled={joining}>
          {joining ? "Joining…" : "Join meeting"}
        </Button>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
      </InviteCard>
    </div>
  );
}
