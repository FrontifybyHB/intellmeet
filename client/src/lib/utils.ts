import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conditional class names with Tailwind conflict resolution.
 * Required by shadcn/ui components and used by app-level components too.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
