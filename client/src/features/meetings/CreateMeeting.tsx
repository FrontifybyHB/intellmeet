import { CalendarClock, CheckCircle2, Copy, ExternalLink, LayoutDashboard } from "lucide-react";
import { useState } from "react";

import { ROUTES } from "@/app/paths";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { PageHeader } from "@/shared/ui/PageHeader";
import {
  createMeeting,
  startScheduledMeeting,
  type CreateMeetingResult,
} from "@/features/meetings/api";
import { useAsyncAction } from "@/shared/hooks/useAsyncAction";

/**
 * Creation stays intentionally small: it only collects fields supported by
 * the API, then presents the persisted invitation and valid next steps.
 */
export function CreateMeeting({
  onCreated,
}: {
  onCreated?: (meeting: { meetingId: string; joinUrl: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [scheduledLocal, setScheduledLocal] = useState(() => localDateTimeValue(new Date()));
  const [result, setResult] = useState<CreateMeetingResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const create = useAsyncAction(
    async () => {
      let scheduledAt: string | undefined;
      if (mode === "schedule") {
        const selected = new Date(scheduledLocal);
        if (!scheduledLocal || Number.isNaN(selected.getTime()) || selected.getTime() <= Date.now()) {
          throw new Error("Choose a future local date and time.");
        }
        scheduledAt = selected.toISOString();
      }
      const body = await createMeeting({
        title,
        scheduledAt,
        timezone: mode === "schedule" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
      });
      setResult(body);
      onCreated?.(body);
    },
    { fallbackMessage: "Creation failed." },
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCopied(null);
    await create.run();
  };

  const invitation = result
    ? [
        `You're invited to "${title.trim()}" on IntellMeet.`,
        result.scheduledAt
          ? `Scheduled for ${formatScheduledTime(result.scheduledAt, result.timezone)}${result.timezone ? ` (${result.timezone})` : ""}.`
          : "This meeting is live now.",
        `Join: ${result.joinUrl}`,
        "Open the link, check your camera and microphone, then select Join.",
      ].join("\n")
    : "";

  const copy = async (text: string, label: string) => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`${label} copied.`);
    } catch {
      // Clipboard unavailable (permissions/insecure context): select fallback.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const didCopy = document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(didCopy ? `${label} copied.` : "Copy failed — select the text manually.");
      } catch {
        setCopied("Copy failed — select the text manually.");
      }
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <PageHeader
        title="New meeting"
        description="Create a meeting and share the invite link with participants."
      />

      <Card className="overflow-hidden border-border shadow-sm">
        <CardHeader className="border-b bg-muted/30">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
              <CalendarClock aria-hidden="true" className="size-5" />
            </span>
            <div>
              <h2 className="font-semibold">Meeting details</h2>
              <CardDescription>Choose whether the room is ready immediately or starts later.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          <form onSubmit={submit} className="space-y-6">
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
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">When</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant={mode === "now" ? "secondary" : "outline"}
                  className="h-auto justify-start px-4 py-3 text-left"
                  aria-pressed={mode === "now"}
                  onClick={() => setMode("now")}
                >
                  <span><span className="block">Start now</span><span className="mt-0.5 block text-xs font-normal opacity-80">Open the room as soon as it is created.</span></span>
                </Button>
                <Button
                  type="button"
                  variant={mode === "schedule" ? "secondary" : "outline"}
                  className="h-auto justify-start px-4 py-3 text-left"
                  aria-pressed={mode === "schedule"}
                  onClick={() => setMode("schedule")}
                >
                  <span><span className="block">Schedule</span><span className="mt-0.5 block text-xs font-normal opacity-80">Keep the room waiting until the host starts it.</span></span>
                </Button>
              </div>
              {mode === "schedule" ? (
                <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-4">
                  <Label htmlFor="scheduled-local">Your local date and time</Label>
                  <Input id="scheduled-local" type="datetime-local" value={scheduledLocal} onChange={(e) => setScheduledLocal(e.target.value)} required />
                  <p className="text-xs text-muted-foreground">Timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone || "browser default"}</p>
                </div>
              ) : null}
            </fieldset>

            {create.error && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {create.error}
              </p>
            )}

            <Button type="submit" className="min-h-11" disabled={create.pending}>
              {create.pending ? "Creating…" : "Create & get link"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card className="border-primary/25 bg-primary/[0.03]">
          <CardHeader>
            <div className="flex items-start gap-3">
              <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
              <div><h2 className="text-lg font-semibold tracking-tight">Your meeting is ready</h2>
            <CardDescription>
              Share the persisted invite, or {result.status === "scheduled" ? "start it when you are ready." : "open the lobby to join it yourself."}
            </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p
              className="rounded-lg border bg-muted/60 px-3 py-2 font-mono text-xs break-all"
              data-testid="join-url"
            >
              {result.joinUrl}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copy(result.joinUrl, "Link")}
              >
                <Copy aria-hidden="true" />
                Copy link
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copy(invitation, "Invitation")}
              >
                <Copy aria-hidden="true" />
                Copy invitation
              </Button>
              {result.status === "scheduled" ? (
                <Button type="button" size="sm" onClick={() => void startScheduledMeeting(result.meetingId).then(() => setResult({ ...result, status: "live" }))}>
                  Start meeting
                </Button>
              ) : null}
              <Button asChild type="button" size="sm">
                <a href={result.joinUrl}><ExternalLink aria-hidden="true" />Open lobby</a>
              </Button>
              <Button asChild type="button" variant="outline" size="sm">
                <a href={ROUTES.authenticatedHome}><LayoutDashboard aria-hidden="true" />Open dashboard</a>
              </Button>
              {copied && (
                <span role="status" className="text-sm text-muted-foreground">
                  {copied}
                </span>
              )}
            </div>
            <p
              className="whitespace-pre-wrap rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              data-testid="invitation-text"
            >
              {invitation}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatScheduledTime(value: string, timezone: string | null): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "a scheduled time";
  try {
    return date.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  } catch {
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
}
