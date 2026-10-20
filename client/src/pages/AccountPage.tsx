import { LogOut, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { useAuth } from "@/auth/AuthContext";
import { ConfirmationDialog } from "@/components/common/ConfirmationDialog";
import { PageHeader } from "@/components/common/PageHeader";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { initialsOf } from "@/lib/initials";
import { ApiError, apiFetch } from "@/services/api";

export function AccountPage() {
  const { user, logout } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const logoutAll = async () => {
    setMessage(null);
    try {
      await apiFetch<{ ok: boolean }>("/auth/logout-all", {
        method: "POST",
        body: {},
      });
      await logout();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not sign out everywhere.");
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch<{ ok: boolean; requireRelogin: boolean }>("/auth/change-password", {
        method: "PATCH",
        body: { currentPassword, newPassword },
      });
      // Server invalidates all credentials on password change: sign in again.
      await logout();
      setMessage("Password changed. Please sign in again.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CURRENT_PASSWORD") {
        setMessage("Current password is incorrect.");
      } else {
        setMessage(err instanceof Error ? err.message : "Could not change password.");
      }
    } finally {
      setBusy(false);
      setCurrentPassword("");
      setNewPassword("");
    }
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
            <form onSubmit={changePassword} className="space-y-4">
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
              <Button type="submit" disabled={busy}>
                {busy ? "Changing…" : "Change password"}
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
            onConfirm={logoutAll}
          />
        </CardContent>
      </Card>
    </div>
  );
}
