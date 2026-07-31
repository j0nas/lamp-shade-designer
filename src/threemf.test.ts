// The 3MF writer, byte level. The package must be a valid STORED zip — correct signatures, CRCs
// and central-directory offsets, because a wrong CRC makes strict unzippers (and some slicers)
// reject the file — and the model XML must carry the mesh verbatim, in millimetres.
import { describe, expect, test } from "vite-plus/test";
import { crc32, meshTo3mf } from "./threemf.ts";

// A tetrahedron: the smallest closed mesh, hand-checkable. The title exercises XML escaping.
const TETRA = {
  verts: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10.5]),
  tris: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]),
  title: 'Aurora <v2> & "friends"',
  app: "lamp-shade dev",
};

// A minimal local-header walk, independent of the writer's central directory — so the two halves
// of the archive cross-check each other.
function readZip(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, { data: Uint8Array; crc: number }>();
  let at = 0;
  while (dv.getUint32(at, true) === 0x04034b50) {
    const crc = dv.getUint32(at + 14, true);
    const size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extraLen = dv.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const start = at + 30 + nameLen + extraLen;
    entries.set(name, { data: bytes.subarray(start, start + size), crc });
    at = start + size;
  }
  return { entries, centralStart: at };
}

describe("crc32", () => {
  test("matches the published check vectors", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(new TextEncoder().encode("abc"))).toBe(0x352441c2);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926); // the standard CHECK value
  });
});

describe("meshTo3mf", () => {
  const bytes = meshTo3mf(TETRA);
  const { entries, centralStart } = readZip(bytes);

  test("is a stored zip holding exactly the three OPC parts", () => {
    expect([...entries.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]);
    for (const { data, crc } of entries.values()) expect(crc32(data)).toBe(crc);
  });

  test("the end-of-central-directory record agrees with the local headers", () => {
    const dv = new DataView(bytes.buffer, bytes.byteLength - 22, 22);
    expect(dv.getUint32(0, true)).toBe(0x06054b50);
    expect(dv.getUint16(10, true)).toBe(3); // entry count
    expect(dv.getUint32(16, true)).toBe(centralStart); // where the central directory begins
  });

  test("the model is millimetre XML with the mesh verbatim and the title escaped", () => {
    const xml = new TextDecoder().decode(entries.get("3D/3dmodel.model")!.data);
    expect(xml).toContain('<model unit="millimeter"');
    expect(xml.match(/<vertex /g)).toHaveLength(4);
    expect(xml.match(/<triangle /g)).toHaveLength(4);
    expect(xml).toContain('<vertex x="10" y="0" z="0"/>'); // trailing zeros trimmed
    expect(xml).toContain('z="10.5"');
    expect(xml).toContain('<triangle v1="2" v2="0" v3="3"/>');
    expect(xml).toContain("Aurora &lt;v2&gt; &amp; &quot;friends&quot;");
    expect(xml).toContain('<item objectid="1"/>');
  });

  test("re-exporting the same design is byte-identical (fixed timestamps)", () => {
    expect(meshTo3mf(TETRA)).toEqual(bytes);
  });

  test("the content-types part registers the model extension", () => {
    const xml = new TextDecoder().decode(entries.get("[Content_Types].xml")!.data);
    expect(xml).toContain('Extension="model"');
    expect(xml).toContain("3dmanufacturing-3dmodel+xml");
  });
});
