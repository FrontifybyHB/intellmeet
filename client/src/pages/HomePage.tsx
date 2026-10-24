// Route-level composition for the authenticated landing screen.
//
// The screen itself belongs to the home feature; this page only binds it to
// the route and the session.

import { HomeDashboard } from "@/features/home/HomeDashboard";

export function HomePage() {
  return <HomeDashboard />;
}
