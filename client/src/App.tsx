import { BrowserRouter } from "react-router-dom";

import { AuthProvider } from "@/auth/AuthContext";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { AppRoutes } from "@/routes/AppRoutes";

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
          <Toaster position="top-right" closeButton />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
