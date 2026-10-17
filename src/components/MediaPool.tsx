import { useState } from 'react';
import { folderGroups, folderLabel } from '../media';
import type { MediaItem } from '../types';

type Props = {
  media: MediaItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onSetVisible: (ids: string[], visible: boolean) => void;
  onUseFolder: (folder: string) => void;
  onImportFiles: (files: FileList | null) => void;
  onImportFolder: () => void;
};

export default function MediaPool(p: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = folderGroups(p.media);

  const toggleCollapsed = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <aside className="media">
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

      {!p.media.length && <p className="hint">Images stay in this browser tab – nothing is uploaded.</p>}

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
                {g.items.map((m) => (
                  <div
                    key={m.id}
                    className={`media-item ${m.id === p.activeId ? 'active' : ''} ${m.visible ? '' : 'muted'}`}
                    onClick={() => p.onSelect(m.id)}
                    title={m.name}
                  >
                    <img src={m.url} alt="" loading="lazy" decoding="async" />
                    <span>{m.name}</span>
                    <input
                      type="checkbox"
                      title="Show in viewer"
                      checked={m.visible}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => p.onToggleVisible(m.id)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}
