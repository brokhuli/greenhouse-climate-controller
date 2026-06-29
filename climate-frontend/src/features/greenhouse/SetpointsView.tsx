import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useGreenhouse } from "../../api/queries/greenhouses";
import { ErrorState } from "../../components/ui/ErrorState";
import { Skeleton } from "../../components/ui/Skeleton";
import { SetpointEditForm } from "./SetpointEditForm";

const SECTION_STYLE = { gap: "var(--layout-section-gap)" };

/**
 * The dedicated setpoint-editing view (components §3). Split out from the detail page so the write
 * is a deliberate, focused task rather than a card to scroll past. The detail query is usually warm
 * in cache when navigated here, so this resolves without a second round-trip.
 */
export default function SetpointsView() {
  const { id = "" } = useParams<{ id: string }>();
  const greenhouse = useGreenhouse(id);
  const detail = greenhouse.data;

  if (greenhouse.isLoading) {
    return (
      <div className="flex flex-col" style={SECTION_STYLE}>
        <Skeleton height={24} />
        <Skeleton height={460} />
      </div>
    );
  }

  if (!detail) {
    return (
      <ErrorState
        title="Couldn't load this greenhouse"
        message={greenhouse.error?.message}
        onRetry={() => void greenhouse.refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col" style={SECTION_STYLE}>
      <Link
        to={`/greenhouses/${id}`}
        className="text-fg-muted hover:text-fg-default inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft size={14} aria-hidden />
        Back to {detail.displayName}
      </Link>
      <SetpointEditForm
        greenhouseId={id}
        setpoints={detail.setpoints}
        offline={detail.status === "offline"}
      />
    </div>
  );
}
