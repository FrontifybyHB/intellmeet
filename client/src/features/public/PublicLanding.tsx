import {
  ArrowRight,
  AudioLines,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  FileText,
  Link2,
  Menu,
  MonitorUp,
  PanelTop,
  ShieldCheck,
  Sparkles,
  Video,
  X,
  Zap,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { ROUTES } from "@/app/paths";
import { resolveJoinDestination } from "@/features/public/links";
import { Brand } from "@/shared/ui/Brand";
import { Button } from "@/shared/ui/button";
import { ThemeToggle } from "@/shared/ui/theme/theme-toggle";
import { cn } from "@/shared/lib/utils";

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#solutions", label: "Solutions" },
  { href: "#security", label: "Security" },
];

const STEPS = [
  {
    number: "01",
    title: "Create & share",
    description:
      "Generate a focused meeting link and bring people into the conversation without unnecessary setup.",
    footer: "One link. Zero friction.",
    icon: Link2,
  },
  {
    number: "02",
    title: "Meet & collaborate",
    description:
      "Keep the room clear with audio, video, chat, captions and intentional controls that respect every participant.",
    footer: "A calmer room for better work.",
    icon: AudioLines,
  },
  {
    number: "03",
    title: "Review & follow through",
    description:
      "Turn the conversation into a reviewable summary and clear next steps once the meeting is complete.",
    footer: "Conversation becomes momentum.",
    icon: ClipboardCheck,
  },
];

const SECURITY_ITEMS = [
  [ShieldCheck, "Consent-aware", "Recording and processing states are visible and intentional."],
  [
    FileText,
    "Evidence-linked output",
    "Review transcripts and action items before acting on them.",
  ],
  [PanelTop, "Browser-first", "Join and collaborate from the workflow your team already uses."],
  [
    CircleHelp,
    "Honest states",
    "Unavailable provider capabilities are surfaced instead of simulated.",
  ],
] as const;

function SectionEyebrow({ children }: { children: string }) {
  return (
    <p className="text-xs font-semibold tracking-[0.16em] text-primary uppercase">{children}</p>
  );
}

function PreviewTile({
  label,
  tone,
  active = false,
}: {
  label: string;
  tone: string;
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-28 items-end overflow-hidden rounded-lg border bg-card p-3 shadow-inner sm:min-h-36",
        active ? "border-primary ring-2 ring-primary/30" : "border-border",
      )}
    >
      <div className={cn("absolute inset-0 opacity-80", tone)} aria-hidden="true" />
      <div className="relative z-10 flex items-center gap-2 rounded-md bg-background/85 px-2 py-1 text-xs font-medium text-foreground backdrop-blur">
        <span
          className={cn(
            "size-2 rounded-full",
            active ? "animate-pulse bg-primary" : "bg-muted-foreground/60",
          )}
        />
        {label}
      </div>
    </div>
  );
}

function ProductPreview() {
  return (
    <div className="relative rounded-2xl border border-border bg-card p-3 shadow-2xl shadow-primary/10 sm:p-4">
      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/60 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 font-semibold">
          <span className="size-2 rounded-full bg-destructive" />
          Product planning
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="rounded bg-background px-2 py-1">HD</span>
          <ShieldCheck aria-hidden="true" className="size-4" />
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <PreviewTile label="Host" tone="bg-gradient-to-br from-primary/30 via-muted to-accent" />
        <PreviewTile
          label="Participant"
          tone="bg-gradient-to-br from-accent via-muted to-primary/20"
        />
        <PreviewTile
          label="Participant"
          tone="bg-gradient-to-br from-muted-foreground/20 via-muted to-primary/20"
        />
        <PreviewTile
          label="Speaking now"
          tone="bg-gradient-to-br from-primary/40 via-accent to-muted"
          active
        />
      </div>
      <div className="absolute inset-x-6 bottom-12 rounded-xl border border-primary/20 bg-background/95 p-3 shadow-xl backdrop-blur sm:inset-x-auto sm:right-6 sm:w-72">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
            <Sparkles aria-hidden="true" className="size-3.5" />
            Live meeting signal
          </span>
          <span className="text-[11px] text-muted-foreground">Preview</span>
        </div>
        <p className="mt-2 text-sm font-medium leading-5">
          Keep the decision visible, then capture the next action.
        </p>
        <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/70 px-2 py-1.5 text-xs text-muted-foreground">
          <CheckCircle2 aria-hidden="true" className="size-3.5 text-primary" />
          Reviewable output after the room
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-muted/60 px-3 py-2">
        <div className="flex gap-2">
          {[AudioLines, Video, MonitorUp].map((Icon) => (
            <span
              key={Icon.displayName ?? Icon.name}
              className="flex size-8 items-center justify-center rounded-md bg-background text-muted-foreground"
            >
              <Icon aria-hidden="true" className="size-4" />
            </span>
          ))}
        </div>
        <span className="flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-xs font-semibold text-destructive">
          <X aria-hidden="true" className="size-3.5" />
          Leave
        </span>
      </div>
    </div>
  );
}

