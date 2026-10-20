import { Link, Outlet } from "react-router-dom";

import { Brand } from "@/components/common/Brand";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { ROUTES } from "@/routes/paths";

/**
 * Signed-out shell (login, register, invite landing). Owns the page `<main>`
 * landmark and a single background wash so every auth screen shares a frame.
 */
export function AuthLayout() {
  return (
    <div className="relative flex min-h-svh flex-col overflow-hidden bg-background">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-primary/10 via-primary/5 to-transparent"
      />

      <header className="relative z-10 flex h-16 shrink-0 items-center justify-between gap-2 px-4 sm:px-6">
        <Link
          to={ROUTES.home}
          className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Brand />
        </Link>
        <ThemeToggle />
      </header>

      <main className="relative z-10 flex flex-1 items-start justify-center px-4 pt-2 pb-10 sm:items-center sm:px-6">
        <Outlet />
      </main>

      <footer className="relative z-10 shrink-0 px-4 py-4 text-center text-xs text-muted-foreground">
        Secure meetings, transcripts and follow-ups in one workspace.
      </footer>
    </div>
  );
}
