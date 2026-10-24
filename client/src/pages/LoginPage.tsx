// Route-level composition for the sign-in screen.
//
// The form belongs to the auth feature; this page binds it to the route and
// resolves where to continue after a successful sign-in.

import { useLocation, useNavigate } from "react-router-dom";

import { LoginForm } from "@/features/auth/AuthForms";
import { ROUTES, resolveRedirectTarget } from "@/app/paths";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <LoginForm
      onSwitch={(view) => navigate(view === "register" ? ROUTES.register : ROUTES.login)}
      onSuccess={() => navigate(resolveRedirectTarget(location.state), { replace: true })}
    />
  );
}
