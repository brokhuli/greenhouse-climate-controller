import { useMatch } from "react-router-dom";
import { useGreenhouse } from "../api/queries/greenhouses";
import { useStream } from "../app/stream-context";
import { ConnectionStatus } from "./ConnectionStatus";
import { connectionStateFromWs } from "./connection";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Header strip: current scope (site or greenhouse name), the live connection status, and the theme
 * toggle (components §1). The scope follows the route; the status reflects the single stream.
 */
export function TopBar() {
  const { connectionState } = useStream();
  const detailMatch = useMatch("/greenhouses/:id");
  const activityMatch = useMatch("/activity");
  const greenhouseId = detailMatch?.params.id ?? "";
  const greenhouse = useGreenhouse(greenhouseId);

  let title = "Fleet Overview";
  let subtitle = "Fleet operations console";
  if (greenhouseId) {
    title = greenhouse.data?.displayName ?? `Greenhouse ${greenhouseId}`;
    subtitle = greenhouse.data?.crop ?? "Greenhouse detail";
  } else if (activityMatch) {
    title = "Activity";
    subtitle = "Faults, interlocks & operator writes";
  }

  return (
    <header
      className="border-border bg-surface-1 flex shrink-0 items-center justify-between border-b px-6"
      style={{ height: "var(--layout-topbar-height)" }}
    >
      <div className="min-w-0">
        <h1 className="text-fg-default truncate text-lg font-semibold">{title}</h1>
        <p className="text-fg-muted truncate text-sm">{subtitle}</p>
      </div>
      <div className="flex items-center gap-3">
        <ConnectionStatus state={connectionStateFromWs(connectionState)} />
        <ThemeToggle />
      </div>
    </header>
  );
}
