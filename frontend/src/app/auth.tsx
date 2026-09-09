import { createContext, useContext, useState, type ReactNode } from "react";
import { authLogin, authLogout, AUTH_TOKEN_KEY } from "./api";

const AUTH_KEY = "glisseo_auth_email";

interface AuthState {
  email: string | null;
  login: (email: string, password: string) => Promise<"ok" | "invalid">;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(() => localStorage.getItem(AUTH_KEY));

  async function login(rawEmail: string, password: string): Promise<"ok" | "invalid"> {
    const trimmed = rawEmail.trim().toLowerCase();
    let result;
    try {
      result = await authLogin(trimmed, password);
    } catch {
      return "invalid";
    }
    localStorage.setItem(AUTH_KEY, trimmed);
    localStorage.setItem(AUTH_TOKEN_KEY, result.token);
    setEmail(trimmed);
    return "ok";
  }

  function logout() {
    authLogout().catch(() => { /* best-effort — clear client state regardless */ });
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    setEmail(null);
  }

  return <AuthContext.Provider value={{ email, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
