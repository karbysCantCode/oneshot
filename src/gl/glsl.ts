/** GLSL helpers included in every node shader. Working space: linear sRGB / Rec.709 primaries. */
export const COMMON_GLSL = /* glsl */ `
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
`;
