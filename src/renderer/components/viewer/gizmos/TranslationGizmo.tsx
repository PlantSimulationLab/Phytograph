import { useRef, useMemo, useState, useCallback, useEffect } from 'react';
import { useThree, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';

// Translation gizmo arrow
interface TranslationArrowProps {
  axis: 'x' | 'y' | 'z';
  position: THREE.Vector3;
  size: number;
  onDragStart: (axis: 'x' | 'y' | 'z') => void;
  onHover: (hovered: boolean) => void;
}

function TranslationArrow({ axis, position, size, onDragStart, onHover }: TranslationArrowProps) {
  const [hovered, setHovered] = useState(false);
  const { gl } = useThree();

  const color = axis === 'x' ? '#ef4444' : axis === 'y' ? '#22c55e' : '#3b82f6';
  const hoverColor = axis === 'x' ? '#f87171' : axis === 'y' ? '#4ade80' : '#60a5fa';

  const direction = useMemo(() => {
    switch (axis) {
      case 'x': return new THREE.Vector3(1, 0, 0);
      case 'y': return new THREE.Vector3(0, 1, 0);
      case 'z': return new THREE.Vector3(0, 0, 1);
    }
  }, [axis]);

  const shaftLength = size * 0.8;
  const coneLength = size * 0.25;
  const shaftRadius = size * 0.03;
  const coneRadius = size * 0.08;

  const shaftPosition = useMemo(() => direction.clone().multiplyScalar(shaftLength / 2), [direction, shaftLength]);
  const conePosition = useMemo(() => direction.clone().multiplyScalar(shaftLength + coneLength / 2), [direction, shaftLength, coneLength]);

  const rotation = useMemo(() => {
    if (axis === 'x') return new THREE.Euler(0, 0, -Math.PI / 2);
    if (axis === 'y') return new THREE.Euler(0, 0, 0);
    return new THREE.Euler(Math.PI / 2, 0, 0);
  }, [axis]);

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onDragStart(axis);
  };

  const handlePointerOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(true);
    onHover(true);
    gl.domElement.style.cursor = 'grab';
  };

  const handlePointerOut = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(false);
    onHover(false);
    gl.domElement.style.cursor = 'auto';
  };

  const currentColor = hovered ? hoverColor : color;

  return (
    <group position={position}>
      <mesh position={shaftPosition} rotation={rotation} onPointerOver={handlePointerOver} onPointerOut={handlePointerOut} onPointerDown={handlePointerDown}>
        <cylinderGeometry args={[shaftRadius, shaftRadius, shaftLength, 12]} />
        <meshBasicMaterial color={currentColor} />
      </mesh>
      <mesh position={conePosition} rotation={rotation} onPointerOver={handlePointerOver} onPointerOut={handlePointerOut} onPointerDown={handlePointerDown}>
        <coneGeometry args={[coneRadius, coneLength, 16]} />
        <meshBasicMaterial color={currentColor} />
      </mesh>
    </group>
  );
}

// Drag handler for screen-space dragging
interface DragHandlerProps {
  activeAxis: 'x' | 'y' | 'z' | null;
  gizmoCenter: THREE.Vector3;
  onDrag: (delta: { x: number; y: number; z: number }) => void;
  onDragEnd: () => void;
}

function DragHandler({ activeAxis, gizmoCenter, onDrag, onDragEnd }: DragHandlerProps) {
  const { camera, gl, size } = useThree();
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!activeAxis) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!lastMouseRef.current) {
        lastMouseRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      const deltaX = e.clientX - lastMouseRef.current.x;
      const deltaY = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };

      const axisDir = new THREE.Vector3(
        activeAxis === 'x' ? 1 : 0,
        activeAxis === 'y' ? 1 : 0,
        activeAxis === 'z' ? 1 : 0
      );

      const worldStart = gizmoCenter.clone();
      const worldEnd = gizmoCenter.clone().add(axisDir);
      const screenStart = worldStart.clone().project(camera);
      const screenEnd = worldEnd.clone().project(camera);

      const pixelStart = new THREE.Vector2((screenStart.x + 1) * size.width / 2, (-screenStart.y + 1) * size.height / 2);
      const pixelEnd = new THREE.Vector2((screenEnd.x + 1) * size.width / 2, (-screenEnd.y + 1) * size.height / 2);

      const screenAxis = pixelEnd.clone().sub(pixelStart);
      const screenAxisLength = screenAxis.length();
      if (screenAxisLength < 0.001) return;
      screenAxis.normalize();

      const mouseDelta = new THREE.Vector2(deltaX, deltaY);
      const projectedDelta = mouseDelta.dot(screenAxis);
      const worldDelta = projectedDelta / screenAxisLength;

      const translationDelta = { x: 0, y: 0, z: 0 };
      translationDelta[activeAxis] = worldDelta;
      onDrag(translationDelta);
    };

    const handleMouseUp = () => {
      lastMouseRef.current = null;
      onDragEnd();
    };

    gl.domElement.style.cursor = 'grabbing';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      gl.domElement.style.cursor = 'auto';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [activeAxis, camera, gl, gizmoCenter, onDrag, onDragEnd, size]);

  return null;
}

// Translation gizmo
export interface TranslationGizmoProps {
  center: THREE.Vector3;
  size: number;
  onTranslate: (delta: { x: number; y: number; z: number }) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export function TranslationGizmo({ center, size, onTranslate, onDragStart, onDragEnd }: TranslationGizmoProps) {
  const [activeAxis, setActiveAxis] = useState<'x' | 'y' | 'z' | null>(null);

  const handleAxisDragStart = useCallback((axis: 'x' | 'y' | 'z') => {
    setActiveAxis(axis);
    onDragStart();
  }, [onDragStart]);

  const handleDragEnd = useCallback(() => {
    setActiveAxis(null);
    onDragEnd();
  }, [onDragEnd]);

  return (
    <group>
      <TranslationArrow axis="x" position={center} size={size} onDragStart={handleAxisDragStart} onHover={() => {}} />
      <TranslationArrow axis="y" position={center} size={size} onDragStart={handleAxisDragStart} onHover={() => {}} />
      <TranslationArrow axis="z" position={center} size={size} onDragStart={handleAxisDragStart} onHover={() => {}} />
      <mesh position={center}>
        <sphereGeometry args={[size * 0.05, 16, 16]} />
        <meshBasicMaterial color="#a3a3a3" />
      </mesh>
      <DragHandler activeAxis={activeAxis} gizmoCenter={center} onDrag={onTranslate} onDragEnd={handleDragEnd} />
    </group>
  );
}
