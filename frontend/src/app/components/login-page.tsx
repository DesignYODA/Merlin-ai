import { useState, type FormEvent } from "react";
import { useNavigate, Navigate } from "react-router";
import { ArrowLeft, ArrowRight, Mail, Lock, User, HelpCircle, ShieldX, CheckCircle2 } from "lucide-react";
import { useAuth } from "../auth";
import { authSignup, authGetSecurityQuestion, authResetPassword } from "../api";
import { GlisseoBase, GlisseoLogo } from "./glisseo-mark";
import { GlisseoGlobe } from "./glisseo-globe";

const SECURITY_QUESTIONS = [
  "What is your mother's maiden name?",
  "What was the name of your first pet?",
  "What is your favorite teacher's name?",
  "What city were you born in?",
  "What was your first employer?",
];

type Mode = "login" | "signup" | "forgot-request" | "forgot-reset";

const inputClass =
  "w-full bg-app-elevated border border-[#2a2a3e] rounded-lg pl-9 pr-4 py-2.5 text-white placeholder-[#3a3a50] outline-none focus:border-[#ec5d25]/60 focus:ring-1 focus:ring-[#ec5d25]/30 transition-all";
const iconClass = "absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#555568] pointer-events-none";
const labelClass = "block text-[#8888a0] mb-1.5" as const;

