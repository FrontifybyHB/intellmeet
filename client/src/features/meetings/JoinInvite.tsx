import { ArrowLeft, Camera, CameraOff, CheckCircle2, Mic, MicOff, ShieldCheck, Wifi } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { LoginForm, RegisterForm } from "@/features/auth/AuthForms";
import { useAuth } from "@/features/auth/useAuth";
import { joinMeetingLink, resolveMeetingLink, type JoinResult, type MeetingSummary } from "@/features/meetings/api";
import { ApiError, describeApiError } from "@/shared/api/errors";
import { useAsyncAction } from "@/shared/hooks/useAsyncAction";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/shared/ui/card";
import { ErrorState } from "@/shared/ui/ErrorState";
import { LoadingState } from "@/shared/ui/LoadingState";

function InviteCard({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  return <Card className="w-full max-w-md"><CardHeader className="space-y-1.5"><h2 className="text-xl font-semibold tracking-tight text-balance">{title}</h2><CardDescription>{description}</CardDescription></CardHeader>{children ? <CardContent className="space-y-3">{children}</CardContent> : null}</Card>;
}

type InviteMode = "join" | "login" | "register";

export interface PrejoinPreferences { cameraEnabled: boolean; microphoneEnabled: boolean; }

function PrejoinPreview({ preferences, onChange, displayName = "You" }: { preferences: PrejoinPreferences; onChange: (next: PrejoinPreferences) => void; displayName?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera and microphone access is unavailable in this browser.");
        const stream = await navigator.mediaDevices.getUserMedia({ video: preferences.cameraEnabled, audio: preferences.microphoneEnabled });
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setError(null);
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : "Camera or microphone is unavailable."); }
    };
    void prepare();
    return () => { cancelled = true; streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null; };
  }, [preferences.cameraEnabled, preferences.microphoneEnabled]);

  const toggle = (key: keyof PrejoinPreferences) => onChange({ ...preferences, [key]: !preferences[key] });
  const initial = displayName.trim().slice(0, 1).toUpperCase() || "Y";
  return <div className="space-y-3">
    <div className="relative aspect-video overflow-hidden rounded-2xl border border-border bg-muted shadow-lg">
      <video ref={videoRef} autoPlay muted playsInline className="size-full object-cover" />
      {!preferences.cameraEnabled ? <div className="absolute inset-0 grid place-items-center bg-muted text-center text-sm text-muted-foreground"><div><div className="mx-auto mb-2 grid size-20 place-items-center rounded-full border border-primary/30 bg-primary/10 text-3xl font-semibold text-primary">{initial}</div>Camera is off</div></div> : null}
      <div className="absolute inset-x-3 top-3 flex items-center justify-between text-xs"><span className="rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-foreground backdrop-blur">Camera preview</span><span className="rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-muted-foreground backdrop-blur">{preferences.cameraEnabled ? "HD preview" : "Video off"}</span></div>
      <div className="absolute inset-x-3 bottom-3 flex items-center justify-between rounded-lg border border-border/60 bg-background/80 px-3 py-2 text-sm backdrop-blur"><span className="font-medium">{displayName} (You)</span><span className={preferences.microphoneEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>{preferences.microphoneEnabled ? "Mic ready" : "Mic off"}</span></div>
    </div>
    <div className="flex flex-wrap justify-center gap-2">
      <Button type="button" variant={preferences.microphoneEnabled ? "secondary" : "destructive"} size="sm" onClick={() => toggle("microphoneEnabled")}>{preferences.microphoneEnabled ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}{preferences.microphoneEnabled ? "Mic on" : "Mic off"}</Button>
      <Button type="button" variant={preferences.cameraEnabled ? "secondary" : "destructive"} size="sm" onClick={() => toggle("cameraEnabled")}>{preferences.cameraEnabled ? <Camera aria-hidden="true" /> : <CameraOff aria-hidden="true" />}{preferences.cameraEnabled ? "Camera on" : "Camera off"}</Button>
    </div>
    {error ? <p className="text-sm text-warning" role="status">{error} You can still join with devices off.</p> : null}
  </div>;
}

