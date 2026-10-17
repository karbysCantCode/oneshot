import type { Curves, CurvePoint, Params, Socket } from '../types';
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
 *  Each node = typed sockets + UI controls + GLSL + a function turning
 *  parameters into uniforms. All pixel work happens on the GPU.
 *
 *  GLSL contract
 *  - style 'effect' (default): define `vec4 effect(vec4 c)`; receives the
 *    "image" input at this pixel.
 *  - style 'run': define `vec4 run(vec2 uv)`. For each input socket <id>:
 *      vec4  c_<id>(vec2 uv)   colour value (float sources → (v,v,v,1))
 *      float f_<id>(vec2 uv)   float value (colour sources → luminance)
 *      bool  has_<id>()        whether the socket is connected
 *    Also: u_out (output index), u_pass / u_prev (multi-pass), u_texel,
 *    u_size (render px), u_scale (render px per full-res px), u_aspect,
 *    u_fullSize (full-res px).
 *  - Float outputs: return the value in .x (written as (v,v,v,1)).
 * ===================================================================== */

export type Category = 'Input / Output' | 'Tone' | 'Colour' | 'Filter' | 'Texture' | 'Mask' | 'Converter' | 'Utility' | 'Group';
export const CATEGORIES: Category[] = ['Input / Output', 'Tone', 'Colour', 'Filter', 'Texture', 'Mask', 'Converter', 'Utility'];

export type CurveChannel = { id: string; label: string; color: string; periodic: boolean; defaults: CurvePoint[]; xAxis?: 'tone' | 'hue' };
export type SelectOption = { value: string; label: string; group?: string };

export type Control =
  | { type: 'slider'; key: string; label: string; min: number; max: number; step: number; default: number; unit?: string; digits?: number }
  | { type: 'number'; key: string; label: string; default: number; step: number; softMin: number; softMax: number }
  | { type: 'select'; key: string; label: string; options: SelectOption[]; default: string }
  | { type: 'check'; key: string; label: string; default: boolean }
  | { type: 'color'; key: string; label: string; default: string }
  /** Colour wheel: stores `${key}X`, `${key}Y` (puck) and `${key}M` (master slider). */
  | { type: 'wheel'; key: string; label: string; masterLabel?: string }
  | { type: 'curves'; channels: CurveChannel[] }
  | { type: 'lut' }
  | { type: 'ramp' }
  /** Image Input: choose "current image" or a specific Media Pool image. */
  | { type: 'media'; key: string }
  | { type: 'tabs'; tabs: { label: string; controls: Control[] }[] }
  | { type: 'note'; text: string };

/** Uniform values: number → float, [..] → vecN, {m3} → mat3 (row-major), {fv} → float[], {i} → int, {v4} → vec4[] */
export type UniformValue = number | number[] | { m3: number[] } | { fv: number[] } | { i: number } | { v4: number[] };
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
  /** Hidden from the toolbox (group internals). */
  hidden?: boolean;
  inputs?: Socket[];
  outputs?: Socket[];
  controls: Control[];
  style?: 'effect' | 'run';
  glsl?: string;
  uniforms?: (p: Params) => Uniforms;
  /** Number of render passes (multi-pass filters). */
  passes?: number;
  /** Uses a 3D LUT texture (sampler3D u_lut). */
  lut?: boolean;
  /** Needs GPU statistics of input 0 (sampler2D u_stats, 1×1). */
  stats?: boolean;
  /** Uses Colour Ramp uniforms. */
  ramp?: boolean;
};

/* ---------- helpers ---------- */