function Hero({ onJoin }: { onJoin: (path: string) => void }) {
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const destination = resolveJoinDestination(invite);
    if (!destination) {
      setError("Enter a valid IntellMeet invite link or code.");
      return;
    }
    setError(null);
    onJoin(destination);
  }
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-12 px-4 py-14 sm:px-6 lg:grid-cols-12 lg:items-center lg:px-8 lg:py-24">
      <div className="lg:col-span-5">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border bg-muted/60 px-3 py-1.5 text-xs font-semibold text-primary">
          <Zap aria-hidden="true" className="size-3.5" />
          AI-native conferencing &amp; workflow engine
        </div>
        <h1 className="max-w-xl text-4xl font-bold tracking-tight text-balance sm:text-6xl">
          Meet clearly.
          <br />
          <span className="text-primary">Leave with a plan.</span>
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-8 text-muted-foreground">
          Video meetings, shared notes and reviewed AI output that keep your team moving—from the
          first hello to the next clear action.
        </p>
        <div className="mt-8 space-y-3">
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to={ROUTES.register}>
                <Video aria-hidden="true" />
                Create a meeting
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <form
              onSubmit={submit}
              className="flex min-w-[min(100%,20rem)] flex-1 items-center rounded-md border bg-card p-1 focus-within:border-primary sm:max-w-sm"
            >
              <Link2 aria-hidden="true" className="mx-2 size-4 shrink-0 text-muted-foreground" />
              <input
                value={invite}
                onChange={(event) => {
                  setInvite(event.target.value);
                  setError(null);
                }}
                className="min-w-0 flex-1 bg-transparent px-1 py-2 text-sm outline-none placeholder:text-muted-foreground"
                placeholder="Paste meeting link..."
                aria-label="Meeting link"
              />
              <Button type="submit" variant="secondary" size="sm">
                Join
              </Button>
            </form>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Check aria-hidden="true" className="size-3.5 text-primary" />
              Free for teams
            </span>
            <span aria-hidden="true">•</span>
            <span>No credit card required</span>
            <span aria-hidden="true">•</span>
            <span>Consent-aware by design</span>
          </div>
        </div>
      </div>
      <div className="lg:col-span-7">
        <ProductPreview />
      </div>
    </section>
  );
}

