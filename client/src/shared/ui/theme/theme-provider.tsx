import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  THEME_STORAGE_KEY,
  ThemeContext,
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  type ResolvedTheme,
  type Theme,
  type ThemeContextValue,
} from "@/shared/ui/theme/theme-context";

/**
 * Applies and persists the light/dark/system preference.
 *
 * Deliberately separate from AuthContext: the theme is a UI preference stored
 * under its own key, and no authentication data ever touches localStorage.
 * The initial class is set pre-paint by the inline script in index.html, so
 * this provider only keeps React state in sync (no flash of wrong theme).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") {
      return "system";
    }
    try {
      return readStoredTheme(window.localStorage);
    } catch {
      // Reading localStorage can throw when storage is blocked entirely.
      return "system";
    }
  });
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(theme));

  // Apply on mount and whenever the explicit preference changes.
  useEffect(() => {
    const next = resolveTheme(theme);
    setResolvedTheme(next);
    applyResolvedTheme(next);
  }, [theme]);

  // Follow the OS preference while the user is in "system" mode.
  useEffect(() => {
    if (theme !== "system" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next: ResolvedTheme = media.matches ? "dark" : "light";
      setResolvedTheme(next);
      applyResolvedTheme(next);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; the in-memory preference still applies.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
