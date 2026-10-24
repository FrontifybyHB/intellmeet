// LiveKit room ownership for the contract lab.
//
// One hook owns one room for the whole screen: it connects, reports the
// connection state and the participant count, and tears the room down when
// the screen unmounts. No other module in the lab creates a Room, so the
// "one room per screen" rule holds and a consumer can never end up with two
// competing connections.
//
// This is dev-only code: the product meeting surface owns its own session
// through the product realtime client.

import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";

export type RoomConnectionState = "disconnected" | "connecting" | "connected" | "failed";

export interface MeetingRoomController {
  /** The live room, or null while disconnected. */
  room: Room | null;
  /** Human-readable connection state. */
  state: RoomConnectionState;
  /** Local participant plus remote participants. */
  participants: number;
  /** Connects to a LiveKit room with the grant returned by the join call. */
  connect: (livekitUrl: string, token: string) => Promise<void>;
  /** Disconnects and releases the room. Safe to call twice. */
  disconnect: () => Promise<void>;
}

export function useMeetingRoom(): MeetingRoomController {
  const roomRef = useRef<Room | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [state, setState] = useState<RoomConnectionState>("disconnected");
  const [participants, setParticipants] = useState(0);

  const disconnect = useCallback(async () => {
    const current = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    if (current) {
      try {
        await current.disconnect();
      } catch {
        // A room that is already gone needs no teardown.
      }
    }
    setState("disconnected");
    setParticipants(0);
  }, []);

  const connect = useCallback(async (livekitUrl: string, token: string) => {
    setState("connecting");
    let created: Room;
    try {
      created = new Room();
    } catch (err) {
      setState("failed");
      throw err;
    }
    roomRef.current = created;
    setRoom(created);
    created.on(RoomEvent.ConnectionStateChanged, (next) => {
      setState(String(next) as RoomConnectionState);
    });
    const countParticipants = () => setParticipants(created.remoteParticipants.size + 1);
    created.on(RoomEvent.ParticipantConnected, countParticipants);
    created.on(RoomEvent.ParticipantDisconnected, countParticipants);
    created.on(RoomEvent.TrackSubscribed, countParticipants);
    try {
      await created.connect(livekitUrl, token);
      setState("connected");
      countParticipants();
    } catch (err) {
      roomRef.current = null;
      setRoom(null);
      setState("failed");
      throw err;
    }
  }, []);

  // Unmount teardown: a lab screen that navigates away must not leave a room
  // or a media track running.
  useEffect(
    () => () => {
      const current = roomRef.current;
      roomRef.current = null;
      void current?.disconnect().catch(() => undefined);
    },
    [],
  );

  return { room, state, participants, connect, disconnect };
}
