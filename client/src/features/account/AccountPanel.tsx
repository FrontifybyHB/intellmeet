// Account surface content.
//
// The panel owns the account UI; the /auth endpoints it needs live in the
// auth feature, so there is exactly one place that knows how to sign out or
// change a password.

import { LogOut, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { useAuth } from "@/features/auth/useAuth";
import { changePasswordRequest, logoutAllRequest } from "@/features/auth/api";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Avatar, AvatarFallback } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Separator } from "@/shared/ui/separator";
import { initialsOf } from "@/shared/lib/initials";
import { ApiError } from "@/shared/api/errors";
import { useAsyncAction } from "@/shared/hooks/useAsyncAction";

export function AccountPanel() {
  const { user, logout } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const logoutEverywhere = useAsyncAction(
    async () => {
      await logoutAllRequest();
      await logout();
    },
    {
      fallbackMessage: "Could not sign out everywhere.",
      formatError: (err) =>
        err instanceof Error && err.message ? err.message : "Could not sign out everywhere.",
    },
  );

  const changePassword = useAsyncAction(
    async () => {
      await changePasswordRequest(currentPassword, newPassword);
      // Server invalidates all credentials on password change: sign in again.
      await logout();
      setMessage("Password changed. Please sign in again.");
    },
    {
      fallbackMessage: "Could not change password.",
      formatError: (err) => {
        if (err instanceof ApiError && err.code === "INVALID_CURRENT_PASSWORD") {
          return "Current password is incorrect.";
        }
        return err instanceof Error && err.message ? err.message : "Could not change password.";
      },
    },
  );

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    await changePassword.run();
    setCurrentPassword("");
    setNewPassword("");
  };

  const signOutEverywhere = async () => {
    setMessage(null);
    await logoutEverywhere.run();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account"
        description="Manage your profile, password and signed-in sessions."
      />

      {message && (
        <p
          role="status"
          className="rounded-lg border bg-muted/60 px-3 py-2 text-sm text-foreground"
        >
          {message}
        </p>
      )}

      {logoutEverywhere.error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {logoutEverywhere.error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>The account you are currently using.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Avatar className="size-12 border">
                <AvatarFallback className="bg-primary/10 text-sm font-semibold text-primary">
                  {user ? initialsOf(user.name || user.email) : "?"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{user?.name || "Signed in"}</p>
                <p className="truncate text-sm text-muted-foreground">{user?.email}</p>
              </div>
            </div>

            <Separator />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant="secondary" className="gap-1">
                <ShieldCheck aria-hidden="true" className="size-3.5" />
                Active session
              </Badge>
              <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
                <LogOut aria-hidden="true" />
                Sign out
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              Changing your password signs you out everywhere so old credentials stop working.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitPassword} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="current-password">Current password</Label>
                  <Input
                    id="current-password"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-password">New password (15+ characters)</Label>
                  <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={15}
                  />
                </div>
              </div>

              {changePassword.error && (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                >
                  {changePassword.error}
                </p>
              )}

              <Button type="submit" disabled={changePassword.pending}>
                {changePassword.pending ? "Changing…" : "Change password"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>
            Signing out clears this browser&apos;s cookies. Other browsers stay signed in until you
            choose &ldquo;Sign out everywhere&rdquo;, which invalidates all credentials for this
            account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConfirmationDialog
            destructive
            trigger={
              <Button type="button" variant="destructive">
                <LogOut aria-hidden="true" />
                Sign out everywhere
              </Button>
            }
            title="Sign out everywhere?"
            description="This invalidates every active session for your account, including this browser. You will need to sign in again."
            confirmLabel="Sign out everywhere"
            onConfirm={signOutEverywhere}
          />
        </CardContent>
      </Card>
    </div>
  );
}
