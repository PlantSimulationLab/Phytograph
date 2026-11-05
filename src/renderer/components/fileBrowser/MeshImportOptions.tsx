import {
  MESH_AXES,
  axesCompatible,
  forwardFor,
  isIdentityAxes,
  meshAxesRotationDeg,
  type MeshAxes,
  type MeshAxis,
} from '../../lib/meshAxes';

// Mesh import options in the File -> Import browser: which of the file's axes
// is up and which is forward (Blender's importer convention). Phytograph is
// +Z up / +Y forward, so the default changes nothing; anything else becomes the
// mesh's initial rotation. See lib/meshAxes.ts.

interface MeshImportOptionsProps {
  axes: MeshAxes;
  onChange: (axes: MeshAxes) => void;
  // How many selected meshes the choice applies to (> 1 shows a note).
  count: number;
}

function describeRotation(axes: MeshAxes): string {
  if (isIdentityAxes(axes)) return 'Matches Phytograph (Z up, Y forward): the mesh is imported as the file has it.';
  const r = meshAxesRotationDeg(axes);
  const parts = (['x', 'y', 'z'] as const)
    .filter((k) => r[k] !== 0)
    .map((k) => `${r[k]}° about ${k.toUpperCase()}`);
  return `The mesh is rotated ${parts.join(', then ')} so its up points along Phytograph's Z. `
    + 'You can still change it afterwards with the transform tools.';
}

export function MeshImportOptions({ axes, onChange, count }: MeshImportOptionsProps) {
  const select = 'w-20 px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-[11px] text-neutral-200 focus:outline-none focus:border-neutral-500';
  return (
    <div data-testid="mesh-import-options" className="border border-neutral-700 rounded-lg px-3 py-2.5 space-y-2">
      <div className="text-[11px] font-medium text-neutral-200">Mesh axes</div>
      <div className="flex items-center gap-4 text-[11px] text-neutral-300">
        <label className="flex items-center gap-1.5">
          Up
          <select
            data-testid="mesh-import-up"
            value={axes.up}
            onChange={(e) => {
              const up = e.target.value as MeshAxis;
              onChange({ up, forward: forwardFor(up, axes.forward) });
            }}
            className={select}
          >
            {MESH_AXES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Forward
          <select
            data-testid="mesh-import-forward"
            value={axes.forward}
            onChange={(e) => onChange({ ...axes, forward: e.target.value as MeshAxis })}
            className={select}
          >
            {MESH_AXES.map((a) => (
              <option key={a} value={a} disabled={!axesCompatible(axes.up, a)}>{a}</option>
            ))}
          </select>
        </label>
      </div>
      <p data-testid="mesh-import-axes-note" className="text-[10px] text-neutral-500 leading-snug">
        {describeRotation(axes)}
        {count > 1 && ` Applies to all ${count} selected meshes.`}
        {' '}Many tools (and OBJ by convention) write Y up.
      </p>
    </div>
  );
}
