import { describe, expect, it } from 'vitest';
import { SHIFTLESS_KINDS } from '../components/PointCloudImportWizard';

describe('global shift visibility by format', () => {
  it('hides the shift control for a RIEGL raw project', () => {
    // The control was offered for every previewed format, but the .riproject
    // extract endpoint has no world_shift parameter — so a user could tick the
    // box, type an offset, and nothing at all would happen. A RIEGL project is
    // scanner-local metres anyway: each position sits at its own origin, offset
    // only by a centroid-anchored ENU prior, so there is nothing large to
    // shift away.
    expect(SHIFTLESS_KINDS.has('riproject')).toBe(true);
  });

  it('still offers it for formats whose importer applies a shift', () => {
    // These DO route through create_cloud_session's world_shift, and a UTM
    // cloud genuinely needs it to avoid float32 render artefacts.
    for (const kind of ['ascii', 'las', 'laz', 'e57', 'ply', 'pcd', 'ptx']) {
      expect(SHIFTLESS_KINDS.has(kind)).toBe(false);
    }
  });
});
