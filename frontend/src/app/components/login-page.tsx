import { useState, type FormEvent } from "react";
import { useNavigate, Navigate } from "react-router";
import { Flame, Mail, ArrowRight, ShieldX } from "lucide-react";
import { useAuth } from "../auth";

export function LoginPage() {
  const { email: authedEmail, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "unauthorized">("idle");

  // Already logged in — skip the login screen
  if (authedEmail) return <Navigate to="/dashboard" replace />;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = login(email);
    if (result === "ok") {
      navigate("/dashboard", { replace: true });
    } else {
      setStatus("unauthorized");
    }
  }

  return (
    <div
      className="dark flex items-center justify-center min-h-screen w-screen bg-app-base"
    >
      {/* Ambient glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 60% 40% at 50% 20%, rgba(236,93,37,0.07) 0%, transparent 70%)",
        }}
      />

      <div className="relative w-full max-w-sm mx-4">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#ec5d25] to-[#c4400e] flex items-center justify-center mb-4 shadow-lg shadow-[#ec5d25]/20">
            <Flame className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-white text-2xl font-semibold tracking-tight">Glisseo AI</h1>
          <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.85rem" }}>
            Sales intelligence for Itilite
          </p>
        </div>

        {/* Card */}
        <div className="bg-app-surface border border-[#1e1e2e] rounded-2xl p-6 shadow-2xl">
          <h2 className="text-white font-semibold mb-1" style={{ fontSize: "1rem" }}>
            Sign in
          </h2>
          <p className="text-[#555568] mb-5" style={{ fontSize: "0.8rem" }}>
            Use your Itilite email to continue.
          </p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#555568] pointer-events-none" />
              <input
                type="email"
                placeholder="you@itilite.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (status !== "idle") setStatus("idle");
                }}
                required
                autoFocus
                className="w-full bg-app-elevated border border-[#2a2a3e] rounded-lg pl-9 pr-4 py-2.5 text-white placeholder-[#3a3a50] outline-none focus:border-[#ec5d25]/60 focus:ring-1 focus:ring-[#ec5d25]/30 transition-all"
                style={{ fontSize: "0.85rem" }}
              />
            </div>

            {status === "unauthorized" && (
              <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
                <ShieldX className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-red-300 font-medium" style={{ fontSize: "0.78rem" }}>
                    Not authorised
                  </p>
                  <p className="text-red-400/70" style={{ fontSize: "0.72rem" }}>
                    Access is restricted to @itilite.com accounts.
                  </p>
                </div>
              </div>
            )}

            <button
              type="submit"
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-[#ec5d25] to-[#c4400e] hover:from-[#f06830] hover:to-[#d44a1a] text-white rounded-lg py-2.5 font-medium transition-all shadow-md shadow-[#ec5d25]/20"
              style={{ fontSize: "0.85rem" }}
            >
              Continue
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        </div>

        <p className="text-center text-[#333348] mt-6" style={{ fontSize: "0.7rem" }}>
          Glisseo AI · Itilite internal tool
        </p>
      </div>
    </div>
  );
}
