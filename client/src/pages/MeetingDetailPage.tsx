// Route-level composition for the meeting detail screen.
//
// The meeting surface belongs to the meetings feature; this page binds it to
// the route.

import { MeetingDetailPage as MeetingDetail } from "@/features/meetings/MeetingDetailPage";

export function MeetingDetailPage() {
  return <MeetingDetail />;
}
