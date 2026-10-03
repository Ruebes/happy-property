// Typ-Stub NUR für tsc (npm run check:functions, tsconfig.guards.json): grob,
// geprüft werden soll unser Code, nicht die Bibliothek. Genutzt von studio.
declare module 'https://esm.sh/@resvg/resvg-wasm@2.6.2' {
  export function initWasm(module: unknown): Promise<void>
  export class Resvg {
    constructor(svg: string | Uint8Array, options?: Record<string, unknown>)
    render(): { asPng(): Uint8Array; width: number; height: number }
  }
}
