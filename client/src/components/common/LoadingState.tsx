import { Loader2Icon } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Announces asynchronous work to assistive tech while showing a visual
 * placeholder. `role="status"` keeps the label readable by tests and screen
 * readers without duplicating markup at each call site.
 */
export function LoadingState({
  label = "Loading…",
  withSkeleton = false,
  className,
}: {
  label?: string;
  withSkeleton?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex flex-col items-center justify-center gap-3 py-10 text-center", className)}
    >
      <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
        {label}
      </span>
      {withSkeleton ? (
        <div className="w-full max-w-sm space-y-2" aria-hidden="true">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ) : null}
    </div>
  );
}
