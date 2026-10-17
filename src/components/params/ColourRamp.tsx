import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Ramp, RampStop } from '../../types';

type Props = { ramp: Ramp; onChange: (ramp: Ramp) => void };

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const MAX_STOPS = 16;

const hexToRgb = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Colour of the ramp at t (display preview only). */
function colourAt(stops: RampStop[], t: number): string {
  const s = [...stops].sort((a, b) => a.pos - b.pos);
  if (t <= s[0].pos) return s[0].color;
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i].pos) {
      const f = (t - s[i - 1].pos) / Math.max(s[i].pos - s[i - 1].pos, 1e-6);
      const a = hexToRgb(s[i - 1].color), b = hexToRgb(s[i].color);
      return rgbToHex(a.map((v, k) => v + (b[k] - v) * f));
    }
  }
  return s[s.length - 1].color;
}

/** Colour Ramp editor: click the bar to add a stop, drag stops, select one to edit its colour. */
export default function ColourRamp({ ramp, onChange }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const dragging = useRef<number | null>(null);
  const stops = ramp.stops;
  const sel = Math.min(selected, stops.length - 1);

  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  const gradient =
    ramp.interp === 'constant'
      ? sorted.map((s, i) => `${s.color} ${s.pos * 100}% ${(sorted[i + 1]?.pos ?? 1) * 100}%`).join(', ')
      : sorted.map((s) => `${s.color} ${s.pos * 100}%`).join(', ');

  const setStops = (next: RampStop[]) => onChange({ ...ramp, stops: next });
  const posFromEvent = (e: RPointerEvent) => {
    const r = barRef.current!.getBoundingClientRect();
    return clamp01((e.clientX - r.left) / r.width);
  };

  return (
    <div className="ramp-ctl nodrag nowheel">
      <div className="ramp-row">
        <select
          value={ramp.interp}
          onPointerDown={stop}
          onChange={(e) => onChange({ ...ramp, interp: e.target.value as Ramp['interp'] })}
        >
          <option value="linear">Linear</option>
          <option value="ease">Ease</option>
          <option value="constant">Constant</option>
        </select>
        <button
          className="mini-btn"
          disabled={stops.length >= MAX_STOPS}
          onPointerDown={stop}
          onClick={() => {
            const a = sorted[0], b = sorted[1] ?? sorted[0];
            const pos = (a.pos + b.pos) / 2;
            setStops([...stops, { pos, color: colourAt(stops, pos), alpha: 1 }]);
            setSelected(stops.length);
          }}
          title="Add stop"
        >
          +
        </button>
        <button
          className="mini-btn"
          disabled={stops.length <= 1}
          onPointerDown={stop}
          onClick={() => {
            setStops(stops.filter((_, i) => i !== sel));
            setSelected(0);
          }}
          title="Delete selected stop"
        >
          −
        </button>
      </div>
      <div
        ref={barRef}
        className="ramp-bar"
        style={{ background: `linear-gradient(90deg, ${gradient})` }}
        onPointerDown={(e) => {
          stop(e);
          if (stops.length >= MAX_STOPS) return;
          const pos = posFromEvent(e);
          setStops([...stops, { pos, color: colourAt(stops, pos), alpha: 1 }]);
          setSelected(stops.length);
        }}
        title="Click to add a stop"
      />
      <div
        className="ramp-stops"
        onPointerMove={(e) => {
          const i = dragging.current;
          if (i === null || !(e.buttons & 1)) return;
          setStops(stops.map((s, k) => (k === i ? { ...s, pos: Math.round(posFromEvent(e) * 1000) / 1000 } : s)));
        }}
        onPointerUp={() => (dragging.current = null)}
      >
        {stops.map((s, i) => (
          <div
            key={i}
            className={`ramp-stop ${i === sel ? 'on' : ''}`}
            style={{ left: `${s.pos * 100}%`, background: s.color }}
            onPointerDown={(e) => {
              stop(e);
              (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
              dragging.current = i;
              setSelected(i);
            }}
          />
        ))}
      </div>
      <div className="ramp-row">
        <span>Pos</span>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={stops[sel].pos}
          onPointerDown={stop}
          onChange={(e) => setStops(stops.map((s, k) => (k === sel ? { ...s, pos: clamp01(Number(e.target.value)) } : s)))}
        />
        <input
          type="color"
          value={stops[sel].color}
          onPointerDown={stop}
          onChange={(e) => setStops(stops.map((s, k) => (k === sel ? { ...s, color: e.target.value } : s)))}
        />
      </div>
    </div>
  );
}
