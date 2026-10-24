import { createContext, useContext } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** localStorage key for the theme preference (never authentication data). */
export const THEME_STORAGE_KEY = "intellmeet-theme";

export interface ThemeContextValue {
  /** Explicit user preference, including "system". */
  theme: Theme;
  /** Actual applied theme, with "system" resolved against the OS preference. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Reads the persisted preference, tolerating blocked/invalid storage. */
export function readStoredTheme(storage: Storage | undefined): Theme {
  if (!storage) {
    return "system";
  }
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") {
      return raw;
    }
  } catch {
    // Storage can be unavailable (private mode, blocked cookies).
  }
  return "system";
}

export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Applies the resolved theme to the document root (class + native form controls). */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider.");
  }
  return context;
}
