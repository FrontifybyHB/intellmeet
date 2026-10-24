// Route-level composition for the meeting creation screen.
//
// The creation form belongs to the meetings feature; this page binds it to
// the route. The screen stays on the form after a successful creation so the
// share link can be copied — it does not navigate away.

import { CreateMeeting } from "@/features/meetings/CreateMeeting";

export function NewMeetingPage() {
  return <CreateMeeting />;
}
