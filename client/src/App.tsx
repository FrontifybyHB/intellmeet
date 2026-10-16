import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LoginPage, RegisterPage } from "./pages/AuthPages";
import { AccountPage } from "./pages/AccountPage";
import { MeetingLab } from "./pages/MeetingLab";
import { PostMeeting } from "./pages/PostMeeting";
import { ApiTestBench } from "./pages/ApiTestBench";
import { CreateMeeting, JoinView, joinCodeFromLocation, validReturnPath } from "./pages/ShareLinks";

function Shell() {
  const { user, loading, logout } = useAuth();
  const [view, setView] = useState("login");
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [labMeetingId, setLabMeetingId] = useState("");

  // Invite links work on direct navigation/reload with no router or
  // hosting change: both path-style /join/<code> (needs a static-host
  // SPA fallback to serve index.html — reported prerequisite) and
  // hash-style #/join/<code> (works everywhere) are accepted.
  useEffect(() => {
    const pick = () => {
      const code = joinCodeFromLocation();
      // Allowlisted same-app path only; anything else is ignored.
      if (code && validReturnPath(`/join/${code}`)) {
        setJoinCode(code);
        setView("join");
      }
    };
    pick();
    window.addEventListener("hashchange", pick);
    return () => window.removeEventListener("hashchange", pick);
  }, []);

  if (loading) {
    return (
      <main>
        <p>Checking your session…</p>
      </main>
    );
  }

  if (!user) {
    // Invite links survive logout: JoinView signs the user in inline
    // and returns to the exact meeting (no tokens in URLs/storage).
    if (view === "join" && joinCode) {
      return <JoinView code={joinCode} onJoined={(id) => { setLabMeetingId(id); setView("join"); }} />;
    }
    if (view === "register") {
      return <RegisterPage onSwitch={setView} />;
    }
    return <LoginPage onSwitch={setView} />;
  }

  if (view === "join" && joinCode) {
    return (
      <>
        <nav>
          <button type="button" onClick={() => setView("home")}>
            Home
          </button>
        </nav>
        <JoinView
          code={joinCode}
          onJoined={(id) => {
            setLabMeetingId(id);
            setView("lab");
          }}
        />
      </>
    );
  }

  if (view === "create") {
    return (
      <>
        <nav>
          <button type="button" onClick={() => setView("home")}>
            Home
          </button>
        </nav>
        <ProtectedRoute>
          <CreateMeeting onCreated={(id) => setLabMeetingId(id)} />
        </ProtectedRoute>
      </>
    );
  }

  if (view === "account") {
    return (
      <>
        <nav>
          <button type="button" onClick={() => setView("home")}>
            Home
          </button>
        </nav>
        <ProtectedRoute>
          <AccountPage />
        </ProtectedRoute>
      </>
    );
  }

  if (view === "lab") {
    return (
      <>
        <nav>
          <button type="button" onClick={() => setView("home")}>
            Home
          </button>
        </nav>
        <ProtectedRoute>
          <MeetingLab initialMeetingId={labMeetingId} />
        </ProtectedRoute>
      </>
    );
  }

  if (view === "post") {
    return (
      <>
        <nav>
          <button type="button" onClick={() => setView("home")}>
            Home
          </button>
        </nav>
        <ProtectedRoute>
          <PostMeeting />
        </ProtectedRoute>
      </>
    );
  }

  if (view === "bench") {
    return (
      <>
        <nav>
          <button type="button" onClick={() => setView("home")}>
            Home
          </button>
        </nav>
        <ProtectedRoute>
          <ApiTestBench />
        </ProtectedRoute>
      </>
    );
  }

  return (
    <main>
      <h1>Welcome to IntellMeet</h1>
      <p>Your meeting and collaboration workspace starts here.</p>
      <nav>
        <button type="button" onClick={() => setView("account")}>
          Account
        </button>
        <button type="button" onClick={() => setView("create")}>
          New meeting
        </button>
        <button type="button" onClick={() => setView("lab")}>
          Meeting Lab
        </button>
        <button type="button" onClick={() => setView("post")}>
          Post-meeting
        </button>
        <button type="button" onClick={() => setView("bench")}>
          API Test Bench
        </button>
        <button type="button" onClick={() => void logout()}>
          Sign out
        </button>
      </nav>
    </main>
  );
}

function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

export default App;
