import type { Curves, CurvePoint, Params } from '../types';
import {
  IDENTITY,
  SPACES,
  hexToLinear,
  primariesMatrix,
  space,
  wheelOffset,
  wheelTint,
  whiteBalanceMatrix,
  type Vec3,
} from './colour';

/* =====================================================================
 *  Node registry
 *  Each node = UI controls + a GLSL `vec4 effect(vec4 c)` + a function
 *  that turns parameters into shader uniforms. Pixels are processed only
 *  by the GPU; `effect` receives and returns linear-light RGBA.
 * ===================================================================== */

export type Category = 'Input / Output' | 'Tone' | 'Colour' | 'Utility';
export const CATEGORIES: Category[] = ['Input / Output', 'Tone', 'Colour', 'Utility'];

export type CurveChannel = { id: string; label: string; color: string; periodic: boolean; defaults: CurvePoint[]; xAxis?: 'tone' | 'hue' };

export type Control =
  | { type: 'slider'; key: string; label: string; min: number; max: number; step: number; default: number; unit?: string; digits?: number }
  | { type: 'select'; key: string; label: string; options: { value: string; label: string }[]; default: string }
  | { type: 'check'; key: string; label: string; default: boolean }
  | { type: 'color'; key: string; label: string; default: string }
  /** Colour wheel: stores `${key}X`, `${key}Y` (puck) and `${key}M` (master slider). */
  | { type: 'wheel'; key: string; label: string; masterLabel?: string }
  | { type: 'curves'; channels: CurveChannel[] }
  | { type: 'lut' }
  | { type: 'tabs'; tabs: { label: string; controls: Control[] }[] }
  | { type: 'note'; text: string };

/** Uniform values: number → float, [a,b(,c(,d))] → vecN, {m3} → mat3 (row-major), {fv} → float[] */
export type UniformValue = number | number[] | { m3: number[] } | { fv: number[] };
export type Uniforms = Record<string, UniformValue>;

export type NodeDef = {
  kind: string;
  label: string;
  category: Category;
  description: string;
  /** Extra words matched by the toolbox search. */
  keywords?: string;
  /** Node width in px (default 190). */
  width?: number;
  controls: Control[];
  /** GLSL declaring its uniforms and `vec4 effect(vec4 c)`. Omitted for Input / Output nodes. */
  glsl?: string;
  uniforms?: (p: Params) => Uniforms;
  /** Uses a 3D LUT texture (sampler3D u_lut). */
  lut?: boolean;
  /** Needs GPU image statistics of its input (sampler2D u_stats, 1×1). */
  stats?: boolean;
};

/* ---------- helpers ---------- */

const n = (p: Params, k: string) => Number(p[k] ?? 0);
const pct = (p: Params, k: string) => n(p, k) / 100;
const slider = (key: string, label: string, min: number, max: number, def = 0, step = 1, unit = '', digits = 0): Control => ({
  type: 'slider', key, label, min, max, step, default: def, unit, digits,
});
const wheelVec = (p: Params, key: string, f: (x: number, y: number) => Vec3, scale = 1): number[] => {
  const v = f(n(p, `${key}X`), n(p, `${key}Y`));
  const m = pct(p, `${key}M`);
  return [m + v[0] * scale, m + v[1] * scale, m + v[2] * scale];
};

const BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
const bandSliders = (prefix: string, min = -100, max = 100) => BANDS.map((b, i) => slider(`${prefix}${i}`, b, min, max));
const bandArray = (p: Params, prefix: string) => ({ fv: BANDS.map((_, i) => pct(p, `${prefix}${i}`)) });

const flat6: CurvePoint[] = [0, 1, 2, 3, 4, 5].map((i) => [i / 6, 0.5]);
const diagonal: CurvePoint[] = [[0, 0], [1, 1]];

const spaceOptions = SPACES.map((s) => ({ value: s.value, label: s.label }));

/* ---------- definitions ---------- */

