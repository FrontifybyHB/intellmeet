import { Copy, ExternalLink } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { PageHeader } from "@/shared/ui/PageHeader";
import { createMeeting } from "@/features/meetings/api";
import { useAsyncAction } from "@/shared/hooks/useAsyncAction";

/**
 * Title-only meeting creation: shows the returned URL with copy + fallback.
 */
export function CreateMeeting({
  onCreated,
}: {
  onCreated?: (meeting: { meetingId: string; joinUrl: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [result, setResult] = useState<{ meetingId: string; joinUrl: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const create = useAsyncAction(
    async () => {
      const body = await createMeeting(title);
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
    ? `You're invited to "${title.trim()}" on IntellMeet.\nJoin: ${result.joinUrl}\nOpen the link, check your camera and microphone, then select Join.\nYou can join with your account or as a guest.`
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

            {create.error && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {create.error}
              </p>
            )}

            <Button type="submit" disabled={create.pending}>
              {create.pending ? "Creating…" : "Create & get link"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold tracking-tight">Your meeting is ready</h2>
            <CardDescription>
              Share the persisted invite, or open the lobby to join it yourself.
            </CardDescription>
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
              <Button asChild type="button" size="sm">
                <a href={result.joinUrl}>
                  <ExternalLink aria-hidden="true" />
                  Open lobby
                </a>
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
