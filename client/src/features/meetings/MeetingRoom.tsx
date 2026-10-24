import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  Camera,
  CameraOff,
  Headphones,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  MessageCircle,
  Users,
  X,
} from "lucide-react";
import { Room, RoomEvent, Track, type LocalParticipant, type Participant } from "livekit-client";

import { endMeeting, joinMeeting, takeJoinHandoff, type JoinResult } from "@/features/meetings/api";
import type { PrejoinPreferences } from "@/features/meetings/JoinInvite";
import { RecordingPanel } from "@/features/recordings/RecordingPanel";
import { PostMeetingPanel } from "@/features/postMeeting/PostMeetingPanel";
import { connectMeetingSocket, type ChatMessage } from "@/shared/realtime/meetingSocket";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
import { ErrorState } from "@/shared/ui/ErrorState";
import { LoadingState } from "@/shared/ui/LoadingState";
import { Sheet, SheetContent } from "@/shared/ui/sheet";
import { describeApiError } from "@/shared/api/errors";
import { isLiveKitAuthFailure } from "@/features/meetings/livekitAuth";
import { cn } from "@/shared/lib/utils";
import { meetingResultsPath } from "@/app/paths";
import { useAuth } from "@/features/auth/useAuth";
import { MeetingRoomToolbar, type MeetingViewMode } from "@/features/meetings/MeetingRoomToolbar";

type Panel = "none" | "chat" | "participants" | "recording" | "results";

const GRID_PAGE_SIZE = 9;

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function ParticipantTile({ participant }: { participant: Participant }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const cameraPub = participant.getTrackPublication(Track.Source.Camera);
  const screenPub = participant.getTrackPublication(Track.Source.ScreenShare);
  const micPub = participant.getTrackPublication(Track.Source.Microphone);
  const cameraTrack = cameraPub?.track;
  const screenTrack = screenPub?.track;
  const micTrack = micPub?.track;
  const videoTrack = screenTrack ?? cameraTrack;

  useEffect(() => {
    const element = videoRef.current;
    if (!videoTrack || !element) return;
    videoTrack.attach(element);
    return () => {
      try {
        videoTrack.detach(element);
      } catch {
        /* ignore */
      }
    };
  }, [videoTrack]);

  useEffect(() => {
    const element = audioRef.current;
    if (!micTrack || !element) return;
    micTrack.attach(element);
    return () => {
      try {
        micTrack.detach(element);
      } catch {
        /* ignore */
      }
    };
  }, [micTrack]);

  const label = participant.name?.trim() || "Participant";
  const cameraEnabled = participant.isCameraEnabled !== false && cameraPub?.isSubscribed !== false;
  const isLocal = participant.isLocal;
  const showVideo = !!videoTrack && (screenTrack ? true : cameraEnabled);

  return (
    <div className="relative min-h-0 overflow-hidden rounded-xl border border-border bg-muted" data-testid="participant-tile">
      {!showVideo ? (
        <div className="grid size-full min-h-44 place-items-center text-3xl font-semibold text-muted-foreground">
          {label.slice(0, 1).toUpperCase()}
        </div>
      ) : (
        <video ref={videoRef} autoPlay muted={isLocal} playsInline className="size-full min-h-44 object-cover" />
      )}
      <audio ref={audioRef} autoPlay />
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-3 pt-8 pb-2 text-sm text-white">
        <span className="truncate">
          {label}
          {isLocal ? " (You)" : ""}
        </span>
        <span aria-label={participant.isMicrophoneEnabled ? "Microphone on" : "Microphone muted"}>
          {participant.isMicrophoneEnabled ? <Mic className="size-4" /> : <MicOff className="size-4" />}
        </span>
      </div>
    </div>
  );
}

