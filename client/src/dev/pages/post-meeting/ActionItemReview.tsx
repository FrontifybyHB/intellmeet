// Action-item review panel for the post-meeting lab.
//
// Presentational: the screen owns the review/task calls and hands the
// handlers down.

import type { ActionItem } from "@/dev/pages/post-meeting/api";

export function ActionItemReview({
  items,
  onReview,
  onCreateTask,
}: {
  items: ActionItem[];
  onReview: (item: ActionItem, action: "approve" | "reject") => void;
  onCreateTask: (item: ActionItem) => void;
}) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          {item.proposal.title} [{item.state}] task:{item.task.status}
          {item.state === "proposed" && (
            <>
              <button type="button" onClick={() => onReview(item, "approve")}>
                Approve
              </button>
              <button type="button" onClick={() => onReview(item, "reject")}>
                Reject
              </button>
            </>
          )}
          {item.state === "approved" && item.task.status !== "created" && (
            <button type="button" onClick={() => onCreateTask(item)}>Create task</button>
          )}
        </li>
      ))}
    </ul>
  );
}
