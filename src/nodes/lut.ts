import type { LutData } from '../types';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Parse an Adobe/Resolve .cube 3D LUT. Throws a readable error for unsupported files. */
export function parseCube(text: string, name: string): LutData {
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const head = parts[0].toUpperCase();
    if (head === 'TITLE') continue;
    if (head === 'LUT_1D_SIZE') throw new Error('1D .cube LUTs are not supported – use a 3D LUT');
    if (head === 'LUT_3D_SIZE') {
      size = parseInt(parts[1], 10);
      continue;
    }
    if (head === 'DOMAIN_MIN') {
      domainMin = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      continue;
    }
    if (head === 'DOMAIN_MAX') {
      domainMax = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      continue;
    }
    if (/^[A-Z_]+$/.test(head)) continue; // other keywords (LUT_3D_INPUT_RANGE etc.)
    if (parts.length >= 3) values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }

  if (!size || size < 2 || size > 256) throw new Error('Missing or invalid LUT_3D_SIZE');
  const expected = size * size * size;
  if (values.length / 3 !== expected) throw new Error(`Expected ${expected} entries, found ${values.length / 3}`);
  if (values.some((v) => !Number.isFinite(v))) throw new Error('LUT contains invalid numbers');

  const data = new Float32Array(expected * 4);
  for (let i = 0; i < expected; i++) {
    data[i * 4] = values[i * 3];
    data[i * 4 + 1] = values[i * 3 + 1];
    data[i * 4 + 2] = values[i * 3 + 2];
    data[i * 4 + 3] = 1;
  }
  return { id: uid(), name, size, data, domainMin, domainMax, text };
}
