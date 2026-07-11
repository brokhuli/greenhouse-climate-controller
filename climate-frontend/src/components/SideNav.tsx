import { Activity, LayoutGrid, Sparkle, Sprout, type LucideIcon } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useTheme } from "../hooks/theme";

type NavItem = {
  to: string;
  label: string;
  end: boolean;
  icon: LucideIcon;
};

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Fleet", icon: LayoutGrid, end: true },
  { to: "/profiles", label: "Profiles", icon: Sprout, end: false },
  { to: "/activity", label: "Activity", icon: Activity, end: false },
  { to: "/verdant-force", label: "Optimizer", icon: Sparkle, end: false },
];

/** Primary navigation rail (architecture §8). */
export function SideNav() {
  const { theme } = useTheme();
  const brandIcon = theme === "dark" ? "/favicon-dark.svg" : "/favicon-light.svg";

  return (
    <nav
      aria-label="Primary"
      className="border-border bg-shell flex shrink-0 flex-col gap-1 border-r"
      style={{ width: "var(--layout-sidenav-width)", padding: "var(--space-5)" }}
    >
      <div className="text-fg-default mb-4 flex items-center gap-2">
        <img src={brandIcon} alt="" aria-hidden className="size-8 shrink-0" />
        <span className="font-semibold">Verdant</span>
      </div>

      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-md px-3 py-2 text-base ${
              isActive
                ? "bg-accent text-fg-on-accent hover:bg-accent-hover"
                : "text-fg-muted hover:bg-surface-3 hover:text-fg-default"
            }`
          }
        >
          <item.icon size={18} aria-hidden />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
