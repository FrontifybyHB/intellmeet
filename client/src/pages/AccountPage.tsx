// Route-level composition for the account screen.
//
// The panel belongs to the account feature; this page binds it to the route.

import { AccountPanel } from "@/features/account/AccountPanel";

export function AccountPage() {
  return <AccountPanel />;
}
