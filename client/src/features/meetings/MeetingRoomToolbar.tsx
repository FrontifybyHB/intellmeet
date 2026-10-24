import { Camera, Grid2X2, LogOut, PhoneOff, Presentation, Users } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";

export type MeetingViewMode = "grid" | "speaker" | "screen";

interface MeetingRoomToolbarProps {
  title: string;
  connected: boolean;
  participantCount: number;
  viewMode: MeetingViewMode;
  onViewModeChange: (mode: MeetingViewMode) => void;
  onLeave: () => void;
  onEnd: () => void;
  canEnd: boolean;
}

const views: Array<{ mode: MeetingViewMode; label: string; icon: typeof Grid2X2 }> = [
  { mode: "grid", label: "Grid view", icon: Grid2X2 },
  { mode: "speaker", label: "Speaker view", icon: Camera },
  { mode: "screen", label: "Presentation view", icon: Presentation },
];

export function MeetingRoomToolbar({
  title,
  connected,
  participantCount,
  viewMode,
  onViewModeChange,
  onLeave,
  onEnd,
  canEnd,
}: MeetingRoomToolbarProps) {
  return (
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-border/80 bg-card/80 px-4 py-3 backdrop-blur-md sm:px-6" role="banner">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Camera className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-semibold tracking-tight">{title}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={connected ? "size-2 rounded-full bg-emerald-500" : "size-2 rounded-full bg-muted-foreground"} aria-hidden="true" />
            {connected ? "Connected" : "Connecting"}
          </p>
        </div>
        <span className="hidden items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground sm:flex">
          <Users className="size-3.5" aria-hidden="true" />
          {participantCount}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-lg border border-border bg-muted/50 p-0.5" aria-label="Meeting view">
          {views.map(({ mode, label, icon: Icon }) => (
            <Button
              key={mode}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={label}
              aria-pressed={viewMode === mode}
              className={viewMode === mode ? "bg-background text-primary shadow-sm" : "text-muted-foreground"}
              onClick={() => onViewModeChange(mode)}
            >
              <Icon className="size-4" aria-hidden="true" />
            </Button>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onLeave}>
          <LogOut className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Leave</span>
        </Button>
        {canEnd ? (
          <ConfirmationDialog
            trigger={
              <Button type="button" variant="destructive" size="sm">
                <PhoneOff className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">End meeting</span>
              </Button>
            }
            title="End this meeting for everyone?"
            description="Everyone will be disconnected, and the meeting will move to post-meeting processing. Recording and AI results may finish after you leave."
            confirmLabel="End meeting"
            destructive
            onConfirm={onEnd}
          />
        ) : null}
      </div>
    </header>
  );
}
