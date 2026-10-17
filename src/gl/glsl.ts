/** GLSL helpers included in every node shader. Working space: linear sRGB / Rec.709 primaries. */
export const COMMON_GLSL = /* glsl */ `
const float PI = 3.14159265358979;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA); }

// sRGB transfer (sign-preserving so negative / out-of-gamut values survive round trips)
float toSRGB1(float x) { float a = abs(x); float e = a <= 0.0031308 ? 12.92 * a : 1.055 * pow(a, 1.0 / 2.4) - 0.055; return sign(x) * e; }
float fromSRGB1(float x) { float a = abs(x); float l = a <= 0.04045 ? a / 12.92 : pow((a + 0.055) / 1.055, 2.4); return sign(x) * l; }
vec3 toSRGB(vec3 c) { return vec3(toSRGB1(c.r), toSRGB1(c.g), toSRGB1(c.b)); }
vec3 fromSRGB(vec3 c) { return vec3(fromSRGB1(c.r), fromSRGB1(c.g), fromSRGB1(c.b)); }

// ACEScct
float acescctEnc1(float x) { return x <= 0.0078125 ? 10.5402377416545 * x + 0.0729055341958355 : (log2(x) + 9.72) / 17.52; }
float acescctDec1(float v) { return v <= 0.155251141552511 ? (v - 0.0729055341958355) / 10.5402377416545 : exp2(v * 17.52 - 9.72); }
vec3 acescctEnc(vec3 c) { return vec3(acescctEnc1(c.r), acescctEnc1(c.g), acescctEnc1(c.b)); }
vec3 acescctDec(vec3 c) { return vec3(acescctDec1(c.r), acescctDec1(c.g), acescctDec1(c.b)); }

const mat3 SRGB_TO_ACESCG = mat3(0.6130974, 0.0701937, 0.0206156, 0.3395231, 0.9163539, 0.1095698, 0.0473795, 0.0134524, 0.8698151);
const mat3 ACESCG_TO_SRGB = mat3(1.7050515, -0.1302597, -0.0240033, -0.6217923, 1.1408027, -0.1289687, -0.0832593, -0.0105430, 1.1529720);

// Transfer functions by id: 0 linear, 1 sRGB, 2 gamma 2.4 (Rec.709 / BT.1886), 3 ACEScct
vec3 encodeTF(vec3 c, float tf) {
  if (tf < 0.5) return c;
  if (tf < 1.5) return toSRGB(c);
  if (tf < 2.5) return sign(c) * pow(abs(c), vec3(1.0 / 2.4));
  return acescctEnc(c);
}
vec3 decodeTF(vec3 e, float tf) {
  if (tf < 0.5) return e;
  if (tf < 1.5) return fromSRGB(e);
  if (tf < 2.5) return sign(e) * pow(abs(e), vec3(2.4));
  return acescctDec(e);
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Eight Lightroom-style colour bands (red, orange, yellow, green, aqua, blue, purple, magenta), degrees.
const float BAND_CENTERS[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0);
// Triangular weight of band i at a hue (degrees). Weights of all bands sum to 1.
float bandWeight(float hueDeg, int i) {
  float c = BAND_CENTERS[i];
  float prev = BAND_CENTERS[(i + 7) % 8];
  float next = BAND_CENTERS[(i + 1) % 8];
  float d = mod(hueDeg - c + 540.0, 360.0) - 180.0;
  float wl = mod(c - prev + 360.0, 360.0);
  float wr = mod(next - c + 360.0, 360.0);
  return d >= 0.0 ? clamp(1.0 - d / wr, 0.0, 1.0) : clamp(1.0 + d / wl, 0.0, 1.0);
}

// Curve lookup texture (Curves / Hue Curves nodes): one row per channel, 1024 samples.
uniform sampler2D u_curve;
const float CURVE_N = 1024.0;
float curveAt(float x, float row, float rows) {
  float xc = clamp(x, 0.0, 1.0);
  float v = texture(u_curve, vec2((xc * (CURVE_N - 1.0) + 0.5) / CURVE_N, (row + 0.5) / rows)).r;
  return v + (x - xc); // extend linearly outside 0–1 so HDR values aren't clipped
}

/* ---------------- hashing & noise ---------------- */

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
// Hash of an integer lattice point (given as float) → [0,1)³
vec3 hash33(vec3 cell) {
  uvec3 u = uvec3(ivec3(floor(cell)) + 1048576);
  return vec3(pcg3d(u)) * (1.0 / 4294967296.0);
}
// Hash of arbitrary float bits → [0,1)³ (white noise)
vec3 hashBits(vec3 p) { return vec3(pcg3d(floatBitsToUint(p))) * (1.0 / 4294967296.0); }

vec3 gradAt(vec3 c) { return normalize(hash33(c) * 2.0 - 1.0 + vec3(1e-4)); }
// 3D gradient (Perlin) noise, roughly -1..1
float gnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(gradAt(i), f);
  float n100 = dot(gradAt(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
  float n010 = dot(gradAt(i + vec3(0, 1, 0)), f - vec3(0, 1, 0));
  float n110 = dot(gradAt(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
  float n001 = dot(gradAt(i + vec3(0, 0, 1)), f - vec3(0, 0, 1));
  float n101 = dot(gradAt(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
  float n011 = dot(gradAt(i + vec3(0, 1, 1)), f - vec3(0, 1, 1));
  float n111 = dot(gradAt(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
  return 1.6 * mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
                   mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
// Fractal (fBm) noise in Blender style: detail = octaves (fractional), returns ~0..1
float fbm(vec3 p, float detail, float roughness, float lacunarity) {
  float amp = 1.0, freq = 1.0, sum = 0.0, maxAmp = 0.0;
  int n = int(floor(detail));
  for (int i = 0; i <= 15; i++) {
    if (i > n) break;
    sum += gnoise(p * freq) * amp;
    maxAmp += amp;
    amp *= clamp(roughness, 0.0, 1.0);
    freq *= lacunarity;
  }
  float rmd = detail - floor(detail);
  if (rmd > 0.001) {
    float t = gnoise(p * freq) * amp;
    float a = 0.5 + 0.5 * sum / maxAmp;
    float b = 0.5 + 0.5 * (sum + t) / (maxAmp + amp);
    return mix(a, b, rmd);
  }
  return 0.5 + 0.5 * sum / maxAmp;
}

/* ---------------- math (Blender Math node operations) ---------------- */

float safeDiv(float a, float b) { return b != 0.0 ? a / b : 0.0; }
float safePow(float a, float b) { return (a < 0.0 && b != floor(b)) ? 0.0 : pow(abs(a), b) * ((a < 0.0 && mod(b, 2.0) == 1.0) ? -1.0 : 1.0); }
float smin(float a, float b, float c) { if (c != 0.0) { float h = max(c - abs(a - b), 0.0) / c; return min(a, b) - h * h * h * c / 6.0; } return min(a, b); }
float wrapf(float v, float mx, float mn) { float r = mx - mn; return r != 0.0 ? v - r * floor((v - mn) / r) : mn; }

float mathOp(int op, float a, float b, float c) {
  switch (op) {
    case 0: return a + b;
    case 1: return a - b;
    case 2: return a * b;
    case 3: return safeDiv(a, b);
    case 4: return a * b + c;
    case 5: return safePow(a, b);
    case 6: return (a > 0.0 && b > 0.0 && b != 1.0) ? log(a) / log(b) : 0.0;
    case 7: return a > 0.0 ? sqrt(a) : 0.0;
    case 8: return a > 0.0 ? inversesqrt(a) : 0.0;
    case 9: return abs(a);
    case 10: return exp(a);
    case 11: return min(a, b);
    case 12: return max(a, b);
    case 13: return a < b ? 1.0 : 0.0;
    case 14: return a > b ? 1.0 : 0.0;
    case 15: return sign(a);
    case 16: return abs(a - b) <= max(c, 1e-5) ? 1.0 : 0.0;
    case 17: return smin(a, b, c);
    case 18: return -smin(-a, -b, c);
    case 19: return floor(a + 0.5);
    case 20: return floor(a);
    case 21: return ceil(a);
    case 22: return trunc(a);
    case 23: return a - floor(a);
    case 24: return b != 0.0 ? a - b * trunc(a / b) : 0.0;
    case 25: return b != 0.0 ? a - b * floor(a / b) : 0.0;
    case 26: return wrapf(a, b, c);
    case 27: return b != 0.0 ? floor(a / b) * b : 0.0;
    case 28: return b != 0.0 ? abs(fract((a - b) / (b * 2.0)) * b * 2.0 - b) : 0.0;
    case 29: return sin(a);
    case 30: return cos(a);
    case 31: return tan(a);
    case 32: return (a >= -1.0 && a <= 1.0) ? asin(a) : 0.0;
    case 33: return (a >= -1.0 && a <= 1.0) ? acos(a) : 0.0;
    case 34: return atan(a);
    case 35: return atan(a, b);
    case 36: return sinh(a);
    case 37: return cosh(a);
    case 38: return tanh(a);
    case 39: return radians(a);
    case 40: return degrees(a);
  }
  return 0.0;
}

/* ---------------- blend modes (Blender Mix node) ---------------- */

vec3 blendMix(int mode, float f, vec3 a, vec3 b) {
  float g = 1.0 - f;
  switch (mode) {
    case 0: return mix(a, b, f);
    case 1: return mix(a, min(a, b), f);
    case 2: return mix(a, a * b, f);
    case 3: { // colour burn
      vec3 o;
      for (int i = 0; i < 3; i++) { float t = g + f * b[i]; o[i] = t <= 0.0 ? 0.0 : clamp(1.0 - (1.0 - a[i]) / t, 0.0, 1.0); }
      return o;
    }
    case 4: return mix(a, max(a, b), f);
    case 5: return vec3(1.0) - (vec3(g) + f * (vec3(1.0) - b)) * (vec3(1.0) - a);
    case 6: { // colour dodge
      vec3 o;
      for (int i = 0; i < 3; i++) { if (a[i] == 0.0) { o[i] = 0.0; continue; } float t = 1.0 - f * b[i]; o[i] = t <= 0.0 ? 1.0 : min(a[i] / t, 1.0); }
      return o;
    }
    case 7: return a + b * f;
    case 8: { // overlay
      vec3 o;
      for (int i = 0; i < 3; i++) o[i] = a[i] < 0.5 ? a[i] * (g + 2.0 * f * b[i]) : 1.0 - (g + 2.0 * f * (1.0 - b[i])) * (1.0 - a[i]);
      return o;
    }
    case 9: { vec3 scr = vec3(1.0) - (vec3(1.0) - b) * (vec3(1.0) - a); return g * a + f * ((vec3(1.0) - a) * b * a + a * scr); }
    case 10: return a + f * (2.0 * b - 1.0);
    case 11: return mix(a, abs(a - b), f);
    case 12: return mix(a, max(a + b - 2.0 * a * b, 0.0), f);
    case 13: return a - b * f;
    case 14: return vec3(g) * a + f * vec3(safeDiv(a.r, b.r), safeDiv(a.g, b.g), safeDiv(a.b, b.b));
    case 15: { vec3 hb = rgb2hsv(max(b, 0.0)); if (hb.y == 0.0) return a; vec3 ha = rgb2hsv(max(a, 0.0)); ha.x = hb.x; return mix(a, hsv2rgb(ha), f); }
    case 16: { vec3 ha = rgb2hsv(max(a, 0.0)); if (ha.y == 0.0) return a; vec3 hb = rgb2hsv(max(b, 0.0)); ha.y = mix(ha.y, hb.y, f); return hsv2rgb(ha); }
    case 17: { vec3 hb = rgb2hsv(max(b, 0.0)); if (hb.y == 0.0) return a; vec3 ha = rgb2hsv(max(a, 0.0)); ha.x = hb.x; ha.y = hb.y; return mix(a, hsv2rgb(ha), f); }
    case 18: { vec3 ha = rgb2hsv(max(a, 0.0)); vec3 hb = rgb2hsv(max(b, 0.0)); ha.z = mix(ha.z, hb.z, f); return hsv2rgb(ha); }
  }
  return a;
}

/* ---------------- colour ramp ---------------- */

uniform int u_rn;
uniform float u_rpos[16];
uniform vec4 u_rcol[16];
uniform int u_rinterp; // 0 linear, 1 ease, 2 constant
vec4 rampEval(float t) {
  if (u_rn <= 0) return vec4(vec3(t), 1.0);
  if (t <= u_rpos[0]) return u_rcol[0];
  for (int i = 1; i < 16; i++) {
    if (i >= u_rn) break;
    if (t <= u_rpos[i]) {
      if (u_rinterp == 2) return u_rcol[i - 1];
      float span = u_rpos[i] - u_rpos[i - 1];
      float f = span > 0.0 ? (t - u_rpos[i - 1]) / span : 1.0;
      if (u_rinterp == 1) f = f * f * (3.0 - 2.0 * f);
      return mix(u_rcol[i - 1], u_rcol[i], f);
    }
  }
  return u_rcol[u_rn - 1];
}
`;