const n = (p: Params, k: string) => Number(p[k] ?? 0);
const pct = (p: Params, k: string) => n(p, k) / 100;
const idx = (p: Params, k: string, list: string[]) => ({ i: Math.max(0, list.indexOf(String(p[k]))) });
const slider = (key: string, label: string, min: number, max: number, def = 0, step = 1, unit = '', digits = 0): Control => ({
  type: 'slider', key, label, min, max, step, default: def, unit, digits,
});
const select = (key: string, label: string, options: [string, string][], def?: string): Control => ({
  type: 'select', key, label, default: def ?? options[0][0], options: options.map(([value, l]) => ({ value, label: l })),
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

/* ---------- sockets ---------- */

const img = (id = 'image', label = 'Image'): Socket => ({ id, label, type: 'color', hideValue: true });
export const IMG_IN: Socket[] = [img()];
export const IMG_OUT: Socket[] = [{ id: 'image', label: 'Image', type: 'color' }];
const f = (id: string, label: string, def: number, min?: number, max?: number, step?: number): Socket => ({
  id, label, type: 'float', default: def, min, max, step,
});
const col = (id: string, label: string, def: string): Socket => ({ id, label, type: 'color', default: def });
const vecIn: Socket = { id: 'vector', label: 'Vector', type: 'color', hideValue: true };
const fOut = (id: string, label: string): Socket => ({ id, label, type: 'float' });
const cOut = (id: string, label: string): Socket => ({ id, label, type: 'color' });

/** Texture coordinates: connected Vector input, else aspect-correct UV. */
const COORDS = `vec3 coords(vec2 uv) { return has_vector() ? c_vector(uv).rgb : vec3(uv.x * u_aspect, uv.y, 0.0); }`;

/* ---------- shared filter GLSL ---------- */

/** Separable Gaussian blur. mode 0: image input, 1: previous pass, 2: bright-pass of image. */
const BLUR_GLSL = `uniform float u_thresh;
vec4 blurSrc(vec2 uv, int mode) {
  if (mode == 1) return texture(u_prev, uv);
  vec4 c = c_image(uv);
  if (mode == 2) return vec4(max(c.rgb - u_thresh, 0.0), 1.0);
  return c;
}
vec4 gblur(vec2 uv, vec2 dir, int mode, float radiusPx) {
  float r = radiusPx * u_scale;
  if (r < 0.5) return blurSrc(uv, mode);
  int n = int(min(ceil(r), 48.0));
  float stepPx = r / float(n);
  float sigma = max(r / 2.5, 0.5);
  vec4 sum = vec4(0.0); float wsum = 0.0;
  for (int i = -n; i <= n; i++) {
    float x = float(i) * stepPx;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    sum += blurSrc(uv + dir * x * u_texel, mode) * w;
    wsum += w;
  }
  return sum / wsum;
}`;

/** Sobel gradient magnitude of display-encoded luminance at distance k (texels). */
const SOBEL_GLSL = `float lumAt(vec2 uv) { return toSRGB1(max(luma(c_image(uv).rgb), 0.0)); }
float sobelLuma(vec2 uv, float k) {
  vec2 t = u_texel * k;
  float tl = lumAt(uv + vec2(-t.x, t.y)), tc = lumAt(uv + vec2(0.0, t.y)), tr = lumAt(uv + t);
  float ml = lumAt(uv - vec2(t.x, 0.0)), mr = lumAt(uv + vec2(t.x, 0.0));
  float bl = lumAt(uv - t), bc = lumAt(uv - vec2(0.0, t.y)), br = lumAt(uv + vec2(t.x, -t.y));
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  return length(vec2(gx, gy));
}`;

/* ---------- mask shapes ----------
 * Positions: X = fraction of image width (0 left → 1 right), Y = fraction of image height (0 top → 1 bottom).
 * Sizes, radii and feather are fractions of the image HEIGHT, so shapes stay round on any aspect ratio
 * and scale with the image (previews, grid tiles and full size match).
 * Output: Mask value 1 inside, 0 outside; feather fades from the edge outwards.
 */
const MASK_GLSL = `uniform float u_inv;
vec2 maskP(vec2 uv, vec2 c) { return vec2((uv.x - c.x) * u_aspect, (1.0 - uv.y) - c.y); }
vec2 rot2(vec2 p, float deg) { float a = radians(deg); float s = sin(a), co = cos(a); return vec2(co * p.x - s * p.y, s * p.x + co * p.y); }
vec4 maskOut(float d, float feather) {
  float f = max(feather, 1.0 / u_size.y); // at least one pixel of anti-aliasing
  float m = 1.0 - smoothstep(0.0, f, d);
  return vec4(u_inv > 0.5 ? 1.0 - m : m);
}`;
const maskPos = [f('x', 'X', 0.5, 0, 1, 0.001), f('y', 'Y', 0.5, 0, 1, 0.001)];
const maskFeather = f('feather', 'Feather', 0.05, 0, 0.5, 0.001);
const maskRot = f('rotation', 'Rotation', 0, -180, 180, 1);
const maskOutSock = [fOut('mask', 'Mask')];
const maskInvert: Control = { type: 'check', key: 'invert', label: 'Invert', default: false };
const maskUniforms = (p: Params) => ({ u_inv: p.invert ? 1 : 0 });

/* ---------- operation lists ---------- */

export const MATH_OPS: { value: string; label: string; group: string; uses: number }[] = [
  ['add', 'Add', 'Functions', 2], ['subtract', 'Subtract', 'Functions', 2], ['multiply', 'Multiply', 'Functions', 2],
  ['divide', 'Divide', 'Functions', 2], ['multiply_add', 'Multiply Add', 'Functions', 3], ['power', 'Power', 'Functions', 2],
  ['logarithm', 'Logarithm', 'Functions', 2], ['sqrt', 'Square Root', 'Functions', 1], ['inverse_sqrt', 'Inverse Square Root', 'Functions', 1],
  ['absolute', 'Absolute', 'Functions', 1], ['exponent', 'Exponent', 'Functions', 1],
  ['minimum', 'Minimum', 'Comparison', 2], ['maximum', 'Maximum', 'Comparison', 2], ['less_than', 'Less Than', 'Comparison', 2],
  ['greater_than', 'Greater Than', 'Comparison', 2], ['sign', 'Sign', 'Comparison', 1], ['compare', 'Compare', 'Comparison', 3],
  ['smooth_min', 'Smooth Minimum', 'Comparison', 3], ['smooth_max', 'Smooth Maximum', 'Comparison', 3],
  ['round', 'Round', 'Rounding', 1], ['floor', 'Floor', 'Rounding', 1], ['ceil', 'Ceil', 'Rounding', 1], ['truncate', 'Truncate', 'Rounding', 1],
  ['fraction', 'Fraction', 'Rounding', 1], ['modulo', 'Truncated Modulo', 'Rounding', 2], ['floored_modulo', 'Floored Modulo', 'Rounding', 2],
  ['wrap', 'Wrap', 'Rounding', 3], ['snap', 'Snap', 'Rounding', 2], ['pingpong', 'Ping-Pong', 'Rounding', 2],
  ['sine', 'Sine', 'Trigonometric', 1], ['cosine', 'Cosine', 'Trigonometric', 1], ['tangent', 'Tangent', 'Trigonometric', 1],
  ['arcsine', 'Arcsine', 'Trigonometric', 1], ['arccosine', 'Arccosine', 'Trigonometric', 1], ['arctangent', 'Arctangent', 'Trigonometric', 1],
  ['arctan2', 'Arctan2', 'Trigonometric', 2], ['sinh', 'Hyperbolic Sine', 'Trigonometric', 1], ['cosh', 'Hyperbolic Cosine', 'Trigonometric', 1],
  ['tanh', 'Hyperbolic Tangent', 'Trigonometric', 1], ['radians', 'To Radians', 'Conversion', 1], ['degrees', 'To Degrees', 'Conversion', 1],
].map(([value, label, group, uses]) => ({ value: value as string, label: label as string, group: group as string, uses: uses as number }));

/** Vector-only operations (ids ≥ 100 in the shader). */
const VEC_OPS = [
  ['dot', 'Dot Product', 100], ['cross', 'Cross Product', 101], ['length', 'Length', 102],
  ['distance', 'Distance', 103], ['normalize', 'Normalize', 104], ['scale', 'Scale', 105], ['reflect', 'Reflect', 106],
] as const;
const VEC_COMPONENT_OPS = ['add', 'subtract', 'multiply', 'divide', 'multiply_add', 'power', 'absolute', 'minimum', 'maximum',
  'floor', 'ceil', 'fraction', 'floored_modulo', 'wrap', 'snap', 'sine', 'cosine', 'tangent'];

const vecOpIndex = (op: string) => {
  const v = VEC_OPS.find((o) => o[0] === op);
  return v ? v[2] : Math.max(0, MATH_OPS.findIndex((o) => o.value === op));
};

export const BLEND_MODES: [string, string][] = [
  ['mix', 'Mix'], ['darken', 'Darken'], ['multiply', 'Multiply'], ['burn', 'Colour Burn'], ['lighten', 'Lighten'],
  ['screen', 'Screen'], ['dodge', 'Colour Dodge'], ['add', 'Add'], ['overlay', 'Overlay'], ['soft_light', 'Soft Light'],
  ['linear_light', 'Linear Light'], ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['subtract', 'Subtract'],
  ['divide', 'Divide'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Colour'], ['value', 'Value'],
];

/* ---------- definitions ---------- */

export const NODE_DEFS: NodeDef[] = [
  /* ===== Input / Output ===== */
  {
    kind: 'input', label: 'Image Input', category: 'Input / Output',
    description: 'The current image, or a chosen Media Pool image', keywords: 'image media texture',
    outputs: IMG_OUT, controls: [{ type: 'media', key: 'media' }],
  },
  {
    kind: 'folder', label: 'Folder Input', category: 'Input / Output', description: 'Batch-process every image in a folder',
    keywords: 'batch', width: 200, outputs: IMG_OUT, controls: [],
  },
  { kind: 'output', label: 'Output', category: 'Input / Output', description: 'Final result shown in the viewer', inputs: IMG_IN, controls: [] },
  {
    kind: 'value', label: 'Value', category: 'Input / Output', description: 'A constant number (adjustable per image in Library mode)',
    keywords: 'constant number float scalar parameter', style: 'run',
    outputs: [fOut('value', 'Value')],
    controls: [{ type: 'number', key: 'value', label: 'Value', default: 0.5, step: 0.01, softMin: 0, softMax: 1 }],
    glsl: `uniform float u_v; vec4 run(vec2 uv) { return vec4(u_v); }`,
    uniforms: (p) => ({ u_v: n(p, 'value') }),
  },
  {
    kind: 'rgb', label: 'RGB Colour', category: 'Input / Output', description: 'A constant colour (adjustable per image in Library mode)',
    keywords: 'constant colour color swatch', style: 'run',
    outputs: [cOut('color', 'Colour')],
    controls: [{ type: 'color', key: 'color', label: 'Colour', default: '#cc6633' }],
    glsl: `uniform vec3 u_c; vec4 run(vec2 uv) { return vec4(u_c, 1.0); }`,
    uniforms: (p) => ({ u_c: hexToLinear(String(p.color)) }),
  },
  {
    kind: 'texcoord', label: 'Texture Coordinate', category: 'Input / Output', description: 'Pixel position as vectors and numbers',
    keywords: 'uv coordinates position generated vector', style: 'run',
    outputs: [cOut('generated', 'Generated'), cOut('aspect', 'Aspect'), cOut('centered', 'Centred'), fOut('x', 'X'), fOut('y', 'Y')],
    controls: [],
    glsl: `vec4 run(vec2 uv) {
  if (u_out == 0) return vec4(uv, 0.0, 1.0);
  if (u_out == 1) return vec4(uv.x * u_aspect, uv.y, 0.0, 1.0);
  if (u_out == 2) return vec4((uv.x - 0.5) * u_aspect, uv.y - 0.5, 0.0, 1.0);
  return vec4(u_out == 3 ? uv.x : uv.y);
}`,
  },

  /* ===== Tone ===== */
  {
    kind: 'exposure', label: 'Exposure', category: 'Tone', description: 'Brightness in photographic stops', keywords: 'ev brightness stops',
    controls: [slider('stops', 'Stops', -5, 5, 0, 0.01, ' EV', 2)],
    glsl: `uniform float u_stops;
vec4 effect(vec4 c) { return vec4(c.rgb * exp2(u_stops), c.a); }`,
    uniforms: (p) => ({ u_stops: n(p, 'stops') }),
  },
  {
    kind: 'contrast', label: 'Contrast', category: 'Tone', description: 'Push tones away from a pivot (filmic, log-space)',
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
    kind: 'tones', label: 'Highlights & Shadows', category: 'Tone', description: 'Highlights, Shadows, Whites and Blacks',
    keywords: 'whites blacks shadow highlight recovery lightroom basic',
    controls: [
      slider('highlights', 'Highlights', -100, 100), slider('shadows', 'Shadows', -100, 100),
      slider('whites', 'Whites', -100, 100), slider('blacks', 'Blacks', -100, 100),
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
    kind: 'levels', label: 'Levels', category: 'Tone', description: 'Black point, white point and gamma', keywords: 'input output black white gamma point',
    controls: [
      select('channel', 'Channel', [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']]),
      slider('inBlack', 'In black', 0, 255, 0), slider('inWhite', 'In white', 0, 255, 255),
      slider('gamma', 'Gamma', 0.1, 5, 1, 0.01, '', 2),
      slider('outBlack', 'Out black', 0, 255, 0), slider('outWhite', 'Out white', 0, 255, 255),
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
        u_ib: n(p, 'inBlack') / 255, u_iw: n(p, 'inWhite') / 255, u_g: Math.max(0.01, n(p, 'gamma')),
        u_ob: n(p, 'outBlack') / 255, u_ow: n(p, 'outWhite') / 255,
      };
    },
  },
  {
    kind: 'curves', label: 'Curves', category: 'Tone', description: 'RGB master and per-channel tone curves', keywords: 'tone curve rgb s-curve', width: 240,
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
    kind: 'lgg', label: 'Lift / Gamma / Gain', category: 'Tone', description: 'Primary colour wheels with Offset (DaVinci style)',
    keywords: 'colour wheels primaries offset davinci resolve grading', width: 260,
    controls: [
      { type: 'wheel', key: 'lift', label: 'Lift' }, { type: 'wheel', key: 'gamma', label: 'Gamma' },
      { type: 'wheel', key: 'gain', label: 'Gain' }, { type: 'wheel', key: 'offset', label: 'Offset' },
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
      u_lift: wheelVec(p, 'lift', wheelOffset, 0.5), u_gamma: wheelVec(p, 'gamma', wheelOffset, 0.5),
      u_gain: wheelVec(p, 'gain', wheelOffset, 0.5), u_offset: wheelVec(p, 'offset', wheelOffset, 0.5),
    }),
  },
  {
    kind: 'printer', label: 'Printer Lights', category: 'Tone', description: 'Film-lab RGB printer points (1 pt ≈ 1/12 stop)', keywords: 'printer points offset film lab',
    controls: [slider('master', 'Master', -25, 25), slider('r', 'Red', -25, 25), slider('g', 'Green', -25, 25), slider('b', 'Blue', -25, 25)],
    glsl: `uniform vec3 u_mult;
vec4 effect(vec4 c) { return vec4(c.rgb * u_mult, c.a); }`,
    uniforms: (p) => {
      const m = n(p, 'master');
      const fn = (k: string) => Math.pow(10, 0.025 * (m + n(p, k)));
      return { u_mult: [fn('r'), fn('g'), fn('b')] };
    },
  },
  {
    kind: 'tonemap', label: 'Tone Mapping', category: 'Tone', description: 'Filmic / ACES / AgX: compress HDR to display range',
    keywords: 'filmic aces agx reinhard hable hdr view transform',
    controls: [
      select('mode', 'Curve', [['agx', 'AgX'], ['agxPunchy', 'AgX Punchy'], ['aces', 'ACES (fitted)'], ['hable', 'Filmic (Hable)'], ['reinhard', 'Reinhard']]),
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
      u_exp: n(p, 'exposure'), u_white: Math.max(1, n(p, 'white')),
    }),
  },
  {
    kind: 'autoExposure', label: 'Auto Exposure', category: 'Tone', description: 'Exposes each image to a target average (per image in a batch)',
    keywords: 'auto automatic exposure average', stats: true,
    controls: [slider('target', 'Target grey', 5, 50, 18, 1, '%'), slider('strength', 'Strength', 0, 100, 100, 1, '%'), slider('limit', 'Max change', 0, 6, 3, 0.1, ' EV', 1)],
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
    kind: 'autoLevels', label: 'Auto Levels', category: 'Tone', description: 'Stretches each image’s darkest/brightest areas to black/white',
    keywords: 'auto automatic levels stretch normalize', stats: true,
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
    kind: 'whiteBalance', label: 'White Balance', category: 'Colour', description: 'Temperature and tint (set Temp to the light source)',
    keywords: 'temperature tint kelvin wb colour cast',
    controls: [slider('temp', 'Temp', 2000, 15000, 6500, 50, ' K'), slider('tint', 'Tint', -150, 150, 0)],
    glsl: `uniform mat3 u_m;
vec4 effect(vec4 c) { return vec4(u_m * c.rgb, c.a); }`,
    uniforms: (p) => ({ u_m: { m3: whiteBalanceMatrix(n(p, 'temp'), n(p, 'tint')) } }),
  },
  {
    kind: 'saturation', label: 'Saturation / Vibrance', category: 'Colour', description: 'Global saturation and skin-protecting vibrance',
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
    kind: 'hsl', label: 'HSL / Colour Mixer', category: 'Colour', description: 'Hue, saturation and luminance per colour band',
    keywords: 'hsl colour mixer color mixer band hue saturation luminance', width: 230,
    controls: [{ type: 'tabs', tabs: [{ label: 'Hue', controls: bandSliders('h') }, { label: 'Sat', controls: bandSliders('s') }, { label: 'Lum', controls: bandSliders('l') }] }],
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
    kind: 'hueCurves', label: 'Hue Curves', category: 'Colour', description: 'Hue vs Hue / Sat / Lum and Lum vs Sat',
    keywords: 'hue vs hue sat lum curves davinci secondary', width: 240,
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
    kind: 'grading', label: 'Colour Grading', category: 'Colour', description: 'Shadows / midtones / highlights wheels (split toning)',
    keywords: 'split toning colour balance color grading shadows midtones highlights wheels', width: 260,
    controls: [
      { type: 'wheel', key: 'sh', label: 'Shadows', masterLabel: 'Lum' }, { type: 'wheel', key: 'mid', label: 'Midtones', masterLabel: 'Lum' },
      { type: 'wheel', key: 'hi', label: 'Highlights', masterLabel: 'Lum' }, { type: 'wheel', key: 'glob', label: 'Global', masterLabel: 'Lum' },
      slider('blend', 'Blending', 0, 100, 50), slider('balance', 'Balance', -100, 100),
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
        u_sT: tint('sh'), u_mT: tint('mid'), u_hT: tint('hi'), u_gT: tint('glob'),
        u_lum: [pct(p, 'shM'), pct(p, 'midM'), pct(p, 'hiM'), pct(p, 'globM')],
        u_bal: pct(p, 'balance'), u_blend: pct(p, 'blend'),
      };
    },
  },
  {
    kind: 'channelMixer', label: 'Channel Mixer', category: 'Colour', description: 'Rebuild each output channel from R, G and B', keywords: 'channel mixer swap matrix', width: 220,
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
    uniforms: (p) => ({ u_m: { m3: ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'].map((k) => pct(p, k)) }, u_preserve: p.preserve ? 1 : 0 }),
  },
  {
    kind: 'bwMix', label: 'Black & White Mix', category: 'Colour', description: 'Monochrome with per-colour brightness',
    keywords: 'black white monochrome bw b&w grayscale mix', width: 210, controls: bandSliders('w'),
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
    kind: 'lut3d', label: '3D LUT', category: 'Colour', description: 'Apply a .cube LUT (film emulation, show LUTs)', keywords: 'lut cube film emulation look', width: 210, lut: true,
    controls: [
      { type: 'lut' },
      select('encoding', 'LUT input', [['srgb', 'sRGB / Rec.709 display'], ['linear', 'Linear sRGB'], ['acescct', 'ACEScct']]),
      slider('strength', 'Strength', 0, 100, 100, 1, '%'),
    ],
    glsl: `uniform highp sampler3D u_lut; uniform float u_has; uniform float u_lsize; uniform float u_strength; uniform float u_enc;
uniform vec3 u_dmin; uniform vec3 u_dmax;
vec3 lutEncode(vec3 c) { if (u_enc < 0.5) return toSRGB(c); if (u_enc < 1.5) return c; return acescctEnc(max(SRGB_TO_ACESCG * c, 0.0)); }
vec3 lutDecode(vec3 e) { if (u_enc < 0.5) return fromSRGB(e); if (u_enc < 1.5) return e; return ACESCG_TO_SRGB * acescctDec(e); }
vec4 effect(vec4 c) {
  if (u_has < 0.5) return c;
  vec3 e = lutEncode(c.rgb);
  vec3 t = clamp((e - u_dmin) / (u_dmax - u_dmin), 0.0, 1.0);
  vec3 o = texture(u_lut, (t * (u_lsize - 1.0) + 0.5) / u_lsize).rgb;
  return vec4(lutDecode(mix(e, o, u_strength)), c.a);
}`,
    uniforms: (p) => ({ u_enc: ['srgb', 'linear', 'acescct'].indexOf(String(p.encoding)), u_strength: pct(p, 'strength') }),
  },
  {
    kind: 'colourSpace', label: 'Colour Space Transform', category: 'Colour', description: 'Convert between sRGB, Rec.709, ACEScg/cct, P3, Rec.2020',
    keywords: 'cst color space transform aces p3 rec2020 linear gamma log', width: 230,
    controls: [
      { type: 'select', key: 'from', label: 'From', options: spaceOptions, default: 'lin_srgb' },
      { type: 'select', key: 'to', label: 'To', options: spaceOptions, default: 'acescct' },
      { type: 'note', text: 'Images enter the graph as Linear sRGB. Convert back before Output.' },
    ],
    glsl: `uniform mat3 u_m; uniform float u_fromTF; uniform float u_toTF;
vec4 effect(vec4 c) { return vec4(encodeTF(u_m * decodeTF(c.rgb, u_fromTF), u_toTF), c.a); }`,
    uniforms: (p) => ({
      u_m: { m3: p.from === p.to ? IDENTITY : primariesMatrix(String(p.from), String(p.to)) },
      u_fromTF: space(String(p.from)).tf, u_toTF: space(String(p.to)).tf,
    }),
  },
  {
    kind: 'gamutWarning', label: 'Gamut Warning', category: 'Colour', description: 'Highlights colours outside a display/print gamut (soft-proof)',
    keywords: 'gamut warning soft proof out of gamut clipping',
    controls: [
      select('target', 'Gamut', [['lin_srgb', 'sRGB'], ['lin_p3', 'Display P3'], ['lin_rec2020', 'Rec.2020']]),
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

  /* ===== Filter ===== */
  {
    kind: 'blur', label: 'Gaussian Blur', category: 'Filter', description: 'Smooth blur (radius in full-resolution pixels)', keywords: 'blur soften gaussian',
    style: 'run', inputs: IMG_IN, outputs: IMG_OUT, passes: 2,
    controls: [slider('radius', 'Radius', 0, 200, 8, 0.5, ' px', 1)],
    glsl: `${BLUR_GLSL}
uniform float u_radius;
vec4 run(vec2 uv) { return u_pass == 0 ? gblur(uv, vec2(1.0, 0.0), 0, u_radius) : gblur(uv, vec2(0.0, 1.0), 1, u_radius); }`,
    uniforms: (p) => ({ u_radius: n(p, 'radius'), u_thresh: 0 }),
  },
  {
    kind: 'dirBlur', label: 'Directional Blur', category: 'Filter', description: 'Motion blur along an angle', keywords: 'motion blur directional streak',
    style: 'run', inputs: IMG_IN, outputs: IMG_OUT,
    controls: [slider('angle', 'Angle', -180, 180, 0, 1, '°'), slider('distance', 'Distance', 0, 400, 30, 1, ' px'), { type: 'check', key: 'centred', label: 'Centred', default: true }],
    glsl: `uniform vec2 u_dir; uniform float u_dist; uniform float u_centred;
vec4 run(vec2 uv) {
  float d = u_dist * u_scale;
  if (d < 0.5) return c_image(uv);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 48; i++) {
    float t = float(i) / 47.0;
    if (u_centred > 0.5) t -= 0.5;
    sum += c_image(uv + u_dir * t * d * u_texel);
  }
  return sum / 48.0;
}`,
    uniforms: (p) => {
      const a = (n(p, 'angle') * Math.PI) / 180;
      return { u_dir: [Math.cos(a), Math.sin(a)], u_dist: n(p, 'distance'), u_centred: p.centred ? 1 : 0 };
    },
  },
  {
    kind: 'zoomBlur', label: 'Zoom / Spin Blur', category: 'Filter', description: 'Radial zoom or rotational spin blur', keywords: 'radial zoom spin blur',
    style: 'run', inputs: IMG_IN, outputs: IMG_OUT,
    controls: [
      select('type', 'Type', [['zoom', 'Zoom'], ['spin', 'Spin']]),
      slider('amount', 'Amount', 0, 100, 20), slider('cx', 'Centre X', 0, 100, 50, 1, '%'), slider('cy', 'Centre Y', 0, 100, 50, 1, '%'),
    ],
    glsl: `uniform float u_type; uniform float u_amount; uniform vec2 u_c;
vec4 run(vec2 uv) {
  vec2 p = (uv - u_c) * vec2(u_aspect, 1.0);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 48; i++) {
    float t = (float(i) / 47.0 - 0.5) * u_amount;
    vec2 q;
    if (u_type < 0.5) q = p * (1.0 + t * 0.5);
    else { float a = t * 0.6; q = mat2(cos(a), sin(a), -sin(a), cos(a)) * p; }
    sum += c_image(q / vec2(u_aspect, 1.0) + u_c);
  }
  return sum / 48.0;
}`,
    uniforms: (p) => ({ u_type: p.type === 'spin' ? 1 : 0, u_amount: pct(p, 'amount'), u_c: [pct(p, 'cx'), 1 - pct(p, 'cy')] }),
  },
  {
    kind: 'sharpen', label: 'Sharpen', category: 'Filter', description: 'Unsharp mask: amount, radius and threshold', keywords: 'sharpen unsharp mask detail clarity',
    style: 'run', inputs: IMG_IN, outputs: IMG_OUT, passes: 3,
    controls: [slider('amount', 'Amount', 0, 300, 80, 1, '%'), slider('radius', 'Radius', 0.5, 30, 1.5, 0.1, ' px', 1), slider('threshold', 'Threshold', 0, 50, 0, 1, '%')],
    glsl: `${BLUR_GLSL}
uniform float u_radius; uniform float u_amount; uniform float u_threshold;
vec4 run(vec2 uv) {
  if (u_pass == 0) return gblur(uv, vec2(1.0, 0.0), 0, u_radius);
  if (u_pass == 1) return gblur(uv, vec2(0.0, 1.0), 1, u_radius);
  vec4 o = c_image(uv);
  vec3 b = texture(u_prev, uv).rgb;
  vec3 d = toSRGB(max(o.rgb, 0.0)) - toSRGB(max(b, 0.0));
  float m = smoothstep(u_threshold, u_threshold * 1.5 + 1e-4, abs(luma(d)));
  return vec4(fromSRGB(toSRGB(max(o.rgb, 0.0)) + d * u_amount * m), o.a);
}`,
    uniforms: (p) => ({ u_radius: n(p, 'radius'), u_amount: pct(p, 'amount'), u_threshold: pct(p, 'threshold') * 0.2, u_thresh: 0 }),
  },
  {
    kind: 'bloom', label: 'Bloom / Glow', category: 'Filter', description: 'Glow around bright areas', keywords: 'glow bloom glare highlights',
    style: 'run', inputs: IMG_IN, outputs: IMG_OUT, passes: 3,
    controls: [slider('threshold', 'Threshold', 0, 4, 0.8, 0.01, '', 2), slider('radius', 'Radius', 1, 200, 30, 1, ' px'), slider('intensity', 'Intensity', 0, 300, 60, 1, '%')],
    glsl: `${BLUR_GLSL}
uniform float u_radius; uniform float u_intensity;
vec4 run(vec2 uv) {
  if (u_pass == 0) return gblur(uv, vec2(1.0, 0.0), 2, u_radius);
  if (u_pass == 1) return gblur(uv, vec2(0.0, 1.0), 1, u_radius);
  vec4 o = c_image(uv);
  return vec4(o.rgb + texture(u_prev, uv).rgb * u_intensity, o.a);
}`,
    uniforms: (p) => ({ u_radius: n(p, 'radius'), u_intensity: pct(p, 'intensity'), u_thresh: n(p, 'threshold') }),
  },
  {
    kind: 'edges', label: 'Edge Detect', category: 'Filter', description: 'Sobel / Prewitt / Laplacian edges', keywords: 'edge detection sobel outline lines laplace',
    style: 'run', inputs: IMG_IN, outputs: [cOut('image', 'Image'), fOut('edges', 'Edges')],
    controls: [
      select('op', 'Operator', [['sobel', 'Sobel'], ['prewitt', 'Prewitt'], ['laplace', 'Laplacian']]),
      slider('strength', 'Strength', 0, 500, 100, 1, '%'), slider('width', 'Width', 1, 10, 1, 0.5, ' px', 1),
    ],
    glsl: `uniform float u_op; uniform float u_strength; uniform float u_width;
vec3 E(vec2 uv) { return toSRGB(max(c_image(uv).rgb, 0.0)); }
vec4 run(vec2 uv) {
  vec2 t = u_texel * max(u_width * u_scale, 1.0);
  vec3 tl = E(uv + vec2(-t.x, t.y)), tc = E(uv + vec2(0.0, t.y)), tr = E(uv + t);
  vec3 ml = E(uv - vec2(t.x, 0.0)), mc = E(uv), mr = E(uv + vec2(t.x, 0.0));
  vec3 bl = E(uv - t), bc = E(uv - vec2(0.0, t.y)), br = E(uv + vec2(t.x, -t.y));
  vec3 g;
  if (u_op < 1.5) {
    float k = u_op < 0.5 ? 2.0 : 1.0;
    vec3 gx = (tr + k * mr + br) - (tl + k * ml + bl);
    vec3 gy = (tl + k * tc + tr) - (bl + k * bc + br);
    g = sqrt(gx * gx + gy * gy) / (2.0 + k);
  } else {
    g = abs(4.0 * mc - tc - bc - ml - mr);
  }
  g *= u_strength;
  if (u_out == 1) return vec4(clamp(luma(g), 0.0, 1.0));
  return vec4(fromSRGB(clamp(g, 0.0, 1.0)), 1.0);
}`,
    uniforms: (p) => ({ u_op: ['sobel', 'prewitt', 'laplace'].indexOf(String(p.op)), u_strength: pct(p, 'strength'), u_width: n(p, 'width') }),
  },
  {
    kind: 'comic', label: 'Comic', category: 'Filter', description: 'Posterised colour, ink outlines and optional halftone dots',
    keywords: 'comic cartoon toon cel ink outline posterize halftone', style: 'run', inputs: IMG_IN, outputs: IMG_OUT,
    controls: [
      slider('levels', 'Colour levels', 2, 16, 5), slider('saturation', 'Saturation', 0, 200, 130, 1, '%'),
      slider('edge', 'Edge threshold', 1, 100, 25, 1, '%'), slider('thickness', 'Line width', 0.5, 8, 1.5, 0.5, ' px', 1),
      { type: 'color', key: 'ink', label: 'Ink colour', default: '#111111' },
      { type: 'check', key: 'halftone', label: 'Halftone dots', default: true }, slider('dot', 'Dot size', 2, 40, 8, 1, ' px'),
    ],
    glsl: `${SOBEL_GLSL}
uniform float u_levels; uniform float u_sat; uniform float u_edge; uniform float u_thick; uniform vec3 u_ink;
uniform float u_halftone; uniform float u_dot;
vec4 run(vec2 uv) {
  vec4 c = c_image(uv);
  vec3 e = clamp(toSRGB(max(c.rgb, 0.0)), 0.0, 1.0);
  float l = luma(e);
  e = clamp(l + (e - l) * u_sat, 0.0, 1.0);
  vec3 post = floor(e * u_levels + 0.5) / u_levels;
  if (u_halftone > 0.5) {
    float cell = max(u_dot * u_scale, 2.0);
    vec2 px = uv * u_size;
    vec2 q = mat2(0.7071, 0.7071, -0.7071, 0.7071) * px / cell;
    float d = length(fract(q) - 0.5);
    float dark = 1.0 - luma(post);
    float dotMask = 1.0 - smoothstep(sqrt(dark) * 0.5 - 0.06, sqrt(dark) * 0.5 + 0.06, d);
    post *= mix(1.0, 0.7, dotMask);
  }
  float g = sobelLuma(uv, max(u_thick * u_scale, 1.0));
  float line = smoothstep(u_edge, u_edge * 1.4 + 0.02, g);
  return vec4(fromSRGB(mix(post, toSRGB(u_ink), line)), c.a);
}`,
    uniforms: (p) => ({
      u_levels: Math.max(1, n(p, 'levels') - 1), u_sat: pct(p, 'saturation'), u_edge: pct(p, 'edge') * 1.2,
      u_thick: n(p, 'thickness'), u_ink: hexToLinear(String(p.ink)), u_halftone: p.halftone ? 1 : 0, u_dot: n(p, 'dot'),
    }),
  },
  {
    kind: 'pixelate', label: 'Pixelate', category: 'Filter', description: 'Mosaic of square blocks', keywords: 'pixel mosaic blocks 8-bit',
    style: 'run', inputs: IMG_IN, outputs: IMG_OUT, controls: [slider('size', 'Block size', 1, 200, 16, 1, ' px')],
    glsl: `uniform float u_px;
vec4 run(vec2 uv) {
  vec2 cell = max(u_px * u_scale, 1.0) * u_texel;
  return c_image((floor(uv / cell) + 0.5) * cell);
}`,
    uniforms: (p) => ({ u_px: n(p, 'size') }),
  },
  {
    kind: 'posterize', label: 'Posterize', category: 'Filter', description: 'Reduce each channel to a few levels', keywords: 'posterise quantize levels banding',
    controls: [slider('levels', 'Levels', 2, 32, 6)],
    glsl: `uniform float u_levels;
vec4 effect(vec4 c) { vec3 e = clamp(toSRGB(max(c.rgb, 0.0)), 0.0, 1.0); return vec4(fromSRGB(floor(e * u_levels + 0.5) / u_levels), c.a); }`,
    uniforms: (p) => ({ u_levels: Math.max(1, n(p, 'levels') - 1) }),
  },
  {
    kind: 'threshold', label: 'Threshold', category: 'Filter', description: 'Black/white by brightness', keywords: 'threshold binary black white mask',
    style: 'run', inputs: IMG_IN, outputs: [cOut('image', 'Image'), fOut('mask', 'Mask')],
    controls: [slider('level', 'Level', 0, 100, 50, 1, '%'), slider('soft', 'Softness', 0, 50, 0, 1, '%')],
    glsl: `uniform float u_level; uniform float u_soft;
vec4 run(vec2 uv) {
  float l = toSRGB1(max(luma(c_image(uv).rgb), 0.0));
  float m = smoothstep(u_level - u_soft - 1e-4, u_level + u_soft, l);
  return u_out == 1 ? vec4(m) : vec4(vec3(m), 1.0);
}`,
    uniforms: (p) => ({ u_level: pct(p, 'level'), u_soft: pct(p, 'soft') * 0.5 }),
  },
  {
    kind: 'emboss', label: 'Emboss', category: 'Filter', description: 'Relief effect from light direction', keywords: 'emboss relief bevel',
    style: 'run', inputs: IMG_IN, outputs: IMG_OUT,
    controls: [slider('angle', 'Light angle', -180, 180, 135, 1, '°'), slider('distance', 'Distance', 0.5, 10, 1.5, 0.5, ' px', 1), slider('strength', 'Strength', 0, 500, 150, 1, '%'), slider('mix', 'Colour', 0, 100, 0, 1, '%')],
    glsl: `uniform vec2 u_dir; uniform float u_dist; uniform float u_strength; uniform float u_mixc;
vec4 run(vec2 uv) {
  vec2 o = u_dir * u_texel * max(u_dist * u_scale, 1.0);
  vec4 c = c_image(uv);
  float a = toSRGB1(max(luma(c_image(uv + o).rgb), 0.0));
  float b = toSRGB1(max(luma(c_image(uv - o).rgb), 0.0));
  float e = clamp(0.5 + (b - a) * u_strength, 0.0, 1.0);
  vec3 grey = vec3(fromSRGB1(e));
  vec3 tinted = c.rgb * (e * 2.0);
  return vec4(mix(grey, tinted, u_mixc), c.a);
}`,
    uniforms: (p) => {
      const a = (n(p, 'angle') * Math.PI) / 180;
      return { u_dir: [Math.cos(a), Math.sin(a)], u_dist: n(p, 'distance'), u_strength: pct(p, 'strength'), u_mixc: pct(p, 'mix') };
    },
  },
  {
    kind: 'kuwahara', label: 'Kuwahara (Painterly)', category: 'Filter', description: 'Oil-paint style smoothing that keeps edges', keywords: 'kuwahara painterly oil paint watercolour smooth',
    style: 'run', inputs: IMG_IN, outputs: IMG_OUT, controls: [slider('radius', 'Radius', 1, 32, 6, 1, ' px')],
    glsl: `uniform float u_radius;
vec4 run(vec2 uv) {
  int r = int(clamp(floor(u_radius * u_scale + 0.5), 1.0, 8.0));
  vec3 m[4]; vec3 s[4];
  for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
  vec2 sgn[4] = vec2[4](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(1.0, 1.0));
  float cnt = float((r + 1) * (r + 1));
  for (int k = 0; k < 4; k++) {
    for (int j = 0; j <= 8; j++) {
      if (j > r) break;
      for (int i = 0; i <= 8; i++) {
        if (i > r) break;
        vec3 c = c_image(uv + sgn[k] * vec2(float(i), float(j)) * u_texel).rgb;
        m[k] += c; s[k] += c * c;
      }
    }
  }
  float best = 1e20; vec3 res = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec3 mean = m[k] / cnt;
    vec3 v = abs(s[k] / cnt - mean * mean);
    float sv = v.r + v.g + v.b;
    if (sv < best) { best = sv; res = mean; }
  }
  return vec4(res, c_image(uv).a);
}`,
    uniforms: (p) => ({ u_radius: n(p, 'radius') }),
  },
  {
    kind: 'halftone', label: 'Halftone', category: 'Filter', description: 'Print-style dot screen (mono or CMY)', keywords: 'halftone dots print screen newspaper',
    style: 'run', inputs: IMG_IN, outputs: IMG_OUT,
    controls: [select('mode', 'Mode', [['mono', 'Mono'], ['cmy', 'CMY colour']]), slider('size', 'Dot size', 2, 60, 10, 1, ' px'), slider('angle', 'Angle', 0, 90, 45, 1, '°')],
    glsl: `uniform float u_mode; uniform float u_cell; uniform float u_angle;
float dotCov(vec2 uv, float val, float ang) {
  float cell = max(u_cell * u_scale, 2.0);
  float a = radians(ang);
  vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * (uv * u_size) / cell;
  float d = length(fract(q) - 0.5);
  float r = sqrt(clamp(val, 0.0, 1.0)) * 0.55;
  float aa = 1.5 / cell;
  return 1.0 - smoothstep(r - aa, r + aa, d);
}
vec4 run(vec2 uv) {
  vec4 c = c_image(uv);
  vec3 e = clamp(toSRGB(max(c.rgb, 0.0)), 0.0, 1.0);
  if (u_mode < 0.5) return vec4(vec3(fromSRGB1(1.0 - dotCov(uv, 1.0 - luma(e), u_angle))), c.a);
  vec3 cmy = 1.0 - e;
  vec3 o = vec3(1.0) - vec3(dotCov(uv, cmy.r, u_angle - 30.0), dotCov(uv, cmy.g, u_angle + 30.0), dotCov(uv, cmy.b, u_angle));
  return vec4(fromSRGB(o), c.a);
}`,
    uniforms: (p) => ({ u_mode: p.mode === 'cmy' ? 1 : 0, u_cell: n(p, 'size'), u_angle: n(p, 'angle') }),
  },

  /* ===== Texture (generators) ===== */
  {
    kind: 'noise', label: 'Noise Texture', category: 'Texture', description: 'Fractal Perlin noise (Blender style)', keywords: 'noise perlin fbm fractal clouds procedural',
    style: 'run',
    inputs: [vecIn, f('scale', 'Scale', 5, 0, 100, 0.1), f('detail', 'Detail', 2, 0, 15, 0.1), f('roughness', 'Roughness', 0.5, 0, 1, 0.01), f('lacunarity', 'Lacunarity', 2, 0, 8, 0.01), f('distortion', 'Distortion', 0, 0, 10, 0.01), f('w', 'W', 0, -100, 100, 0.01)],
    outputs: [fOut('fac', 'Fac'), cOut('color', 'Colour')],
    controls: [],
    glsl: `${COORDS}
vec4 run(vec2 uv) {
  vec3 p = coords(uv) * f_scale(uv) + vec3(0.0, 0.0, f_w(uv));
  float dist = f_distortion(uv);
  if (dist != 0.0) p += vec3(gnoise(p + vec3(13.5, 2.1, 7.7)), gnoise(p + vec3(-7.3, 4.1, 1.9)), gnoise(p + vec3(3.3, -9.1, 5.7))) * dist;
  float d = clamp(f_detail(uv), 0.0, 15.0), r = f_roughness(uv), l = f_lacunarity(uv);
  if (u_out == 0) return vec4(fbm(p, d, r, l));
  return vec4(fbm(p, d, r, l), fbm(p + vec3(97.13, 11.7, 3.1), d, r, l), fbm(p + vec3(-41.2, 67.3, -19.9), d, r, l), 1.0);
}`,
  },
  {
    kind: 'voronoi', label: 'Voronoi Texture', category: 'Texture', description: 'Cellular noise: distance, cell colour, edges', keywords: 'voronoi worley cellular cells crackle procedural',
    style: 'run',
    inputs: [vecIn, f('scale', 'Scale', 5, 0, 100, 0.1), f('randomness', 'Randomness', 1, 0, 1, 0.01), f('w', 'W', 0, -100, 100, 0.01)],
    outputs: [fOut('distance', 'Distance'), cOut('color', 'Colour'), cOut('position', 'Position')],
    controls: [
      select('feature', 'Feature', [['f1', 'F1'], ['f2', 'F2'], ['edge', 'Distance to Edge']]),
      select('metric', 'Distance', [['euclidean', 'Euclidean'], ['manhattan', 'Manhattan'], ['chebychev', 'Chebychev']]),
    ],
    glsl: `${COORDS}
uniform int u_feature; uniform int u_metric;
float vdist(vec3 d) { if (u_metric == 1) return abs(d.x) + abs(d.y) + abs(d.z); if (u_metric == 2) return max(abs(d.x), max(abs(d.y), abs(d.z))); return length(d); }
vec4 run(vec2 uv) {
  float sc = f_scale(uv);
  vec3 p = coords(uv) * sc + vec3(0.0, 0.0, f_w(uv));
  float rnd = clamp(f_randomness(uv), 0.0, 1.0);
  vec3 cell = floor(p); vec3 fr = p - cell;
  float d1 = 1e10, d2 = 1e10; vec3 g1 = vec3(0.0), g2 = vec3(0.0), o1 = vec3(0.0), o2 = vec3(0.0);
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = hash33(cell + g) * rnd;
    float d = vdist(g + o - fr);
    if (d < d1) { d2 = d1; g2 = g1; o2 = o1; d1 = d; g1 = g; o1 = o; }
    else if (d < d2) { d2 = d; g2 = g; o2 = o; }
  }
  if (u_feature == 2 && u_out == 0) {
    vec3 mr = g1 + o1 - fr; float md = 1e10;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 g = g1 + vec3(float(x), float(y), float(z));
      vec3 r = g + hash33(cell + g) * rnd - fr;
      vec3 dd = r - mr;
      if (dot(dd, dd) > 1e-6) md = min(md, dot(0.5 * (mr + r), normalize(dd)));
    }
    return vec4(md);
  }
  bool second = u_feature == 1;
  vec3 g = second ? g2 : g1; vec3 o = second ? o2 : o1;
  if (u_out == 0) return vec4(second ? d2 : d1);
  if (u_out == 1) return vec4(hash33(cell + g + vec3(31.0, 17.0, 5.0)), 1.0);
  return vec4((cell + g + o) / max(sc, 1e-4), 1.0);
}`,
    uniforms: (p) => ({ u_feature: idx(p, 'feature', ['f1', 'f2', 'edge']), u_metric: idx(p, 'metric', ['euclidean', 'manhattan', 'chebychev']) }),
  },
  {
    kind: 'whiteNoise', label: 'White Noise', category: 'Texture', description: 'Random value per pixel (or per input vector)', keywords: 'white noise random hash grain static',
    style: 'run', inputs: [vecIn, f('w', 'W', 0, -100, 100, 0.01)], outputs: [fOut('value', 'Value'), cOut('color', 'Colour')], controls: [],
    glsl: `vec4 run(vec2 uv) {
  vec3 p = has_vector() ? c_vector(uv).rgb : vec3(floor(uv * u_fullSize), 0.0);
  p.z += f_w(uv);
  vec3 h = hashBits(p);
  return u_out == 0 ? vec4(h.x) : vec4(h, 1.0);
}`,
  },
  {
    kind: 'gradient', label: 'Gradient Texture', category: 'Texture', description: 'Linear, radial and spherical gradients', keywords: 'gradient ramp linear radial spherical procedural',
    style: 'run', inputs: [vecIn], outputs: [cOut('color', 'Colour'), fOut('fac', 'Fac')],
    controls: [select('type', 'Type', [['linear', 'Linear'], ['quadratic', 'Quadratic'], ['easing', 'Easing'], ['diagonal', 'Diagonal'], ['spherical', 'Spherical'], ['quadSphere', 'Quadratic Sphere'], ['radial', 'Radial']])],
    glsl: `uniform int u_type;
vec4 run(vec2 uv) {
  vec3 p = has_vector() ? c_vector(uv).rgb : vec3(uv, 0.0);
  vec3 q = has_vector() ? p : vec3((uv - 0.5) * vec2(u_aspect, 1.0) * 2.0, 0.0);
  float t;
  if (u_type == 0) t = p.x;
  else if (u_type == 1) { float r = max(p.x, 0.0); t = r * r; }
  else if (u_type == 2) { float r = clamp(p.x, 0.0, 1.0); t = r * r * (3.0 - 2.0 * r); }
  else if (u_type == 3) t = (p.x + p.y) * 0.5;
  else if (u_type == 4) t = max(1.0 - length(q), 0.0);
  else if (u_type == 5) { float r = max(1.0 - length(q), 0.0); t = r * r; }
  else t = atan(q.y, q.x) / (2.0 * PI) + 0.5;
  t = clamp(t, 0.0, 1.0);
  return u_out == 1 ? vec4(t) : vec4(vec3(t), 1.0);
}`,
    uniforms: (p) => ({ u_type: idx(p, 'type', ['linear', 'quadratic', 'easing', 'diagonal', 'spherical', 'quadSphere', 'radial']) }),
  },
  {
    kind: 'wave', label: 'Wave Texture', category: 'Texture', description: 'Bands or rings with sine/saw/triangle profile', keywords: 'wave stripes bands rings procedural',
    style: 'run',
    inputs: [vecIn, f('scale', 'Scale', 5, 0, 100, 0.1), f('distortion', 'Distortion', 0, 0, 50, 0.1), f('detail', 'Detail', 2, 0, 15, 0.1), f('detailScale', 'Detail Scale', 1, 0, 20, 0.1), f('phase', 'Phase', 0, -100, 100, 0.01)],
    outputs: [cOut('color', 'Colour'), fOut('fac', 'Fac')],
    controls: [
      select('type', 'Type', [['bands', 'Bands'], ['rings', 'Rings']]),
      select('direction', 'Direction', [['x', 'X'], ['y', 'Y'], ['diagonal', 'Diagonal']]),
      select('profile', 'Profile', [['sine', 'Sine'], ['saw', 'Saw'], ['triangle', 'Triangle']]),
    ],
    glsl: `${COORDS}
uniform int u_type; uniform int u_dirn; uniform int u_profile;
vec4 run(vec2 uv) {
  vec3 base = has_vector() ? c_vector(uv).rgb : (u_type == 1 ? vec3((uv.x - 0.5) * u_aspect, uv.y - 0.5, 0.0) : coords(uv));
  vec3 p = base * f_scale(uv);
  float nv;
  if (u_type == 0) nv = (u_dirn == 0 ? p.x : u_dirn == 1 ? p.y : (p.x + p.y) * 0.5) * 20.0;
  else nv = length(p) * 20.0;
  nv += f_phase(uv);
  float dist = f_distortion(uv);
  if (dist != 0.0) nv += dist * (fbm(p * f_detailScale(uv), clamp(f_detail(uv), 0.0, 15.0), 0.5, 2.0) * 2.0 - 1.0);
  float t;
  if (u_profile == 0) t = 0.5 + 0.5 * sin(nv - PI * 0.5);
  else if (u_profile == 1) { nv /= 2.0 * PI; t = nv - floor(nv); }
  else { nv /= 2.0 * PI; t = abs(nv - floor(nv + 0.5)) * 2.0; }
  return u_out == 1 ? vec4(t) : vec4(vec3(t), 1.0);
}`,
    uniforms: (p) => ({ u_type: idx(p, 'type', ['bands', 'rings']), u_dirn: idx(p, 'direction', ['x', 'y', 'diagonal']), u_profile: idx(p, 'profile', ['sine', 'saw', 'triangle']) }),
  },
  {
    kind: 'checker', label: 'Checker Texture', category: 'Texture', description: 'Checkerboard of two colours', keywords: 'checker checkerboard grid squares procedural',
    style: 'run', inputs: [vecIn, col('color1', 'Colour 1', '#e6e6e6'), col('color2', 'Colour 2', '#333333'), f('scale', 'Scale', 5, 0, 200, 0.1)],
    outputs: [cOut('color', 'Colour'), fOut('fac', 'Fac')], controls: [],
    glsl: `${COORDS}
vec4 run(vec2 uv) {
  vec3 p = coords(uv) * f_scale(uv) + 1e-5;
  float s = mod(floor(p.x) + floor(p.y) + floor(p.z), 2.0);
  if (u_out == 1) return vec4(s);
  return s > 0.5 ? c_color1(uv) : c_color2(uv);
}`,
  },

  /* ===== Mask (primitive shapes → per-pixel factor) ===== */
  {
    kind: 'circleMask', label: 'Circle Mask', category: 'Mask', description: 'Feathered circle at X, Y with radius R → mask value',
    keywords: 'circle mask shape vignette spot radial feather matte', style: 'run',
    inputs: [...maskPos, f('radius', 'Radius', 0.25, 0, 1, 0.001), maskFeather], outputs: maskOutSock, controls: [maskInvert],
    glsl: `${MASK_GLSL}
vec4 run(vec2 uv) {
  vec2 p = maskP(uv, vec2(f_x(uv), f_y(uv)));
  return maskOut(length(p) - max(f_radius(uv), 0.0), f_feather(uv));
}`,
    uniforms: maskUniforms,
  },
  {
    kind: 'ellipseMask', label: 'Ellipse Mask', category: 'Mask', description: 'Feathered, rotatable ellipse → mask value',
    keywords: 'ellipse oval mask shape feather matte', style: 'run',
    inputs: [...maskPos, f('rx', 'Radius X', 0.35, 0, 1, 0.001), f('ry', 'Radius Y', 0.2, 0, 1, 0.001), maskRot, maskFeather],
    outputs: maskOutSock, controls: [maskInvert],
    glsl: `${MASK_GLSL}
vec4 run(vec2 uv) {
  vec2 p = rot2(maskP(uv, vec2(f_x(uv), f_y(uv))), -f_rotation(uv));
  vec2 r = max(vec2(f_rx(uv), f_ry(uv)), vec2(1e-5));
  float d = (length(p / r) - 1.0) * min(r.x, r.y);
  return maskOut(d, f_feather(uv));
}`,
    uniforms: maskUniforms,
  },
  {
    kind: 'rectMask', label: 'Rectangle Mask', category: 'Mask', description: 'Feathered, rotatable box with rounded corners → mask value',
    keywords: 'rectangle box square mask shape rounded feather matte', style: 'run',
    inputs: [...maskPos, f('w', 'Width', 0.6, 0, 2, 0.001), f('h', 'Height', 0.4, 0, 2, 0.001), f('corner', 'Corner', 0, 0, 0.5, 0.001), maskRot, maskFeather],
    outputs: maskOutSock, controls: [maskInvert],
    glsl: `${MASK_GLSL}
vec4 run(vec2 uv) {
  vec2 p = rot2(maskP(uv, vec2(f_x(uv), f_y(uv))), -f_rotation(uv));
  vec2 b = 0.5 * max(vec2(f_w(uv), f_h(uv)), vec2(0.0));
  float cr = clamp(f_corner(uv), 0.0, min(b.x, b.y));
  vec2 q = abs(p) - b + cr;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - cr;
  return maskOut(d, f_feather(uv));
}`,
    uniforms: maskUniforms,
  },
  {
    kind: 'polygonMask', label: 'Polygon Mask', category: 'Mask', description: 'Feathered regular polygon (3–32 sides) → mask value',
    keywords: 'polygon triangle hexagon pentagon mask shape feather matte', style: 'run',
    inputs: [...maskPos, f('radius', 'Radius', 0.3, 0, 1, 0.001), f('sides', 'Sides', 6, 3, 12, 1), maskRot, maskFeather],
    outputs: maskOutSock, controls: [maskInvert],
    glsl: `${MASK_GLSL}
vec4 run(vec2 uv) {
  vec2 p = rot2(maskP(uv, vec2(f_x(uv), f_y(uv))), -f_rotation(uv));
  p.y = -p.y; // first vertex points up
  float r = max(f_radius(uv), 0.0);
  float n = clamp(floor(f_sides(uv) + 0.5), 3.0, 32.0);
  float an = PI / n;
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  vec2 q = length(p) * vec2(cos(bn), abs(sin(bn)));
  q -= r * vec2(cos(an), sin(an));
  q.y += clamp(-q.y, 0.0, r * sin(an));
  return maskOut(length(q) * sign(q.x), f_feather(uv));
}`,
    uniforms: maskUniforms,
  },

  /* ===== Converter ===== */
  {
    kind: 'math', label: 'Math', category: 'Converter', description: 'Add, multiply, sin, exp, ceil … (Blender Math)', keywords: 'math add subtract multiply divide power sin cos exp log floor ceil modulo min max',
    style: 'run', width: 200,
    inputs: [f('a', 'A', 0.5, undefined, undefined, 0.01), f('b', 'B', 0.5, undefined, undefined, 0.01), f('c', 'C', 0, undefined, undefined, 0.01)],
    outputs: [fOut('value', 'Value')],
    controls: [{ type: 'select', key: 'op', label: 'Operation', default: 'add', options: MATH_OPS }, { type: 'check', key: 'clamp', label: 'Clamp 0–1', default: false }],
    glsl: `uniform int u_op; uniform float u_clamp;
vec4 run(vec2 uv) {
  float r = mathOp(u_op, f_a(uv), f_b(uv), f_c(uv));
  if (u_clamp > 0.5) r = clamp(r, 0.0, 1.0);
  return vec4(r);
}`,
    uniforms: (p) => ({ u_op: { i: Math.max(0, MATH_OPS.findIndex((o) => o.value === p.op)) }, u_clamp: p.clamp ? 1 : 0 }),
  },
  {
    kind: 'vectorMath', label: 'Vector Math', category: 'Converter', description: 'Per-component maths on colours/vectors, dot, cross, length …', keywords: 'vector math float3 dot cross length normalize distance scale',
    style: 'run', width: 200,
    inputs: [col('a', 'A', '#000000'), col('b', 'B', '#000000'), col('c', 'C', '#000000'), f('scale', 'Scale', 1, undefined, undefined, 0.01)],
    outputs: [cOut('vector', 'Vector'), fOut('value', 'Value')],
    controls: [{
      type: 'select', key: 'op', label: 'Operation', default: 'add',
      options: [
        ...MATH_OPS.filter((o) => VEC_COMPONENT_OPS.includes(o.value)).map((o) => ({ value: o.value, label: o.label, group: 'Per component' })),
        ...VEC_OPS.map(([value, label]) => ({ value, label, group: 'Vector' })),
      ],
    }],
    glsl: `uniform int u_op;
vec4 run(vec2 uv) {
  vec3 a = c_a(uv).rgb, b = c_b(uv).rgb, c = c_c(uv).rgb;
  vec3 v = vec3(0.0); float s = 0.0;
  if (u_op < 100) v = vec3(mathOp(u_op, a.x, b.x, c.x), mathOp(u_op, a.y, b.y, c.y), mathOp(u_op, a.z, b.z, c.z));
  else if (u_op == 100) s = dot(a, b);
  else if (u_op == 101) v = cross(a, b);
  else if (u_op == 102) s = length(a);
  else if (u_op == 103) s = distance(a, b);
  else if (u_op == 104) v = length(a) > 0.0 ? normalize(a) : vec3(0.0);
  else if (u_op == 105) v = a * f_scale(uv);
  else if (u_op == 106) v = length(b) > 0.0 ? reflect(a, normalize(b)) : a;
  return u_out == 1 ? vec4(s) : vec4(v, 1.0);
}`,
    uniforms: (p) => ({ u_op: { i: vecOpIndex(String(p.op)) } }),
  },
  {
    kind: 'mix', label: 'Mix', category: 'Converter', description: 'Blend two inputs by a factor (Mix, Multiply, Screen, Overlay …)', keywords: 'mix blend combine composite overlay multiply screen layer',
    style: 'run', inputs: [f('fac', 'Factor', 0.5, 0, 1, 0.01), col('a', 'A', '#808080'), col('b', 'B', '#808080')], outputs: [cOut('result', 'Result')],
    controls: [select('blend', 'Blend', BLEND_MODES), { type: 'check', key: 'clampFac', label: 'Clamp factor', default: true }, { type: 'check', key: 'clampRes', label: 'Clamp result', default: false }],
    glsl: `uniform int u_blend; uniform float u_clampFac; uniform float u_clampRes;
vec4 run(vec2 uv) {
  float fc = f_fac(uv);
  if (u_clampFac > 0.5) fc = clamp(fc, 0.0, 1.0);
  vec4 a = c_a(uv), b = c_b(uv);
  vec3 r = blendMix(u_blend, fc, a.rgb, b.rgb);
  if (u_clampRes > 0.5) r = clamp(r, 0.0, 1.0);
  return vec4(r, a.a);
}`,
    uniforms: (p) => ({ u_blend: idx(p, 'blend', BLEND_MODES.map((b) => b[0])), u_clampFac: p.clampFac ? 1 : 0, u_clampRes: p.clampRes ? 1 : 0 }),
  },
  {
    kind: 'colorRamp', label: 'Colour Ramp', category: 'Converter', description: 'Map a value to colours along a gradient', keywords: 'colour ramp color gradient map lut false colour',
    style: 'run', width: 230, ramp: true, inputs: [f('fac', 'Fac', 0.5, 0, 1, 0.01)], outputs: [cOut('color', 'Colour'), fOut('alpha', 'Alpha')],
    controls: [{ type: 'ramp' }],
    glsl: `vec4 run(vec2 uv) { vec4 c = rampEval(f_fac(uv)); return u_out == 1 ? vec4(c.a) : c; }`,
  },
  {
    kind: 'mapRange', label: 'Map Range', category: 'Converter', description: 'Remap a value from one range to another', keywords: 'map range remap fit normalize scale',
    style: 'run',
    inputs: [f('value', 'Value', 0.5, undefined, undefined, 0.01), f('fromMin', 'From Min', 0), f('fromMax', 'From Max', 1), f('toMin', 'To Min', 0), f('toMax', 'To Max', 1), f('steps', 'Steps', 4, 0, 64, 1)],
    outputs: [fOut('result', 'Result')],
    controls: [select('interp', 'Interpolation', [['linear', 'Linear'], ['stepped', 'Stepped Linear'], ['smooth', 'Smooth Step'], ['smoother', 'Smoother Step']]), { type: 'check', key: 'clamp', label: 'Clamp', default: true }],
    glsl: `uniform int u_mode; uniform float u_clamp;
vec4 run(vec2 uv) {
  float v = f_value(uv), a = f_fromMin(uv), b = f_fromMax(uv), c = f_toMin(uv), d = f_toMax(uv), st = f_steps(uv);
  float t = b != a ? (v - a) / (b - a) : 0.0;
  if (u_mode == 1) t = st > 0.0 ? floor(t * (st + 1.0)) / st : 0.0;
  else if (u_mode == 2) { t = clamp(t, 0.0, 1.0); t = t * t * (3.0 - 2.0 * t); }
  else if (u_mode == 3) { t = clamp(t, 0.0, 1.0); t = t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
  float r = c + t * (d - c);
  if (u_clamp > 0.5 && u_mode < 2) r = clamp(r, min(c, d), max(c, d));
  return vec4(r);
}`,
    uniforms: (p) => ({ u_mode: idx(p, 'interp', ['linear', 'stepped', 'smooth', 'smoother']), u_clamp: p.clamp ? 1 : 0 }),
  },
  {
    kind: 'clamp', label: 'Clamp', category: 'Converter', description: 'Limit a value between min and max', keywords: 'clamp limit min max',
    style: 'run', inputs: [f('value', 'Value', 0.5, undefined, undefined, 0.01), f('min', 'Min', 0), f('max', 'Max', 1)], outputs: [fOut('result', 'Result')],
    controls: [select('type', 'Type', [['minmax', 'Min Max'], ['range', 'Range']])],
    glsl: `uniform float u_range;
vec4 run(vec2 uv) { float a = f_min(uv), b = f_max(uv); if (u_range > 0.5 && a > b) { float t = a; a = b; b = t; } return vec4(clamp(f_value(uv), a, b)); }`,
    uniforms: (p) => ({ u_range: p.type === 'range' ? 1 : 0 }),
  },
  {
    kind: 'separateRgb', label: 'Separate RGB', category: 'Converter', description: 'Split a colour into R, G, B, A', keywords: 'separate split channels rgb float',
    style: 'run', inputs: IMG_IN, outputs: [fOut('r', 'R'), fOut('g', 'G'), fOut('b', 'B'), fOut('a', 'A')], controls: [],
    glsl: `vec4 run(vec2 uv) { vec4 c = c_image(uv); return vec4(u_out == 0 ? c.r : u_out == 1 ? c.g : u_out == 2 ? c.b : c.a); }`,
  },
  {
    kind: 'combineRgb', label: 'Combine RGB', category: 'Converter', description: 'Build a colour from R, G, B, A', keywords: 'combine merge channels rgb float3',
    style: 'run', inputs: [f('r', 'R', 0, 0, 1, 0.01), f('g', 'G', 0, 0, 1, 0.01), f('b', 'B', 0, 0, 1, 0.01), f('a', 'A', 1, 0, 1, 0.01)], outputs: [cOut('image', 'Image')], controls: [],
    glsl: `vec4 run(vec2 uv) { return vec4(f_r(uv), f_g(uv), f_b(uv), f_a(uv)); }`,
  },
  {
    kind: 'separateHsv', label: 'Separate HSV', category: 'Converter', description: 'Split a colour into hue, saturation, value', keywords: 'separate hsv hue saturation value',
    style: 'run', inputs: IMG_IN, outputs: [fOut('h', 'H'), fOut('s', 'S'), fOut('v', 'V')], controls: [],
    glsl: `vec4 run(vec2 uv) { vec3 h = rgb2hsv(max(c_image(uv).rgb, 0.0)); return vec4(u_out == 0 ? h.x : u_out == 1 ? h.y : h.z); }`,
  },
  {
    kind: 'combineHsv', label: 'Combine HSV', category: 'Converter', description: 'Build a colour from hue, saturation, value', keywords: 'combine hsv hue saturation value',
    style: 'run', inputs: [f('h', 'H', 0, 0, 1, 0.01), f('s', 'S', 1, 0, 1, 0.01), f('v', 'V', 1, 0, 1, 0.01)], outputs: [cOut('image', 'Image')], controls: [],
    glsl: `vec4 run(vec2 uv) { return vec4(hsv2rgb(vec3(fract(f_h(uv)), clamp(f_s(uv), 0.0, 1.0), max(f_v(uv), 0.0))), 1.0); }`,
  },
  {
    kind: 'rgbToBw', label: 'RGB to BW', category: 'Converter', description: 'Colour to a luminance value', keywords: 'luminance luma bw float convert',
    style: 'run', inputs: IMG_IN, outputs: [fOut('val', 'Val')], controls: [],
    glsl: `vec4 run(vec2 uv) { return vec4(luma(c_image(uv).rgb)); }`,
  },

  /* ===== Utility ===== */
  {
    kind: 'grayscale', label: 'Grayscale', category: 'Utility', description: 'Luminance conversion', keywords: 'gray grey desaturate', controls: [],
    glsl: `vec4 effect(vec4 c) { return vec4(vec3(luma(c.rgb)), c.a); }`, uniforms: () => ({}),
  },
  {
    kind: 'invert', label: 'Invert', category: 'Utility', description: 'Invert RGB channels', keywords: 'negative', controls: [],
    glsl: `vec4 effect(vec4 c) { return vec4(fromSRGB(1.0 - clamp(toSRGB(c.rgb), 0.0, 1.0)), c.a); }`, uniforms: () => ({}),
  },

  /* ===== Group internals (not in toolbox; sockets come from node data) ===== */
  { kind: 'group', label: 'Group', category: 'Group', description: 'Compound node – a collection of nodes', hidden: true, controls: [] },
  { kind: 'groupIn', label: 'Group Input', category: 'Group', description: 'Inputs of the group', hidden: true, controls: [] },
  { kind: 'groupOut', label: 'Group Output', category: 'Group', description: 'Outputs of the group', hidden: true, controls: [] },
];

const BY_KIND = new Map(NODE_DEFS.map((d) => [d.kind, d]));
export const getDef = (kind: string) => BY_KIND.get(kind);

/** Whether a node kind renders on the GPU (has a shader). */
export const isShaderKind = (kind: string) => !!getDef(kind)?.glsl;

/** Static sockets of a node kind (group kinds return [] – use socketsOf in graph.ts). */
export function defSockets(kind: string): { inputs: Socket[]; outputs: Socket[] } {
  const d = getDef(kind);
  if (!d) return { inputs: [], outputs: [] };
  const effect = !!d.glsl && (d.style ?? 'effect') === 'effect';
  return { inputs: d.inputs ?? (effect ? IMG_IN : []), outputs: d.outputs ?? (effect ? IMG_OUT : []) };
}

/* ---------- defaults ---------- */

function collectDefaults(controls: Control[], out: Params) {
  for (const c of controls) {
    if (c.type === 'slider' || c.type === 'select' || c.type === 'check' || c.type === 'color' || c.type === 'number') out[c.key] = c.default;
    else if (c.type === 'media') out[c.key] = '';
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
  if (!def) return {};
  const out = collectDefaults(def.controls, {});
  for (const s of defSockets(kind).inputs) if (s.default !== undefined && !s.hideValue) out[`in_${s.id}`] = s.default;
  return out;
};

/** Curve channels of a node (empty if it has no curves control). */
export const curveChannels = (kind: string): CurveChannel[] =>
  getDef(kind)?.controls.flatMap((c) => (c.type === 'curves' ? c.channels : [])) ?? [];

export const resolveCurves = (kind: string, curves?: Curves) =>
  curveChannels(kind).map((ch) => ({ points: curves?.[ch.id] ?? ch.defaults, periodic: ch.periodic }));
