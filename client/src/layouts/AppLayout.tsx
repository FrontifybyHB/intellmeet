import { useState } from "react";
import {
  ChevronsUpDown,
  FileText,
  FlaskConical,
  House,
  LogOut,
  Menu,
  Terminal,
  UserRound,
  Video,
  type LucideIcon,
} from "lucide-react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { useAuth } from "@/auth/AuthContext";
import { Brand } from "@/components/common/Brand";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { IS_DEV } from "@/config/env";
import { initialsOf } from "@/lib/initials";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/routes/paths";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { to: ROUTES.home, label: "Home", icon: House, end: true },
  { to: ROUTES.meetings, label: "Meetings", icon: Video },
  { to: ROUTES.account, label: "Account", icon: UserRound },
];

// Contract tools stay out of production navigation entirely.
const DEV_NAV: NavItem[] = IS_DEV
  ? [
      { to: ROUTES.devLab, label: "Meeting Lab", icon: FlaskConical },
      { to: ROUTES.devPost, label: "Post-meeting", icon: FileText },
      { to: ROUTES.devBench, label: "API Test Bench", icon: Terminal },
    ]
  : [];

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
    "focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar focus-visible:outline-none",
    isActive
      ? "bg-sidebar-accent text-sidebar-accent-foreground"
      : "text-sidebar-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
  );

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <ul className="space-y-1">
      {items.map(({ to, label, icon: Icon, end }) => (
        <li key={to}>
          <NavLink to={to} end={end} onClick={onNavigate} className={navLinkClass}>
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function SidebarSections({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <nav aria-label="Primary">
        <NavList items={PRIMARY_NAV} onNavigate={onNavigate} />
      </nav>
      {DEV_NAV.length > 0 ? (
        <div className="mt-6">
          <p className="px-3 pb-2 text-xs font-semibold tracking-wider text-sidebar-muted-foreground uppercase">
            Dev tools
          </p>
          <nav aria-label="Developer tools">
            <NavList items={DEV_NAV} onNavigate={onNavigate} />
          </nav>
        </div>
      ) : null}
    </>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();

  if (!user) {
    return null;
  }

  const label = user.name || user.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
          aria-label={`Account menu for ${label}`}
        >
          <Avatar className="size-8 border border-sidebar-border">
            <AvatarFallback className="bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
              {initialsOf(label)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-medium text-sidebar-foreground">
              {label}
            </span>
            <span className="block truncate text-xs text-sidebar-muted-foreground">
              {user.email}
            </span>
          </span>
          <ChevronsUpDown
            aria-hidden="true"
            className="size-4 shrink-0 text-sidebar-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-56">
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
          {user.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={ROUTES.account}>
            <UserRound aria-hidden="true" />
            Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void logout()}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarFooter() {
  return (
    <div className="shrink-0 space-y-2 border-t border-sidebar-border p-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-sidebar-muted-foreground">Appearance</span>
        <ThemeToggle className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />
      </div>
      <UserMenu />
    </div>
  );
}

/**
 * Authenticated application shell: dark sidebar on desktop, sheet navigation on
 * mobile, and a single `<main>` landmark that owns the page content.
 */
export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobile = () => setMobileOpen(false);

  return (
    <div className="flex min-h-svh w-full bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-svh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-5">
          <Link
            to={ROUTES.home}
            className="rounded-md focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
          >
            <Brand />
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarSections />
        </div>
        <SidebarFooter />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur lg:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button type="button" variant="outline" size="icon" aria-label="Open navigation menu">
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-[17rem] gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground"
            >
              <SheetHeader className="border-b border-sidebar-border px-5 py-4 text-left">
                <SheetTitle className="text-sidebar-foreground">
                  <Brand />
                </SheetTitle>
                <SheetDescription className="sr-only">
                  Browse IntellMeet sections and account settings.
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto px-3 py-4">
                <SidebarSections onNavigate={closeMobile} />
              </div>
              <SidebarFooter />
            </SheetContent>
          </Sheet>

          <Link
            to={ROUTES.home}
            className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Brand />
          </Link>

          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 focus-visible:outline-none sm:px-6 lg:px-8 lg:py-8"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
