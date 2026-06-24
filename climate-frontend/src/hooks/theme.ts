import { createContext, useContext } from "react";

export type ThemeName = "dark" | "light";

export type ThemeContextValue = {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  toggleTheme: () => void;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}

/** Apply a theme to the document and remember it (mirrors the pre-paint script in index.html). */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // localStorage can be unavailable (private mode); the attribute swap still works.
  }
}

/** Read the theme the pre-paint script already resolved onto <html>, defaulting to dark. */
export function readInitialTheme(): ThemeName {
  const current = document.documentElement.getAttribute("data-theme");
  return current === "light" ? "light" : "dark";
}
