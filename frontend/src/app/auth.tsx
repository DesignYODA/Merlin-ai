import { createContext, useContext, useState, type ReactNode } from "react";

const AUTH_KEY = "glisseo_auth_email";
const ALLOWED_DOMAIN = "itilite.com";

interface AuthState {
  email: string | null;
  login: (email: string) => "ok" | "unauthorized";
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(() => localStorage.getItem(AUTH_KEY));

  function login(raw: string): "ok" | "unauthorized" {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed.endsWith(`@${ALLOWED_DOMAIN}`)) return "unauthorized";
    localStorage.setItem(AUTH_KEY, trimmed);
    setEmail(trimmed);
    return "ok";
  }

  function logout() {
    localStorage.removeItem(AUTH_KEY);
    setEmail(null);
  }

  return <AuthContext.Provider value={{ email, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
