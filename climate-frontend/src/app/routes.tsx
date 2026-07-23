import { lazy } from "react";
import { Route, Routes } from "react-router-dom";

// Route-level code splitting: each view is a lazy module so the fleet landing bundle excludes
// the detail view (frontend tech-stack §Vite, components §5).
const FleetOverview = lazy(() => import("../features/fleet/FleetOverview"));
const GreenhouseDetail = lazy(() => import("../features/greenhouse/GreenhouseDetail"));
const SetpointsView = lazy(() => import("../features/greenhouse/SetpointsView"));
const ActivityFeed = lazy(() => import("../features/activity/ActivityFeed"));
const ProfileManagement = lazy(() => import("../features/profiles/ProfileManagement"));
const OptimizerConsole = lazy(() => import("../features/optimizer/OptimizerConsole"));
const LoginCallback = lazy(() => import("../features/auth/LoginCallback"));
const NotFound = lazy(() => import("../features/NotFound"));

/** The client-side route tree (architecture §3). */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<FleetOverview />} />
      <Route path="/greenhouses/:id" element={<GreenhouseDetail />} />
      <Route path="/greenhouses/:id/setpoints" element={<SetpointsView />} />
      <Route path="/profiles" element={<ProfileManagement />} />
      <Route path="/activity" element={<ActivityFeed />} />
      <Route path="/optimizer" element={<OptimizerConsole />} />
      <Route path="/login/callback" element={<LoginCallback />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
