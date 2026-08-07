import { describe, it, expect } from 'vitest';
import { isQsmCsvHeader, isQsmCsvFile } from './qsmImport';

// The exact header qsmToCylinderCsv writes (qsmExport.ts). Duplicated on purpose:
// if the exporter's header ever changes, this test fails and forces the detector
// to be updated alongside it — otherwise the app would stop recognizing its own
// exports and silently route them to the point-cloud wizard.
const PHYTOGRAPH_HEADER =
  'ID,parentID,branchID,branchOrder,segmentID,parentSegmentID,' +
  'startX,startY,startZ,endX,endY,endZ,' +
  'axisX,axisY,axisZ,radius,length,surfaceCoverage,meanAbsDeviation';

describe('isQsmCsvHeader', () => {
  it('accepts the header Phytograph itself exports', () => {
    expect(isQsmCsvHeader(PHYTOGRAPH_HEADER)).toBe(true);
  });

  it('accepts a trailing carriage return (CRLF files)', () => {
    expect(isQsmCsvHeader(`${PHYTOGRAPH_HEADER}\r`)).toBe(true);
  });

  it('accepts case and separator variants of the column names', () => {
    expect(isQsmCsvHeader('id,parent_id,branch_id,branch_order,radius')).toBe(true);
    expect(isQsmCsvHeader('Id,ParentId,BranchId,BranchOrder')).toBe(true);
    expect(isQsmCsvHeader('ID,parent-id,branch-id,branch-order')).toBe(true);
  });

  it('accepts semicolon- and tab-delimited headers', () => {
    expect(isQsmCsvHeader(PHYTOGRAPH_HEADER.replace(/,/g, ';'))).toBe(true);
    expect(isQsmCsvHeader(PHYTOGRAPH_HEADER.replace(/,/g, '\t'))).toBe(true);
  });

  it('accepts a BOM-prefixed header (Excel-saved CSV)', () => {
    expect(isQsmCsvHeader(`﻿${PHYTOGRAPH_HEADER}`)).toBe(true);
  });

  it('rejects a point-cloud CSV header', () => {
    expect(isQsmCsvHeader('x,y,z,intensity')).toBe(false);
    expect(isQsmCsvHeader('X,Y,Z,R,G,B,classification')).toBe(false);
    expect(isQsmCsvHeader('//X,Y,Z,Reflectance')).toBe(false);
  });

  it('rejects a partial match missing a required column', () => {
    // branchID/branchOrder present but no ID/parentID — not a cylinder table.
    expect(isQsmCsvHeader('branchID,branchOrder,x,y,z')).toBe(false);
    // Topology columns without the branch columns: a skeleton-ish edge list.
    expect(isQsmCsvHeader('ID,parentID,x,y,z')).toBe(false);
  });

  it('rejects empty, blank, and non-CSV first lines', () => {
    expect(isQsmCsvHeader('')).toBe(false);
    expect(isQsmCsvHeader('   ')).toBe(false);
    expect(isQsmCsvHeader('ply')).toBe(false);
    expect(isQsmCsvHeader('1.0 2.0 3.0')).toBe(false);
  });

  it('does not match a data row that happens to be read first', () => {
    expect(isQsmCsvHeader('0,-1,0,0,0,-1,0,0,0,0,0,1,0,0,1,0.05,1,,')).toBe(false);
  });
});

describe('isQsmCsvFile', () => {
  const asFile = (text: string, name = 'tree.csv') =>
    new File([text], name, { type: 'text/csv' });

  it('detects a QSM CSV from its first line only', async () => {
    const body = '0,-1,0,0,0,-1,0,0,0,0,0,1,0,0,1,0.05,1,,\n';
    expect(await isQsmCsvFile(asFile(`${PHYTOGRAPH_HEADER}\n${body}`))).toBe(true);
  });

  it('rejects a point-cloud CSV', async () => {
    expect(await isQsmCsvFile(asFile('x,y,z\n1,2,3\n4,5,6\n'))).toBe(false);
  });

  it('rejects an empty file without throwing', async () => {
    expect(await isQsmCsvFile(asFile(''))).toBe(false);
  });

  it('reads only the head of a large file', async () => {
    // A QSM header followed by more than the 64 KB probe window still detects,
    // proving detection never depends on reading the whole cloud-sized file.
    const filler = '0,-1,0,0,0,-1,0,0,0,0,0,1,0,0,1,0.05,1,,\n'.repeat(5000);
    expect(await isQsmCsvFile(asFile(`${PHYTOGRAPH_HEADER}\n${filler}`))).toBe(true);
  });
});
