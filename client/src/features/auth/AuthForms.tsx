import { CircleCheck } from "lucide-react";
import { useState } from "react";

import { useAuth } from "@/features/auth/useAuth";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";

const ALERT_CLASS =
  "rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive";

/**
 * Sign-in form. Shared by the /login route and the inline sign-in step of
 * the invite flow, so the callback contract stays in one place.
 */
export function LoginForm({
  onSwitch,
  onSuccess,
}: {
  onSwitch: (view: string) => void;
  /** Called after a successful sign-in; lets a route redirect the user. */
  onSuccess?: () => void;
}) {
  const { login, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLocalError(null);
    try {
      await login(email, password);
      onSuccess?.();
    } catch {
      setLocalError("Invalid email or password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-full max-w-md shadow-lg shadow-primary/5">
      <CardHeader className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">Sign in</h1>
        <CardDescription>Welcome back. Sign in to continue to IntellMeet.</CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {(localError || error) && (
            <p role="alert" className={ALERT_CLASS}>
              {localError || error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="justify-center border-t text-sm text-muted-foreground">
        <span>
          No account?{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-sm font-semibold"
            onClick={() => onSwitch("register")}
          >
            Register
          </Button>
        </span>
      </CardFooter>
    </Card>
  );
}

/**
 * Registration form. Shows a confirmation step instead of signing the user
 * in: registration never auto-authenticates.
 */
export function RegisterForm({ onSwitch }: { onSwitch: (view: string) => void }) {
  const { register, error } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLocalError(null);
    try {
      await register(name, email, password);
      setDone(true);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Card className="w-full max-w-md shadow-lg shadow-primary/5">
        <CardHeader className="items-center space-y-2 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-success/10 text-success">
            <CircleCheck aria-hidden="true" className="size-5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">Account created</h1>
          <CardDescription>Please sign in with your new credentials.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" className="w-full" onClick={() => onSwitch("login")}>
            Go to sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md shadow-lg shadow-primary/5">
      <CardHeader className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">Register</h1>
        <CardDescription>
          Create your IntellMeet account. Passwords need at least 15 characters.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="register-name">Name</Label>
            <Input
              id="register-name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="register-email">Email</Label>
            <Input
              id="register-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="register-password">Password (15+ characters)</Label>
            <Input
              id="register-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={15}
            />
          </div>

          {(localError || error) && (
            <p role="alert" className={ALERT_CLASS}>
              {localError || error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Registering…" : "Register"}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="justify-center border-t text-sm text-muted-foreground">
        <span>
          Have an account?{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-sm font-semibold"
            onClick={() => onSwitch("login")}
          >
            Sign in
          </Button>
        </span>
      </CardFooter>
    </Card>
  );
}
