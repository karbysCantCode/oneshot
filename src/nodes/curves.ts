import type { CurvePoint } from '../types';

/** Samples per curve row in the GPU lookup texture. */
export const CURVE_RES = 1024;

const sortPoints = (pts: CurvePoint[]) =>
  [...pts]
    .map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] as CurvePoint)
    .sort((a, b) => a[0] - b[0])
    .filter((p, i, arr) => i === 0 || p[0] - arr[i - 1][0] > 1e-4);

const hermite = (y0: number, y1: number, m0: number, m1: number, h: number, t: number) => {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1;
};

function evalSegments(xs: number[], ys: number[], ms: number[], x: number) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i];
  return hermite(ys[i], ys[i + 1], ms[i], ms[i + 1], h, (x - xs[i]) / h);
}

/** Monotone cubic (Fritsch–Carlson) – no overshoot, standard for tone curves. */
export function monotoneCurve(points: CurvePoint[]): (x: number) => number {
  const p = sortPoints(points);
  if (p.length === 0) return (x) => x;
  if (p.length === 1) return () => p[0][1];
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  const n = p.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  return (x) => evalSegments(xs, ys, m, x);
}

/** Smooth periodic curve over 0–1 (hue curves): Catmull-Rom style Hermite with wrap-around. */
export function periodicCurve(points: CurvePoint[]): (x: number) => number {
  const p = sortPoints(points).filter((q) => q[0] < 1 - 1e-4);
  if (p.length === 0) return () => 0.5;
  if (p.length === 1) return () => p[0][1];
  const ext: CurvePoint[] = [
    ...p.slice(-2).map(([x, y]) => [x - 1, y] as CurvePoint),
    ...p,
    ...p.slice(0, 2).map(([x, y]) => [x + 1, y] as CurvePoint),
  ];
  const xs = ext.map((q) => q[0]);
  const ys = ext.map((q) => q[1]);
  const ms = xs.map((_, i) =>
    i === 0 || i === xs.length - 1 ? 0 : (ys[i + 1] - ys[i - 1]) / (xs[i + 1] - xs[i - 1]),
  );
  return (x) => evalSegments(xs, ys, ms, ((x % 1) + 1) % 1);
}

export const curveFn = (points: CurvePoint[], periodic: boolean) =>
  periodic ? periodicCurve(points) : monotoneCurve(points);

const cache = new Map<string, Float32Array>();

/**
 * Build the lookup-table rows for a set of curves (one row per channel).
 * This only samples the small user-drawn curve; the GPU applies it to the image.
 */
export function curveTable(rows: { points: CurvePoint[]; periodic: boolean }[]): { key: string; data: Float32Array } {
  const key = JSON.stringify(rows);
  let data = cache.get(key);
  if (!data) {
    data = new Float32Array(CURVE_RES * rows.length);
    rows.forEach((row, r) => {
      const f = curveFn(row.points, row.periodic);
      for (let i = 0; i < CURVE_RES; i++) data![r * CURVE_RES + i] = Math.min(1, Math.max(0, f(i / (CURVE_RES - 1))));
    });
    cache.set(key, data);
    if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  }
  return { key, data };
}
