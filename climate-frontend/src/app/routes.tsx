import { lazy } from "react";
import { Route, Routes } from "react-router-dom";

// Route-level code splitting: each view is a lazy module so the fleet landing bundle excludes
// the detail view (frontend tech-stack §Vite, components §5).
const FleetOverview = lazy(() => import("../features/fleet/FleetOverview"));
const GreenhouseDetail = lazy(() => import("../features/greenhouse/GreenhouseDetail"));
const ActivityFeed = lazy(() => import("../features/activity/ActivityFeed"));
const NotFound = lazy(() => import("../features/NotFound"));

/** The client-side route tree (architecture §3). 2b routes (/profiles…) are deferred. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<FleetOverview />} />
      <Route path="/greenhouses/:id" element={<GreenhouseDetail />} />
      <Route path="/activity" element={<ActivityFeed />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
