import { ArrowRight, CalendarPlus, UserRound, Video } from "lucide-react";
import { Link } from "react-router-dom";

import { useAuth } from "@/auth/AuthContext";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ROUTES } from "@/routes/paths";

/**
 * Authenticated landing screen. Deliberately minimal: the dashboard module
 * (stats, activity, responsive shell) is a later phase.
 */
export function HomePage() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Welcome to IntellMeet"
        description="Your meeting and collaboration workspace starts here."
        actions={
          <Button asChild>
            <Link to={ROUTES.newMeeting}>
              <CalendarPlus aria-hidden="true" />
              New meeting
            </Link>
          </Button>
        }
      />

      {user && (
        <p className="text-sm text-muted-foreground">
          Signed in as{" "}
          <span className="font-medium text-foreground">{user.name || user.email}</span>
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Video aria-hidden="true" className="size-4 text-primary" />
              Meetings
            </CardTitle>
            <CardDescription>Review existing meetings or create a new share link.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link to={ROUTES.meetings}>
                Go to meetings
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserRound aria-hidden="true" className="size-4 text-primary" />
              Account
            </CardTitle>
            <CardDescription>Update your password and manage active sessions.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link to={ROUTES.account}>
                Manage account
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
