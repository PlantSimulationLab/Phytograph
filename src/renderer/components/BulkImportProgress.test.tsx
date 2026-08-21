import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BulkImportProgress, type BulkImportProgressState } from './BulkImportProgress';

afterEach(cleanup);

// The modal is shared by every long-running import, but its default wording is
// scan-specific ("Importing scans…"). A mesh or skeleton import reusing it must
// be able to say what it is actually importing — the per-import `title` override
// is what makes that possible, alongside the older `hint` override.

const base: BulkImportProgressState = { current: 1, total: 1, label: 'Loading tree.obj' };

const title = () => screen.getByTestId('bulk-import-progress-title').textContent;

describe('BulkImportProgress header', () => {
  it('defaults to the scan wording when nothing overrides it', () => {
    render(<BulkImportProgress progress={base} />);
    expect(title()).toBe('Importing scans…');
  });

  it('lets a caller retitle the modal via the title prop', () => {
    render(<BulkImportProgress progress={base} title="Stitching clouds…" />);
    expect(title()).toBe('Stitching clouds…');
  });

  it('lets a single import retitle the modal for its own file type', () => {
    // The bug: a mesh import showed "Importing scans…", which is simply wrong —
    // scans are irrelevant when the file being read is a mesh.
    render(<BulkImportProgress progress={{ ...base, title: 'Importing mesh…' }} />);
    expect(title()).toBe('Importing mesh…');
  });

  it('per-import title beats the component prop', () => {
    // A shared modal instance gets its prop from the render site; the in-flight
    // import knows better what it is doing, so it wins.
    render(
      <BulkImportProgress
        progress={{ ...base, title: 'Importing skeleton…' }}
        title="Importing scans…"
      />,
    );
    expect(title()).toBe('Importing skeleton…');
  });

  it('still shows the per-import hint alongside the per-import title', () => {
    render(
      <BulkImportProgress
        progress={{ ...base, title: 'Importing mesh…', hint: 'Reading mesh from disk…' }}
      />,
    );
    expect(title()).toBe('Importing mesh…');
    expect(screen.getByText('Reading mesh from disk…')).toBeTruthy();
  });

  it('renders nothing when there is no import in flight', () => {
    render(<BulkImportProgress progress={null} />);
    expect(screen.queryByTestId('bulk-import-progress')).toBeNull();
  });
});
