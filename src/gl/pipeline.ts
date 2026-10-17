import { COMMON_GLSL } from './glsl';
import { CURVE_RES } from '../nodes/curves';
import { hexToLinear } from '../nodes/colour';
import { defSockets, getDef, type UniformValue } from '../nodes/registry';
import type { Plan, Ref, Step } from '../nodes/graph';
import type { LutData, Ramp } from '../types';

/* =====================================================================
 *  WebGL 2 pipeline – evaluates a node DAG on the GPU.
 *  - Source images: SRGB8_ALPHA8 textures → sampling returns linear light.
 *  - Every node output is a full-size RGBA16F texture (8-bit sRGB fallback).
 *    Float sockets are stored as (v, v, v, 1); conversions are implicit.
 *  - Intermediate textures come from a pool and are released as soon as
 *    their last consumer has run.
 *  - A final pass encodes to sRGB for display.
 * ===================================================================== */

const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
in vec2 v_uv;
out vec4 outColor;
`;

const MAX_INPUTS = 8;

/** Texture units (fixed per sampler name). */
const UNIT: Record<string, number> = { u_image: 0, u_prev: 8, u_curve: 9, u_lut: 10, u_stats: 11 };
for (let i = 0; i < MAX_INPUTS; i++) UNIT[`u_in${i}`] = i;

/** Shader source for a node kind: socket accessors + node GLSL + main. */
function nodeSource(kind: string): string | null {
  const def = getDef(kind);
  if (!def?.glsl) return null;
  const { inputs, outputs } = defSockets(kind);
  const access = inputs
    .map((s, i) => `uniform sampler2D u_in${i}; uniform float u_has${i}; uniform vec4 u_def${i};
vec4 c_${s.id}(vec2 uv) { return u_has${i} > 0.5 ? texture(u_in${i}, uv) : u_def${i}; }
float f_${s.id}(vec2 uv) { return u_has${i} > 0.5 ? luma(texture(u_in${i}, uv).rgb) : u_def${i}.x; }
bool has_${s.id}() { return u_has${i} > 0.5; }`)
    .join('\n');
  const effect = (def.style ?? 'effect') === 'effect';
  const floatOut = outputs.map((o) => (o.type === 'float' ? 'true' : 'false'));
  return `${HEADER}
