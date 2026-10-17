import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { folderGroups, folderLabel, readDropped, type DroppedFile } from '../media';
import type { MediaItem } from '../types';

type Props = {
  media: MediaItem[];
  activeId: string | null;
  /** Name of the saved graph applied to an image (Library), if any. */
  graphName: (item: MediaItem) => string | undefined;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onSetVisible: (ids: string[], visible: boolean) => void;
  onUseFolder: (folder: string) => void;
  onImportFiles: (files: FileList | null) => void;
  onImportFolder: () => void;
  /** Files / folders dropped onto the pool. */
  onDropFiles: (files: DroppedFile[]) => void;
  /** Remove images from the pool (and from the stored session). */
  onDelete: (ids: string[]) => void;
};

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M1.5 3 H10.5 M4.5 3 V1.5 H7.5 V3 M2.8 3 L3.4 10.5 H8.6 L9.2 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

export default function MediaPool(p: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = folderGroups(p.media);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  /* ---- selection (for deleting): click = one, Ctrl/⌘ = toggle, Shift = range ---- */
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const order = useMemo(() => groups.flatMap((g) => g.items.map((m) => m.id)), [groups]);

  // Drop selections of images that no longer exist.
  useEffect(() => {
    const ids = new Set(p.media.map((m) => m.id));
    setSel((s) => {
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [p.media]);

  const clickItem = (e: MouseEvent, id: string) => {
    if (e.shiftKey && anchor.current && order.includes(anchor.current)) {
      const a = order.indexOf(anchor.current), b = order.indexOf(id);
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
      setSel((s) => (e.metaKey || e.ctrlKey ? new Set([...s, ...range]) : new Set(range)));
    } else if (e.metaKey || e.ctrlKey) {
      setSel((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchor.current = id;
    } else {
      setSel(new Set([id]));
      anchor.current = id;
      p.onSelect(id);
    }
  };

  const remove = (ids: string[]) => {
    if (!ids.length) return;
    if (ids.length > 1 && !window.confirm(`Remove ${ids.length} images from the Media Pool?`)) return;
    p.onDelete(ids);
    setSel(new Set());
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) {
      e.preventDefault();
      e.stopPropagation(); // don't let the node editor delete nodes too
      remove([...sel]);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && p.media.length) {
      e.preventDefault();
      e.stopPropagation();
      setSel(new Set(order));
    } else if (e.key === 'Escape' && sel.size) {
      setSel(new Set());
    }
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current++;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (!depth.current) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    void readDropped(e.dataTransfer).then((files) => files.length && p.onDropFiles(files));
  };

  const toggleCollapsed = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <aside
      className={`media ${dragging ? 'drop-target' : ''}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && <div className="drop-overlay">Drop images or folders</div>}
      <h3>Media Pool</h3>
      <div className="import-row">
        <label className="import" title="Import one or more images">
          + Images
          <input
            hidden
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              p.onImportFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        <button className="import" title="Import every image in a folder and batch-process it" onClick={p.onImportFolder}>
          + Folder
        </button>
      </div>

      {p.media.length > 0 && (
        <div className="select-row">
          <button className="mini-btn" onClick={() => setSel(new Set(order))} title="Select all images (Ctrl/⌘+A)">
            Select all
          </button>
          <button className="mini-btn" disabled={!sel.size} onClick={() => setSel(new Set())} title="Clear selection (Esc)">
            None
          </button>
          <button className="mini-btn danger" disabled={!sel.size} onClick={() => remove([...sel])} title="Remove selected images (Delete)">
            <TrashIcon /> {sel.size || ''}
          </button>
        </div>
      )}

      {!p.media.length && <p className="hint drop-hint">Drag images or folders here, or use the buttons above. Images are kept in this browser between sessions – nothing is uploaded.</p>}

      {groups.map((g) => {
        const allShown = g.items.every((m) => m.visible);
        const someShown = g.items.some((m) => m.visible);
        const open = !collapsed.has(g.key);
        return (
          <div key={g.key} className="media-group">
            <div className="group-head">
              <button className="twisty" onClick={() => toggleCollapsed(g.key)} title={open ? 'Collapse' : 'Expand'}>
                {open ? '▾' : '▸'}
              </button>
              <span className="group-name" title={folderLabel(g.key)}>
                {folderLabel(g.key)}
              </span>
              <span className="count">{g.items.length}</span>
              <input
                type="checkbox"
                title="Show all of this folder in the viewer"
                checked={allShown}
                ref={(el) => {
                  if (el) el.indeterminate = someShown && !allShown;
                }}
                onChange={() => p.onSetVisible(g.items.map((m) => m.id), !allShown)}
              />
              <button className="icon-btn small" title="Batch-process this folder (Folder Input node)" onClick={() => p.onUseFolder(g.key)}>
                ⇢
              </button>
              <button className="icon-btn small danger" title="Remove this folder from the Media Pool" onClick={() => remove(g.items.map((m) => m.id))}>
                <TrashIcon />
              </button>
            </div>
            {open && (
              <div className="media-list">
                {g.items.map((m) => {
                  const graph = p.graphName(m);
                  return (
                    <div
                      key={m.id}
                      className={`media-item ${m.id === p.activeId ? 'active' : ''} ${sel.has(m.id) ? 'selected' : ''} ${m.visible ? '' : 'muted'}`}
                      onClick={(e) => clickItem(e, m.id)}
                      title={graph ? `${m.name} · graph: ${graph}` : m.name}
                    >
                      <img src={m.url} alt="" loading="lazy" decoding="async" />
                      <span>
                        {m.name}
                        {graph && <em className="graph-badge">{graph}</em>}
                      </span>
                      <input
                        type="checkbox"
                        title="Show in viewer"
                        checked={m.visible}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => p.onToggleVisible(m.id)}
                      />
                      <button
                        className="item-del"
                        title="Remove from the Media Pool"
                        onClick={(e) => {
                          e.stopPropagation();
                          remove([m.id]);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}
