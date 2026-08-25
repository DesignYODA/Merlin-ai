import { useState, useEffect } from "react";
import { Link } from "react-router";
import { Brain, BarChart2, Activity } from "lucide-react";
import { GlisseoBase, GlisseoLogo } from "./glisseo-mark";
import { GlisseoGlobe } from "./glisseo-globe";

const FEATURES = [
  { icon: Brain,     label: "Ask Glisseo",     sub: "Auto-generated post-call" },
  { icon: BarChart2, label: "Call Analytics",    sub: "Volume · Keywords · AEs" },
  { icon: Activity,  label: "Product Analytics",  sub: "Product insights" },
];

const TOKEN = "pk_L8_LjP3dRAaHRmdddLSwUg";
const logo = (domain: string) => `https://img.logo.dev/${domain}?token=${TOKEN}&size=32&format=png`;

export function LandingPage() {
  const [hovered, setHovered] = useState<number | null>(null);
  const [time, setTime] = useState("");
  const logoSize = 42; //size of the logo image

  useEffect(() => {
    const update = () =>
      setTime(new Date().toLocaleTimeString("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      height: "100vh", overflow: "hidden",
      background: "radial-gradient(ellipse at 50% 38%, #7D2400 0%, #3E0C00 42%, #0B0200 78%)",
      color: "#fff",
      fontFamily: "'Geist', sans-serif",
      display: "flex", flexDirection: "column",
    }}>

      <style>{`
        @keyframes pulseOrb  { 0%,100%{opacity:.82} 50%{opacity:1} }
        @keyframes spinRing  { from{transform:rotate(0deg)}  to{transform:rotate(360deg)}  }
        @keyframes spinRingR { from{transform:rotate(0deg)}  to{transform:rotate(-360deg)} }
        @keyframes floatY    { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
      `}</style>

      {/* ── Navbar ─────────────────────────────────────────────────────── */}
      <header style={{
        flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 48px",
        height: 72,
      }}>

        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <GlisseoLogo size={28} />
          <span style={{ fontFamily: "'Fustat', sans-serif", fontWeight: 700, fontSize: "1rem" }}>
            Glisseo<span style={{ color: "#EC5D25" }}>.</span>AI
          </span>
        </div>

        {/* Login — rectangular outlined */}
        <Link
          to="/login"
          style={{
            padding: "8px 24px",
            border: "1px solid rgba(255,255,255,0.5)",
            borderRadius: 4,
            background: "transparent",
            color: "#fff",
            fontSize: "0.8rem", fontWeight: 500,
            textDecoration: "none",
            transition: "background 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.07)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.8)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.5)"; }}
        >
          Login
        </Link>
      </header>

      {/* ── Hero: 3 columns ────────────────────────────────────────────── */}
      <main style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", minHeight: 0 }}>

        {/* Left — headline only */}
        <div style={{
          display: "flex", flexDirection: "column", justifyContent: "flex-end",
          padding: "56px 40px 60px 56px",
        }}>
          <h1 style={{
            fontFamily: "'Fustat', sans-serif",
            fontSize: "clamp(2.5rem, 4vw, 3.8rem)",
            fontWeight: 800, lineHeight: 1.05,
            letterSpacing: "-0.03em", margin: 0,
          }}>
            <span style={{ color: "rgba(236,93,37,0.72)" }}>Sales<br />Intelligence,<br /></span>
            <span style={{ color: "#ffffff" }}>Automated.</span>
          </h1>
        </div>
   

        {/* Center — animated orb */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          position: "relative",
        }}>

          {/* Globe + pedestal — one flex column so both share the exact same
              horizontal center; the pedestal sits in normal flow right below
              the sphere stage (unaffected by the globe's floatY bob) with a
              negative margin pulling it up to meet the sphere's visible edge. */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            {/* Sphere stage — rings, glow, and globe all centered on this one
                620x620 box, so they stay concentric regardless of what's below. */}
            <div style={{
              width: 620, height: 620,
              animation: "floatY 5s ease-in-out infinite",
              display: "flex", alignItems: "center", justifyContent: "center",
              position: "relative",
              flexShrink: 0,
            }}>
              {/* Fireflies orbit — its own ring, circular icon container */}
              {/* <div style={{
                position: "absolute", width: 550, height: 550, borderRadius: "50%",
                animation: "spinRing 22s linear infinite",
                pointerEvents: "none",
              }}>
                <div style={{
                  position: "absolute", top: -15, left: "50%", transform: "translateX(-50%)",
                  width: logoSize, height: logoSize,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  animation: "spinRingR 22s linear infinite",
                }}>
                  <img src={logo("fireflies.ai")} alt="Fireflies"
                    style={{ width: logoSize, height: logoSize, borderRadius: "50%", objectFit: "cover", opacity: 0.9 }} />
                </div>
              </div>

              <div style={{
                position: "absolute", width: 680, height: 680, borderRadius: "50%",
                animation: "spinRingR 20s linear infinite",
                pointerEvents: "none",
              }}>
                <div style={{
                  position: "absolute", bottom: -15, left: "50%", transform: "translateX(-50%)",
                  width: logoSize, height: logoSize,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  animation: "spinRing 32s linear infinite",
                }}>
                  <img src={logo("hubspot.com")} alt="HubSpot"
                    style={{ width: logoSize, height: logoSize, borderRadius: "50%", objectFit: "cover", opacity: 0.9 }} />
                </div>
              </div> */}

              <div style={{
                position: "absolute", width: 480, height: 480, borderRadius: "50%",
                background: "radial-gradient(circle, rgba(240,120,68,0.35) 0%, rgba(184,48,0,0.14) 45%, transparent 72%)",
                filter: "blur(20px)",
              }} />
              <div style={{ filter: "drop-shadow(0 30px 50px rgba(0,0,0,0.55))" }}>
                <GlisseoGlobe size={520} />
              </div>
            </div>

            {/* Base — static pedestal beneath the globe, pulled up to meet its bottom edge */}
            <div style={{ marginTop: -70 }}>
              <GlisseoBase width={500} />
            </div>
          </div>

        </div>

        {/* Right — top copy + bottom feature cards */}
        <div style={{
          display: "flex", flexDirection: "column", justifyContent: "space-between",
          padding: "56px 56px 60px 40px",
        }}>
          <p style={{ fontSize: "0.87rem", color: "rgba(255,255,255,0.32)", lineHeight: 1.35, maxWidth: 320 }}>
            Every conversation, Every meeting <span style={{ color: "#fff" }}>  intelligently analysed, automatically.
            </span>
          </p>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 9, marginLeft: "auto", maxWidth: 220 }}>
            <p style={{ fontSize: "0.58rem", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.18)", margin: "0 0 6px" }}>
              Capabilities
            </p>
            {FEATURES.map((f, i) => (
              <div
                key={f.label}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  display: "flex", flexDirection: "row-reverse", alignItems: "center", gap: 12,
                  padding: "12px 14px", borderRadius: 8, width: "100%",
                  border: `1px solid ${hovered === i ? "rgba(236,93,37,0.28)" : "rgba(255,255,255,0.07)"}`,
                  background: hovered === i ? "rgba(236,93,37,0.07)" : "rgba(255,255,255,0.025)",
                  transition: "all 0.18s", cursor: "default",
                }}
              >
                <div style={{
                  width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                  background: hovered === i ? "rgba(236,93,37,0.14)" : "rgba(255,255,255,0.05)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "background 0.18s",
                }}>
                  <f.icon style={{ width: 16, height: 16, color: hovered === i ? "#EC5D25" : "rgba(255,255,255,0.4)" }} />
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ fontSize: "0.75rem", fontWeight: 600, color: "rgba(255,255,255,0.82)", margin: 0 }}>{f.label}</p>
                  <p style={{ fontSize: "0.62rem", color: "rgba(255,255,255,0.26)", margin: "2px 0 0" }}>{f.sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* ── Bottom info bar ─────────────────────────────────────────────── */}
      {/* <div style={{
        flexShrink: 0,
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        background: "rgba(6,2,0,0.65)",
        backdropFilter: "blur(12px)",
      }}>
        {[
          { top: "Best Sales Intelligence", bottom: "2026" },
          // { top: "Mumbai, India",           bottom: `${time} IST` },
          { top: "AI-Powered Analytics",    bottom: "itilite internal" },
        ].map((item, i) => (
          <div key={item.top} style={{
            padding: "14px 24px",
            paddingLeft: i === 0 ? 48 : 24,
            paddingRight: i === 2 ? 48 : 24,
          }}>
            <p style={{ fontSize: "0.6rem", fontWeight: 700, color: "rgba(255,255,255,0.16)", textTransform: "uppercase", letterSpacing: "0.07em", margin: 0 }}>
              {item.top}
            </p>
            <p style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.38)", margin: "3px 0 0" }}>{item.bottom}</p>
          </div>
        ))}
      </div> */}
    </div>
  );
}