uniform int u_out; uniform int u_pass; uniform sampler2D u_prev;
uniform vec2 u_texel; uniform vec2 u_size; uniform float u_scale; uniform float u_aspect; uniform vec2 u_fullSize;
${COMMON_GLSL}
${access}
${def.glsl}
${effect ? 'vec4 run(vec2 uv) { return effect(c_image(uv)); }' : ''}
const bool FLOAT_OUT[${Math.max(1, floatOut.length)}] = bool[${Math.max(1, floatOut.length)}](${floatOut.length ? floatOut.join(', ') : 'false'});
void main() {
  vec4 r = run(v_uv);
  outColor = FLOAT_OUT[clamp(u_out, 0, ${Math.max(0, floatOut.length - 1)})] ? vec4(vec3(r.x), 1.0) : r;
}`;
}

const plain = (main: string) => `${HEADER}uniform sampler2D u_image;
${COMMON_GLSL}
${main}`;

/** Built-in passes. */
const BUILTIN: Record<string, string> = {
  /** Sample an 8-bit sRGB-encoded (non-sRGB format) texture and output linear values. */
  copyDecode: plain(`void main() { vec4 c = texture(u_image, v_uv); outColor = vec4(fromSRGB(c.rgb), c.a); }`),
  /** Linear → display sRGB (8-bit canvas). */
  display: plain(`void main() { vec4 c = texture(u_image, v_uv); outColor = vec4(toSRGB(clamp(c.rgb, 0.0, 1.0)), clamp(c.a, 0.0, 1.0)); }`),
  /* Image statistics (Auto Exposure / Auto Levels): r = min lum, g = max lum (l/(1+l)), b = mean log2 lum mapped to 0–1. */
  statsInit: plain(`uniform ivec2 u_srcSize;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  float s = 0.0, lg = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 q = min(p + ivec2(i % 2, i / 2), u_srcSize - 1);
    float l = max(luma(texelFetch(u_image, q, 0).rgb), 0.0);
    s += l; lg += log2(l + 1e-5);
  }
  float l = s * 0.25; float enc = l / (1.0 + l);
  outColor = vec4(enc, enc, clamp((lg * 0.25 + 17.0) / 20.0, 0.0, 1.0), 1.0);
}`),
  statsAvg: plain(`uniform ivec2 u_srcSize;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  vec4 a = vec4(0.0);
  for (int i = 0; i < 4; i++) a += texelFetch(u_image, min(p + ivec2(i % 2, i / 2), u_srcSize - 1), 0);
  outColor = a * 0.25;
}`),
  statsMinMax: plain(`uniform ivec2 u_srcSize;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  vec4 o = vec4(1.0, 0.0, 0.0, 1.0);
  for (int i = 0; i < 4; i++) {
    vec4 t = texelFetch(u_image, min(p + ivec2(i % 2, i / 2), u_srcSize - 1), 0);
    o.r = min(o.r, t.r); o.g = max(o.g, t.g); o.b += t.b * 0.25;
  }
  outColor = o;
}`),
};

/** Blocks are averaged until the stats image is at most this size, then min/max reduced. */
const STATS_AVG_UNTIL = 64;

/** What is being rendered: a media image, or the procedural canvas (image = null). */
export type RenderItem = { id: string; image: HTMLImageElement | null; width: number; height: number };

export type RenderContext = {
  item: RenderItem;
  /** Longest output edge in px. */
  maxSize: number;
  /** Lookup for Image Inputs pointing at specific Media Pool images. */
  media: (id: string) => RenderItem | null;
  /** 3D LUT per original node id. */
  luts: Map<string, LutData>;
};

type Format = 'srgb8' | 'rgba16f' | 'rgba8';
type Entry = { tex: WebGLTexture; w: number; h: number; bytes: number };
type Target = { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number };
type Program = { prog: WebGLProgram; locs: Map<string, WebGLUniformLocation | null> };
type Tex = { tex: WebGLTexture; w: number; h: number; target?: Target };

export class WebGLPipeline {
  readonly canvas: HTMLCanvasElement;
  readonly maxTextureSize: number;
  /** True when intermediate results are 16-bit float (HDR headroom, negative values, no banding). */
  readonly floatTargets: boolean;
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private programs = new Map<string, Program | null>();
  private cache = new Map<string, Entry>();
  private cacheBytes = 0;
  private pinned = new Set<string>();
  private pool = new Map<string, Target[]>();
  private statsChains = new Map<string, Target[]>();
  private curveTextures = new Map<string, WebGLTexture>();
  private lutTextures = new Map<string, WebGLTexture>();
  private black: WebGLTexture;
  private budgetBytes: number;

  constructor(budgetBytes = 768 * 1024 * 1024) {
    this.budgetBytes = budgetBytes;
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL 2 is unavailable. Enable hardware acceleration or use a current browser.');
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float') && this.canRender('rgba16f');

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    this.black = this.newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

    for (const name of Object.keys(BUILTIN)) {
      if (!this.program(name)) throw new Error(`Built-in shader "${name}" failed to compile – see console`);
    }
  }

  /** Compile every node shader now (returns kinds that failed). Optional – shaders also compile lazily. */
  warmUp(kinds: string[]) {
    return kinds.filter((k) => getDef(k)?.glsl && !this.program(k));
  }

  /** Free every GPU texture cached for a media item (after it is deleted). */
  forget(id: string) {
    for (const [key, entry] of this.cache) {
      if (!key.startsWith(`${id}@`)) continue;
      this.gl.deleteTexture(entry.tex);
      this.cache.delete(key);
      this.cacheBytes -= entry.bytes;
    }
  }

  /** Output size for an item at a maximum edge length. */
  outputSize(item: RenderItem, maxSize: number) {
    const limit = Math.min(maxSize, this.maxTextureSize);
    const s = Math.min(1, limit / Math.max(item.width, item.height));
    return { w: Math.max(1, Math.round(item.width * s)), h: Math.max(1, Math.round(item.height * s)) };
  }

  /**
   * Evaluate a plan. Returns false if there is nothing to show (plan has no target).
   * The result is left in this.canvas (sRGB, ready for present()).
   */
  render(plan: Plan, ctx: RenderContext) {
    if (!plan.target) return false;
    const gl = this.gl;
    const { w, h } = this.outputSize(ctx.item, ctx.maxSize);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.pinned.clear();

    // Consumers per output, to release textures early.
    const refKey = (r: Ref) => `${r.node}#${r.out}`;
    const remaining = new Map<string, number>();
    const count = (r: Ref | null) => r && remaining.set(refKey(r), (remaining.get(refKey(r)) ?? 0) + 1);
    plan.steps.forEach((s) => s.inputs.forEach(count));
    count(plan.target);

    const results = new Map<string, Tex>();
    const release = (r: Ref | null) => {
      if (!r) return;
      const k = refKey(r);
      const left = (remaining.get(k) ?? 1) - 1;
      remaining.set(k, left);
      if (left <= 0) {
        const t = results.get(k);
        if (t?.target) this.releaseTarget(t.target);
        results.delete(k);
      }
    };

    const ctxScale = w / ctx.item.width;

    for (const step of plan.steps) {
      if (step.kind === 'input' || step.kind === 'folder') {
        const m = String(step.params.media ?? '');
        const src = step.kind === 'input' && m ? ctx.media(m) : ctx.item;
        results.set(`${step.id}#0`, this.sourceTex(src, ctx.maxSize));
      } else if (getDef(step.kind)?.glsl) {
        for (const o of step.outs) results.set(`${step.id}#${o}`, this.runStep(step, o, results, w, h, ctxScale, ctx));
      }
      step.inputs.forEach(release);
    }

    const final = results.get(refKey(plan.target));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    this.runPass('display', final?.tex ?? this.black);
    release(plan.target);
    for (const t of results.values()) if (t.target) this.releaseTarget(t.target);
    this.trimPool(`${w}x${h}`);
    this.pinned.clear();
    return true;
  }

  /** Copy the last rendered frame into a 2D canvas for display (a plain copy, no pixel processing). */
  present(target: HTMLCanvasElement) {
    if (target.width !== this.canvas.width) target.width = this.canvas.width;
    if (target.height !== this.canvas.height) target.height = this.canvas.height;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(this.canvas, 0, 0);
  }

  /* ---------------- node execution ---------------- */

  private runStep(step: Step, out: number, results: Map<string, Tex>, w: number, h: number, scale: number, ctx: RenderContext): Tex {
    const gl = this.gl;
    const def = getDef(step.kind)!;
    const prog = this.program(step.kind);
    if (!prog) {
      // Shader failed: pass input 0 through (or black).
      const r = step.inputs[0];
      const t = r ? results.get(`${r.node}#${r.out}`) : undefined;
      const target = this.acquire(w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, w, h);
      this.runPass('copyPass', t?.tex ?? this.black);
      return { tex: target.tex, w, h, target };
    }

    const { inputs } = defSockets(step.kind);
    const passes = def.passes ?? 1;
    const stats = def.stats ? this.inputStats(step, results) : null;
    const uniforms = def.uniforms?.(step.params) ?? {};
    let prev: Target | null = null;

    for (let pass = 0; pass < passes; pass++) {
      const target = this.acquire(w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog.prog);

      inputs.forEach((s, i) => {
        const r = step.inputs[i];
        const t = r ? results.get(`${r.node}#${r.out}`) : undefined;
        this.bindTexture(i, gl.TEXTURE_2D, t?.tex ?? this.black);
        this.set(prog, `u_has${i}`, t ? 1 : 0);
        this.set(prog, `u_def${i}`, this.inlineValue(s, step.params[`in_${s.id}`]));
      });
      this.bindTexture(UNIT.u_prev, gl.TEXTURE_2D, prev?.tex ?? this.black);
      this.set(prog, 'u_out', { i: out });
      this.set(prog, 'u_pass', { i: pass });
      this.set(prog, 'u_texel', [1 / w, 1 / h]);
      this.set(prog, 'u_size', [w, h]);
      this.set(prog, 'u_scale', scale);
      this.set(prog, 'u_aspect', w / h);
      this.set(prog, 'u_fullSize', [ctx.item.width, ctx.item.height]);

      if (step.curve) this.bindTexture(UNIT.u_curve, gl.TEXTURE_2D, this.curveTexture(step.curve));
      if (def.lut) {
        const lut = ctx.luts.get(step.rawId) ?? null;
        this.bindTexture(UNIT.u_lut, gl.TEXTURE_3D, lut ? this.lutTexture(lut) : null);
        this.set(prog, 'u_has', lut ? 1 : 0);
        if (lut) {
          this.set(prog, 'u_lsize', lut.size);
          this.set(prog, 'u_dmin', lut.domainMin);
          this.set(prog, 'u_dmax', lut.domainMax);
        }
      }
      if (stats) this.bindTexture(UNIT.u_stats, gl.TEXTURE_2D, stats);
      if (def.ramp) this.setRamp(prog, step.ramp);
      for (const [name, value] of Object.entries(uniforms)) this.set(prog, name, value);

      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (prev) this.releaseTarget(prev);
      prev = target;
    }
    return { tex: prev!.tex, w, h, target: prev! };
  }

  private inlineValue(s: { type: string; default?: number | string }, v: unknown): number[] {
    const value = v ?? s.default;
    if (s.type === 'float') {
      const x = Number(value ?? 0);
      return [x, x, x, 1];
    }
    if (typeof value === 'string') return [...hexToLinear(value), 1];
    return [0, 0, 0, 1];
  }

  private setRamp(p: Program, ramp?: Ramp) {
    const stops = [...(ramp?.stops ?? [])].sort((a, b) => a.pos - b.pos).slice(0, 16);
    const pos = new Array(16).fill(1);
    const cols = new Array(64).fill(0);
    stops.forEach((s, i) => {
      pos[i] = s.pos;
      const c = hexToLinear(s.color);
      cols.splice(i * 4, 4, c[0], c[1], c[2], s.alpha ?? 1);
    });
    this.set(p, 'u_rn', { i: stops.length });
    this.set(p, 'u_rpos', { fv: pos });
    this.set(p, 'u_rcol', { v4: cols });
    this.set(p, 'u_rinterp', { i: ['linear', 'ease', 'constant'].indexOf(ramp?.interp ?? 'linear') });
  }

  /* ---------------- sources ---------------- */

  private sourceTex(item: RenderItem | null, maxSize: number): Tex {
    if (!item?.image) return { tex: this.black, w: 1, h: 1 };
    const key = this.source(item.id, item.image, maxSize);
    this.pinned.add(key);
    const e = this.cache.get(key)!;
    return { tex: e.tex, w: e.w, h: e.h };
  }

  /** Get (or create) a GPU texture for an image, no larger than maxSize on its longest edge. */
  private source(id: string, image: HTMLImageElement, maxSize = Infinity): string {
    const gl = this.gl;
    const fullW = image.naturalWidth;
    const fullH = image.naturalHeight;
    const limit = Math.min(maxSize, this.maxTextureSize);
    const scale = Math.min(1, limit / Math.max(fullW, fullH));
    const w = Math.max(1, Math.round(fullW * scale));
    const h = Math.max(1, Math.round(fullH * scale));
    const key = `${id}@${w}x${h}`;

    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return key;
    }

    let tex: WebGLTexture;
    if (scale === 1) {
      tex = this.uploadImage(image, 'srgb8', false);
    } else if (Math.max(fullW, fullH) <= this.maxTextureSize) {
      // GPU downscale: full-res mipmapped upload → render into a smaller sRGB texture → drop the full-res copy.
      const full = this.uploadImage(image, 'rgba8', true);
      tex = this.allocate(w, h, 'srgb8');
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      this.runPass('copyDecode', full);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(full);
    } else {
      // Larger than this GPU's max texture size: the browser resamples during upload.
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d')!.drawImage(image, 0, 0, w, h);
      tex = this.uploadImage(c, 'srgb8', false);
    }

    const entry = { tex, w, h, bytes: w * h * 4 };
    this.cache.set(key, entry);
    this.cacheBytes += entry.bytes;
    this.evict(key);
    return key;
  }

  private evict(keep: string) {
    for (const [key, entry] of this.cache) {
      if (this.cacheBytes <= this.budgetBytes) break;
      if (key === keep || this.pinned.has(key)) continue;
      this.gl.deleteTexture(entry.tex);
      this.cache.delete(key);
      this.cacheBytes -= entry.bytes;
    }
  }

  /* ---------------- programs & uniforms ---------------- */

  private program(name: string): Program | null {
    if (this.programs.has(name)) return this.programs.get(name)!;
    const gl = this.gl;
    let result: Program | null = null;
    try {
      const src = name === 'copyPass' ? plain(`void main() { outColor = texture(u_image, v_uv); }`) : BUILTIN[name] ?? nodeSource(name);
      if (!src) throw new Error(`Unknown node "${name}"`);
      const prog = gl.createProgram()!;
      gl.attachShader(prog, this.compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, this.compile(gl.FRAGMENT_SHADER, src));
      gl.bindAttribLocation(prog, 0, 'a_pos');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
      result = { prog, locs: new Map() };
      gl.useProgram(prog);
      for (const [sampler, unit] of Object.entries(UNIT)) {
        const loc = gl.getUniformLocation(prog, sampler);
        if (loc) gl.uniform1i(loc, unit);
      }
    } catch (e) {
      console.error(`[NodeGL] shader "${name}" failed:`, e);
    }
    this.programs.set(name, result);
    return result;
  }

  private compile(type: number, src: string) {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'compile failed');
    return s;
  }

  private loc(p: Program, name: string) {
    if (!p.locs.has(name)) p.locs.set(name, this.gl.getUniformLocation(p.prog, name));
    return p.locs.get(name)!;
  }

  private set(p: Program, name: string, v: UniformValue) {
    const gl = this.gl;
    const loc = this.loc(p, name);
    if (!loc) return; // unused by this shader
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (Array.isArray(v)) {
      if (v.length === 2) gl.uniform2fv(loc, v);
      else if (v.length === 3) gl.uniform3fv(loc, v);
      else if (v.length === 4) gl.uniform4fv(loc, v);
      else gl.uniform1fv(loc, v);
    } else if ('m3' in v) gl.uniformMatrix3fv(loc, true, v.m3);
    else if ('fv' in v) gl.uniform1fv(loc, v.fv);
    else if ('v4' in v) gl.uniform4fv(loc, v.v4);
    else gl.uniform1i(loc, v.i);
  }

  private bindTexture(unit: number, target: number, tex: WebGLTexture | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
  }

  /** Run a built-in pass into the currently bound framebuffer. */
  private runPass(name: string, input: WebGLTexture, ints?: Record<string, [number, number]>) {
    const gl = this.gl;
    const p = this.program(name)!;
    gl.useProgram(p.prog);
    this.bindTexture(UNIT.u_image, gl.TEXTURE_2D, input);
    if (ints) for (const [k, v] of Object.entries(ints)) {
      const loc = this.loc(p, k);
      if (loc) gl.uniform2i(loc, v[0], v[1]);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /* ---------------- textures ---------------- */

  private formatInfo(f: Format) {
    const gl = this.gl;
    if (f === 'srgb8') return { internal: gl.SRGB8_ALPHA8, type: gl.UNSIGNED_BYTE };
    if (f === 'rgba16f') return { internal: gl.RGBA16F, type: gl.HALF_FLOAT };
    return { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
  }

  private newTexture(target: number = this.gl.TEXTURE_2D, mipmaps = false) {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(target, t);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return t;
  }

  private uploadImage(source: TexImageSource, format: 'srgb8' | 'rgba8', mipmaps: boolean) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    const t = this.newTexture(gl.TEXTURE_2D, mipmaps);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.formatInfo(format).internal, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }

  private allocate(w: number, h: number, format: Format) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    const t = this.newTexture();
    const { internal, type } = this.formatInfo(format);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    return t;
  }

  private canRender(format: Format) {
    const gl = this.gl;
    const tex = this.allocate(4, 4, format);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    return ok;
  }

  private makeTarget(w: number, h: number, format: Format): Target {
    const gl = this.gl;
    const tex = this.allocate(w, h, format);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  private freeTargets(list: Target[]) {
    list.forEach((t) => {
      this.gl.deleteTexture(t.tex);
      this.gl.deleteFramebuffer(t.fb);
    });
  }

  /** Get a render target from the pool. */
  private acquire(w: number, h: number): Target {
    const key = `${w}x${h}`;
    const free = this.pool.get(key);
    if (free?.length) return free.pop()!;
    return this.makeTarget(w, h, this.floatTargets ? 'rgba16f' : 'srgb8');
  }

  private releaseTarget(t: Target) {
    const key = `${t.w}x${t.h}`;
    const free = this.pool.get(key) ?? [];
    if (!free.includes(t)) free.push(t);
    this.pool.delete(key); // move to most-recent position
    this.pool.set(key, free);
  }

  /** Keep pooled targets for a few recent sizes only. */
  private trimPool(current: string) {
    const free = this.pool.get(current);
    if (free && free.length > 12) this.freeTargets(free.splice(12));
    while (this.pool.size > 4) {
      const old = this.pool.keys().next().value as string;
      if (old === current) break;
      this.freeTargets(this.pool.get(old)!);
      this.pool.delete(old);
    }
  }

  /** GPU statistics of a step's first input. */
  private inputStats(step: Step, results: Map<string, Tex>) {
    const r = step.inputs[0];
    const t = r ? results.get(`${r.node}#${r.out}`) : undefined;
    if (!t) return this.black;
    return this.computeStats(t.tex, t.w, t.h);
  }

  /** GPU reduction of `input` (w×h) to a 1×1 statistics texture. */
  private computeStats(input: WebGLTexture, w: number, h: number) {
    const gl = this.gl;
    const key = `${w}x${h}`;
    let chain = this.statsChains.get(key);
    if (!chain) {
      chain = [];
      const format: Format = this.floatTargets ? 'rgba16f' : 'rgba8';
      let cw = w, ch = h;
      do {
        cw = Math.max(1, Math.ceil(cw / 2));
        ch = Math.max(1, Math.ceil(ch / 2));
        chain.push(this.makeTarget(cw, ch, format));
      } while (cw > 1 || ch > 1);
      this.statsChains.set(key, chain);
      while (this.statsChains.size > 4) {
        const old = this.statsChains.keys().next().value as string;
        this.freeTargets(this.statsChains.get(old)!);
        this.statsChains.delete(old);
      }
    }
    let src = input, sw = w, sh = h;
    chain.forEach((t, i) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.viewport(0, 0, t.w, t.h);
      const pass = i === 0 ? 'statsInit' : Math.max(sw, sh) > STATS_AVG_UNTIL ? 'statsAvg' : 'statsMinMax';
      this.runPass(pass, src, { u_srcSize: [sw, sh] });
      src = t.tex;
      sw = t.w;
      sh = t.h;
    });
    return chain[chain.length - 1].tex;
  }

  private curveTexture(curve: NonNullable<Step['curve']>) {
    const hit = this.curveTextures.get(curve.key);
    if (hit) return hit;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + UNIT.u_curve);
    const t = this.newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, CURVE_RES, curve.rows, 0, gl.RED, gl.FLOAT, curve.data);
    this.curveTextures.set(curve.key, t);
    while (this.curveTextures.size > 32) {
      const old = this.curveTextures.keys().next().value as string;
      gl.deleteTexture(this.curveTextures.get(old)!);
      this.curveTextures.delete(old);
    }
    return t;
  }

  private lutTexture(lut: LutData) {
    const hit = this.lutTextures.get(lut.id);
    if (hit) return hit;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + UNIT.u_lut);
    const t = this.newTexture(gl.TEXTURE_3D);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.FLOAT, lut.data);
    this.lutTextures.set(lut.id, t);
    while (this.lutTextures.size > 8) {
      const old = this.lutTextures.keys().next().value as string;
      gl.deleteTexture(this.lutTextures.get(old)!);
      this.lutTextures.delete(old);
    }
    return t;
  }
}
