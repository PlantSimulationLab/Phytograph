import { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * Load a base64 image into a THREE.Texture, disposing it correctly across
 * re-renders and StrictMode's double-effect.
 *
 * Extracted from TexturedPlantMesh's `useBase64Texture`, which serves textured
 * PLANT meshes (leaf cutouts whose UVs the backend supplies pre-V-flipped). This
 * variant covers the TILED case — QSM bark — and differs in three ways that
 * matter:
 *
 *   - It carries the real MIME type. The plant helper hardcodes `image/png`; bark
 *     assets are JPG. Browsers do sniff content, but naming the type is not
 *     something to leave to chance.
 *   - `flipY` stays at three.js's default `true`. The plant path sets it false
 *     because the backend pre-flips V; our QSM UVs are generated locally in
 *     three.js convention, so no compensation is wanted.
 *   - Mipmaps are ON with a trilinear min filter, and wrapping is Repeat. Tiled
 *     bark on a distant branch aliases badly without mipmaps, and the QSM UVs
 *     deliberately exceed [0,1] so ClampToEdge would smear the last texel.
 */
export function useImageTexture(
  base64Data: string | undefined,
  mimeType: string = 'image/png'
): THREE.Texture | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  // Track the live texture in a ref so cleanup disposes the ACTUAL current value,
  // not the stale one closed over when the effect was set up.
  const currentRef = useRef<THREE.Texture | null>(null);

  useEffect(() => {
    if (!base64Data) {
      if (currentRef.current) {
        currentRef.current.dispose();
        currentRef.current = null;
      }
      setTexture(null);
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      // Sharpens the tiled pattern at grazing angles (trunk silhouettes), which is
      // exactly where trilinear filtering alone goes muddy. Clamped by the GPU to
      // its real limit, so an unsupported value is harmless.
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      if (currentRef.current) currentRef.current.dispose();
      currentRef.current = tex;
      setTexture(tex);
    };
    img.onerror = (e) => {
      if (cancelled) return;
      console.error('[useImageTexture] Failed to load texture from base64:', e);
      setTexture(null);
    };
    img.src = `data:${mimeType};base64,${base64Data}`;

    return () => {
      cancelled = true;
      if (currentRef.current) {
        currentRef.current.dispose();
        currentRef.current = null;
      }
    };
  }, [base64Data, mimeType]);

  return texture;
}
