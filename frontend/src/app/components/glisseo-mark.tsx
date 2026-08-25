import { useId } from "react";

/**
 * Shared gradient for every Glisseo sphere surface (globe texture, pedestal,
 * navbar logo) — bright highlight at the center, fading smoothly out to the
 * dark edge.
 */
export const GLISSEO_GRADIENT_COLORS = [
  "#B5390C", // center (muted orange, less bright)
  "#91360C", // mid (deep muted red-orange)
  "#3D0701", // edge (near-black)
];

function lerpColor(a: string, b: string, t: number): string {
  const ra = parseInt(a.substring(1, 3), 16), ga = parseInt(a.substring(3, 5), 16), ba = parseInt(a.substring(5, 7), 16);
  const rb = parseInt(b.substring(1, 3), 16), gb = parseInt(b.substring(3, 5), 16), bb = parseInt(b.substring(5, 7), 16);
  const r = Math.round(ra + (rb - ra) * t);
  const g = Math.round(ga + (gb - ga) * t);
  const bl = Math.round(ba + (bb - ba) * t);
  return "#" + r.toString(16).padStart(2, "0") + g.toString(16).padStart(2, "0") + bl.toString(16).padStart(2, "0");
}

/** Continuous color for t ∈ [0, 1] (0 = center, 1 = edge). Returns a CSS hex string. */
export function getGlisseoGradientColor(t: number): string {
  t = Math.max(0, Math.min(1, t));
  const [c0, c1, c2] = GLISSEO_GRADIENT_COLORS;
  return t < 0.5 ? lerpColor(c0, c1, t * 2) : lerpColor(c1, c2, (t - 0.5) * 2);
}

/**
 * Densely sampled stops from the continuous function above. Both the SVG
 * gradients (pedestal, navbar logo) and the globe's canvas texture render
 * from this same array, so every surface shows one identical smooth blend
 * with no banding or hard boundary between colors.
 */
export const GLISSEO_GRADIENT_STOPS: [number, string][] = Array.from(
  { length: 15 },
  (_, i) => {
    const t = i / 14;
    return [t, getGlisseoGradientColor(t)];
  },
);

export const GLISSEO_GRADIENT_CSS =
  `radial-gradient(circle at 36% 30%, ${GLISSEO_GRADIENT_STOPS.map(([o, c]) => `${c} ${o * 100}%`).join(", ")})`;

export function GlisseoMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 1082.11 1082" width={size} height={size} style={{ display: "block" }}>
      <path fill="#fff" d="M692.27,537.27c-1.84,4.24-4.85,6.32-8.73,6.44-4.09.13-7.45-2.11-9.21-6.16l-40.37-93.14-87.78-42.71c-3.58-1.74-5.77-4.46-5.99-8.11-.21-3.54,1.43-7.3,5.15-9.11l88.54-43.09,40.64-93.6c1.69-3.89,5.23-5.87,8.99-5.76,3.89.11,6.94,2.3,8.64,6.2l40.38,93.09,87.79,42.72c3.74,1.82,5.95,4.77,6,8.59.05,3.65-1.82,7.04-5.55,8.85l-88.25,42.94-40.28,92.84Z"/>
      <path fill="#fff" d="M830.8,313.52c-.91,2.1-2.4,3.13-4.32,3.19-2.02.06-3.69-1.04-4.56-3.05l-19.99-46.12-43.46-21.15c-1.77-.86-2.86-2.21-2.96-4.02s.71-3.61,2.55-4.51l43.84-21.33,20.12-46.34c.84-1.93,2.59-2.91,4.45-2.85,1.92.06,3.44,1.14,4.28,3.07l20,46.09,43.47,21.15c1.85.9,2.95,2.36,2.97,4.26.02,1.81-.9,3.49-2.75,4.38l-43.69,21.26-19.94,45.96Z"/>
    </svg>
  );
}

export function GlisseoBase({ width }: { width: number }) {
  const gradId = useId();
  const height = width * (100 / 960);
  return (
    <svg viewBox="60 990 960 100" width={width} height={height} style={{ display: "block" }}>
      <defs>
        <radialGradient id={gradId} cx="36%" cy="30%" r="75%">
          {GLISSEO_GRADIENT_STOPS.map(([offset, color]) => (
            <stop key={offset} offset={`${offset * 100}%`} stopColor={color} />
          ))}
        </radialGradient>
      </defs>
      <path fill={`url(#${gradId})`} d="M920.28,1001.72c46.79,0,81.78,36.3,81.56,80.27H80.26c-.19-43.87,35.07-80.24,80.5-80.24l759.51-.03Z"/>
    </svg>
  );
}

/** Combined sphere + pedestal mark, for use as the Glisseo logo anywhere in the app. */
export function GlisseoLogo({ size }: { size: number }) {
  const baseWidth = size * 1.15;
  const baseHeight = baseWidth * (100 / 960);
  return (
    <div style={{ position: "relative", width: size, height: size + baseHeight * 0.55 }}>
      <div style={{
        position: "absolute", bottom: 0, left: "50%", transform: "translateX(-50%)",
      }}>
        <GlisseoBase width={baseWidth} />
      </div>
      <div style={{
        position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
        width: size, height: size, borderRadius: "50%",
        background: GLISSEO_GRADIENT_CSS,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <GlisseoMark size={size * 0.46} />
      </div>
    </div>
  );
}
