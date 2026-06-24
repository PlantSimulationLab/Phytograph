import { useMemo, useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

// Blender-style selection outline via the Jump Flood Algorithm (JFA).
//
// Why JFA and not an inverted hull or the postprocessing OutlineEffect: both of
// those failed here — the hull duplicates every leaf of a plant mesh, and
// postprocessing's OutlineEffect silently renders nothing on this three/R3F
// stack. JFA is the technique Blender's overlay engine uses: it's a SCREEN-SPACE
// distance field, so the outline width is uniform regardless of topology (thin
// leaves, high-aspect slivers, foliage, holes) — the exact case that breaks the
// naive overlays. Reference: Ben Golus, "The Quest for Very Wide Outlines".
//
// Pipeline, every frame (this component owns the render loop at priority 1, just
// as the EffectComposer did — nothing else in the app takes the loop):
//   1. render the scene normally to the screen
//   2. mask pass: render only the selected meshes (a dedicated render layer)
//      white into a mask target, honoring each material's texture alpha so
//      alpha-cutout leaves mask their real silhouette, not the quad
//   3. seed init: each white texel stores its own UV; others store a sentinel
//   4. JFA: log2(width) ping-pong passes build a nearest-seed (distance) field
//   5. composite: outside the mask, draw the outline color with alpha =
//      smoothstep over the pixel distance to the silhouette → uniform AA outline

// Dedicated render layer for "this mesh should be outlined". 0 is the default
// layer (everything), so the mask camera restricting to this layer sees ONLY
// objects we explicitly opt in. Range is [1,31]; 11 avoids postprocessing's
// historical default (10) and three's common picks.
export const OUTLINE_LAYER = 11;

// Marks its descendant meshes for outlining by toggling OUTLINE_LAYER. Enabling
// the layer is additive — the mesh stays on layer 0 too, so the normal scene
// render is unaffected; only the mask camera (restricted to OUTLINE_LAYER) picks
// it up. Mirrors the proven traverse pattern from postprocessing's <Select>.
export function OutlineSelect({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useEffect(() => {
    const group = ref.current;
    if (!group) return;
    group.traverse(o => {
      if ((o as THREE.Mesh).isMesh) {
        if (enabled) o.layers.enable(OUTLINE_LAYER);
        else o.layers.disable(OUTLINE_LAYER);
      }
    });
  });
  return <group ref={ref}>{children}</group>;
}

const FS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Seed init: white mask texel → its own UV; empty → sentinel (-1,-1).
const SEED_INIT_FRAG = /* glsl */ `
  uniform sampler2D uMask;
  varying vec2 vUv;
  void main() {
    float m = texture2D(uMask, vUv).r;
    gl_FragColor = m > 0.5 ? vec4(vUv, 0.0, 1.0) : vec4(-1.0, -1.0, 0.0, 1.0);
  }
`;

// JFA step: among the 3x3 neighbours at the current step distance, keep the
// stored seed UV nearest to this pixel. Nearest filtering is mandatory (we store
// positions, which must not be interpolated).
const JFA_STEP_FRAG = /* glsl */ `
  uniform sampler2D uSeed;
  uniform vec2 uResolution;
  uniform float uStep;
  varying vec2 vUv;
  void main() {
    vec2 best = vec2(-1.0);
    float bestDist = 1e20;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 off = vec2(float(x), float(y)) * uStep / uResolution;
        vec4 s = texture2D(uSeed, vUv + off);
        if (s.x >= 0.0) {
          vec2 d = (s.xy - vUv) * uResolution;
          float dist = dot(d, d);
          if (dist < bestDist) { bestDist = dist; best = s.xy; }
        }
      }
    }
    gl_FragColor = vec4(best, 0.0, 1.0);
  }
`;

// Composite: outside the mask, alpha falls from 1→0 across the last 1.5px of the
// requested width → a uniform, anti-aliased outline hugging the silhouette.
const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D uSeed;
  uniform sampler2D uMask;
  uniform vec2 uResolution;
  uniform float uWidth;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float inside = texture2D(uMask, vUv).r;
    vec4 s = texture2D(uSeed, vUv);
    float alpha = 0.0;
    if (inside < 0.5 && s.x >= 0.0) {
      float dist = length((s.xy - vUv) * uResolution);
      alpha = 1.0 - smoothstep(uWidth - 1.5, uWidth + 0.5, dist);
    }
    gl_FragColor = vec4(uColor, alpha);
  }
`;

// Mask material: renders a selected mesh as solid white, but honors its diffuse
// map's ALPHA channel via an alpha test — so an alpha-cutout leaf (a quad whose
// real shape lives in the texture's alpha, as Helios plant leaves do) masks its
// actual silhouette, not the rectangular quad. Untextured meshes mask solid.
const MASK_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const MASK_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform bool uHasMap;
  uniform float uAlphaTest;
  varying vec2 vUv;
  void main() {
    if (uHasMap && texture2D(uMap, vUv).a < uAlphaTest) discard;
    gl_FragColor = vec4(1.0);
  }
`;

export interface JFAOutlineProps {
  active: boolean;        // is anything selected?
  color?: string;         // outline color
  width?: number;         // outline width in screen pixels
}

export function JFAOutline({ active, color = '#a3e635', width = 4 }: JFAOutlineProps) {
  const { gl } = useThree();

  // Fullscreen-quad rig for the post passes.
  const rig = useMemo(() => {
    const fsScene = new THREE.Scene();
    const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    fsScene.add(quad);

    const make = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });

    const seedInit = make(SEED_INIT_FRAG, { uMask: { value: null } });
    const jfaStep = make(JFA_STEP_FRAG, { uSeed: { value: null }, uResolution: { value: new THREE.Vector2() }, uStep: { value: 1 } });
    const composite = make(COMPOSITE_FRAG, {
      uSeed: { value: null }, uMask: { value: null },
      uResolution: { value: new THREE.Vector2() },
      uWidth: { value: width }, uColor: { value: new THREE.Color(color) },
    });
    composite.transparent = true;
    composite.blending = THREE.NormalBlending;

    return { fsScene, fsCam, quad, seedInit, jfaStep, composite };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Ping-pong render targets, sized to the drawing buffer.
  const rts = useRef<{ mask: THREE.WebGLRenderTarget; a: THREE.WebGLRenderTarget; b: THREE.WebGLRenderTarget; w: number; h: number } | null>(null);

  // One mask material per source material (keyed weakly so it dies with the
  // source), its uniforms refreshed each frame to track async-loaded textures.
  // The parallel list lets us dispose the GPU programs on unmount.
  const maskCache = useRef(new WeakMap<THREE.Material, THREE.ShaderMaterial>());
  const maskList = useRef<THREE.ShaderMaterial[]>([]);
  const maskMaterialFor = (src: THREE.Material): THREE.ShaderMaterial => {
    let m = maskCache.current.get(src);
    if (!m) {
      m = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: null }, uHasMap: { value: false }, uAlphaTest: { value: 0.5 } },
        vertexShader: MASK_VERT, fragmentShader: MASK_FRAG,
        side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      });
      maskCache.current.set(src, m);
      maskList.current.push(m);
    }
    const map = (src as THREE.MeshStandardMaterial).map ?? null;
    const at = (src as THREE.Material & { alphaTest?: number }).alphaTest ?? 0;
    m.uniforms.uMap.value = map;
    m.uniforms.uHasMap.value = !!map;
    m.uniforms.uAlphaTest.value = at > 0 ? at : 0.5;
    m.side = (src as THREE.Material).side ?? THREE.DoubleSide;
    return m;
  };

  useEffect(() => {
    rig.composite.uniforms.uColor.value = new THREE.Color(color);
    rig.composite.uniforms.uWidth.value = width;
  }, [rig, color, width]);

  useEffect(() => () => {
    rig.quad.geometry.dispose();
    rig.seedInit.dispose(); rig.jfaStep.dispose(); rig.composite.dispose();
    maskList.current.forEach(m => m.dispose());
    const r = rts.current;
    if (r) { r.mask.dispose(); r.a.dispose(); r.b.dispose(); }
  }, [rig]);

  const blit = (mat: THREE.Material, target: THREE.WebGLRenderTarget | null) => {
    rig.quad.material = mat;
    gl.setRenderTarget(target);
    gl.render(rig.fsScene, rig.fsCam);
  };

  useFrame(({ gl, scene, camera, size }) => {
    // 1. Main scene render to screen (we own the loop at priority 1).
    gl.setRenderTarget(null);
    gl.render(scene, camera);
    if (!active) return;

    const dpr = gl.getPixelRatio();
    const w = Math.max(1, Math.floor(size.width * dpr));
    const h = Math.max(1, Math.floor(size.height * dpr));

    // (Re)allocate targets on size change — only when something is selected, so
    // the common (nothing-selected) case allocates nothing. Seeds need FloatType
    // + Nearest so the stored UV positions keep full precision (no interpolation).
    if (!rts.current || rts.current.w !== w || rts.current.h !== h) {
      rts.current?.mask.dispose(); rts.current?.a.dispose(); rts.current?.b.dispose();
      const seedOpts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
      rts.current = {
        mask: new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false }),
        a: new THREE.WebGLRenderTarget(w, h, seedOpts),
        b: new THREE.WebGLRenderTarget(w, h, seedOpts),
        w, h,
      };
    }
    const { mask, a, b } = rts.current;

    // 2. Mask pass: render only OUTLINE_LAYER objects, white-on-black, into the
    // mask target. We can't use scene.overrideMaterial (a single material can't
    // carry each leaf's texture), so we temporarily swap each selected mesh's
    // material to its alpha-aware mask material, then restore. The alpha test
    // makes a cutout leaf mask its real silhouette, not the quad.
    const prevMask = camera.layers.mask;
    const prevBg = scene.background;
    const prevClear = gl.getClearColor(new THREE.Color());
    const prevClearAlpha = gl.getClearAlpha();
    const prevAutoClear = gl.autoClear;

    const swapped: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
    scene.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.layers.isEnabled(OUTLINE_LAYER)) {
        swapped.push({ mesh, mat: mesh.material });
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(maskMaterialFor)
          : maskMaterialFor(mesh.material);
      }
    });

    camera.layers.set(OUTLINE_LAYER);
    scene.background = null;
    gl.autoClear = true;
    gl.setRenderTarget(mask);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(scene, camera);

    for (const s of swapped) s.mesh.material = s.mat;
    camera.layers.mask = prevMask;
    scene.background = prevBg;
    gl.setClearColor(prevClear, prevClearAlpha);

    // 3. Seed init.
    const res = rig.jfaStep.uniforms.uResolution.value as THREE.Vector2;
    res.set(w, h);
    rig.seedInit.uniforms.uMask.value = mask.texture;
    blit(rig.seedInit, a);

    // 4. JFA flood: step from nextPow2(width+margin) down to 1, ping-ponging.
    let src = a, dst = b;
    let step = Math.pow(2, Math.ceil(Math.log2(Math.max(2, width + 2))));
    while (step >= 1) {
      rig.jfaStep.uniforms.uSeed.value = src.texture;
      rig.jfaStep.uniforms.uStep.value = step;
      blit(rig.jfaStep, dst);
      const t = src; src = dst; dst = t;
      step = Math.floor(step / 2);
    }

    // 5. Composite the outline over the screen (no clear → additive overlay).
    (rig.composite.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    rig.composite.uniforms.uSeed.value = src.texture;
    rig.composite.uniforms.uMask.value = mask.texture;
    gl.autoClear = false;
    blit(rig.composite, null);
    gl.autoClear = prevAutoClear;
  }, 1);

  return null;
}
