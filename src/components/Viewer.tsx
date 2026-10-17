import { useRef } from 'react';
import type { ViewerLayout } from '../settings';
import type { MediaItem } from '../types';

type Props = {
  layout: ViewerLayout;
  onLayout: (layout: ViewerLayout) => void;
  /** Every image the Output is currently processing. */
  batch: MediaItem[];
  /** Image shown in single view / highlighted in grid view. */
  current: MediaItem | null;
  connected: boolean;
  hasMedia: boolean;
  tileSize: number;
  onSelect: (id: string) => void;
  onStep: (dir: 1 | -1) => void;
  onToggleVisible: (id: string) => void;
  onSetVisible: (ids: string[], visible: boolean) => void;
  /** Must be a stable callback. */
  registerCanvas: (key: string, el: HTMLCanvasElement | null) => void;
};

export default function Viewer(p: Props) {
  // Stable ref callback per canvas key so canvases are only registered when they mount/unmount.
  const refs = useRef(new Map<string, (el: HTMLCanvasElement | null) => void>());
  const refFor = (key: string) => {
    let f = refs.current.get(key);
    if (!f) {
      f = (el) => p.registerCanvas(key, el);
      refs.current.set(key, f);
    }
    return f;
  };

  const shown = p.batch.filter((m) => m.visible);
  const pool = shown.length ? shown : p.batch;
  const idx = p.current ? pool.findIndex((m) => m.id === p.current!.id) : -1;

  let message: string | null = null;
  if (!p.hasMedia) message = 'Import an image or a folder to begin';
  else if (!p.connected) message = 'Output is not connected to an Image Input or Folder Input';
  else if (!p.batch.length) message = 'The connected input has no images';
  else if (p.layout === 'grid' && !shown.length) message = 'No images selected for display – tick images in the Media Pool or click “Show all”';

  return (
    <>
      <div className="viewer-bar">
        <div className="seg">
          <button className={p.layout === 'single' ? 'on' : ''} onClick={() => p.onLayout('single')}>
            Single
          </button>
          <button className={p.layout === 'grid' ? 'on' : ''} onClick={() => p.onLayout('grid')}>
            Grid
          </button>
        </div>

        {p.layout === 'single' ? (
          <>
            <button className="icon-btn" disabled={pool.length < 2} onClick={() => p.onStep(-1)} title="Previous image">
              ◀
            </button>
            <span className="viewer-name">
              {p.current ? p.current.name : '—'}
              {idx >= 0 && pool.length > 1 && <small> · {idx + 1} / {pool.length}</small>}
            </span>
            <button className="icon-btn" disabled={pool.length < 2} onClick={() => p.onStep(1)} title="Next image">
              ▶
            </button>
          </>
        ) : (
          <span className="viewer-name">
            {shown.length} of {p.batch.length} shown
          </span>
        )}

        <span className="spacer" />
        <button className="bar-btn" disabled={!p.batch.length} onClick={() => p.onSetVisible(p.batch.map((m) => m.id), true)}>
          Show all
        </button>
        <button className="bar-btn" disabled={!p.batch.length} onClick={() => p.onSetVisible(p.batch.map((m) => m.id), false)}>
          Hide all
        </button>
      </div>

      <div className={`viewer layout-${p.layout}`}>
        {p.layout === 'single' && <canvas ref={refFor('single')} className={message ? 'blank' : ''} />}

        {p.layout === 'grid' && !message && (
          <div className="tile-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${p.tileSize}px, 1fr))` }}>
            {shown.map((m) => (
              <figure
                key={m.id}
                className={m.id === p.current?.id ? 'focus' : ''}
                onClick={() => p.onSelect(m.id)}
                onDoubleClick={() => {
                  p.onSelect(m.id);
                  p.onLayout('single');
                }}
                title="Click to focus · double-click to open in single view"
              >
                <div className="tile-img">
                  <canvas ref={refFor(`tile:${m.id}`)} />
                </div>
                <figcaption>
                  <span>{m.name}</span>
                  <button
                    className="icon-btn small"
                    title="Hide from viewer"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onToggleVisible(m.id);
                    }}
                  >
                    ✕
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}

        {message && <div className="empty">{message}</div>}
      </div>
    </>
  );
}
