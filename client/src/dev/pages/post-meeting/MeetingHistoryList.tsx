// Meeting history panel for the post-meeting lab.
//
// Presentational: the screen owns the fetching and hands the rows down.

import type { HistoryRow } from "@/dev/pages/post-meeting/api";

export function MeetingHistoryList({
  meetings,
  onSelect,
}: {
  meetings: HistoryRow[];
  onSelect: (meetingId: string) => void;
}) {
  return (
    <ul>
      {meetings.map((meeting) => (
        <li key={meeting.id}>
          <button type="button" onClick={() => onSelect(meeting.id)}>
            {meeting.title || meeting.id} ({meeting.status})
          </button>
        </li>
      ))}
    </ul>
  );
}
