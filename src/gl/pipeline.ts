import { COMMON_GLSL } from './glsl';
import { CURVE_RES } from '../nodes/curves';
import { getDef, type UniformValue } from '../nodes/registry';
import type { LutData, Params, ShaderKind } from '../types';

/* =====================================================================
 *  WebGL 2 pipeline
 *  - Source images are stored as SRGB8_ALPHA8 textures, so sampling them
 *    returns linear light (hardware sRGB decode).
 *  - Nodes run in linear light on RGBA16F targets (HDR headroom). If the GPU
 *    can't render to float, SRGB8_ALPHA8 targets are used instead.
 *  - A final display pass encodes to sRGB for the screen.
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
precision highp sampler3D;
in vec2 v_uv;
uniform sampler2D u_image;
out vec4 outColor;
`;

const nodeFragment = (body: string) => `${HEADER}${COMMON_GLSL}
${body}
void main() { outColor = effect(texture(u_image, v_uv)); }`;

const plainFragment = (main: string) => `${HEADER}${COMMON_GLSL}
${main}`;

/** Built-in passes. */
const BUILTIN: Record<string, string> = {
  copy: plainFragment(`void main() { outColor = texture(u_image, v_uv); }`),
  /** Sample an 8-bit sRGB-encoded (non-sRGB format) texture and output linear values. */
  copyDecode: plainFragment(`void main() { vec4 c = texture(u_image, v_uv); outColor = vec4(fromSRGB(c.rgb), c.a); }`),
  /** Linear → display sRGB (8-bit canvas). */
  display: plainFragment(`void main() { vec4 c = texture(u_image, v_uv); outColor = vec4(toSRGB(clamp(c.rgb, 0.0, 1.0)), clamp(c.a, 0.0, 1.0)); }`),

  /* --- image statistics (Auto Exposure / Auto Levels) ---
   * r = min luminance, g = max luminance (both stored as l/(1+l)),
   * b = mean log2 luminance mapped to 0–1. Early passes average blocks so isolated
   * hot/dead pixels don't decide the black/white points. */
  statsInit: plainFragment(`uniform ivec2 u_srcSize;
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
  statsAvg: plainFragment(`uniform ivec2 u_srcSize;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  vec4 a = vec4(0.0);
  for (int i = 0; i < 4; i++) a += texelFetch(u_image, min(p + ivec2(i % 2, i / 2), u_srcSize - 1), 0);
  outColor = a * 0.25;
}`),
  statsMinMax: plainFragment(`uniform ivec2 u_srcSize;
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

/** Texture units. Fixed per sampler name so 2D and 3D samplers never share a unit. */
const UNIT = { u_image: 0, u_curve: 1, u_lut: 2, u_stats: 3 } as const;

/** Blocks are averaged until the stats image is at most this size, then min/max reduced. */
const STATS_AVG_UNTIL = 64;

export type Op = {
  kind: ShaderKind;
  params: Params;
  /** Curve lookup rows (Curves / Hue Curves). */
  curve?: { key: string; data: Float32Array; rows: number };
  lut?: LutData | null;
  /** Change signature – identical signatures render identically. */
  sig: string;
};

type Format = 'srgb8' | 'rgba16f' | 'rgba8';
type Entry = { tex: WebGLTexture; w: number; h: number; bytes: number };
type Target = { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number };
type Program = { prog: WebGLProgram; locs: Map<string, WebGLUniformLocation | null> };

export class WebGLPipeline {
  readonly canvas: HTMLCanvasElement;
  readonly maxTextureSize: number;
  /** True when intermediate results are 16-bit float (HDR headroom, no banding). */
  readonly floatTargets: boolean;
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private programs = new Map<string, Program | null>();
  private cache = new Map<string, Entry>();
  private cacheBytes = 0;
  private targets = new Map<string, Target[]>();
  private statsChains = new Map<string, Target[]>();
  private curveTextures = new Map<string, WebGLTexture>();
  private lutTextures = new Map<string, WebGLTexture>();
  private budgetBytes: number;

  constructor(budgetBytes = 768 * 1024 * 1024) {
    this.budgetBytes = budgetBytes;
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
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
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // Built-ins must compile – fail loudly if they don't.
    for (const name of Object.keys(BUILTIN)) {
      if (!this.program(name)) throw new Error(`Built-in shader "${name}" failed to compile – see console`);
    }
  }

  /* ---------------- public API ---------------- */

  /**
   * Get (or create) a GPU texture for an image, no larger than maxSize on its longest edge.
   * Returns the cache key to pass to render().
   */
  source(id: string, image: HTMLImageElement, maxSize = Infinity): string {
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
      // GPU downscale: full-res mipmapped upload → render into a smaller sRGB texture → drop full-res copy.
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

  /** Run the node chain on a cached source texture. The result is left in this.canvas. */
  render(key: string, ops: Op[]) {
    const src = this.cache.get(key);
    if (!src) return false;
    const gl = this.gl;
    const { w, h } = src;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;

    const effects = ops.filter((o) => getDef(o.kind)?.glsl);
    let input = src.tex;

    if (effects.length) {
      const targets = this.targetsFor(w, h);
      let idx = 0;
      for (const op of effects) {
        const def = getDef(op.kind)!;
        const prog = this.program(op.kind);
        if (!prog) continue; // shader failed to compile – pass through

        const stats = def.stats ? this.computeStats(input, w, h) : null;

        gl.bindFramebuffer(gl.FRAMEBUFFER, targets[idx].fb);
        gl.viewport(0, 0, w, h);
        gl.useProgram(prog.prog);
        this.bindTexture(UNIT.u_image, gl.TEXTURE_2D, input);
        if (op.curve) this.bindTexture(UNIT.u_curve, gl.TEXTURE_2D, this.curveTexture(op.curve));
        if (def.lut) {
          const lut = op.lut ?? null;
          this.bindTexture(UNIT.u_lut, gl.TEXTURE_3D, lut ? this.lutTexture(lut) : null);
          this.set(prog, 'u_has', lut ? 1 : 0);
          if (lut) {
            this.set(prog, 'u_size', lut.size);
            this.set(prog, 'u_dmin', lut.domainMin);
            this.set(prog, 'u_dmax', lut.domainMax);
          }
        }
        if (stats) this.bindTexture(UNIT.u_stats, gl.TEXTURE_2D, stats);

        const uniforms = def.uniforms?.(op.params) ?? {};
        for (const [name, value] of Object.entries(uniforms)) this.set(prog, name, value);
        this.drawQuad();

        input = targets[idx].tex;
        idx = 1 - idx;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    this.runPass('display', input);
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

  /* ---------------- programs & uniforms ---------------- */

  private program(name: string): Program | null {
    if (this.programs.has(name)) return this.programs.get(name)!;
    const gl = this.gl;
    let result: Program | null = null;
    try {
      const src = BUILTIN[name] ?? (getDef(name)?.glsl ? nodeFragment(getDef(name)!.glsl!) : null);
      if (!src) throw new Error(`Unknown node "${name}"`);
      const prog = gl.createProgram()!;
      gl.attachShader(prog, this.compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, this.compile(gl.FRAGMENT_SHADER, src));
      gl.bindAttribLocation(prog, 0, 'a_pos');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
      result = { prog, locs: new Map() };
      // Fixed texture units for every sampler the program uses.
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
    else gl.uniform1fv(loc, v.fv);
  }

  private bindTexture(unit: number, target: number, tex: WebGLTexture | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
  }

  private drawQuad() {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
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
    this.drawQuad();
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

  /** Ping-pong render targets per size (a few sizes kept so grids with mixed aspect ratios don't thrash). */
  private targetsFor(w: number, h: number) {
    const key = `${w}x${h}`;
    const hit = this.targets.get(key);
    if (hit) {
      this.targets.delete(key);
      this.targets.set(key, hit);
      return hit;
    }
    const format: Format = this.floatTargets ? 'rgba16f' : 'srgb8';
    const pair = [this.makeTarget(w, h, format), this.makeTarget(w, h, format)];
    this.targets.set(key, pair);
    while (this.targets.size > 4) {
      const old = this.targets.keys().next().value as string;
      this.freeTargets(this.targets.get(old)!);
      this.targets.delete(old);
    }
    return pair;
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

  private curveTexture(curve: NonNullable<Op['curve']>) {
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

  private evict(keep: string) {
    for (const [key, entry] of this.cache) {
      if (this.cacheBytes <= this.budgetBytes) break;
      if (key === keep) continue;
      this.gl.deleteTexture(entry.tex);
      this.cache.delete(key);
      this.cacheBytes -= entry.bytes;
    }
  }
}