export function LoginPage() {
  const { email: authedEmail, login } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>("login");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Shared / login fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Signup fields
  const [signupUsername, setSignupUsername] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupConfirmPassword, setSignupConfirmPassword] = useState("");
  const [signupQuestion, setSignupQuestion] = useState(SECURITY_QUESTIONS[0]);
  const [signupAnswer, setSignupAnswer] = useState("");

  // Forgot-password fields
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotQuestion, setForgotQuestion] = useState("");
  const [forgotAnswer, setForgotAnswer] = useState("");
  const [forgotNewPassword, setForgotNewPassword] = useState("");
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState("");

  if (authedEmail) return <Navigate to="/dashboard" replace />;

  function goTo(next: Mode) {
    setMode(next);
    setError("");
    setNotice("");
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await login(email, password);
      if (result === "ok") navigate("/dashboard", { replace: true });
      else setError("Invalid email or password.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignup(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (signupPassword !== signupConfirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (!signupAnswer.trim()) {
      setError("Please answer the security question.");
      return;
    }
    setSubmitting(true);
    try {
      await authSignup({
        email: signupEmail,
        username: signupUsername,
        password: signupPassword,
        securityquestion: signupQuestion,
        answer: signupAnswer,
      });
      setEmail(signupEmail);
      goTo("login");
      setNotice("Account created — you can now sign in.");
    } catch (err) {
      setError((err as Error).message.replace(/^Server error \d+: /, ""));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleForgotRequest(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const { securityquestion } = await authGetSecurityQuestion(forgotEmail);
      setForgotQuestion(securityquestion);
      setMode("forgot-reset");
    } catch (err) {
      setError((err as Error).message.replace(/^Server error \d+: /, ""));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleForgotReset(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (forgotNewPassword !== forgotConfirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await authResetPassword({
        email: forgotEmail,
        answer: forgotAnswer,
        new_password: forgotNewPassword,
      });
      setEmail(forgotEmail);
      goTo("login");
      setNotice("Password reset — you can now sign in.");
    } catch (err) {
      setError((err as Error).message.replace(/^Server error \d+: /, ""));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        height: "100vh",
        overflow: "hidden",
        background: "radial-gradient(ellipse at 50% 38%, #7D2400 0%, #3E0C00 42%, #0B0200 78%)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "'Geist', sans-serif",
      }}
    >
      <style>{`
        @keyframes floatY { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
      `}</style>

      {/* Logo, top-left */}
      <header style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 10, padding: "24px 0 0 48px" }}>
        <GlisseoLogo size={26} />
        <span style={{ fontFamily: "'Fustat', sans-serif", fontWeight: 700, fontSize: "1rem", color: "#fff" }}>
          Glisseo<span style={{ color: "#EC5D25" }}>.</span>AI
        </span>
      </header>

      <main style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", minHeight: 0 }}>
        {/* Left — floating blob */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div
              style={{
                width: 440,
                height: 440,
                animation: "floatY 5s ease-in-out infinite",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  width: 360,
                  height: 360,
                  borderRadius: "50%",
                  background:
                    "radial-gradient(circle, rgba(240,120,68,0.35) 0%, rgba(184,48,0,0.14) 45%, transparent 72%)",
                  filter: "blur(20px)",
                }}
              />
              <div style={{ filter: "drop-shadow(0 30px 50px rgba(0,0,0,0.55))" }}>
                <GlisseoGlobe size={380} />
              </div>
            </div>
            <div style={{ marginTop: -50 }}>
              <GlisseoBase width={360} />
            </div>
          </div>
        </div>

        {/* Right — form */}
        <div className="dark" style={{ display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
          <div className="relative w-full max-w-sm mx-4">
            <div className="bg-app-surface border border-[#1e1e2e] rounded-2xl p-6 shadow-2xl relative">
              {mode !== "login" && (
                <button
                  type="button"
                  onClick={() => goTo("login")}
                  className="absolute top-5 left-5 w-7 h-7 flex items-center justify-center rounded-md text-[#8888a0] hover:text-white hover:bg-white/5 transition-colors"
                  aria-label="Back"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}

              {mode === "login" && (
                <>
                  <h2 className="text-white font-semibold mb-1 text-center" style={{ fontSize: "1.1rem" }}>
                    Sign in
                  </h2>
                  <p className="text-[#555568] mb-5 text-center" style={{ fontSize: "0.8rem" }}>
                    Welcome back to Glisseo AI.
                  </p>

                  {notice && (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <p className="text-emerald-300" style={{ fontSize: "0.78rem" }}>{notice}</p>
                    </div>
                  )}

                  <form onSubmit={handleLogin} className="space-y-3">
                    <div className="relative">
                      <Mail className={iconClass} />
                      <input
                        type="email"
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => { setEmail(e.target.value); setError(""); }}
                        required
                        autoFocus
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>
                    <div className="relative">
                      <Lock className={iconClass} />
                      <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => { setPassword(e.target.value); setError(""); }}
                        required
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>

                    {error && (
                      <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
                        <ShieldX className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        <p className="text-red-300" style={{ fontSize: "0.78rem" }}>{error}</p>
                      </div>
                    )}

                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => { setForgotEmail(email); goTo("forgot-request"); }}
                        className="text-[#8888a0] hover:text-[#ec5d25] transition-colors"
                        style={{ fontSize: "0.72rem" }}
                      >
                        Forgot password?
                      </button>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-[#ec5d25] to-[#c4400e] hover:from-[#f06830] hover:to-[#d44a1a] text-white rounded-lg py-2.5 font-medium transition-all shadow-md shadow-[#ec5d25]/20 disabled:opacity-60"
                      style={{ fontSize: "0.85rem" }}
                    >
                      {submitting ? "Signing in…" : "Continue"}
                      {!submitting && <ArrowRight className="w-4 h-4" />}
                    </button>
                  </form>

                  <p className="text-center text-[#555568] mt-5" style={{ fontSize: "0.78rem" }}>
                    Don't have an account?{" "}
                    <button
                      type="button"
                      onClick={() => goTo("signup")}
                      className="text-[#ec5d25] hover:text-[#f06830] font-medium transition-colors"
                    >
                      Sign up
                    </button>
                  </p>
                </>
              )}

              {mode === "signup" && (
                <>
                  <h2 className="text-white font-semibold mb-1 text-center mt-2" style={{ fontSize: "1.1rem" }}>
                    Create account
                  </h2>
                  <p className="text-[#555568] mb-5 text-center" style={{ fontSize: "0.8rem" }}>
                    Sign up to get started with Glisseo AI.
                  </p>

                  <form onSubmit={handleSignup} className="space-y-3">
                    <div className="relative">
                      <User className={iconClass} />
                      <input
                        type="text"
                        placeholder="Username"
                        value={signupUsername}
                        onChange={(e) => { setSignupUsername(e.target.value); setError(""); }}
                        required
                        autoFocus
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>
                    <div className="relative">
                      <Mail className={iconClass} />
                      <input
                        type="email"
                        placeholder="you@company.com"
                        value={signupEmail}
                        onChange={(e) => { setSignupEmail(e.target.value); setError(""); }}
                        required
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>
                    <div className="relative">
                      <Lock className={iconClass} />
                      <input
                        type="password"
                        placeholder="Password (min. 6 characters)"
                        value={signupPassword}
                        onChange={(e) => { setSignupPassword(e.target.value); setError(""); }}
                        required
                        minLength={6}
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>
                    <div className="relative">
                      <Lock className={iconClass} />
                      <input
                        type="password"
                        placeholder="Confirm password"
                        value={signupConfirmPassword}
                        onChange={(e) => { setSignupConfirmPassword(e.target.value); setError(""); }}
                        required
                        minLength={6}
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>
                    <div>
                      <label className={labelClass} style={{ fontSize: "0.72rem" }}>Security question</label>
                      <div className="relative">
                        <HelpCircle className={iconClass} />
                        <select
                          value={signupQuestion}
                          onChange={(e) => setSignupQuestion(e.target.value)}
                          className={inputClass}
                          style={{ fontSize: "0.85rem", appearance: "none" }}
                        >
                          {SECURITY_QUESTIONS.map((q) => (
                            <option key={q} value={q}>{q}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="relative">
                      <HelpCircle className={iconClass} />
                      <input
                        type="text"
                        placeholder="Your answer"
                        value={signupAnswer}
                        onChange={(e) => { setSignupAnswer(e.target.value); setError(""); }}
                        required
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>

                    {error && (
                      <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
                        <ShieldX className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        <p className="text-red-300" style={{ fontSize: "0.78rem" }}>{error}</p>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-[#ec5d25] to-[#c4400e] hover:from-[#f06830] hover:to-[#d44a1a] text-white rounded-lg py-2.5 font-medium transition-all shadow-md shadow-[#ec5d25]/20 disabled:opacity-60"
                      style={{ fontSize: "0.85rem" }}
                    >
                      {submitting ? "Creating account…" : "Create account"}
                    </button>
                  </form>
                </>
              )}

              {mode === "forgot-request" && (
                <>
                  <h2 className="text-white font-semibold mb-1 text-center mt-2" style={{ fontSize: "1.1rem" }}>
                    Reset password
                  </h2>
                  <p className="text-[#555568] mb-5 text-center" style={{ fontSize: "0.8rem" }}>
                    Enter your account email to continue.
                  </p>

                  <form onSubmit={handleForgotRequest} className="space-y-3">
                    <div className="relative">
                      <Mail className={iconClass} />
                      <input
                        type="email"
                        placeholder="you@company.com"
                        value={forgotEmail}
                        onChange={(e) => { setForgotEmail(e.target.value); setError(""); }}
                        required
                        autoFocus
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>

                    {error && (
                      <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
                        <ShieldX className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        <p className="text-red-300" style={{ fontSize: "0.78rem" }}>{error}</p>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-[#ec5d25] to-[#c4400e] hover:from-[#f06830] hover:to-[#d44a1a] text-white rounded-lg py-2.5 font-medium transition-all shadow-md shadow-[#ec5d25]/20 disabled:opacity-60"
                      style={{ fontSize: "0.85rem" }}
                    >
                      {submitting ? "Checking…" : "Continue"}
                    </button>
                  </form>
                </>
              )}

              {mode === "forgot-reset" && (
                <>
                  <h2 className="text-white font-semibold mb-1 text-center mt-2" style={{ fontSize: "1.1rem" }}>
                    Verify & reset
                  </h2>
                  <p className="text-[#555568] mb-4 text-center" style={{ fontSize: "0.8rem" }}>
                    Answer your security question to reset your password.
                  </p>

                  <form onSubmit={handleForgotReset} className="space-y-3">
                    <p className="text-white/80 bg-app-elevated border border-[#2a2a3e] rounded-lg px-3 py-2.5" style={{ fontSize: "0.8rem" }}>
                      {forgotQuestion}
                    </p>
                    <div className="relative">
                      <HelpCircle className={iconClass} />
                      <input
                        type="text"
                        placeholder="Your answer"
                        value={forgotAnswer}
                        onChange={(e) => { setForgotAnswer(e.target.value); setError(""); }}
                        required
                        autoFocus
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>
                    <div className="relative">
                      <Lock className={iconClass} />
                      <input
                        type="password"
                        placeholder="New password (min. 6 characters)"
                        value={forgotNewPassword}
                        onChange={(e) => { setForgotNewPassword(e.target.value); setError(""); }}
                        required
                        minLength={6}
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>
                    <div className="relative">
                      <Lock className={iconClass} />
                      <input
                        type="password"
                        placeholder="Confirm new password"
                        value={forgotConfirmPassword}
                        onChange={(e) => { setForgotConfirmPassword(e.target.value); setError(""); }}
                        required
                        minLength={6}
                        className={inputClass}
                        style={{ fontSize: "0.85rem" }}
                      />
                    </div>

                    {error && (
                      <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
                        <ShieldX className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        <p className="text-red-300" style={{ fontSize: "0.78rem" }}>{error}</p>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-[#ec5d25] to-[#c4400e] hover:from-[#f06830] hover:to-[#d44a1a] text-white rounded-lg py-2.5 font-medium transition-all shadow-md shadow-[#ec5d25]/20 disabled:opacity-60"
                      style={{ fontSize: "0.85rem" }}
                    >
                      {submitting ? "Resetting…" : "Reset password"}
                    </button>
                  </form>
                </>
              )}
            </div>

            <p className="text-center text-[#333348] mt-6" style={{ fontSize: "0.7rem" }}>
              Glisseo AI · Sales intelligence, automated.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
