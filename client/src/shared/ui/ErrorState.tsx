import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * Human-readable failure block. The message keeps `role="alert"` so existing
 * error announcements (and any consumers relying on them) keep working.
 */
export function ErrorState({
  title = "Something went wrong",
  message,
  action,
  className,
}: {
  title?: string;
  message: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 sm:p-5",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p role="alert" className="text-sm text-pretty text-muted-foreground">
            {message}
          </p>
        </div>
      </div>
      {action ? <div className="flex flex-wrap gap-2 pl-8">{action}</div> : null}
    </div>
  );
}
