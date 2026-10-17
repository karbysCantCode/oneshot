import { useRef, type PointerEvent as RPointerEvent } from 'react';

type Props = {
  label: string;
  x: number;
  y: number;
  master: number;
  masterLabel?: string;
  onChange: (x: number, y: number, master: number) => void;
};

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** Colour wheel (hue around, amount outward) with a master slider. Double-click resets. */
export default function ColourWheel({ label, x, y, master, masterLabel = 'Master', onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const fromEvent = (e: RPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    let nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    let ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    const d = Math.hypot(nx, ny);
    if (d > 1) {
      nx /= d;
      ny /= d;
    }
    onChange(Math.round(nx * 1000) / 1000, Math.round(ny * 1000) / 1000, master);
  };

  return (
    <div className="wheel-ctl nodrag nowheel">
      <span className="wheel-label">{label}</span>
      <div
        ref={ref}
        className="wheel"
        onPointerDown={(e) => {
          stop(e);
          (e.target as Element).setPointerCapture(e.pointerId);
          fromEvent(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) fromEvent(e);
        }}
        onDoubleClick={() => onChange(0, 0, master)}
        title="Drag to tint · double-click to reset"
      >
        <div className="puck" style={{ left: `${(x + 1) * 50}%`, top: `${(y + 1) * 50}%` }} />
      </div>
      <input
        className="nodrag nowheel"
        type="range"
        min={-100}
        max={100}
        step={1}
        value={master}
        title={`${masterLabel}: ${master} (double-click to reset)`}
        onPointerDown={stop}
        onChange={(e) => onChange(x, y, Number(e.target.value))}
        onDoubleClick={() => onChange(x, y, 0)}
      />
      <small>
        {masterLabel} {master > 0 ? '+' : ''}
        {master}
      </small>
    </div>
  );
}
