import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/routes/paths";

/** Reusable 404 screen rendered for any unmatched route (outside the shells). */
export function NotFound() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md space-y-4 text-center">
        <Badge variant="secondary">404</Badge>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">Page not found</h1>
        <p className="text-sm text-pretty text-muted-foreground">
          The page you were looking for does not exist or has moved.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to={ROUTES.home}>Go to home</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to={ROUTES.login}>Sign in</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
