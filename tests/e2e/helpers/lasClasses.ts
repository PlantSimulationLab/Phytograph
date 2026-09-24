import { readFileSync } from 'node:fs';

/**
 * Point format and the classification byte of every record in a LAS 1.4 file,
 * read straight from the bytes. The byte sits at record offset 16 in point
 * formats 6-10, and in the low 5 bits of offset 15 in the legacy 0-5.
 */
export function readLasClasses(path: string): { format: number; classes: number[] } {
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 4) !== 'LASF') throw new Error(`${path} is not a LAS file`);
  const offset = buf.readUInt32LE(96);
  const format = buf.readUInt8(104) & 0x3f;
  const recLen = buf.readUInt16LE(105);
  const n = Number(buf.readBigUInt64LE(247));
  const classes: number[] = [];
  for (let i = 0; i < n; i++) {
    const at = offset + i * recLen;
    classes.push(format >= 6 ? buf.readUInt8(at + 16) : buf.readUInt8(at + 15) & 0x1f);
  }
  return { format, classes };
}
