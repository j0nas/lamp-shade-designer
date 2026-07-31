// Minimal 3MF writer — the 3D Manufacturing Format modern slicers (Bambu, Prusa, Orca) import
// natively. A 3MF is an OPC package: a ZIP whose payload is XML. The mesh rides in
// 3D/3dmodel.model with an explicit millimetre unit — killing the "what unit is this STL"
// question — and the model carries Title/Application metadata the way the STL header carries the
// provenance stamp.
//
// The ZIP is hand-rolled and STORED (no compression): a writer with a fixed method-0 layout is
// ~60 lines and dependency-free, and the XML for a dense shade is of the same order as the
// equivalent binary STL. Everything here is pure bytes-in-bytes-out, so it runs identically in
// the export worker and in Node tests.

export type Mesh3mf = {
  verts: Float32Array; // xyz triples, millimetres
  tris: Uint32Array | Uint16Array; // vertex-index triples, CCW from outside
  title: string;
  app: string;
};

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

const escapeXml = (s: string): string =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );

// Millimetres to 3 decimals (1 µm — far below print resolution), trailing zeros trimmed; roughly
// halves the XML next to printing full doubles.
const fmt = (x: number): string => x.toFixed(3).replace(/\.?0+$/, "");

function modelXml(m: Mesh3mf): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
      `<metadata name="Title">${escapeXml(m.title)}</metadata>\n` +
      `<metadata name="Application">${escapeXml(m.app)}</metadata>\n` +
      '<resources><object id="1" type="model"><mesh>\n<vertices>\n',
  ];
  for (let i = 0; i < m.verts.length; i += 3) {
    parts.push(
      `<vertex x="${fmt(m.verts[i])}" y="${fmt(m.verts[i + 1])}" z="${fmt(m.verts[i + 2])}"/>\n`,
    );
  }
  parts.push("</vertices>\n<triangles>\n");
  for (let i = 0; i < m.tris.length; i += 3) {
    parts.push(`<triangle v1="${m.tris[i]}" v2="${m.tris[i + 1]}" v3="${m.tris[i + 2]}"/>\n`);
  }
  parts.push(
    '</triangles>\n</mesh></object></resources>\n<build><item objectid="1"/></build>\n</model>\n',
  );
  return parts.join("");
}

// --- stored ZIP ----------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed 1980-01-01 00:00 DOS timestamp: re-exporting the same design gives byte-identical output,
// which is what lets a golden test pin the whole file rather than fuzzy-matching around a clock.
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;

type ZipEntry = { name: string; data: Uint8Array };

function storedZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const items = entries.map((e) => ({ ...e, nameB: enc.encode(e.name), crc: crc32(e.data) }));

  const localSize = items.reduce((s, it) => s + 30 + it.nameB.length + it.data.length, 0);
  const centralSize = items.reduce((s, it) => s + 46 + it.nameB.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const dv = new DataView(out.buffer);

  // Shared fields of a local (isLocal) or central directory header, little-endian throughout.
  const header = (at: number, it: (typeof items)[number], isLocal: boolean, offset: number) => {
    let w = at;
    dv.setUint32(w, isLocal ? 0x04034b50 : 0x02014b50, true);
    w += 4;
    if (!isLocal) {
      dv.setUint16(w, 20, true); // version made by
      w += 2;
    }
    dv.setUint16(w, 20, true); // version needed: 2.0, plain stored entries
    dv.setUint16(w + 2, 0, true); // flags
    dv.setUint16(w + 4, 0, true); // method 0 = stored
    dv.setUint16(w + 6, DOS_TIME, true);
    dv.setUint16(w + 8, DOS_DATE, true);
    dv.setUint32(w + 10, it.crc, true);
    dv.setUint32(w + 14, it.data.length, true); // compressed size (= raw: stored)
    dv.setUint32(w + 18, it.data.length, true); // uncompressed size
    dv.setUint16(w + 22, it.nameB.length, true);
    dv.setUint16(w + 24, 0, true); // extra length
    w += 26;
    if (!isLocal) {
      // comment len, disk start, internal attrs (all 0), external attrs, local header offset
      dv.setUint16(w, 0, true);
      dv.setUint16(w + 2, 0, true);
      dv.setUint16(w + 4, 0, true);
      dv.setUint32(w + 6, 0, true);
      dv.setUint32(w + 10, offset, true);
      w += 14;
    }
    out.set(it.nameB, w);
    return w + it.nameB.length;
  };

  let w = 0;
  const offsets: number[] = [];
  for (const it of items) {
    offsets.push(w);
    w = header(w, it, true, 0);
    out.set(it.data, w);
    w += it.data.length;
  }
  const centralStart = w;
  items.forEach((it, i) => {
    w = header(w, it, false, offsets[i]);
  });
  // End of central directory.
  dv.setUint32(w, 0x06054b50, true);
  dv.setUint16(w + 4, 0, true); // this disk
  dv.setUint16(w + 6, 0, true); // central-dir disk
  dv.setUint16(w + 8, items.length, true);
  dv.setUint16(w + 10, items.length, true);
  dv.setUint32(w + 12, centralSize, true);
  dv.setUint32(w + 16, centralStart, true);
  dv.setUint16(w + 20, 0, true); // comment length
  return out;
}

export function meshTo3mf(m: Mesh3mf): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  return storedZip([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(RELS) },
    { name: "3D/3dmodel.model", data: enc.encode(modelXml(m)) },
  ]);
}