export const NODE_DEFS: NodeDef[] = [
  /* ===== Input / Output ===== */
  { kind: 'input', label: 'Image Input', category: 'Input / Output', description: 'The active image from the Media Pool', controls: [] },
  { kind: 'folder', label: 'Folder Input', category: 'Input / Output', description: 'Batch-process every image in a folder', keywords: 'batch', width: 200, controls: [] },
  { kind: 'output', label: 'Output', category: 'Input / Output', description: 'Final result shown in the viewer', controls: [] },

  /* ===== Tone ===== */
  {
    kind: 'exposure',
    label: 'Exposure',
    category: 'Tone',
    description: 'Brightness in photographic stops',
    keywords: 'ev brightness stops',
    controls: [slider('stops', 'Stops', -5, 5, 0, 0.01, ' EV', 2)],
    glsl: `uniform float u_stops;
vec4 effect(vec4 c) { return vec4(c.rgb * exp2(u_stops), c.a); }`,
    uniforms: (p) => ({ u_stops: n(p, 'stops') }),
  },
  {
    kind: 'contrast',
    label: 'Contrast',
    category: 'Tone',
    description: 'Push tones away from a pivot (filmic, log-space)',
    controls: [
      slider('amount', 'Contrast', -100, 100),
      slider('pivot', 'Pivot', 1, 100, 18, 1, '%'),
      { type: 'check', key: 'luma', label: 'Preserve saturation', default: false },
    ],
    glsl: `uniform float u_k; uniform float u_pivot; uniform float u_luma;
vec4 effect(vec4 c) {
  vec3 o;
  if (u_luma > 0.5) {
    float l = max(luma(c.rgb), 1e-6);
    float nl = u_pivot * pow(l / u_pivot, u_k);
    o = c.rgb * (nl / l);
  } else {
    o = u_pivot * pow(max(c.rgb, 0.0) / u_pivot, vec3(u_k));
  }
  return vec4(o, c.a);
}`,
    uniforms: (p) => ({ u_k: Math.pow(2, n(p, 'amount') / 100), u_pivot: pct(p, 'pivot'), u_luma: p.luma ? 1 : 0 }),
  },
  {
    kind: 'tones',
    label: 'Highlights & Shadows',
    category: 'Tone',
    description: 'Highlights, Shadows, Whites and Blacks',
    keywords: 'whites blacks shadow highlight recovery lightroom basic',
    controls: [
      slider('highlights', 'Highlights', -100, 100),
      slider('shadows', 'Shadows', -100, 100),
      slider('whites', 'Whites', -100, 100),
      slider('blacks', 'Blacks', -100, 100),
    ],
    glsl: `uniform float u_hi; uniform float u_sh; uniform float u_wh; uniform float u_bl;
vec4 effect(vec4 c) {
  float l = max(luma(c.rgb), 0.0);
  float y = toSRGB1(l);
  float yc = clamp(y, 0.0, 1.0);
  float wB = pow(1.0 - yc, 4.0);
  float wS = exp(-pow((yc - 0.25) / 0.2, 2.0));
  float wH = exp(-pow((yc - 0.75) / 0.2, 2.0));
  float wW = pow(yc, 4.0);
  float ny = max(y + 0.25 * (u_bl * wB + u_sh * wS + u_hi * wH + u_wh * wW), 0.0);
  float nl = fromSRGB1(ny);
  vec3 o = l > 1e-6 ? c.rgb * (nl / l) : c.rgb + vec3(nl);
  return vec4(o, c.a);
}`,
    uniforms: (p) => ({ u_hi: pct(p, 'highlights'), u_sh: pct(p, 'shadows'), u_wh: pct(p, 'whites'), u_bl: pct(p, 'blacks') }),
  },
  {
    kind: 'levels',
    label: 'Levels',
    category: 'Tone',
    description: 'Black point, white point and gamma',
    keywords: 'input output black white gamma point',
    controls: [
      {
        type: 'select', key: 'channel', label: 'Channel', default: 'rgb',
        options: [{ value: 'rgb', label: 'RGB' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }],
      },
      slider('inBlack', 'In black', 0, 255, 0),
      slider('inWhite', 'In white', 0, 255, 255),
      slider('gamma', 'Gamma', 0.1, 5, 1, 0.01, '', 2),
      slider('outBlack', 'Out black', 0, 255, 0),
      slider('outWhite', 'Out white', 0, 255, 255),
    ],
    glsl: `uniform vec3 u_mask; uniform float u_ib; uniform float u_iw; uniform float u_g; uniform float u_ob; uniform float u_ow;
vec4 effect(vec4 c) {
  vec3 e = toSRGB(c.rgb);
  vec3 t = max((e - u_ib) / max(u_iw - u_ib, 1e-4), 0.0);
  t = pow(t, vec3(1.0 / u_g));
  t = mix(vec3(u_ob), vec3(u_ow), t);
  return vec4(fromSRGB(mix(e, t, u_mask)), c.a);
}`,
    uniforms: (p) => {
      const ch = String(p.channel);
      return {
        u_mask: ch === 'r' ? [1, 0, 0] : ch === 'g' ? [0, 1, 0] : ch === 'b' ? [0, 0, 1] : [1, 1, 1],
        u_ib: n(p, 'inBlack') / 255,
        u_iw: n(p, 'inWhite') / 255,
        u_g: Math.max(0.01, n(p, 'gamma')),
        u_ob: n(p, 'outBlack') / 255,
        u_ow: n(p, 'outWhite') / 255,
      };
    },
  },
  {
    kind: 'curves',
    label: 'Curves',
    category: 'Tone',
    description: 'RGB master and per-channel tone curves',
    keywords: 'tone curve rgb s-curve',
    width: 240,
    controls: [
      {
        type: 'curves',
        channels: [
          { id: 'master', label: 'RGB', color: '#e8ebf3', periodic: false, defaults: diagonal },
          { id: 'r', label: 'R', color: '#ff6b6b', periodic: false, defaults: diagonal },
          { id: 'g', label: 'G', color: '#5be38a', periodic: false, defaults: diagonal },
          { id: 'b', label: 'B', color: '#6da7ff', periodic: false, defaults: diagonal },
        ],
      },
    ],
    glsl: `vec4 effect(vec4 c) {
  vec3 e = toSRGB(c.rgb);
  e = vec3(curveAt(e.r, 0.0, 4.0), curveAt(e.g, 0.0, 4.0), curveAt(e.b, 0.0, 4.0));
  e = vec3(curveAt(e.r, 1.0, 4.0), curveAt(e.g, 2.0, 4.0), curveAt(e.b, 3.0, 4.0));
  return vec4(fromSRGB(e), c.a);
}`,
    uniforms: () => ({}),
  },
  {
    kind: 'lgg',
    label: 'Lift / Gamma / Gain',
    category: 'Tone',
    description: 'Primary colour wheels with Offset (DaVinci style)',
    keywords: 'colour wheels primaries offset davinci resolve grading',
    width: 260,
    controls: [
      { type: 'wheel', key: 'lift', label: 'Lift' },
      { type: 'wheel', key: 'gamma', label: 'Gamma' },
      { type: 'wheel', key: 'gain', label: 'Gain' },
      { type: 'wheel', key: 'offset', label: 'Offset' },
    ],
    glsl: `uniform vec3 u_lift; uniform vec3 u_gamma; uniform vec3 u_gain; uniform vec3 u_offset;
vec4 effect(vec4 c) {
  vec3 e = toSRGB(c.rgb);
  e = e + u_lift * 0.5 * (1.0 - clamp(e, 0.0, 1.0));
  e = sign(e) * pow(abs(e), 1.0 / max(1.0 + u_gamma, vec3(0.1)));
  e = e * max(1.0 + u_gain, vec3(0.0));
  e = e + u_offset * 0.25;
  return vec4(fromSRGB(e), c.a);
}`,
    uniforms: (p) => ({
      u_lift: wheelVec(p, 'lift', wheelOffset, 0.5),
      u_gamma: wheelVec(p, 'gamma', wheelOffset, 0.5),
      u_gain: wheelVec(p, 'gain', wheelOffset, 0.5),
      u_offset: wheelVec(p, 'offset', wheelOffset, 0.5),
    }),
  },
  {
    kind: 'printer',
    label: 'Printer Lights',
    category: 'Tone',
    description: 'Film-lab RGB printer points (1 pt ≈ 1/12 stop)',
    keywords: 'printer points offset film lab',
    controls: [
      slider('master', 'Master', -25, 25),
      slider('r', 'Red', -25, 25),
      slider('g', 'Green', -25, 25),
      slider('b', 'Blue', -25, 25),
    ],
    glsl: `uniform vec3 u_mult;
vec4 effect(vec4 c) { return vec4(c.rgb * u_mult, c.a); }`,
    uniforms: (p) => {
      const m = n(p, 'master');
      const f = (k: string) => Math.pow(10, 0.025 * (m + n(p, k)));
      return { u_mult: [f('r'), f('g'), f('b')] };
    },
  },
  {
    kind: 'tonemap',
    label: 'Tone Mapping',
    category: 'Tone',
    description: 'Filmic / ACES / AgX: compress HDR to display range',
    keywords: 'filmic aces agx reinhard hable hdr view transform',
    controls: [
      {
        type: 'select', key: 'mode', label: 'Curve', default: 'agx',
        options: [
          { value: 'agx', label: 'AgX' },
          { value: 'agxPunchy', label: 'AgX Punchy' },
          { value: 'aces', label: 'ACES (fitted)' },
          { value: 'hable', label: 'Filmic (Hable)' },
          { value: 'reinhard', label: 'Reinhard' },
        ],
      },
      slider('exposure', 'Exposure', -5, 5, 0, 0.01, ' EV', 2),
      slider('white', 'White point', 1, 20, 4, 0.1, '', 1),
    ],
    glsl: `uniform float u_mode; uniform float u_exp; uniform float u_white;
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 v, bool punchy) {
  const mat3 IN = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                       0.0784335999999992, 0.878468636469772, 0.0784336,
                       0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 OUT = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                        -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                        -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  const float lo = -12.47393; const float hi = 4.026069;
  v = IN * max(v, 1e-10);
  v = (clamp(log2(v), lo, hi) - lo) / (hi - lo);
  v = agxContrast(v);
  if (punchy) { float l = luma(v); v = pow(max(v, 0.0), vec3(1.35)); v = l + 1.4 * (v - l); }
  v = OUT * v;
  return pow(max(v, 0.0), vec3(2.2));
}
vec3 aces(vec3 v) {
  const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  v = IN * v;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(OUT * (a / b), 0.0, 1.0);
}
vec3 hableF(vec3 x) { const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30; return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F; }
vec4 effect(vec4 c) {
  vec3 v = max(c.rgb * exp2(u_exp), 0.0);
  vec3 o;
  if (u_mode < 0.5) o = agx(v, false);
  else if (u_mode < 1.5) o = agx(v, true);
  else if (u_mode < 2.5) o = aces(v);
  else if (u_mode < 3.5) o = hableF(v * 2.0) / hableF(vec3(u_white * 2.8));
  else { float l = max(luma(v), 1e-6); float nl = l * (1.0 + l / (u_white * u_white)) / (1.0 + l); o = v * (nl / l); }
  return vec4(clamp(o, 0.0, 1.0), c.a);
}`,
    uniforms: (p) => ({
      u_mode: ['agx', 'agxPunchy', 'aces', 'hable', 'reinhard'].indexOf(String(p.mode)),
      u_exp: n(p, 'exposure'),
      u_white: Math.max(1, n(p, 'white')),
    }),
  },
  {
    kind: 'autoExposure',
    label: 'Auto Exposure',
    category: 'Tone',
    description: 'Exposes each image to a target average (per image in a batch)',
    keywords: 'auto automatic exposure average',
    stats: true,
    controls: [
      slider('target', 'Target grey', 5, 50, 18, 1, '%'),
      slider('strength', 'Strength', 0, 100, 100, 1, '%'),
      slider('limit', 'Max change', 0, 6, 3, 0.1, ' EV', 1),
    ],
    glsl: `uniform sampler2D u_stats; uniform float u_target; uniform float u_strength; uniform float u_limit;
vec4 effect(vec4 c) {
  vec4 s = texelFetch(u_stats, ivec2(0), 0);
  float meanLog = s.b * 20.0 - 17.0;
  float ev = clamp(log2(u_target) - meanLog, -u_limit, u_limit) * u_strength;
  return vec4(c.rgb * exp2(ev), c.a);
}`,
    uniforms: (p) => ({ u_target: pct(p, 'target'), u_strength: pct(p, 'strength'), u_limit: n(p, 'limit') }),
  },
  {
    kind: 'autoLevels',
    label: 'Auto Levels',
    category: 'Tone',
    description: 'Stretches each image’s darkest/brightest areas to black/white',
    keywords: 'auto automatic levels stretch normalize',
    stats: true,
    controls: [slider('strength', 'Strength', 0, 100, 100, 1, '%')],
    glsl: `uniform sampler2D u_stats; uniform float u_strength;
vec4 effect(vec4 c) {
  vec4 s = texelFetch(u_stats, ivec2(0), 0);
  float lmin = s.r / max(1.0 - s.r, 1e-4);
  float lmax = s.g / max(1.0 - s.g, 1e-4);
  float emin = toSRGB1(lmin);
  float emax = toSRGB1(lmax);
  vec3 e = toSRGB(c.rgb);
  vec3 t = (e - emin) / max(emax - emin, 1e-3);
  return vec4(fromSRGB(mix(e, t, u_strength)), c.a);
}`,
    uniforms: (p) => ({ u_strength: pct(p, 'strength') }),
  },

  /* ===== Colour ===== */
  {
    kind: 'whiteBalance',
    label: 'White Balance',
    category: 'Colour',
    description: 'Temperature and tint (set Temp to the light source)',
    keywords: 'temperature tint kelvin wb colour cast',
    controls: [
      slider('temp', 'Temp', 2000, 15000, 6500, 50, ' K'),
      slider('tint', 'Tint', -150, 150, 0),
    ],
    glsl: `uniform mat3 u_m;
vec4 effect(vec4 c) { return vec4(u_m * c.rgb, c.a); }`,
    uniforms: (p) => ({ u_m: { m3: whiteBalanceMatrix(n(p, 'temp'), n(p, 'tint')) } }),
  },
  {
    kind: 'saturation',
    label: 'Saturation / Vibrance',
    category: 'Colour',
    description: 'Global saturation and skin-protecting vibrance',
    keywords: 'vibrance saturation colourfulness',
    controls: [slider('saturation', 'Saturation', -100, 100), slider('vibrance', 'Vibrance', -100, 100)],
    glsl: `uniform float u_sat; uniform float u_vib;
vec4 effect(vec4 c) {
  float l = luma(c.rgb);
  vec3 o = l + (c.rgb - l) * (1.0 + u_sat);
  vec3 hsv = rgb2hsv(max(toSRGB(o), 0.0));
  float skin = exp(-pow((hsv.x - 0.07) / 0.05, 2.0));
  float amt = u_vib * (1.0 - hsv.y) * (u_vib > 0.0 ? 1.0 - 0.6 * skin : 1.0);
  o = l + (o - l) * (1.0 + amt);
  return vec4(o, c.a);
}`,
    uniforms: (p) => ({ u_sat: pct(p, 'saturation'), u_vib: pct(p, 'vibrance') }),
  },
  {
    kind: 'hsl',
    label: 'HSL / Colour Mixer',
    category: 'Colour',
    description: 'Hue, saturation and luminance per colour band',
    keywords: 'hsl colour mixer color mixer band hue saturation luminance',
    width: 230,
    controls: [
      {
        type: 'tabs',
        tabs: [
          { label: 'Hue', controls: bandSliders('h') },
          { label: 'Saturation', controls: bandSliders('s') },
          { label: 'Luminance', controls: bandSliders('l') },
        ],
      },
    ],
    glsl: `uniform float u_h[8]; uniform float u_s[8]; uniform float u_l[8];
vec4 effect(vec4 c) {
  vec3 e = max(toSRGB(c.rgb), 0.0);
  vec3 hsv = rgb2hsv(e);
  float deg = hsv.x * 360.0;
  float dh = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 8; i++) { float w = bandWeight(deg, i); dh += w * u_h[i]; ds += w * u_s[i]; dl += w * u_l[i]; }
  float s0 = hsv.y;
  hsv.x = fract(hsv.x + dh * 30.0 / 360.0);
  hsv.y = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
  vec3 o = hsv2rgb(hsv) * (1.0 + dl * 0.6 * s0);
  return vec4(fromSRGB(o), c.a);
}`,
    uniforms: (p) => ({ u_h: bandArray(p, 'h'), u_s: bandArray(p, 's'), u_l: bandArray(p, 'l') }),
  },
  {
    kind: 'hueCurves',
    label: 'Hue Curves',
    category: 'Colour',
    description: 'Hue vs Hue / Sat / Lum and Lum vs Sat',
    keywords: 'hue vs hue sat lum curves davinci secondary',
    width: 240,
    controls: [
      {
        type: 'curves',
        channels: [
          { id: 'hh', label: 'Hue vs Hue', color: '#e8ebf3', periodic: true, defaults: flat6, xAxis: 'hue' },
          { id: 'hs', label: 'Hue vs Sat', color: '#e8ebf3', periodic: true, defaults: flat6, xAxis: 'hue' },
          { id: 'hl', label: 'Hue vs Lum', color: '#e8ebf3', periodic: true, defaults: flat6, xAxis: 'hue' },
          { id: 'ls', label: 'Lum vs Sat', color: '#e8ebf3', periodic: false, defaults: [[0, 0.5], [1, 0.5]], xAxis: 'tone' },
        ],
      },
    ],
    glsl: `vec4 effect(vec4 c) {
  vec3 e = max(toSRGB(c.rgb), 0.0);
  vec3 hsv = rgb2hsv(e);
  float h = hsv.x; float s0 = hsv.y;
  float hh = curveAt(h, 0.0, 4.0) - 0.5;
  float hs = curveAt(h, 1.0, 4.0) * 2.0;
  float hl = curveAt(h, 2.0, 4.0) - 0.5;
  float ls = curveAt(clamp(luma(e), 0.0, 1.0), 3.0, 4.0) * 2.0;
  hsv.x = fract(h + hh * 0.5);
  hsv.y = clamp(s0 * hs * ls, 0.0, 1.0);
  vec3 o = hsv2rgb(hsv) * exp2(hl * 2.0 * s0);
  return vec4(fromSRGB(o), c.a);
}`,
    uniforms: () => ({}),
  },
  {
    kind: 'grading',
    label: 'Colour Grading',
    category: 'Colour',
    description: 'Shadows / midtones / highlights wheels (split toning)',
    keywords: 'split toning colour balance color grading shadows midtones highlights wheels',
    width: 260,
    controls: [
      { type: 'wheel', key: 'sh', label: 'Shadows', masterLabel: 'Lum' },
      { type: 'wheel', key: 'mid', label: 'Midtones', masterLabel: 'Lum' },
      { type: 'wheel', key: 'hi', label: 'Highlights', masterLabel: 'Lum' },
      { type: 'wheel', key: 'glob', label: 'Global', masterLabel: 'Lum' },
      slider('blend', 'Blending', 0, 100, 50),
      slider('balance', 'Balance', -100, 100),
    ],
    glsl: `uniform vec3 u_sT; uniform vec3 u_mT; uniform vec3 u_hT; uniform vec3 u_gT;
uniform vec4 u_lum; uniform float u_bal; uniform float u_blend;
vec4 effect(vec4 c) {
  float y = clamp(toSRGB1(max(luma(c.rgb), 0.0)), 0.0, 1.0);
  float mid = 0.5 + u_bal * 0.35;
  float w = mix(0.15, 0.5, u_blend);
  float ws = 1.0 - smoothstep(max(mid - w, 0.0), mid, y);
  float wh = smoothstep(mid, min(mid + w, 1.0), y);
  float wm = 1.0 - ws - wh;
  vec3 o = c.rgb * (1.0 + ws * u_sT) * (1.0 + wm * u_mT) * (1.0 + wh * u_hT) * (1.0 + u_gT);
  o *= exp2(ws * u_lum.x + wm * u_lum.y + wh * u_lum.z + u_lum.w);
  return vec4(max(o, 0.0), c.a);
}`,
    uniforms: (p) => {
      const tint = (k: string) => wheelTint(n(p, `${k}X`), n(p, `${k}Y`)).map((v) => v * 0.5);
      return {
        u_sT: tint('sh'),
        u_mT: tint('mid'),
        u_hT: tint('hi'),
        u_gT: tint('glob'),
        u_lum: [pct(p, 'shM'), pct(p, 'midM'), pct(p, 'hiM'), pct(p, 'globM')],
        u_bal: pct(p, 'balance'),
        u_blend: pct(p, 'blend'),
      };
    },
  },
  {
    kind: 'channelMixer',
    label: 'Channel Mixer',
    category: 'Colour',
    description: 'Rebuild each output channel from R, G and B',
    keywords: 'channel mixer swap matrix',
    width: 220,
    controls: [
      {
        type: 'tabs',
        tabs: [
          { label: 'Red', controls: [slider('rr', 'Red', -200, 200, 100), slider('rg', 'Green', -200, 200), slider('rb', 'Blue', -200, 200)] },
          { label: 'Green', controls: [slider('gr', 'Red', -200, 200), slider('gg', 'Green', -200, 200, 100), slider('gb', 'Blue', -200, 200)] },
          { label: 'Blue', controls: [slider('br', 'Red', -200, 200), slider('bg', 'Green', -200, 200), slider('bb', 'Blue', -200, 200, 100)] },
        ],
      },
      { type: 'check', key: 'preserve', label: 'Preserve luminance', default: false },
    ],
    glsl: `uniform mat3 u_m; uniform float u_preserve;
vec4 effect(vec4 c) {
  vec3 o = u_m * c.rgb;
  if (u_preserve > 0.5) { float a = luma(c.rgb); float b = luma(o); if (abs(b) > 1e-6) o *= a / b; }
  return vec4(o, c.a);
}`,
    uniforms: (p) => ({
      u_m: { m3: ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'].map((k) => pct(p, k)) },
      u_preserve: p.preserve ? 1 : 0,
    }),
  },
  {
    kind: 'bwMix',
    label: 'Black & White Mix',
    category: 'Colour',
    description: 'Monochrome with per-colour brightness',
    keywords: 'black white monochrome bw b&w grayscale mix',
    width: 210,
    controls: bandSliders('w'),
    glsl: `uniform float u_w[8];
vec4 effect(vec4 c) {
  vec3 e = max(toSRGB(c.rgb), 0.0);
  vec3 hsv = rgb2hsv(e);
  float deg = hsv.x * 360.0;
  float adj = 0.0;
  for (int i = 0; i < 8; i++) adj += bandWeight(deg, i) * u_w[i];
  float y = toSRGB1(max(luma(c.rgb), 0.0)) * max(1.0 + adj * hsv.y, 0.0);
  return vec4(vec3(fromSRGB1(y)), c.a);
}`,
    uniforms: (p) => ({ u_w: bandArray(p, 'w') }),
  },
  {
    kind: 'lut3d',
    label: '3D LUT',
    category: 'Colour',
    description: 'Apply a .cube LUT (film emulation, show LUTs)',
    keywords: 'lut cube film emulation look',
    width: 210,
    lut: true,
    controls: [
      { type: 'lut' },
      {
        type: 'select', key: 'encoding', label: 'LUT input', default: 'srgb',
        options: [
          { value: 'srgb', label: 'sRGB / Rec.709 display' },
          { value: 'linear', label: 'Linear sRGB' },
          { value: 'acescct', label: 'ACEScct' },
        ],
      },
      slider('strength', 'Strength', 0, 100, 100, 1, '%'),
    ],
    glsl: `uniform highp sampler3D u_lut; uniform float u_has; uniform float u_size; uniform float u_strength; uniform float u_enc;
uniform vec3 u_dmin; uniform vec3 u_dmax;
vec3 lutEncode(vec3 c) {
  if (u_enc < 0.5) return toSRGB(c);
  if (u_enc < 1.5) return c;
  return acescctEnc(max(SRGB_TO_ACESCG * c, 0.0));
}
vec3 lutDecode(vec3 e) {
  if (u_enc < 0.5) return fromSRGB(e);
  if (u_enc < 1.5) return e;
  return ACESCG_TO_SRGB * acescctDec(e);
}
vec4 effect(vec4 c) {
  if (u_has < 0.5) return c;
  vec3 e = lutEncode(c.rgb);
  vec3 t = clamp((e - u_dmin) / (u_dmax - u_dmin), 0.0, 1.0);
  vec3 o = texture(u_lut, (t * (u_size - 1.0) + 0.5) / u_size).rgb;
  return vec4(lutDecode(mix(e, o, u_strength)), c.a);
}`,
    uniforms: (p) => ({
      u_enc: ['srgb', 'linear', 'acescct'].indexOf(String(p.encoding)),
      u_strength: pct(p, 'strength'),
    }),
  },
  {
    kind: 'colourSpace',
    label: 'Colour Space Transform',
    category: 'Colour',
    description: 'Convert between sRGB, Rec.709, ACEScg/cct, P3, Rec.2020',
    keywords: 'cst color space transform aces p3 rec2020 linear gamma log',
    width: 230,
    controls: [
      { type: 'select', key: 'from', label: 'From', options: spaceOptions, default: 'lin_srgb' },
      { type: 'select', key: 'to', label: 'To', options: spaceOptions, default: 'acescct' },
      { type: 'note', text: 'Images enter the graph as Linear sRGB. Convert back before Output.' },
    ],
    glsl: `uniform mat3 u_m; uniform float u_fromTF; uniform float u_toTF;
vec4 effect(vec4 c) { return vec4(encodeTF(u_m * decodeTF(c.rgb, u_fromTF), u_toTF), c.a); }`,
    uniforms: (p) => ({
      u_m: { m3: p.from === p.to ? IDENTITY : primariesMatrix(String(p.from), String(p.to)) },
      u_fromTF: space(String(p.from)).tf,
      u_toTF: space(String(p.to)).tf,
    }),
  },
  {
    kind: 'gamutWarning',
    label: 'Gamut Warning',
    category: 'Colour',
    description: 'Highlights colours outside a display/print gamut (soft-proof)',
    keywords: 'gamut warning soft proof out of gamut clipping',
    controls: [
      {
        type: 'select', key: 'target', label: 'Gamut', default: 'lin_srgb',
        options: [
          { value: 'lin_srgb', label: 'sRGB' },
          { value: 'lin_p3', label: 'Display P3' },
          { value: 'lin_rec2020', label: 'Rec.2020' },
        ],
      },
      { type: 'color', key: 'color', label: 'Warning colour', default: '#ff00ff' },
    ],
    glsl: `uniform mat3 u_m; uniform vec3 u_col;
vec4 effect(vec4 c) {
  vec3 t = u_m * c.rgb;
  bool outside = any(lessThan(t, vec3(-1e-4))) || any(greaterThan(t, vec3(1.0 + 1e-4)));
  return outside ? vec4(u_col, c.a) : c;
}`,
    uniforms: (p) => ({ u_m: { m3: primariesMatrix('lin_srgb', String(p.target)) }, u_col: hexToLinear(String(p.color)) }),
  },

  /* ===== Utility ===== */
  {
    kind: 'grayscale',
    label: 'Grayscale',
    category: 'Utility',
    description: 'Luminance conversion',
    keywords: 'gray grey desaturate',
    controls: [],
    glsl: `vec4 effect(vec4 c) { return vec4(vec3(luma(c.rgb)), c.a); }`,
    uniforms: () => ({}),
  },
  {
    kind: 'invert',
    label: 'Invert',
    category: 'Utility',
    description: 'Invert RGB channels',
    keywords: 'negative',
    controls: [],
    glsl: `vec4 effect(vec4 c) { return vec4(fromSRGB(1.0 - clamp(toSRGB(c.rgb), 0.0, 1.0)), c.a); }`,
    uniforms: () => ({}),
  },
];

const BY_KIND = new Map(NODE_DEFS.map((d) => [d.kind, d]));
export const getDef = (kind: string) => BY_KIND.get(kind);

/* ---------- defaults ---------- */

function collectDefaults(controls: Control[], out: Params) {
  for (const c of controls) {
    if (c.type === 'slider' || c.type === 'select' || c.type === 'check' || c.type === 'color') out[c.key] = c.default;
    else if (c.type === 'wheel') {
      out[`${c.key}X`] = 0;
      out[`${c.key}Y`] = 0;
      out[`${c.key}M`] = 0;
    } else if (c.type === 'tabs') c.tabs.forEach((t) => collectDefaults(t.controls, out));
  }
  return out;
}

export const defaultParams = (kind: string): Params => {
  const def = getDef(kind);
  return def ? collectDefaults(def.controls, {}) : {};
};

/** Curve channels of a node (empty if it has no curves control). */
export const curveChannels = (kind: string): CurveChannel[] =>
  getDef(kind)?.controls.flatMap((c) => (c.type === 'curves' ? c.channels : [])) ?? [];

export const resolveCurves = (kind: string, curves?: Curves) =>
  curveChannels(kind).map((ch) => ({ points: curves?.[ch.id] ?? ch.defaults, periodic: ch.periodic }));
