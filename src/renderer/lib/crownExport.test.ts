import { describe, it, expect } from 'vitest';
import {
  CROWN_CSV_HEADER, buildCrownCsv, crownExportBaseName, crownMeshFileName, joinExportPath,
  type CrownCsvRow,
} from './crownExport';
import type { CrownFitCrown, CrownFitParams } from '../utils/backendApi';

function crown(
  shape: string, params: CrownFitParams | undefined, treeId = 1,
): CrownFitCrown {
  return {
    tree_instance_id: treeId,
    shape,
    vertices: [],
    triangles: [],
    normals: [],
    params,
    metrics: {
      tree_height_m: 9.5,
      crown_volume_m3: 42.125,
      crown_center: [1, 2, 3],
      crown_dims_m: [4, 5, 6],
      crown_base_z: 0,
      crown_top_z: 6,
      surface_area_m2: 77.5,
      num_points_used: 1500,
      num_vertices: 338,
      num_triangles: 672,
    },
  };
}

const ELLIPSOID: CrownFitParams = { a_m: 2, b_m: 2.5, c_m: 3 };
const CONE: CrownFitParams = { base_radius_m: 2.4, height_m: 6 };
const ALPHA: CrownFitParams = { alpha_m: 0.31, alpha_auto: true, watertight: true };

function cells(csv: string, rowIndex: number): string[] {
  return csv.trim().split('\n')[rowIndex].split(',');
}

function cell(csv: string, rowIndex: number, column: string): string {
  return cells(csv, rowIndex)[CROWN_CSV_HEADER.indexOf(column as never)];
}

