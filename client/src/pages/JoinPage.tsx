// Route-level composition for the invite landing.
//
// The invite flow belongs to the meetings feature; this page binds it to the
// route and performs the navigation once the meeting was joined.

import { useNavigate, useParams } from "react-router-dom";

import { JoinInvite } from "@/features/meetings/JoinInvite";
import { meetingPath } from "@/app/paths";
import { putJoinHandoff } from "@/features/meetings/api";

export function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  return (
    <JoinInvite
      code={code ?? ""}
      onJoined={(result, preferences) => {
        putJoinHandoff(result);
        navigate(meetingPath(result.meetingId), { replace: true, state: { preferences } });
      }}
    />
  );
}
