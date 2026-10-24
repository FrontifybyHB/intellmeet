// Dev-only route table.
//
// This module is only ever reached through a compile-time guarded dynamic
// import (`import.meta.env.DEV ? lazy(() => import("@/dev/DevRoutes")) : null`),
// so a production build never emits it and never emits the LiveKit /
// Socket.IO chunks the labs pull in.
//
// The routes are declared as children of the app's `/dev/*` route, so their
// paths are relative to that prefix: "lab" is "/dev/lab".

import { Route, Routes } from "react-router-dom";

import { ApiTestBench } from "@/dev/pages/api-bench/ApiTestBench";
import { MeetingLab } from "@/dev/pages/meeting-lab/MeetingLab";
import { PostMeeting } from "@/dev/pages/post-meeting/PostMeeting";

export function DevRoutes() {
  return (
    <Routes>
      <Route path="lab" element={<MeetingLab />} />
      <Route path="post" element={<PostMeeting />} />
      <Route path="bench" element={<ApiTestBench />} />
      <Route
        path="*"
        element={<p className="p-6 text-sm text-muted-foreground">Unknown dev route.</p>}
      />
    </Routes>
  );
}

export default DevRoutes;
