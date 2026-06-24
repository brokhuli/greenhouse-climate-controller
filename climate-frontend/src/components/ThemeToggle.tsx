import { Moon, Sun } from "lucide-react";
import { useTheme } from "../hooks/theme";

/** Dark/light theme toggle (architecture §8). Swaps the one `data-theme` attribute. */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      className="border-border text-fg-muted hover:text-fg-default inline-flex items-center justify-center rounded-md border"
      style={{ width: "var(--size-icon-button)", height: "var(--size-icon-button)" }}
    >
      {isDark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </button>
  );
}
