// Route-level composition for the meetings index.
//
// The list itself belongs to the meetings feature; this page binds it to the
// route.

import { MeetingsOverview } from "@/features/meetings/MeetingsOverview";

export function MeetingsPage() {
  return <MeetingsOverview />;
}
