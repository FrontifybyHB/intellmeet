import { Users } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ROUTES } from "@/routes/paths";

/**
 * Meeting detail placeholder. It exposes the meeting id so flows that land
 * here (invite join, creation) can be verified; the detail view itself
 * (status pointers, participants, recordings, AI output) is a later phase.
 */
export function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Meeting"
        description="Participants, recordings and post-meeting output will appear here."
        actions={
          <Button asChild variant="outline">
            <Link to={ROUTES.meetings}>Back to meetings</Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Meeting details</CardTitle>
          <CardDescription>Identifiers used by invite and realtime flows.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">Meeting ID</dt>
            <dd className="font-mono break-all text-foreground" data-testid="meeting-id">
              {id}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <EmptyState
        icon={Users}
        title="Nothing here yet"
        description="Live participants, recordings and AI follow-ups arrive in a later phase."
      />
    </div>
  );
}
