import { useRef } from 'react';

type Props = {
  /** 'x' = vertical bar resizing widths, 'y' = horizontal bar resizing heights. */
  axis: 'x' | 'y';
  /** Called when a drag starts (snapshot the current size). */
  onStart: () => void;
  /** Called while dragging with the total pointer movement in px since the drag started. */
  onDrag: (delta: number) => void;
  /** Double-click resets the size. */
  onReset: () => void;
  title?: string;
};

/** Draggable divider between panels. */
export default function Splitter({ axis, onStart, onDrag, onReset, title }: Props) {
  const start = useRef<number | null>(null);
  const pos = (e: { clientX: number; clientY: number }) => (axis === 'x' ? e.clientX : e.clientY);

  const end = () => {
    start.current = null;
    document.body.classList.remove(`resizing-${axis}`);
  };

  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      title={title ?? 'Drag to resize · double-click to reset'}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = pos(e);
        document.body.classList.add(`resizing-${axis}`);
        onStart();
      }}
      onPointerMove={(e) => {
        if (start.current !== null) onDrag(pos(e) - start.current);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
    />
  );
}
