import { useRef, useState, type DragEvent } from 'react';
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
};

export default function MediaPool(p: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = folderGroups(p.media);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

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

      {!p.media.length && <p className="hint drop-hint">Drag images or folders here, or use the buttons above. Images stay in this browser tab – nothing is uploaded.</p>}

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
            </div>
            {open && (
              <div className="media-list">
                {g.items.map((m) => {
                  const graph = p.graphName(m);
                  return (
                    <div
                      key={m.id}
                      className={`media-item ${m.id === p.activeId ? 'active' : ''} ${m.visible ? '' : 'muted'}`}
                      onClick={() => p.onSelect(m.id)}
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
