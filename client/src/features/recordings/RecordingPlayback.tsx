// Playback of a ready recording.
//
// The access link is minted ON DEMAND, held in component state only and
// never persisted (no localStorage, no URL parameter, no history entry).
// The server hands out short-lived links, so the view detects expiry and
// re-mints instead of pretending a stale link still works.

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, PlayIcon, RefreshCwIcon } from "lucide-react";

import { describeApiError } from "@/shared/api/errors";
import { Button } from "@/shared/ui/button";
import { ErrorState } from "@/shared/ui/ErrorState";
import { LoadingState } from "@/shared/ui/LoadingState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { fetchRecordingAccessLink } from "@/features/recordings/api";

interface RecordingPlaybackProps {
  meetingId: string;
  recordingId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the player closes so the caller can drop the link. */
  onClosed?: () => void;
}

export function RecordingPlayback({
  meetingId,
  recordingId,
  open,
  onOpenChange,
  onClosed,
}: RecordingPlaybackProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const positionRef = useRef(0);
  const pendingPositionRef = useRef(0);

  const viewerLink = `${window.location.origin}/meetings/${meetingId}/results?recording=${encodeURIComponent(recordingId)}`;

  const mintLink = useCallback(async () => {
    setLoading(true);
    setError(null);
    setExpired(false);
    try {
      const link = await fetchRecordingAccessLink(meetingId, recordingId);
      pendingPositionRef.current = positionRef.current;
      setUrl(link.url);
      setExpiresAt(link.expiresAt);
    } catch (err) {
      setUrl(null);
      setExpiresAt(null);
      setError(describeApiError(err, "Could not open this recording."));
    } finally {
      setLoading(false);
    }
  }, [meetingId, recordingId]);

  // Mint only while the player is open: the link is never fetched for a
  // recording the user has not asked to play.
  useEffect(() => {
    if (!open) return;
    void mintLink();
  }, [open, mintLink]);

  // Drop the link when the player closes so it cannot linger in memory.
  useEffect(() => {
    if (open) return;
    setUrl(null);
    setExpiresAt(null);
    setError(null);
    setExpired(false);
    setCopied(false);
    onClosed?.();
    // `onClosed` is intentionally not a dependency: it is a notification,
    // not an input to this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Detect expiry while the player stays open.
  useEffect(() => {
    if (!expiresAt) return;
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = window.setTimeout(() => setExpired(true), Math.min(remaining, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setUrl(null);
      setExpiresAt(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Recording playback</DialogTitle>
          <DialogDescription>
            Share the viewer link with someone who has meeting access. The video playback URL is
            issued on demand and expires shortly afterward.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-40">
          {loading ? <LoadingState label="Preparing playback…" /> : null}

          {!loading && error ? (
            <ErrorState
              title="Playback unavailable"
              message={error}
              action={
                <Button variant="outline" size="sm" onClick={() => void mintLink()}>
                  <RefreshCwIcon aria-hidden="true" />
                  Try again
                </Button>
              }
            />
          ) : null}

          {!loading && !error && expired ? (
            <ErrorState
              title="Link expired"
              message="This playback link is no longer valid. A new one has to be issued."
              action={
                <Button variant="outline" size="sm" onClick={() => void mintLink()}>
                  <RefreshCwIcon aria-hidden="true" />
                  Issue a new link
                </Button>
              }
            />
          ) : null}

          {!loading && !error && !expired && url ? (
            <video
              ref={videoRef}
              controls
              className="aspect-video w-full rounded-lg bg-black"
              src={url}
              onLoadedMetadata={(event) => {
                const position = pendingPositionRef.current;
                if (position > 0 && position < event.currentTarget.duration) {
                  event.currentTarget.currentTime = position;
                }
                pendingPositionRef.current = 0;
              }}
              onTimeUpdate={(event) => {
                positionRef.current = event.currentTarget.currentTime;
              }}
              onError={() => {
                setExpired(true);
                setUrl(null);
              }}
              data-testid="recording-player"
            />
          ) : null}
        </div>

        <DialogFooter>
          <div className="flex-1 text-left text-xs text-muted-foreground">
            {expiresAt ? (
              <span data-testid="recording-link-expiry">
                Link valid until {new Date(expiresAt).toLocaleTimeString()}
              </span>
            ) : null}
          </div>
          <Button
            variant="outline"
            onClick={() => {
              const write = navigator.clipboard?.writeText(viewerLink);
              if (write) void write.then(() => setCopied(true));
            }}
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button variant="outline" onClick={() => void mintLink()}>
            <RefreshCwIcon aria-hidden="true" />
            Refresh link
          </Button>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The trigger button that opens the player. */
export function PlayRecordingButton({
  meetingId,
  recordingId,
  autoOpen = false,
}: {
  meetingId: string;
  recordingId: string;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <PlayIcon aria-hidden="true" />
        Play
      </Button>
      <RecordingPlayback
        meetingId={meetingId}
        recordingId={recordingId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
