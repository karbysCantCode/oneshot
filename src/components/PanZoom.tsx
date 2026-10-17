import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

type Props = {
  /** Receives the <canvas> element (the GPU result is copied into it). Must be stable. */
  canvasRef: (el: HTMLCanvasElement | null) => void;
  /** Changing this re-fits the view (e.g. the id of the image being shown). */
  resetKey: string;
  /** Hide the canvas (nothing to show). */
  blank?: boolean;
  /** Disable interaction (e.g. when the viewer is behind the node graph). */
  passive?: boolean;
};

type View = { fit: boolean; s: number; x: number; y: number };

const MIN = 0.02;
const MAX = 32;
const STEPS = [0.05, 0.1, 0.125, 0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
/** Pixels of image that must stay visible when panning. */
const KEEP = 48;

/**
 * Pan / zoom viewer for the single-image canvas.
 * - Defaults to Fit; re-fits when the image changes or the panel is resized while in Fit mode.
 * - Wheel / pinch: zoom around the cursor. Trackpad two-finger scroll: pan.
 * - Drag (left or middle button): pan. Double-click: toggle Fit ↔ 100%.
 * - Keys (when the viewer has focus): F or 0 = fit, 1 = 100%, + / − = zoom, arrows = pan.
 */
export default function PanZoom({ canvasRef, resetKey, blank, passive }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [view, setView] = useState<View>({ fit: true, s: 1, x: 0, y: 0 });
  const [img, setImg] = useState({ w: 0, h: 0 });
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);

  const setCanvas = useCallback(
    (el: HTMLCanvasElement | null) => {
      canvas.current = el;
      canvasRef(el);
      if (el) setImg({ w: el.width, h: el.height });
    },
    [canvasRef],
  );

  // Track the canvas bitmap size (set by the renderer) and the panel size.
  useEffect(() => {
    const el = canvas.current;
    const b = box.current;
    if (!el || !b) return;
    const mo = new MutationObserver(() => setImg({ w: el.width, h: el.height }));
    mo.observe(el, { attributes: true, attributeFilter: ['width', 'height'] });
    const ro = new ResizeObserver(() => setBoxSize({ w: b.clientWidth, h: b.clientHeight }));
    ro.observe(b);
    setBoxSize({ w: b.clientWidth, h: b.clientHeight });
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, []);

  const fitView = useCallback((): View => {
    const { w, h } = img;
    const bw = boxSize.w, bh = boxSize.h;
    if (!w || !h || !bw || !bh) return { fit: true, s: 1, x: 0, y: 0 };
    const s = Math.min(bw / w, bh / h);
    return { fit: true, s, x: (bw - w * s) / 2, y: (bh - h * s) / 2 };
  }, [img, boxSize]);

  /** Keep part of the image on screen. */
  const clampView = useCallback(
    (v: View): View => {
      const iw = img.w * v.s, ih = img.h * v.s;
      const kx = Math.min(KEEP, iw), ky = Math.min(KEEP, ih);
      return { ...v, x: Math.min(boxSize.w - kx, Math.max(kx - iw, v.x)), y: Math.min(boxSize.h - ky, Math.max(ky - ih, v.y)) };
    },
    [img, boxSize],
  );

  // Fit by default, on image change, and on resize while in Fit mode.
  useLayoutEffect(() => {
    if (viewRef.current.fit) setView(fitView());
    else setView((v) => clampView(v));
  }, [fitView, clampView]);
  useLayoutEffect(() => setView(fitView()), [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Zoom to scale `s` keeping the image point under (cx, cy) fixed. */
  const zoomTo = useCallback(
    (s: number, cx = boxSize.w / 2, cy = boxSize.h / 2) => {
      setView((v) => {
        const ns = Math.min(MAX, Math.max(MIN, s));
        const ix = (cx - v.x) / v.s, iy = (cy - v.y) / v.s;
        return clampView({ fit: false, s: ns, x: cx - ix * ns, y: cy - iy * ns });
      });
    },
    [boxSize, clampView],
  );

  const step = (dir: 1 | -1) => {
    const s = viewRef.current.s;
    const next = dir > 0 ? STEPS.find((z) => z > s * 1.001) ?? MAX : [...STEPS].reverse().find((z) => z < s / 1.001) ?? MIN;
    zoomTo(next);
  };

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const b = box.current;
    if (!b || passive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = b.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * lines, dy = e.deltaY * lines;
      const trackpadScroll = !e.ctrlKey && e.deltaMode === 0 && (dx !== 0 || !Number.isInteger(dy) || Math.abs(dy) < 4);
      if (trackpadScroll) {
        setView((v) => clampView({ ...v, fit: false, x: v.x - dx, y: v.y - dy }));
      } else {
        const k = e.ctrlKey ? 0.01 : 0.0018; // pinch gestures arrive as ctrl+wheel
        zoomTo(viewRef.current.s * Math.exp(-dy * k), cx, cy);
      }
    };
    b.addEventListener('wheel', onWheel, { passive: false });
    return () => b.removeEventListener('wheel', onWheel);
  }, [zoomTo, clampView, passive]);

  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key;
    const pan = (dx: number, dy: number) => setView((v) => clampView({ ...v, fit: false, x: v.x + dx, y: v.y + dy }));
    if (k === 'f' || k === 'F' || k === '0') setView(fitView());
    else if (k === '1') zoomTo(1);
    else if (k === '+' || k === '=') step(1);
    else if (k === '-' || k === '_') step(-1);
    else if (k === 'ArrowLeft') pan(60, 0);
    else if (k === 'ArrowRight') pan(-60, 0);
    else if (k === 'ArrowUp') pan(0, 60);
    else if (k === 'ArrowDown') pan(0, -60);
    else return;
    e.preventDefault();
    e.stopPropagation(); // keep viewer keys away from the node editor shortcuts
  };

  const pct = Math.round(view.s * 1000) / 10;

  return (
    <div
      ref={box}
      className={`pz ${panning ? 'panning' : ''} ${passive ? 'passive' : ''}`}
      tabIndex={passive ? -1 : 0}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (passive || (e.button !== 0 && e.button !== 1) || (e.target as HTMLElement).closest('.pz-hud')) return;
        e.preventDefault();
        box.current?.focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
        setPanning(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setView((v) => clampView({ ...v, fit: false, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
      }}
      onPointerUp={() => {
        drag.current = null;
        setPanning(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setPanning(false);
      }}
      onDoubleClick={(e) => {
        if (passive || (e.target as HTMLElement).closest('.pz-hud')) return;
        const r = box.current!.getBoundingClientRect();
        if (viewRef.current.fit || Math.abs(viewRef.current.s - 1) > 0.001) zoomTo(1, e.clientX - r.left, e.clientY - r.top);
        else setView(fitView());
      }}
    >
      <canvas
        ref={setCanvas}
        className={`${blank ? 'blank' : ''} ${!view.fit && view.s >= 2 ? 'pixelated' : ''}`}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
      />
      {!blank && !passive && img.w > 0 && (
        <div className="pz-hud" onDoubleClick={(e) => e.stopPropagation()}>
          <button className={view.fit ? 'on' : ''} onClick={() => setView(fitView())} title="Fit to view (F)">
            Fit
          </button>
          <button className={!view.fit && Math.abs(view.s - 1) < 0.001 ? 'on' : ''} onClick={() => zoomTo(1)} title="Actual pixels (1)">
            100%
          </button>
          <button onClick={() => step(-1)} title="Zoom out (−)">
            −
          </button>
          <span className="pz-zoom" title={`${img.w} × ${img.h} px`}>
            {pct}%
          </span>
          <button onClick={() => step(1)} title="Zoom in (+)">
            +
          </button>
        </div>
      )}
    </div>
  );
}
