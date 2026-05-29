import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

// Scene background component
export function SceneBackground({ color, style }: { color: 'black' | 'white'; style: 'solid' | 'gradient' }) {
  const { scene, gl } = useThree();

  useEffect(() => {
    if (style === 'solid') {
      // Solid background
      scene.background = null;
      gl.setClearColor(color === 'black' ? '#171717' : '#f5f5f5');
    } else {
      // Gradient background using a canvas texture
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const gradient = ctx.createLinearGradient(0, 0, 0, 512);
        if (color === 'black') {
          // Dark gradient: from dark gray at top to black at bottom
          gradient.addColorStop(0, '#2a2a2a');
          gradient.addColorStop(1, '#0a0a0a');
        } else {
          // Light gradient: from white at top to darker gray at bottom
          gradient.addColorStop(0, '#ffffff');
          gradient.addColorStop(1, '#737373');
        }
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 2, 512);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        scene.background = texture;
      }
    }

    return () => {
      if (scene.background instanceof THREE.Texture) {
        scene.background.dispose();
      }
      scene.background = null;
    };
  }, [color, style, scene, gl]);

  return null;
}
