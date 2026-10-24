// Route-level composition for the registration screen.
//
// The form belongs to the auth feature; this page binds it to the route.
// Registration never signs the user in: the auth feature asks the visitor to
// sign in afterwards.

import { useNavigate } from "react-router-dom";

import { RegisterForm } from "@/features/auth/AuthForms";
import { ROUTES } from "@/app/paths";

export function RegisterPage() {
  const navigate = useNavigate();

  return (
    <RegisterForm
      onSwitch={(view) => navigate(view === "register" ? ROUTES.register : ROUTES.login)}
    />
  );
}
