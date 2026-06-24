import { useCallback, useMemo, useState, type ReactNode } from "react";
import { applyTheme, readInitialTheme, ThemeContext, type ThemeName } from "./theme";

/** Holds the active theme and re-themes the document on change (architecture §8). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(() => readInitialTheme());

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    applyTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: ThemeName = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