function StepsSection() {
  const [selected, setSelected] = useState(0);
  const step = STEPS[selected];
  return (
    <section id="how-it-works" className="border-y bg-muted/30 py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <SectionEyebrow>Zero-friction collaboration</SectionEyebrow>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            From initial hello to team follow-through
          </h2>
        </div>
        <div className="md:hidden">
          <StepCard step={step} />
          <div className="mt-4 flex items-center justify-center gap-4">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Previous step"
              onClick={() => setSelected((value) => (value + STEPS.length - 1) % STEPS.length)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <div className="flex gap-1.5" role="tablist" aria-label="How it works steps">
              {STEPS.map((item, index) => (
                <button
                  key={item.number}
                  type="button"
                  role="tab"
                  aria-selected={index === selected}
                  aria-label={`Go to step ${index + 1}`}
                  onClick={() => setSelected(index)}
                  className={cn(
                    "h-2 rounded-full bg-border transition-all",
                    index === selected ? "w-6 bg-primary" : "w-2",
                  )}
                />
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Next step"
              onClick={() => setSelected((value) => (value + 1) % STEPS.length)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="hidden gap-5 md:grid md:grid-cols-3">
          {STEPS.map((item) => (
            <StepCard key={item.number} step={item} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StepCard({ step }: { step: (typeof STEPS)[number] }) {
  const Icon = step.icon;
  return (
    <article className="flex h-full flex-col gap-5 rounded-xl border bg-card p-6 transition-colors hover:border-primary/50">
      <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-sm font-bold text-primary">
        {step.number}
      </div>
      <div>
        <h3 className="text-xl font-semibold">{step.title}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{step.description}</p>
      </div>
      <div className="mt-auto flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
        {step.footer}
      </div>
    </article>
  );
}

function SynthesisSection() {
  return (
    <section id="features" className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
      <div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <SectionEyebrow>Synthesis engine</SectionEyebrow>
          <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
            From raw conversation to structured execution
          </h2>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
          Reviewable by your team
        </div>
      </div>
      <div className="grid gap-5 rounded-2xl border bg-muted/30 p-4 lg:grid-cols-5 lg:p-6">
        <div className="rounded-xl border bg-card p-5 lg:col-span-2">
          <div className="flex items-center gap-2 border-b pb-3 text-sm font-semibold">
            <FileText aria-hidden="true" className="size-4 text-muted-foreground" />
            Verified transcript stream
          </div>
          <div className="mt-5 space-y-4 text-sm">
            {[
              "Capture the important context.",
              "Make decisions easy to find.",
              "Keep the source conversation close.",
            ].map((line, index) => (
              <div key={line}>
                <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                  <span className="size-1.5 rounded-full bg-primary" />
                  Signal 0{index + 1}
                </div>
                <p className="mt-1 rounded-lg border bg-muted/50 p-3 text-muted-foreground">
                  {line}
                </p>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border bg-card p-5 lg:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles aria-hidden="true" className="size-4 text-primary" />
              Synthesized action blueprint
            </div>
            <span className="rounded-md border bg-muted px-2 py-1 text-xs text-muted-foreground">
              Review before sharing
            </span>
          </div>
          <div className="mt-5 space-y-4">
            <div>
              <p className="text-xs font-semibold tracking-wider text-muted-foreground">SUMMARY</p>
              <p className="mt-2 rounded-lg border bg-muted/50 p-3 text-sm leading-6">
                A clear meeting record with the context, decisions and follow-through your team can
                verify.
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold tracking-wider text-muted-foreground">
                NEXT STEPS
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {[
                  "Review the transcript",
                  "Confirm owners",
                  "Share the outcome",
                  "Keep work moving",
                ].map((item) => (
                  <div
                    key={item}
                    className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm"
                  >
                    <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-primary" />
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SecuritySection() {
  return (
    <section id="security" className="border-t bg-muted/30 py-16">
      <div className="mx-auto grid max-w-7xl gap-6 px-4 sm:px-6 md:grid-cols-2 lg:grid-cols-4 lg:px-8">
        {SECURITY_ITEMS.map(([Icon, title, description]) => (
          <div key={title} className="flex gap-3">
            <Icon aria-hidden="true" className="size-6 shrink-0 text-primary" />
            <div>
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PublicLanding() {
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="min-h-svh bg-background text-foreground">
      <span data-testid="landing-route-marker" className="sr-only">
        {location.pathname}
      </span>
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link
            to={ROUTES.home}
            aria-label="IntellMeet home"
            className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Brand />
          </Link>
          <nav className="hidden items-center gap-6 md:flex" aria-label="Primary">
            {NAV_LINKS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <div className="hidden items-center gap-1 sm:flex">
              <Button asChild variant="ghost" size="sm">
                <Link to={ROUTES.login}>Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link to={ROUTES.register}>Get started</Link>
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="md:hidden"
              aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            </Button>
          </div>
        </div>
        {menuOpen ? (
          <nav aria-label="Mobile navigation" className="border-t px-4 py-3 md:hidden">
            <div className="mx-auto grid max-w-7xl gap-1">
              {NAV_LINKS.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {item.label}
                </a>
              ))}
              <div className="mt-2 grid grid-cols-2 gap-2 border-t pt-3">
                <Button asChild variant="outline">
                  <Link to={ROUTES.login}>Sign in</Link>
                </Button>
                <Button asChild>
                  <Link to={ROUTES.register}>Get started</Link>
                </Button>
              </div>
            </div>
          </nav>
        ) : null}
      </header>
      <main>
        <Hero onJoin={(path) => navigate(path)} />
        <StepsSection />
        <SynthesisSection />
        <section id="solutions" className="border-y bg-primary/[0.06] py-14">
          <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-4 sm:px-6 md:flex-row md:items-center lg:px-8">
            <div>
              <SectionEyebrow>For focused teams</SectionEyebrow>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                Make every meeting easier to act on.
              </h2>
            </div>
            <Button asChild variant="outline">
              <Link to={ROUTES.register}>
                Start with IntellMeet <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </section>
        <SecuritySection />
      </main>
      <footer className="border-t py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 px-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Brand />
            <span>© 2026 IntellMeet</span>
          </div>
          <nav aria-label="Footer" className="flex gap-5">
            <a href="#security" className="hover:text-foreground">
              Security
            </a>
            <a href="#features" className="hover:text-foreground">
              Features
            </a>
            <a href="#how-it-works" className="hover:text-foreground">
              How it works
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
