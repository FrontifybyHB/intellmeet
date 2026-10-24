// LiveKit console for the API test bench (dev only).
//
// Owns its own room and disconnects it on unmount. The join token is minted
// by the same endpoint the product uses.

import { useEffect, useRef, useState } from "react";
import { Room } from "livekit-client";

import { apiFetch } from "@/shared/api/client";

export function LiveKitConsole({ meetingId }: { meetingId: string }) {
  const roomRef = useRef<Room | null>(null);
  const [state, setState] = useState("disconnected");
  const [info, setInfo] = useState("Not connected.");

  useEffect(
    () => () => {
      void roomRef.current?.disconnect().catch(() => undefined);
      roomRef.current = null;
    },
    [],
  );

  const connect = async () => {
    try {
      const grant = await apiFetch<{ livekitUrl: string; token: string }>(
        `/meetings/${meetingId}/join`,
        { method: "POST", body: {} },
      );
      const room = new Room();
      roomRef.current = room;
      await room.connect(grant.livekitUrl, grant.token);
      setState("connected");
      setInfo(`room participants: ${room.remoteParticipants.size + 1}`);
    } catch (err) {
      setState("failed");
      setInfo(err instanceof Error ? err.message : String(err));
    }
  };

  const disconnect = async () => {
    await roomRef.current?.disconnect();
    roomRef.current = null;
    setState("disconnected");
  };

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (err) {
      setInfo(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section>
      <h2>LiveKit (media)</h2>
      <p>State: {state}</p>
      <div>
        <button type="button" onClick={() => void connect()}>
          connect with join token
        </button>
        <button type="button" onClick={() => void disconnect()}>
          disconnect
        </button>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              await roomRef.current?.localParticipant.setCameraEnabled(true);
              setInfo("camera enabled");
            })
          }
        >
          camera on
        </button>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              await roomRef.current?.localParticipant.setMicrophoneEnabled(true);
              setInfo("mic enabled");
            })
          }
        >
          mic on
        </button>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              await roomRef.current?.localParticipant.setScreenShareEnabled(true);
              setInfo("screen on");
            })
          }
        >
          screen on
        </button>
      </div>
      <pre>{info}</pre>
    </section>
  );
}
