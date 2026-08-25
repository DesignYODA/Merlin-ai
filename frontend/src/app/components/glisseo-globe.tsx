import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { getGlisseoGradientColor } from "./glisseo-mark";

const STAR_PATHS = [
  "M692.27,537.27c-1.84,4.24-4.85,6.32-8.73,6.44-4.09.13-7.45-2.11-9.21-6.16l-40.37-93.14-87.78-42.71c-3.58-1.74-5.77-4.46-5.99-8.11-.21-3.54,1.43-7.3,5.15-9.11l88.54-43.09,40.64-93.6c1.69-3.89,5.23-5.87,8.99-5.76,3.89.11,6.94,2.3,8.64,6.2l40.38,93.09,87.79,42.72c3.74,1.82,5.95,4.77,6,8.59.05,3.65-1.82,7.04-5.55,8.85l-88.25,42.94-40.28,92.84Z",
  "M830.8,313.52c-.91,2.1-2.4,3.13-4.32,3.19-2.02.06-3.69-1.04-4.56-3.05l-19.99-46.12-43.46-21.15c-1.77-.86-2.86-2.21-2.96-4.02s.71-3.61,2.55-4.51l43.84-21.33,20.12-46.34c.84-1.93,2.59-2.91,4.45-2.85,1.92.06,3.44,1.14,4.28,3.07l20,46.09,43.47,21.15c1.85.9,2.95,2.36,2.97,4.26.02,1.81-.9,3.49-2.75,4.38l-43.69,21.26-19.94,45.96Z",
];

function createGlobeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;

  // Shade by longitude (not by a fixed-point radial gradient) so the texture
  // wraps seamlessly: at x=0 and x=width, theta lands on the same angle mod
  // 2π, so the two edges of the map always match where they meet on the
  // sphere. A radial gradient centered at one fixed pixel can't guarantee
  // that — its color at the left edge and right edge of the canvas differ,
  // which shows up as a hard boundary running down the globe.
  const frontFrac = 0.6; // matches the front star copy drawn below
  for (let x = 0; x < canvas.width; x++) {
    const theta = (x / canvas.width) * Math.PI * 2;
    const frontTheta = frontFrac * Math.PI * 2;
    const t = (1 - Math.cos(theta - frontTheta)) / 2; // 0 at front, 1 at back — periodic, so seamless
    ctx.fillStyle = getGlisseoGradientColor(t);
    ctx.fillRect(x, 0, 1, canvas.height);
  }

  const scale = 0.32;
  const starSize = 1082 * scale;
  const drawStarAt = (centerXFrac: number) => {
    const offsetX = canvas.width * centerXFrac - starSize / 2;
    const offsetY = canvas.height * 0.5 - starSize / 2;
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.fillStyle = "#ffffff";
    for (const d of STAR_PATHS) ctx.fill(new Path2D(d));
    ctx.restore();
  };

  // Front copy, and a back copy split across the texture's wrap seam (180° opposite)
  drawStarAt(0.5);
  drawStarAt(0);
  drawStarAt(1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function GlisseoGlobe({ size = 650 }: { size?: number }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 3.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    mount.appendChild(renderer.domElement);

    // Unlit: the baked gradient in the texture already supplies all the shading
    // this sphere needs. A real light on top of that (MeshStandardMaterial)
    // adds its own terminator line, which combines with the baked gradient
    // into a hard, unrelated dark crescent instead of one smooth shade.
    const texture = createGlobeTexture();
    const globeGeo = new THREE.SphereGeometry(1, 96, 96);
    const globeMat = new THREE.MeshBasicMaterial({ map: texture, opacity: 0.778, transparent: true });
    const globe = new THREE.Mesh(globeGeo, globeMat);
    scene.add(globe);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.minPolarAngle = Math.PI / 2 - 0.5;
    controls.maxPolarAngle = Math.PI / 2 + 0.5;

    renderer.setAnimationLoop(() => {
      globe.rotation.y += 0.0052;
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      controls.dispose();
      renderer.dispose();
      texture.dispose();
      globeGeo.dispose();
      globeMat.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [size]);

  return <div ref={mountRef} style={{ width: size, height: size }} />;
}