export function JoinInvite({ code, onJoined }: { code: string; onJoined: (result: JoinResult, preferences: PrejoinPreferences) => void }) {
  const { user } = useAuth();
  const [info, setInfo] = useState<MeetingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<InviteMode>("join");
  const [awaitingSignIn, setAwaitingSignIn] = useState(false);
  const [preferences, setPreferences] = useState<PrejoinPreferences>({ cameraEnabled: true, microphoneEnabled: true });

  const load = useCallback(async () => { setLoading(true); setLoadError(null); try { setInfo(await resolveMeetingLink(code)); } catch (err) { if (err instanceof ApiError && err.status === 401) { setAwaitingSignIn(true); setMode("login"); } else setLoadError(describeApiError(err, "Could not load invite.")); } finally { setLoading(false); } }, [code]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!awaitingSignIn || !user) return; setAwaitingSignIn(false); setMode("join"); void load(); }, [awaitingSignIn, user, load]);

  const join = useAsyncAction(async () => { if (!user) throw new Error("Sign in to join this meeting."); onJoined(await joinMeetingLink(code), preferences); }, { fallbackMessage: "Join failed." });

  if (mode !== "join") return <div className="w-full max-w-md space-y-4"><div className="space-y-1 text-center"><h2 className="text-lg font-semibold tracking-tight">Sign in to join</h2><p className="text-sm text-pretty text-muted-foreground">This invite needs an IntellMeet account. After sign-in you return here.</p></div><PrejoinPreview preferences={preferences} onChange={setPreferences} displayName={user?.name || "You"} />{mode === "login" ? <LoginForm onSwitch={() => setMode("register")} /> : <RegisterForm onSwitch={() => setMode("login")} />}<Button type="button" variant="ghost" className="w-full" onClick={() => { setAwaitingSignIn(false); setMode("join"); void load(); }}>I already signed in — continue</Button>{(join.error || loadError) ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{join.error || loadError}</p> : null}</div>;
  if (loading) return <div className="w-full max-w-md"><Card><CardContent><LoadingState label="Loading invite…" /></CardContent></Card></div>;
  if (loadError || !info) return <div className="w-full max-w-md"><Card><CardContent className="space-y-4 pt-6"><ErrorState title="Invite unavailable" message={loadError || "Unknown invite."} /><Button type="button" variant="outline" className="w-full" onClick={() => void load()}>Retry</Button></CardContent></Card></div>;
  if (info.status === "ended" || info.status === "cancelled") return <div className="w-full max-w-md"><InviteCard title={info.title || "Meeting"} description={info.status === "cancelled" ? "This meeting is no longer available." : "This meeting has ended."} /></div>;
  if (info.admission !== "link") return <div className="w-full max-w-md"><InviteCard title={info.title || "Meeting"} description="This meeting does not accept link joins. Ask the host to admit you." /></div>;
  if (info.membership === "removed") return <div className="w-full max-w-md"><InviteCard title={info.title || "Meeting"} description="You cannot join this meeting." /></div>;

  const meetingTitle = info.title || "Meeting";
  const statusLabel = info.status === "active" ? "In progress" : "Ready to join";
  return <div className="w-full max-w-6xl space-y-5 py-2 sm:space-y-6 lg:py-6">
    <div className="flex items-center justify-between gap-3"><a href="/" className="inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft className="size-4" aria-hidden="true" />Back to home</a><span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Wifi className="size-3.5" aria-hidden="true" />Browser connection</span></div>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.85fr)]">
      <section className="space-y-4"><div><p className="mb-2 text-sm font-medium text-primary">Pre-join lobby</p><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Ready to join?</h1><p className="mt-2 max-w-xl text-sm text-muted-foreground sm:text-base">Check your camera and microphone before entering the meeting.</p></div><PrejoinPreview preferences={preferences} onChange={setPreferences} displayName={user?.name || "You"} /><div className="grid gap-3 rounded-xl border border-border bg-card/70 p-4 sm:grid-cols-2"><div className="flex items-center gap-3"><CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /><div><p className="text-sm font-medium">Camera</p><p className="text-xs text-muted-foreground">{preferences.cameraEnabled ? "Enabled for this meeting" : "You will join without video"}</p></div></div><div className="flex items-center gap-3"><CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /><div><p className="text-sm font-medium">Microphone</p><p className="text-xs text-muted-foreground">{preferences.microphoneEnabled ? "Enabled for this meeting" : "You will join muted"}</p></div></div></div></section>
      <Card className="border-border bg-card/90 shadow-lg"><CardContent className="space-y-5 p-5 sm:p-6"><div className="flex items-start justify-between gap-3"><div><span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300"><span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />{statusLabel}</span><h2 className="mt-3 text-2xl font-semibold tracking-tight">{meetingTitle}</h2><p className="mt-1 text-sm text-muted-foreground">Invite code <span className="font-mono">{code}</span></p></div><ShieldCheck className="size-6 shrink-0 text-primary" aria-label="Secure meeting" /></div><div className="rounded-xl border border-border bg-muted/40 p-4"><p className="text-sm font-medium">Joining as</p>{user ? <div className="mt-3 flex items-center gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 font-semibold text-primary">{user.name?.trim().slice(0, 1).toUpperCase() || "U"}</div><div className="min-w-0"><p className="truncate text-sm font-semibold">{user.name || "User"}</p><p className="truncate text-xs text-muted-foreground">{user.email}</p></div></div> : <p className="mt-2 text-sm text-muted-foreground">Sign in or register to continue.</p>}</div><div className="space-y-2 text-sm text-muted-foreground"><p>Meeting access is controlled by the host.</p><p>Recording and AI processing settings follow the meeting configuration.</p></div><Button type="button" className="h-11 w-full" onClick={() => void join.run()} disabled={join.pending || !user}>{join.pending ? "Connecting…" : "Join meeting"}</Button>{!user ? <Button type="button" variant="outline" className="w-full" onClick={() => setMode("login")}>Sign in to continue</Button> : null}{join.error ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{join.error}</p> : null}</CardContent></Card>
    </div>
  </div>;
}
