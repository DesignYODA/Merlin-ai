import { createContext, useContext, useState, type ReactNode } from "react";
import { authLogin, authLogout, AUTH_TOKEN_KEY } from "./api";

const AUTH_KEY = "glisseo_auth_email";
const USERNAME_KEY = "glisseo_auth_username";
const TITLE_KEY = "glisseo_auth_title";
const ROLE_KEY = "glisseo_auth_role";
const LAST_LOGGED_IN_KEY = "glisseo_auth_lastloggedin";

type Role = "admin" | "member";

interface AuthState {
  email: string | null;
  username: string | null;
  title: string | null;
  role: Role | null;
  lastLoggedIn: number | null;
  login: (email: string, password: string) => Promise<"ok" | "invalid">;
  logout: () => void;
}

interface StoredAuth {
  email: string | null;
  username: string | null;
  title: string | null;
  role: Role | null;
  lastLoggedIn: number | null;
}

const AuthContext = createContext<AuthState | null>(null);

// A logged-in state requires BOTH the email and token keys — email alone (e.g.
// left over from before session tokens existed, or a token that got cleared by
// a 401 elsewhere) must never be treated as authenticated, or route guards that
// check email presence (LoginPage, Layout/SplitLayout/AskAiRoute) will bounce
// the user into a page that immediately fails every data fetch with no valid
// session behind it. username/title/role/lastLoggedIn are written in the same
// login() call as the token, so they're read together and cleared together too.
function _readStoredAuth(): StoredAuth {
  const storedEmail = localStorage.getItem(AUTH_KEY);
  const storedToken = localStorage.getItem(AUTH_TOKEN_KEY);
  if (storedEmail && storedToken) {
    return {
      email: storedEmail,
      username: localStorage.getItem(USERNAME_KEY),
      title: localStorage.getItem(TITLE_KEY),
      role: (localStorage.getItem(ROLE_KEY) as Role | null) ?? "member",
      lastLoggedIn: (() => {
        const raw = localStorage.getItem(LAST_LOGGED_IN_KEY);
        return raw ? Number(raw) : null;
      })(),
    };
  }
  if (storedEmail || storedToken) {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
    localStorage.removeItem(TITLE_KEY);
    localStorage.removeItem(ROLE_KEY);
    localStorage.removeItem(LAST_LOGGED_IN_KEY);
  }
  return { email: null, username: null, title: null, role: null, lastLoggedIn: null };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoredAuth>(_readStoredAuth);

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
    localStorage.setItem(USERNAME_KEY, result.username);
    localStorage.setItem(TITLE_KEY, result.title);
    localStorage.setItem(ROLE_KEY, result.role);
    localStorage.setItem(LAST_LOGGED_IN_KEY, String(result.lastloggedin ?? ""));
    setState({
      email: trimmed,
      username: result.username,
      title: result.title,
      role: result.role,
      lastLoggedIn: result.lastloggedin,
    });
    return "ok";
  }

  function logout() {
    authLogout().catch(() => { /* best-effort — clear client state regardless */ });
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
    localStorage.removeItem(TITLE_KEY);
    localStorage.removeItem(ROLE_KEY);
    localStorage.removeItem(LAST_LOGGED_IN_KEY);
    setState({ email: null, username: null, title: null, role: null, lastLoggedIn: null });
  }

  return <AuthContext.Provider value={{ ...state, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
