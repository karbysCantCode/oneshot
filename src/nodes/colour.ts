/**
 * Colour maths used to build shader uniforms (matrices, wheel colours, white balance).
 * These only compute small parameter values – no image pixels are processed on the CPU.
 * Matrices are row-major and uploaded with transpose = true.
 */

export type Mat3 = number[]; // 9 numbers, row-major
export type Vec3 = [number, number, number];

export const mul = (a: Mat3, b: Mat3): Mat3 => {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
};

export const mulVec = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export function inv(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

export const diag = (v: Vec3): Mat3 => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/* ---------- colour spaces (D65 XYZ) ---------- */

const SRGB_TO_XYZ: Mat3 = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
const P3_TO_XYZ: Mat3 = [0.4865709, 0.2656677, 0.1982173, 0.2289746, 0.6917385, 0.0792869, 0.0, 0.0451134, 1.0439444];
const REC2020_TO_XYZ: Mat3 = [0.636958, 0.1446169, 0.168881, 0.2627002, 0.6779981, 0.0593017, 0.0, 0.0280727, 1.0609851];
/** ACEScg (AP1) → linear sRGB, Bradford-adapted D60 → D65. */
const ACESCG_TO_SRGB: Mat3 = [1.7050515, -0.6217923, -0.0832593, -0.1302597, 1.1408027, -0.010543, -0.0240033, -0.1289687, 1.152972];
const ACESCG_TO_XYZ = mul(SRGB_TO_XYZ, ACESCG_TO_SRGB);

export type SpaceId = 'lin_srgb' | 'srgb' | 'rec709' | 'acescg' | 'acescct' | 'p3' | 'lin_p3' | 'lin_rec2020';

/** Transfer function ids, matching the GLSL helpers decodeTF / encodeTF. */
export const TF = { linear: 0, srgb: 1, gamma24: 2, acescct: 3 } as const;

export const SPACES: { value: SpaceId; label: string; toXYZ: Mat3; tf: number }[] = [
  { value: 'lin_srgb', label: 'Linear sRGB / Rec.709 (working)', toXYZ: SRGB_TO_XYZ, tf: TF.linear },
  { value: 'srgb', label: 'sRGB (display encoded)', toXYZ: SRGB_TO_XYZ, tf: TF.srgb },
  { value: 'rec709', label: 'Rec.709 (gamma 2.4)', toXYZ: SRGB_TO_XYZ, tf: TF.gamma24 },
  { value: 'acescg', label: 'ACEScg (linear AP1)', toXYZ: ACESCG_TO_XYZ, tf: TF.linear },
  { value: 'acescct', label: 'ACEScct (log AP1)', toXYZ: ACESCG_TO_XYZ, tf: TF.acescct },
  { value: 'p3', label: 'Display P3', toXYZ: P3_TO_XYZ, tf: TF.srgb },
  { value: 'lin_p3', label: 'Linear Display P3', toXYZ: P3_TO_XYZ, tf: TF.linear },
  { value: 'lin_rec2020', label: 'Linear Rec.2020', toXYZ: REC2020_TO_XYZ, tf: TF.linear },
];

export const space = (id: string) => SPACES.find((s) => s.value === id) ?? SPACES[0];

/** Matrix converting linear RGB in `from` primaries to linear RGB in `to` primaries. */
export const primariesMatrix = (from: string, to: string): Mat3 => mul(inv(space(to).toXYZ), space(from).toXYZ);

/* ---------- white balance ---------- */

/** CIE xy chromaticity of a Planckian (black-body) light, Kim et al. approximation, 1667–25000 K. */
export function kelvinToXY(kelvin: number): [number, number] {
  const T = Math.min(25000, Math.max(1667, kelvin));
  const t = 1e3 / T, t2 = t * t, t3 = t2 * t;
  const x = T <= 4000
    ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.17991
    : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;
  const x2 = x * x, x3 = x2 * x;
  const y = T <= 2222
    ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000
      ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const xyToXYZ = ([x, y]: [number, number]): Vec3 => [x / y, 1, (1 - x - y) / y];

/** Tint units are shifts of the white point's y chromaticity (positive = magenta correction). */
const TINT_SCALE = 0.0003;

/**
 * Linear-sRGB matrix that neutralises a light source of `kelvin` / `tint`
 * (Lightroom semantics: set Temp to the light's colour temperature to correct it).
 * 6500 K / 0 tint = identity.
 */
export function whiteBalanceMatrix(kelvin: number, tint: number): Mat3 {
  const [sx, sy] = kelvinToXY(kelvin);
  const src = xyToXYZ([sx, sy + tint * TINT_SCALE]);
  const dst = xyToXYZ(kelvinToXY(6500));
  const cs = mulVec(BRADFORD, src);
  const cd = mulVec(BRADFORD, dst);
  const adapt = mul(inv(BRADFORD), mul(diag([cd[0] / cs[0], cd[1] / cs[1], cd[2] / cs[2]]), BRADFORD));
  return mul(inv(SRGB_TO_XYZ), mul(adapt, SRGB_TO_XYZ));
}

/* ---------- colour wheels ---------- */

export function hsvToRgb(h: number, s: number, v: number): Vec3 {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];
export const luma = (c: Vec3) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];

/** Wheel puck position (x right, y down, radius ≤ 1) → hue (0–1, red at top, clockwise) and amount. */
export function wheelHueAmount(x: number, y: number): { hue: number; amount: number } {
  const amount = Math.min(1, Math.hypot(x, y));
  const hue = ((Math.atan2(x, -y) / (2 * Math.PI)) % 1 + 1) % 1;
  return { hue, amount };
}

/** Wheel colour as an RGB offset with zero luminance, scaled by the puck distance. */
export function wheelOffset(x: number, y: number): Vec3 {
  const { hue, amount } = wheelHueAmount(x, y);
  const c = hsvToRgb(hue, 1, 1);
  const l = luma(c);
  return [(c[0] - l) * amount, (c[1] - l) * amount, (c[2] - l) * amount];
}

/** Wheel colour as a luminance-normalised tint (1,1,1 = neutral) minus one, scaled by distance. */
export function wheelTint(x: number, y: number): Vec3 {
  const { hue, amount } = wheelHueAmount(x, y);
  const c = hsvToRgb(hue, 1, 1);
  const l = luma(c);
  return [(c[0] / l - 1) * amount, (c[1] / l - 1) * amount, (c[2] / l - 1) * amount];
}

/** "#rrggbb" → linear RGB. */
export function hexToLinear(hex: string): Vec3 {
  const n = parseInt(hex.replace('#', ''), 16) || 0;
  const dec = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return [dec(((n >> 16) & 255) / 255), dec(((n >> 8) & 255) / 255), dec((n & 255) / 255)];
}