function RemoteAudio({ room }: { room: Room }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const attachRemote = () => {
      // Attach all remote audio tracks
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.audioTrackPublications.values()) {
          const track = pub.track;
          if (track && !el.querySelector(`[data-audio-id='${pub.trackSid}']`)) {
            const audio = track.attach() as HTMLMediaElement;
            audio.setAttribute("data-audio-id", pub.trackSid);
            audio.autoplay = true;
            el.appendChild(audio);
          }
        }
      }
    };
    attachRemote();
    room.on(RoomEvent.TrackSubscribed, attachRemote);
    room.on(RoomEvent.TrackUnsubscribed, attachRemote);
    room.on(RoomEvent.TrackPublished, attachRemote);
    room.on(RoomEvent.TrackUnpublished, attachRemote);
    room.on(RoomEvent.ParticipantConnected, attachRemote);
    room.on(RoomEvent.ParticipantDisconnected, attachRemote);
    return () => {
      room.off(RoomEvent.TrackSubscribed, attachRemote);
      room.off(RoomEvent.TrackUnsubscribed, attachRemote);
      room.off(RoomEvent.TrackPublished, attachRemote);
      room.off(RoomEvent.TrackUnpublished, attachRemote);
      room.off(RoomEvent.ParticipantConnected, attachRemote);
      room.off(RoomEvent.ParticipantDisconnected, attachRemote);
      el.innerHTML = "";
    };
  }, [room]);

  return <div ref={containerRef} aria-hidden="true" className="hidden" />;
}

function useKeyboardShortcuts(options: {
  enabled: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onToggleShare: () => void;
  onToggleChat: () => void;
}) {
  const { enabled, onToggleMic, onToggleCam, onToggleShare, onToggleChat } = options;

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.isComposing || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "m") {
        event.preventDefault();
        onToggleMic();
        return;
      }
      if (key === "c") {
        event.preventDefault();
        onToggleCam();
        return;
      }
      if (key === "v") {
        event.preventDefault();
        onToggleShare();
        return;
      }
      if (key === "k") {
        event.preventDefault();
        onToggleChat();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, onToggleMic, onToggleCam, onToggleShare, onToggleChat]);
}

function getGridClass(count: number) {
  if (count <= 1) return "grid-cols-1";
  if (count <= 2) return "grid-cols-1 sm:grid-cols-2";
  if (count <= 4) return "grid-cols-1 sm:grid-cols-2 xl:grid-cols-2";
  if (count <= 9) return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3";
  if (count <= 16) return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
  return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";
}

