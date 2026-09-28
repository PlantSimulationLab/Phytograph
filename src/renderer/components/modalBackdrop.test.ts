// A modal's dimmed backdrop must NOT dismiss it.
//
// Most of our modals are option forms (triangulation, LAD, synthetic scan,
// export, registration, ...) that can take minutes to fill in. A backdrop that
// closed on click threw all of it away on one stray click just outside the
// panel. Dismissal is intentional only: the X / Cancel buttons (and Esc where a
// modal handles it).
//
// Every modal draws the same backdrop element, so this pins the rule at the
// source level: no `bg-black/NN backdrop-blur` overlay may carry a click
// handler. Lightweight popovers (colour pickers, the command palette) use an
// invisible click-catcher instead and are deliberately out of scope.
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const RENDERER = join(process.cwd(), 'src/renderer');

async function tsxFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsxFiles(p)));
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(p);
  }
  return out;
}

// A JSX element whose className is a full-screen dimmed backdrop, up to the end
// of its opening tag.
const BACKDROP = /<div\b[^>]*className="[^"]*\binset-0\b[^"]*\bbg-black\/\d+[^"]*"[^>]*>/g;

describe('modal backdrops', () => {
  it('never dismiss the modal on click', async () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of await tsxFiles(RENDERER)) {
      const src = (await readFile(file, 'utf8')).replace(/\0/g, '');
      for (const m of src.matchAll(BACKDROP)) {
        seen++;
        if (/\bon(Click|MouseDown|PointerDown|MouseUp|PointerUp)\s*=/.test(m[0])) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${file.slice(RENDERER.length + 1)}:${line}`);
        }
      }
    }
    // The scan must actually find the modals, or it proves nothing.
    expect(seen).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
