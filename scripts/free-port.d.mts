// Types for scripts/free-port.mjs, which src/main/backend.ts imports.
export interface PortBand { readonly min: number; readonly max: number }
export declare const PORT_BANDS: Readonly<{ app: PortBand; dev: PortBand; e2e: PortBand }>;
export declare function e2eWorkerBand(parallelIndex: number | string | undefined): PortBand;
export declare function canListen(port: number, host?: string): Promise<boolean>;
export declare function findFreePort(
  band: PortBand,
  opts?: { exclude?: number[]; tries?: number; host?: string },
): Promise<number>;