export function MeetingRoom() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const preferences = (location.state as { preferences?: PrejoinPreferences } | null)?.preferences;
  const joinPromiseRef = useRef<Promise<JoinResult> | null>(null);
  const roomRef = useRef<Room | null>(null);
  const [join, setJoin] = useState<JoinResult | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [state, setState] = useState<"loading" | "connecting" | "connected" | "ended" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [panel, setPanel] = useState<Panel>("none");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState("");
  const [chatReady, setChatReady] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const sendChatRef = useRef<((text: string) => Promise<void>) | null>(null);
  const [micPending, setMicPending] = useState(false);
  const [camPending, setCamPending] = useState(false);
  const [sharePending, setSharePending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<MeetingViewMode>("grid");
  const [, setVersion] = useState(0);
  const [page, setPage] = useState(0);
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  const participants = room
    ? [room.localParticipant, ...Array.from(room.remoteParticipants.values())]
    : [];

  const presentation = participants.find(
    (participant) => Boolean(participant.getTrackPublication(Track.Source.ScreenShare)?.track),
  );
  const gridParticipants = presentation
    ? participants.filter((participant) => participant.identity !== presentation.identity)
    : participants;
  const pageCount = Math.max(1, Math.ceil(gridParticipants.length / GRID_PAGE_SIZE));
  const visibleParticipants = gridParticipants.slice(page * GRID_PAGE_SIZE, (page + 1) * GRID_PAGE_SIZE);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  const forceUpdate = useCallback(() => setVersion((v) => v + 1), []);

  const reconnect = useCallback(async () => {
    if (!id || roomRef.current) return;
    setState("loading");
    setError(null);
    setActionError(null);
    const connectAttempt = async (allowProviderAuthRetry: boolean): Promise<(() => void) | undefined> => {
      if (roomRef.current) return undefined;
      if (!joinPromiseRef.current) {
        const handoff = takeJoinHandoff(id);
        joinPromiseRef.current = handoff ? Promise.resolve(handoff) : joinMeeting(id);
      }
      const result = await joinPromiseRef.current;
      if (roomRef.current) return undefined;
      setJoin(result);
      const next = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = next;
      setRoom(next);
      setState("connecting");

      const onChange = () => forceUpdate();
      next.on(RoomEvent.TrackSubscribed, onChange);
      next.on(RoomEvent.TrackUnsubscribed, onChange);
      next.on(RoomEvent.TrackPublished, onChange);
      next.on(RoomEvent.TrackUnpublished, onChange);
      next.on(RoomEvent.TrackMuted, onChange);
      next.on(RoomEvent.TrackUnmuted, onChange);
      next.on(RoomEvent.ParticipantConnected, onChange);
      next.on(RoomEvent.ParticipantDisconnected, onChange);
      next.on(RoomEvent.LocalTrackPublished, onChange);
      next.on(RoomEvent.LocalTrackUnpublished, onChange);
      next.on(RoomEvent.ActiveSpeakersChanged, onChange);
      next.on(RoomEvent.Disconnected, () => setState("ended"));
      next.on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!next.canPlaybackAudio));

      try {
        await next.connect(result.livekitUrl, result.token);
      } catch (connectError) {
        await next.disconnect();
        roomRef.current = null;
        setRoom(null);
        if (allowProviderAuthRetry && isLiveKitAuthFailure(connectError)) {
          joinPromiseRef.current = null;
          return connectAttempt(false);
        }
        throw connectError;
      }

      await next.localParticipant.setCameraEnabled(preferences?.cameraEnabled ?? true);
      await next.localParticipant.setMicrophoneEnabled(preferences?.microphoneEnabled ?? true);
      setState("connected");
      setAudioBlocked(!next.canPlaybackAudio);
      forceUpdate();

      return connectMeetingSocket(id, {
        onMeetingEnded: () => setState("ended"),
        onMeetingRevoked: () => setState("ended"),
        onChatHistory: (messages) =>
          setChatMessages((current) => {
            const merged = new Map(current.map((message) => [message.id, message]));
            for (const message of messages) merged.set(message.id, message);
            return [...merged.values()]
              .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
              .slice(-100);
          }),
        onChatMessage: (message) =>
          setChatMessages((current) =>
            current.some((item) => item.id === message.id) ? current : [...current, message].slice(-100),
          ),
        onChatReady: (send) => {
          sendChatRef.current = send;
          setChatReady(true);
          setActionError(null);
        },
        onDisconnected: () => {
          sendChatRef.current = null;
          setChatReady(false);
        },
        onError: (message) => {
          setActionError(message);
        },
        onPermissions: (event) => {
          if (event.userId === next.localParticipant.identity) {
            setJoin((current) =>
              current ? { ...current, permissions: { ...current.permissions, canRecord: event.canRecord } } : current,
            );
          }
        },
      });
    };
    try {
      return await connectAttempt(true);
    } catch (err) {
      roomRef.current = null;
      setRoom(null);
      setState("error");
      setError(describeApiError(err, "Could not join this meeting."));
    }
  }, [id, preferences?.cameraEnabled, preferences?.microphoneEnabled, forceUpdate]);

  useEffect(() => {
    let stopSocket: (() => void) | undefined;
    let active = true;
    void reconnect().then((teardown) => {
      if (!active) teardown?.();
      else stopSocket = teardown;
    });
    return () => {
      active = false;
      stopSocket?.();
      sendChatRef.current = null;
      setChatReady(false);
      const current = roomRef.current;
      roomRef.current = null;
      setRoom(null);
      void current?.disconnect();
    };
  }, [reconnect]);

  const toggleMic = useCallback(async () => {
    if (!room || micPending) return;
    setMicPending(true);
    setActionError(null);
    try {
      const lp = room.localParticipant as LocalParticipant;
      await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled);
      forceUpdate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not toggle microphone.");
    } finally {
      setMicPending(false);
    }
  }, [room, micPending, forceUpdate]);

  const toggleCam = useCallback(async () => {
    if (!room || camPending) return;
    setCamPending(true);
    setActionError(null);
    try {
      const lp = room.localParticipant as LocalParticipant;
      await lp.setCameraEnabled(!lp.isCameraEnabled);
      forceUpdate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not toggle camera.");
    } finally {
      setCamPending(false);
    }
  }, [room, camPending, forceUpdate]);

  const toggleScreen = useCallback(async () => {
    if (!room || sharePending) return;
    setSharePending(true);
    setActionError(null);
    try {
      const lp = room.localParticipant as LocalParticipant;
      const enabled = lp.isScreenShareEnabled;
      if (enabled) {
        await lp.setScreenShareEnabled(false);
      } else {
        await lp.setScreenShareEnabled(true);
      }
      forceUpdate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not toggle screen share.");
    } finally {
      setSharePending(false);
    }
  }, [room, sharePending, forceUpdate]);

  const toggleChatPanel = useCallback(() => {
    setPanel((p) => (p === "chat" ? "none" : "chat"));
  }, []);

  useKeyboardShortcuts({
    enabled: state === "connected" && !!room,
    onToggleMic: toggleMic,
    onToggleCam: toggleCam,
    onToggleShare: toggleScreen,
    onToggleChat: toggleChatPanel,
  });

  const leave = async () => {
    await roomRef.current?.disconnect();
    navigate("/meetings", { replace: true });
  };

  const endForEveryone = async () => {
    if (!id || !join?.permissions.isHost) return;
    try {
      await endMeeting(id);
      await roomRef.current?.disconnect();
      setState("ended");
    } catch (err) {
      throw new Error(describeApiError(err, "Could not end the meeting."));
    }
  };

  if (state === "loading" || state === "connecting") {
    return (
      <div className="flex h-svh items-center justify-center bg-background text-foreground">
        <span data-testid="meeting-id" className="sr-only">
          {id}
        </span>
        <LoadingState label={state === "loading" ? "Preparing your meeting…" : "Connecting to the meeting…"} />
      </div>
    );
  }

  if (state === "ended") {
    return (
      <div className="flex h-svh items-center justify-center bg-background p-4 text-foreground">
        <ErrorState
          title="Meeting ended"
          message="The call has ended."
          action={
            user && id ? (
              <Button type="button" onClick={() => navigate(meetingResultsPath(id), { replace: true })}>View results</Button>
            ) : (
              <Button type="button" onClick={() => navigate("/", { replace: true })}>Return home</Button>
            )
          }
          className="w-full max-w-lg"
        />
      </div>
    );
  }

  if (state === "error" || !room || !join) {
    return (
      <div className="flex h-svh items-center justify-center bg-background p-4 text-foreground">
        <span data-testid="meeting-id" className="sr-only">
          {id}
        </span>
        <ErrorState title="Meeting unavailable" message={error || "The meeting could not be connected."} action={<Button onClick={() => void reconnect()}>Try again</Button>} />
      </div>
    );
  }

  const lp = room.localParticipant as LocalParticipant;
  const micOn = lp.isMicrophoneEnabled;
  const camOn = lp.isCameraEnabled;
  const screenOn = lp.isScreenShareEnabled;
  const speakerParticipant = presentation ?? participants[0];

  const chatPanel = (
    <Card className="h-full border-border bg-card text-card-foreground">
      <CardContent className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <p className="font-semibold">Chat</p>
          <Button type="button" variant="ghost" size="icon" onClick={() => setPanel("none")} aria-label="Close chat">
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto" aria-live="polite">
          {chatMessages.length === 0 ? <p className="text-sm text-muted-foreground">No messages yet.</p> : null}
          {chatMessages.map((message) => (
            <p key={message.id} className="rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="mr-2 text-xs text-muted-foreground">{message.senderName?.trim() || "Participant"}</span>
              {message.text}
            </p>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = chatText.trim();
            if (text && !sendChatRef.current) {
              setActionError("Chat is connecting. Wait for the connection, then try sending again.");
              return;
            }
            if (text && sendChatRef.current && !chatSending) {
              setChatSending(true);
              void sendChatRef.current(text)
                .then(() => { setChatText((current) => current === text ? "" : current); setActionError(null); })
                .catch((err) => setActionError(err instanceof Error ? err.message : "Message was not sent."))
                .finally(() => setChatSending(false));
            }
          }}
        >
          <input
            value={chatText}
            onChange={(event) => setChatText(event.target.value)}
            aria-label="Message"
            placeholder="Message everyone"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
          <Button type="submit" size="sm" disabled={!chatText.trim() || chatSending}>
            Send
          </Button>
        </form>
        {!chatReady ? <p role="status" className="text-xs text-muted-foreground">Connecting chat…</p> : null}
        {actionError ? <p role="alert" className="text-xs text-destructive">{actionError}</p> : null}
      </CardContent>
    </Card>
  );

  const participantsPanel = (
    <Card className="h-full border-border bg-card text-card-foreground">
      <CardContent className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <p className="font-semibold">Participants ({participants.length})</p>
          <Button type="button" variant="ghost" size="icon" onClick={() => setPanel("none")} aria-label="Close participants">
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto">
          {participants.map((participant) => (
            <div key={participant.identity} className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="truncate">
                {participant.name?.trim() || "Participant"}
                {participant.isLocal ? " (You)" : ""}
              </span>
              <span className="flex items-center gap-2 text-muted-foreground">
                {participant.isMicrophoneEnabled ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                {participant.isCameraEnabled ? <Camera className="size-4" /> : <CameraOff className="size-4" />}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );

  const recordingPanel = (
    <Card className="h-full border-border bg-card text-card-foreground">
      <CardContent className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <p className="font-semibold">Recording</p>
          <Button type="button" variant="ghost" size="icon" onClick={() => setPanel("none")} aria-label="Close recording">
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <RecordingPanel meetingId={id!} isHost={join.permissions.isHost} canRecord={join.permissions.canRecord} />
        </div>
      </CardContent>
    </Card>
  );

  const resultsPanel = (
    <Card className="h-full border-border bg-card text-card-foreground">
      <CardContent className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <p className="font-semibold">Results</p>
          <Button type="button" variant="ghost" size="icon" onClick={() => setPanel("none")} aria-label="Close results">
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <PostMeetingPanel meetingId={id!} isHost={join.permissions.isHost} />
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="flex h-svh w-screen flex-col bg-background text-foreground">
      <span data-testid="meeting-id" className="sr-only">
        {id}
      </span>
      <RemoteAudio room={room} />
      <MeetingRoomToolbar
        title={join.title || "IntellMeet"}
        connected={state === "connected"}
        participantCount={participants.length}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onLeave={() => void leave()}
        onEnd={() => void endForEveryone()}
        canEnd={join.permissions.isHost}
      />
      <main className="flex min-h-0 flex-1 flex-col gap-4 bg-muted/20 p-3 sm:p-4 lg:flex-row">
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          {audioBlocked ? (
            <Button
              variant="outline"
              className="self-start"
              onClick={() => {
                void room.startAudio();
                setAudioBlocked(false);
              }}
            >
              <Headphones /> Enable meeting audio
            </Button>
          ) : null}
          {(error || actionError) ? (
            <p role="alert" className="rounded-lg border border-red-400/30 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {actionError || error}
            </p>
          ) : null}
          <div className="min-h-0 flex-1 rounded-2xl border border-border/70 bg-card/40 p-2 shadow-sm sm:p-3">
            {viewMode === "screen" && !presentation ? (
              <div className="grid size-full min-h-56 place-items-center rounded-xl border border-dashed border-border bg-muted/40 p-6 text-center">
                <div>
                  <MonitorUp className="mx-auto mb-2 size-8 text-muted-foreground" aria-hidden="true" />
                  <p className="font-medium">No presentation is being shared</p>
                  <p className="mt-1 text-sm text-muted-foreground">Ask a participant to share their screen.</p>
                </div>
              </div>
            ) : viewMode === "speaker" ? (
              <div className="flex size-full min-h-56 flex-col gap-3">
                {speakerParticipant ? <div className="min-h-0 flex-1"><ParticipantTile participant={speakerParticipant} /></div> : null}
                {participants.length > 1 ? (
                  <div className="grid h-24 shrink-0 grid-flow-col auto-cols-[9rem] gap-3 overflow-x-auto pb-1">
                    {participants.filter((participant) => participant.identity !== speakerParticipant?.identity).map((participant) => (
                      <ParticipantTile key={participant.identity} participant={participant} />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : presentation ? (
              <div className="flex h-full min-h-0 flex-col gap-3">
                <div className="min-h-0 flex-1">
                  <ParticipantTile participant={presentation} />
                </div>
                {gridParticipants.length > 0 ? (
                  <div className="grid h-28 shrink-0 grid-flow-col auto-cols-[10rem] gap-3 overflow-x-auto pb-1">
                    {gridParticipants.map((participant) => (
                      <ParticipantTile key={participant.identity} participant={participant} />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className={cn("grid size-full min-h-56 auto-rows-fr gap-3", getGridClass(visibleParticipants.length))}>
                {visibleParticipants.map((participant) => (
                  <ParticipantTile key={participant.identity} participant={participant} />
                ))}
              </div>
            )}
          </div>
          {!presentation && pageCount > 1 ? (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Button type="button" size="sm" variant="outline" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0}>
                Previous
              </Button>
              <span>Page {page + 1} of {pageCount}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={page === pageCount - 1}>
                Next
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-border bg-card/90 p-3 shadow-sm">
            <Button
              type="button"
              variant={micOn ? "secondary" : "destructive"}
              size="icon"
              aria-label="Toggle microphone"
              disabled={micPending}
              onClick={() => void toggleMic()}
            >
              {micOn ? <Mic /> : <MicOff />}
            </Button>
            <Button
              type="button"
              variant={camOn ? "secondary" : "destructive"}
              size="icon"
              aria-label="Toggle camera"
              disabled={camPending}
              onClick={() => void toggleCam()}
            >
              {camOn ? <Camera /> : <CameraOff />}
            </Button>
            {join.permissions.canScreenShare ? (
              <Button
                type="button"
                variant={screenOn ? "secondary" : "outline"}
                size="icon"
                aria-label={screenOn ? "Stop sharing" : "Share screen"}
                aria-pressed={screenOn}
                disabled={sharePending}
                onClick={() => void toggleScreen()}
              >
                {screenOn ? <MonitorX /> : <MonitorUp />}
              </Button>
            ) : null}
            <Button type="button" variant={panel === "chat" ? "secondary" : "outline"} onClick={() => setPanel(panel === "chat" ? "none" : "chat")}>
              <MessageCircle /> Chat
            </Button>
            <Button type="button" variant={panel === "participants" ? "secondary" : "outline"} onClick={() => setPanel(panel === "participants" ? "none" : "participants")}>
              <Users /> Participants
            </Button>
            <Button type="button" variant={panel === "recording" ? "secondary" : "outline"} onClick={() => setPanel(panel === "recording" ? "none" : "recording")}>
              Recording
            </Button>
            <Button type="button" variant={panel === "results" ? "secondary" : "outline"} onClick={() => setPanel(panel === "results" ? "none" : "results")}>
              Results
            </Button>
          </div>
        </section>
        {isDesktop ? (
          <aside className="w-96 shrink-0">
            {panel === "chat" ? chatPanel : panel === "participants" ? participantsPanel : panel === "recording" ? recordingPanel : panel === "results" ? resultsPanel : null}
          </aside>
        ) : null}
      </main>
      <Sheet open={!isDesktop && panel !== "none"} onOpenChange={(open) => !open && setPanel("none")}>
        <SheetContent side="right" className="w-full border-border bg-background p-0 sm:max-w-md">
          <div className="h-full p-2">
            {panel === "chat" ? chatPanel : panel === "participants" ? participantsPanel : panel === "recording" ? recordingPanel : panel === "results" ? resultsPanel : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
