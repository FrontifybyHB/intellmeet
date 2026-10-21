import { Video } from "lucide-react";

import { cn } from "@/lib/utils";

/** Product wordmark used by both application and authentication shells. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm"
      >
        <Video className="size-4" />
      </span>
      <span className="text-base font-semibold tracking-tight">IntellMeet</span>
    </span>
  );
}
