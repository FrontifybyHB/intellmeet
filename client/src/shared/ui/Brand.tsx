import { cn } from "@/shared/lib/utils";

/** Product wordmark used by both application and authentication shells. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <img src="/logo.webp" alt="" aria-hidden="true" className="size-8 shrink-0 rounded-lg shadow-sm" />
      <span className="text-base font-semibold tracking-tight">IntellMeet</span>
    </span>
  );
}
