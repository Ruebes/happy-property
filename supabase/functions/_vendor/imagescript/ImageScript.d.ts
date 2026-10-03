// Typ-Stub NUR für tsc (npm run check:functions, tsconfig.guards.json).
// Deno lädt zur Laufzeit ImageScript.js direkt; diese Datei wird nie gebündelt.
// Enthält nur, was die geprüften Functions benutzen (studio, _shared/higgsfield.ts);
// bei Bedarf ergänzen.
export class Image {
  static RESIZE_AUTO: number
  static decode(data: Uint8Array | ArrayBuffer): Promise<Image>
  readonly width: number
  readonly height: number
  clone(): Image
  crop(x: number, y: number, width: number, height: number): Image
  resize(width: number, height: number): Image
  composite(source: Image, x?: number, y?: number): Image
  encode(compression?: number): Promise<Uint8Array>
  encodeJPEG(quality?: number): Promise<Uint8Array>
}
