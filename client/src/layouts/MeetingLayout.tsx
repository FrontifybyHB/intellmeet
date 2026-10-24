import { Outlet } from "react-router-dom";

export function MeetingLayout() {
  return (
    <div className="h-svh w-screen overflow-hidden bg-background text-foreground">
      <Outlet />
    </div>
  );
}
