import { Activity, LayoutGrid, Leaf } from "lucide-react";
import { NavLink } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/", label: "Fleet", icon: LayoutGrid, end: true },
  { to: "/activity", label: "Activity", icon: Activity, end: false },
] as const;

/** Primary navigation rail (architecture §8). Profiles (2b) is intentionally absent in 2a. */
export function SideNav() {
  return (
    <nav
      aria-label="Primary"
      className="border-border bg-shell flex shrink-0 flex-col gap-1 border-r"
      style={{ width: "var(--layout-sidenav-width)", padding: "var(--space-5)" }}
    >
      <div className="text-fg-default mb-4 flex items-center gap-2">
        <Leaf size={20} aria-hidden />
        <span className="font-semibold">Greenhouse</span>
      </div>

      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-md px-3 py-2 text-base ${
              isActive
                ? "bg-accent text-fg-on-accent hover:bg-accent-hover"
                : "text-fg-muted hover:bg-surface-3 hover:text-fg-default"
            }`
          }
        >
          <Icon size={18} aria-hidden />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
