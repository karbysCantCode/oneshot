import { useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { curveFn } from '../../nodes/curves';
import type { CurveChannel } from '../../nodes/registry';
import type { CurvePoint, Curves } from '../../types';

type Props = {
  channels: CurveChannel[];
  curves?: Curves;
  onChange: (channel: string, points: CurvePoint[]) => void;
};

const SIZE = 200;
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Curve editor.
 * Click empty space to add a point, drag points to move, double-click a point to delete.
 * "Reset" restores the active channel's default curve.
 */
export default function CurveEditor({ channels, curves, onChange }: Props) {
  const [active, setActive] = useState(channels[0].id);
  const ch = channels.find((c) => c.id === active) ?? channels[0];
  const points = curves?.[ch.id] ?? ch.defaults;
  const svgRef = useRef<SVGSVGElement>(null);
  const dragIndex = useRef<number | null>(null);

  const path = useMemo(() => {
    const f = curveFn(points, ch.periodic);
    let d = '';
    for (let i = 0; i <= 100; i++) {
      const x = i / 100;
      d += `${i ? 'L' : 'M'}${(x * SIZE).toFixed(1)},${((1 - clamp01(f(x))) * SIZE).toFixed(1)}`;
    }
    return d;
  }, [points, ch.periodic]);

  const toLocal = (e: RPointerEvent | RMouseEvent): CurvePoint => {
    const r = svgRef.current!.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01(1 - (e.clientY - r.top) / r.height)];
  };

  const update = (next: CurvePoint[]) => onChange(ch.id, next.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]));

  // Endpoints of tone curves keep their x position so the curve always spans 0–1.
  const isEndpoint = (i: number) => !ch.periodic && (i === 0 || i === points.length - 1);

  const onDown = (e: RPointerEvent) => {
    stop(e);
    if (e.button !== 0) return;
    svgRef.current!.setPointerCapture(e.pointerId);
    const [x, y] = toLocal(e);
    const r = svgRef.current!.getBoundingClientRect();
    const hit = points.findIndex(([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < 9);
    if (hit >= 0) {
      dragIndex.current = hit;
      return;
    }
    const next = [...points, [x, y] as CurvePoint].sort((a, b) => a[0] - b[0]);
    dragIndex.current = next.findIndex((p) => p[0] === x && p[1] === y);
    update(next);
  };

  const onMove = (e: RPointerEvent) => {
    const i = dragIndex.current;
    if (i === null || !(e.buttons & 1)) return;
    let [x, y] = toLocal(e);
    const next = points.map((p) => [...p] as CurvePoint);
    if (isEndpoint(i)) x = next[i][0];
    else {
      const lo = i > 0 ? next[i - 1][0] + 0.01 : 0;
      const hi = i < next.length - 1 ? next[i + 1][0] - 0.01 : 1;
      x = Math.min(hi, Math.max(lo, x));
    }
    next[i] = [x, y];
    update(next);
  };

  const onDouble = (e: RMouseEvent) => {
    stop(e);
    const [x, y] = toLocal(e);
    const r = svgRef.current!.getBoundingClientRect();
    const hit = points.findIndex(([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < 9);
    if (hit >= 0 && !isEndpoint(hit) && points.length > 2) update(points.filter((_, i) => i !== hit));
  };

  const isHue = ch.xAxis === 'hue';
  const many = channels.length > 4 || channels.some((c) => c.label.length > 3);

  return (
    <div className="curve-ctl nodrag nowheel">
      <div className={`curve-tabs ${many ? 'wrap' : ''}`}>
        {channels.map((c) => (
          <button
            key={c.id}
            className={c.id === ch.id ? 'on' : ''}
            style={{ color: c.color }}
            title={c.label}
            onPointerDown={stop}
            onClick={() => setActive(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className={`curve-box ${isHue ? 'hue' : 'tone'}`}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          preserveAspectRatio="none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => (dragIndex.current = null)}
          onDoubleClick={onDouble}
        >
          {[0.25, 0.5, 0.75].map((g) => (
            <g key={g} className="grid">
              <line x1={g * SIZE} y1={0} x2={g * SIZE} y2={SIZE} />
              <line x1={0} y1={g * SIZE} x2={SIZE} y2={g * SIZE} />
            </g>
          ))}
          {ch.periodic || ch.id === 'ls' ? (
            <line className="ref" x1={0} y1={SIZE / 2} x2={SIZE} y2={SIZE / 2} />
          ) : (
            <line className="ref" x1={0} y1={SIZE} x2={SIZE} y2={0} />
          )}
          <path d={path} stroke={ch.color} />
          {points.map(([x, y], i) => (
            <circle key={i} cx={x * SIZE} cy={(1 - y) * SIZE} r={5} />
          ))}
        </svg>
      </div>
      <div className="curve-foot">
        <small className="curve-help">Click: add · drag: move · double-click: delete</small>
        <button className="mini-btn" onPointerDown={stop} onClick={() => update(ch.defaults)} title="Reset this channel">
          Reset
        </button>
      </div>
    </div>
  );
}
