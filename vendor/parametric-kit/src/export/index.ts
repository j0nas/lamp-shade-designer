// Download/export helpers all three apps repeat: the anchor-click download idiom, and a binary-STL
// wrapper around three's STLExporter so the preview mesh and the downloaded file come from the same
// geometry.

import { BufferGeometry, Mesh, type Object3D } from "three";
import { STLExporter } from "three/addons/exporters/STLExporter.js";

// Trigger a browser download of a blob. The object URL is revoked on the next macrotask, after the
// click has had a chance to start the download.
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Trigger a browser download of text content (CSV, JSON, …), tagged UTF-8.
export function downloadText(name: string, text: string, mime = "text/plain"): void {
  downloadBlob(name, new Blob([text], { type: `${mime};charset=utf-8` }));
}

// Serialize a mesh/object/geometry to a binary STL. A bare BufferGeometry is wrapped in a throwaway
// Mesh (what the exporter needs); a Mesh/Object3D is parsed as-is — STLExporter traverses it.
export function stlBinary(input: Object3D | BufferGeometry): DataView<ArrayBuffer> {
  const object = input instanceof BufferGeometry ? new Mesh(input) : input;
  return new STLExporter().parse(object, { binary: true });
}

// Export a mesh/object/geometry as a downloaded binary STL, ready to print (mm, Z-up, no supports —
// exactly what the preview shows).
export function exportSTL(input: Object3D | BufferGeometry, filename: string): void {
  downloadBlob(filename, new Blob([stlBinary(input)], { type: "application/octet-stream" }));
}
