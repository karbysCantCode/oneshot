import { useRef, type ReactNode } from 'react';
import type { ViewerLayout, ViewSource } from '../settings';

/** Something the viewer can show: a media image or the procedural canvas. */
export type ViewItem = { id: string; name: string; visible: boolean; badge?: string };

type Props = {
  layout: ViewerLayout;
  onLayout: (layout: ViewerLayout) => void;
  source: ViewSource;
  onSource: (source: ViewSource) => void;
  /** Every item being processed. */
  batch: ViewItem[];
  /** Item shown in single view / highlighted in grid view. */
  current: ViewItem | null;
  /** Message to show instead of images (e.g. output not connected). */
  message: string | null;
  tileSize: number;
  onSelect: (id: string) => void;
  onStep: (dir: 1 | -1) => void;
  onToggleVisible: (id: string) => void;
  onSetVisible: (ids: string[], visible: boolean) => void;
  /** Must be a stable callback. */
  registerCanvas: (key: string, el: HTMLCanvasElement | null) => void;
  /** Panel shown under the image (Library parameters). */
  footer?: ReactNode;
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
  let message = p.message;
  if (!message && p.layout === 'grid' && !shown.length) message = 'No images selected for display – tick images in the Media Pool or click “Show all”';

  return (
    <>
      <div className="viewer-bar">
        <div className="seg" title="Workspace: the graph you are editing · Library: each image with its own saved graph">
          <button className={p.source === 'workspace' ? 'on' : ''} onClick={() => p.onSource('workspace')}>
            Workspace
          </button>
          <button className={p.source === 'library' ? 'on' : ''} onClick={() => p.onSource('library')}>
            Library
          </button>
        </div>
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

      <div className="viewer-wrap">
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
                    {m.badge && <em className="tile-badge">{m.badge}</em>}
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
        {p.footer}
      </div>
    </>
  );
}
