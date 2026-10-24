// Room + device controls for the contract lab.
//
// Purely presentational: the screen owns the room and the media controller
// and passes the handlers down. Nothing here opens a connection.

import type { ParticipantMediaController } from "@/dev/pages/meeting-lab/useParticipantMedia";
import type { RoomConnectionState } from "@/dev/pages/meeting-lab/useMeetingRoom";

export function MeetingControls({
  roomState,
  participants,
  media,
}: {
  roomState: RoomConnectionState;
  participants: number;
  media: ParticipantMediaController;
}) {
  return (
    <section>
      <p data-testid="room-state">
        LiveKit: {roomState} · participants: {participants}
      </p>
      <button type="button" onClick={() => void media.toggleCamera()}>
        Camera {media.cameraOn ? "off" : "on"}
      </button>
      <button type="button" onClick={() => void media.toggleMic()}>
        Mic {media.micOn ? "off" : "on"}
      </button>
      <button type="button" onClick={() => void media.toggleScreen()}>
        Screen {media.screenOn ? "stop" : "share"}
      </button>
      {media.error && <p role="alert">{media.error}</p>}
    </section>
  );
}
