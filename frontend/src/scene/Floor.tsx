import { useEffect, useMemo } from 'react';
import { useStore } from '../store';
import { drawFloor, gridTexture, pixelTexture } from './textures';
import { mat } from './materials';

export function Floor() {
  const layout = useStore((s) => s.layout);
  const build = useStore((s) => s.mode === 'build');
  // New canvas/texture when the office size changes (GPU textures are immutable in size).
  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = layout.width * 16;
    c.height = layout.depth * 16;
    return c;
  }, [layout.width, layout.depth]);
  const texture = useMemo(() => pixelTexture(canvas), [canvas]);
  useEffect(() => {
    drawFloor(layout, canvas);
    texture.image = canvas;
    texture.needsUpdate = true;
  }, [layout, canvas, texture]);
  useEffect(() => () => texture.dispose(), [texture]);
  const grid = useMemo(() => gridTexture(), []);
  grid.repeat.set(layout.width, layout.depth);
  return (
    <group>
      <mesh
        rotation-x={-Math.PI / 2}
        position={[layout.width / 2, 0, layout.depth / 2]}
        receiveShadow
        name="floor"
      >
        <planeGeometry args={[layout.width, layout.depth]} />
        <meshLambertMaterial map={texture} />
      </mesh>
      <mesh
        position={[layout.width / 2, -0.16, layout.depth / 2]}
        material={mat('#7A5A3A')}
        receiveShadow
      >
        <boxGeometry args={[layout.width + 0.3, 0.3, layout.depth + 0.3]} />
      </mesh>
      {build && (
        <mesh
          rotation-x={-Math.PI / 2}
          position={[layout.width / 2, 0.012, layout.depth / 2]}
          renderOrder={1}
        >
          <planeGeometry args={[layout.width, layout.depth]} />
          <meshBasicMaterial map={grid} transparent opacity={0.55} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
