// Camera / microphone / screen-share controls for the contract lab.
//
// The hook never owns a room: it receives the room from the screen and only
// publishes or unpublishes tracks on it. Before a room exists it proves
// device availability with a plain getUserMedia call, which is how the lab
// exercises the permission-denied path without a server.

import { useCallback, useState } from "react";
import type { Room } from "livekit-client";

export interface ParticipantMediaController {
  cameraOn: boolean;
  micOn: boolean;
  screenOn: boolean;
  /** The last device/permission error, or null. */
  error: string | null;
  toggleCamera: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleScreen: () => Promise<void>;
  clearError: () => void;
}

export function useParticipantMedia(room: Room | null): ParticipantMediaController {
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const toggleCamera = useCallback(async () => {
    try {
      if (!room) {
        // Pre-join check: proves getUserMedia availability / denial.
        await navigator.mediaDevices.getUserMedia({ video: true });
        setCameraOn((on) => !on);
        return;
      }
      await room.localParticipant.setCameraEnabled(!cameraOn);
      setCameraOn((on) => !on);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Camera unavailable.");
    }
  }, [cameraOn, room]);

  const toggleMic = useCallback(async () => {
    try {
      if (!room) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        setMicOn((on) => !on);
        return;
      }
      await room.localParticipant.setMicrophoneEnabled(!micOn);
      setMicOn((on) => !on);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone unavailable.");
    }
  }, [micOn, room]);

  const toggleScreen = useCallback(async () => {
    try {
      if (!room) {
        setError("Join the LiveKit room before screen share.");
        return;
      }
      await room.localParticipant.setScreenShareEnabled(!screenOn);
      setScreenOn((on) => !on);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Screen share failed.");
    }
  }, [room, screenOn]);

  return { cameraOn, micOn, screenOn, error, toggleCamera, toggleMic, toggleScreen, clearError };
}
