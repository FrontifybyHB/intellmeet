import { BrowserRouter } from "react-router-dom";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { ThemeProvider } from "@/shared/ui/theme/theme-provider";
import { Toaster } from "@/shared/ui/sonner";
import { AppRoutes } from "@/app/AppRoutes";
import { AppErrorBoundary } from "@/shared/ui/AppErrorBoundary";

function App() {
  return (
    <ThemeProvider>
      <AppErrorBoundary>
        <BrowserRouter>
          <AuthProvider>
            <AppRoutes />
            <Toaster position="top-right" closeButton />
          </AuthProvider>
        </BrowserRouter>
      </AppErrorBoundary>
    </ThemeProvider>
  );
}

export default App;