describe('buildCrownCsv', () => {
  it('emits one row per crown with every cell aligned to the header', () => {
    const rows: CrownCsvRow[] = [
      { scanName: 'oak', crown: crown('ellipsoid', ELLIPSOID, 1) },
      { scanName: 'oak', crown: crown('cone', CONE, 2) },
    ];
    const csv = buildCrownCsv(rows, 0.2);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 crowns
    expect(lines[0]).toBe(CROWN_CSV_HEADER.join(','));
    for (const line of lines) {
      expect(line.split(',')).toHaveLength(CROWN_CSV_HEADER.length);
    }
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('writes each shape only the parameters it actually has', () => {
    const csv = buildCrownCsv([
      { scanName: 's', crown: crown('ellipsoid', ELLIPSOID) },
      { scanName: 's', crown: crown('cone', CONE) },
      { scanName: 's', crown: crown('alpha', ALPHA), meshFile: 's_crown_tree1.ply' },
    ], 0.2);

    // Ellipsoid: semi-axes filled, cone/alpha params blank.
    expect(cell(csv, 1, 'param_a_m')).toBe('2.0000');
    expect(cell(csv, 1, 'param_c_m')).toBe('3.0000');
    expect(cell(csv, 1, 'param_base_radius_m')).toBe('');
    expect(cell(csv, 1, 'param_alpha_m')).toBe('');

    // Cone: radius + height only.
    expect(cell(csv, 2, 'param_base_radius_m')).toBe('2.4000');
    expect(cell(csv, 2, 'param_height_m')).toBe('6.0000');
    expect(cell(csv, 2, 'param_a_m')).toBe('');

    // Alpha: the radius it used, and whether the fit chose it.
    expect(cell(csv, 3, 'param_alpha_m')).toBe('0.3100');
    expect(cell(csv, 3, 'param_alpha_auto')).toBe('true');
    expect(cell(csv, 3, 'param_a_m')).toBe('');
  });

  it('names the mesh file for an alpha crown and leaves it empty otherwise', () => {
    const csv = buildCrownCsv([
      { scanName: 's', crown: crown('ellipsoid', ELLIPSOID) },
      { scanName: 's', crown: crown('alpha', ALPHA), meshFile: 'oak_s_tree1.obj' },
    ], 0.2);
    // The parametric row is fully described by its params, so no mesh travels
    // with it; the alpha row's geometry lives in the referenced file.
    expect(cell(csv, 1, 'mesh_file')).toBe('');
    expect(cell(csv, 2, 'mesh_file')).toBe('oak_s_tree1.obj');
  });

  it('reports the mesh size so an alpha row says how big its file is', () => {
    const csv = buildCrownCsv([{ scanName: 's', crown: crown('alpha', ALPHA) }], 0.2);
    expect(cell(csv, 1, 'mesh_vertices')).toBe('338');
    expect(cell(csv, 1, 'mesh_triangles')).toBe('672');
  });

  it('leaves parameter and size cells blank when the backend predates them', () => {
    // A mismatched/older backend omits `params` and the counts entirely. The row
    // must still be well-formed rather than throwing or emitting "undefined".
    const c = crown('ellipsoid', undefined);
    delete c.metrics.num_vertices;
    delete c.metrics.num_triangles;
    const csv = buildCrownCsv([{ scanName: 's', crown: c }], 0.2);
    expect(cells(csv, 1)).toHaveLength(CROWN_CSV_HEADER.length);
    expect(cell(csv, 1, 'param_a_m')).toBe('');
    expect(cell(csv, 1, 'param_alpha_auto')).toBe('');
    expect(cell(csv, 1, 'mesh_vertices')).toBe('');
    // The metrics that DO exist are unaffected.
    expect(cell(csv, 1, 'crown_volume_m3')).toBe('42.1250');
  });

  it('quotes a scan name containing a comma or a quote', () => {
    const csv = buildCrownCsv([
      { scanName: 'plot 3, north', crown: crown('alpha', ALPHA) },
      { scanName: 'the "big" oak', crown: crown('alpha', ALPHA) },
    ], 0.2);
    const lines = csv.trim().split('\n');
    expect(lines[1].startsWith('"plot 3, north",')).toBe(true);
    expect(lines[2].startsWith('"the ""big"" oak",')).toBe(true);
  });
});

describe('crownExportBaseName', () => {
  it('prefers what the user typed', () => {
    expect(crownExportBaseName('  my_crowns ', 'oak')).toBe('my_crowns');
  });

  it('falls back to the scan name when the field is empty', () => {
    expect(crownExportBaseName('', 'oak_plot3')).toBe('oak_plot3');
  });

  it('strips a typed extension so it cannot leak into the written names', () => {
    expect(crownExportBaseName('crowns.csv', 'oak')).toBe('crowns');
  });

  it('never falls back to the scan-export default of "scans"', () => {
    // exportBaseName('') returns 'scans'; a crown export naming itself after
    // scans would misdescribe the file.
    expect(crownExportBaseName('', '')).toBe('crowns');
  });
});

describe('crownMeshFileName', () => {
  it('names a per-tree crown by its tree id', () => {
    expect(crownMeshFileName('oak', 'plot3', 7, 'obj', new Set())).toBe('oak_plot3_tree7.obj');
  });

  it('names an unsegmented whole-cloud fit "crown"', () => {
    expect(crownMeshFileName('oak', 'plot3', 0, 'ply', new Set())).toBe('oak_plot3_crown.ply');
  });

  it('dedupes within a batch so two crowns cannot overwrite one file', () => {
    const used = new Set<string>();
    const a = crownMeshFileName('oak', 'plot3', 1, 'stl', used);
    const b = crownMeshFileName('oak', 'plot3', 1, 'stl', used);
    expect(a).toBe('oak_plot3_tree1.stl');
    expect(b).toBe('oak_plot3_tree1_2.stl');
  });

  it('dedupes case-insensitively, since macOS and Windows would collide', () => {
    const used = new Set<string>();
    crownMeshFileName('oak', 'Plot3', 1, 'obj', used);
    expect(crownMeshFileName('oak', 'PLOT3', 1, 'obj', used)).toBe('oak_PLOT3_tree1_2.obj');
  });

  it('sanitises a scan name with path-unsafe characters', () => {
    const name = crownMeshFileName('oak', 'plot 3/north.laz', 1, 'obj', new Set());
    expect(name).toBe('oak_plot_3_north_tree1.obj');
    expect(name).not.toMatch(/[/\\ ]/);
  });
});

describe('joinExportPath', () => {
  it('uses the separator the directory already uses', () => {
    expect(joinExportPath('/Users/me/out', 'a.csv')).toBe('/Users/me/out/a.csv');
    expect(joinExportPath('C:\\Users\\me', 'a.csv')).toBe('C:\\Users\\me\\a.csv');
  });

  it('does not double a trailing separator', () => {
    expect(joinExportPath('/Users/me/out/', 'a.csv')).toBe('/Users/me/out/a.csv');
  });
});
