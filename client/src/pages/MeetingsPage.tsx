import { Plus, Video } from "lucide-react";
import { Link } from "react-router-dom";

import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/routes/paths";

/**
 * Meetings index placeholder. Meeting list/search/filter/pagination is the
 * meeting-management phase; creation already exists and is linked here.
 */
export function MeetingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Meetings"
        description="Your meeting list and management tools will live here."
        actions={
          <Button asChild>
            <Link to={ROUTES.newMeeting}>
              <Plus aria-hidden="true" />
              New meeting
            </Link>
          </Button>
        }
      />

      <EmptyState
        icon={Video}
        title="No meetings yet"
        description="Create a meeting to get a share link you can send to participants."
        action={
          <Button asChild variant="outline">
            <Link to={ROUTES.newMeeting}>Create a meeting</Link>
          </Button>
        }
      />
    </div>
  );
}
