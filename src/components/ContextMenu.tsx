import { useEffect, useRef } from 'react';

export type MenuItem =
  | { label: string; onSelect?: () => void; danger?: boolean; disabled?: boolean }
  | 'separator';

export type MenuState = { x: number; y: number; title?: string; items: MenuItem[] };

type Props = { menu: MenuState; onClose: () => void };

export default function ContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Keep the menu on-screen.
  const left = Math.min(menu.x, window.innerWidth - 250);
  const top = Math.min(menu.y, window.innerHeight - (menu.items.length * 34 + 50));

  return (
    <div ref={ref} className="context-menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {menu.title && <div className="context-title">{menu.title}</div>}
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={item.danger ? 'danger' : ''}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect?.();
              onClose();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
