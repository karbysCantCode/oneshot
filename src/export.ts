/* =====================================================================
 *  Export helpers: encoding options, file naming and a small ZIP writer.
 *  Pixels are produced by the WebGL pipeline; only the final file
 *  encoding (PNG/JPEG/WebP) and ZIP packaging happen on the CPU.
 * ===================================================================== */

export type ExportFormat = 'png' | 'jpeg' | 'webp';
export type ExportScope = 'current' | 'shown' | 'batch';

export type ExportOptions = {
  scope: ExportScope;
  format: ExportFormat;
  /** 1–100, JPEG / WebP only. */
  quality: number;
  /** Longest edge in px; 0 = full resolution. */
  maxSize: number;
  /** Appended to the original file name. */
  suffix: string;
  /** Several files: one ZIP, or individual downloads. */
  packaging: 'zip' | 'files';
};

export const defaultExportOptions: ExportOptions = {
  scope: 'current',
  format: 'jpeg',
  quality: 92,
  maxSize: 0,
  suffix: '_edit',
  packaging: 'zip',
};

const KEY = 'nodegl.export.v1';
export function loadExportOptions(): ExportOptions {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaultExportOptions, ...JSON.parse(raw) } : defaultExportOptions;
  } catch {
    return defaultExportOptions;
  }
}
export function saveExportOptions(o: ExportOptions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

export const MIME: Record<ExportFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
export const EXT: Record<ExportFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };

/** Whether this browser can encode a format (Safari can't encode WebP). */
export function canEncode(format: ExportFormat) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL(MIME[format]).startsWith(`data:${MIME[format]}`);
  } catch {
    return false;
  }
}

/** Encode a canvas. The canvas bitmap is copied synchronously when this is called. */
export function encodeCanvas(canvas: HTMLCanvasElement, format: ExportFormat, quality: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), MIME[format], format === 'png' ? undefined : quality / 100),
  );
}

/** "IMG_001.CR2.jpg" + "_edit" + "jpg" → "IMG_001.CR2_edit.jpg"; unique within `used`. */
export function exportName(original: string, suffix: string, format: ExportFormat, used: Set<string>) {
  const base = (original.replace(/\.[^./\\]+$/, '') || 'image').replace(/[\\/:*?"<>|]+/g, '_');
  let name = `${base}${suffix}.${EXT[format]}`;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}${suffix}_${i}.${EXT[format]}`;
  used.add(name.toLowerCase());
  return name;
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------- ZIP (store, no compression – images are already compressed) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP limit without ZIP64. */
export const ZIP_MAX_BYTES = 0xfffffffe;

/** Build a ZIP from files. Total size must stay below ~4 GB. */
export async function makeZip(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, data);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    const entry = new Uint8Array(46 + name.length);
    entry.set(new Uint8Array(c.buffer), 0);
    entry.set(name, 46);
    central.push(entry);

    offset += 30 + name.length + data.length;
  }

  const cdSize = central.reduce((s, e) => s + e.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
