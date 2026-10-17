import { useState } from 'react';
import { CATEGORIES, NODE_DEFS, type NodeDef } from '../nodes/registry';
import { exposedNodes } from '../nodes/graph';
import type { GraphPreset } from '../types';

type Props = {
  onAdd: (def: NodeDef) => void;
  presets: GraphPreset[];
  onSavePreset: () => void;
  onLoadPreset: (id: string) => void;
  /** Add a saved graph's nodes to the workspace (keeps the current graph). */
  onInsertPreset: (id: string) => void;
  /** Number of built-in looks the user has deleted, and a way to bring them back. */
  missingBuiltins: number;
  onRestoreBuiltins: () => void;
  onApplyPreset: (id: string) => void;
  onRenamePreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
  onExportPreset: (id: string) => void;
  onImportPreset: (files: File[]) => void;
};

export default function Toolbox(p: Props) {
  const [tab, setTab] = useState<'nodes' | 'library'>('nodes');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const q = search.trim().toLowerCase();

  const matches = (d: NodeDef) =>
    !d.hidden && (!q || `${d.label} ${d.description} ${d.category} ${d.keywords ?? ''}`.toLowerCase().includes(q));

  return (
    <aside className="toolbox">
      <div className="seg full">
        <button className={tab === 'nodes' ? 'on' : ''} onClick={() => setTab('nodes')}>
          Nodes
        </button>
        <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>
          Library ({p.presets.length})
        </button>
      </div>

      {tab === 'nodes' && (
        <>
          <input placeholder="Search nodes…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {CATEGORIES.map((cat) => {
            const defs = NODE_DEFS.filter((d) => d.category === cat && matches(d));
            if (!defs.length) return null;
            const open = !!q || !collapsed.has(cat);
            return (
              <div key={cat} className="tool-group">
                <button
                  className="tool-cat"
                  onClick={() =>
                    setCollapsed((s) => {
                      const next = new Set(s);
                      if (next.has(cat)) next.delete(cat);
                      else next.add(cat);
                      return next;
                    })
                  }
                >
                  {open ? '▾' : '▸'} {cat} <span className="count">{defs.length}</span>
                </button>
                {open &&
                  defs.map((d) => (
                    <button key={d.kind} className={`tool cat-${d.category.split(' ')[0].toLowerCase()}`} onClick={() => p.onAdd(d)}>
                      <b>{d.label}</b>
                      <small>{d.description}</small>
                    </button>
                  ))}
              </div>
            );
          })}
          {!NODE_DEFS.some(matches) && <p className="hint">No nodes match “{search}”.</p>}
          <p className="hint">Select nodes and press Ctrl/⌘+G to make a compound node.</p>
        </>
      )}

      {tab === 'library' && (
        <>
          <button className="import full" onClick={p.onSavePreset}>
            + Save current graph
          </button>
          <label className="bar-btn file-btn">
            Import graph / pack files…
            <input
              hidden
              type="file"
              multiple
              accept="application/json,.json"
              onChange={(e) => {
                const files: File[] = Array.from((e.target as HTMLInputElement).files ?? []);
                if (files.length) p.onImportPreset(files);
                e.target.value = '';
              }}
            />
          </label>
          {p.missingBuiltins > 0 && (
            <button className="bar-btn file-btn" onClick={p.onRestoreBuiltins}>
              Restore {p.missingBuiltins} built-in look{p.missingBuiltins === 1 ? '' : 's'}
            </button>
          )}
          {!p.presets.length && (
            <p className="hint">
              Saved graphs can be applied to images in the Media Pool. Value, RGB Colour and Image Input nodes in a saved graph become
              per-image parameters, shown under the image in Library view.
            </p>
          )}
          {p.presets.map((g) => {
            const exposed = exposedNodes(g.nodes).length;
            return (
              <div key={g.id} className="preset">
                <div className="preset-head">
                  <b title={g.name}>
                    {g.name}
                    {g.builtin && <span className="builtin-tag">BUILT-IN</span>}
                  </b>
                  {g.description && <span className="preset-desc">{g.description}</span>}
                  <small>
                    {g.nodes.length} nodes · {exposed} param{exposed === 1 ? '' : 's'}
                  </small>
                </div>
                <div className="preset-actions">
                  <button className="mini-btn" title="Apply to the images shown in the viewer (switches to Library view)" onClick={() => p.onApplyPreset(g.id)}>
                    Apply
                  </button>
                  <button className="mini-btn" title="Add this graph's nodes to the workspace, appended after the current graph, so you can see and tinker with them" onClick={() => p.onInsertPreset(g.id)}>
                    Insert
                  </button>
                  <button className="mini-btn" title="Open in the node workspace (replaces the current graph)" onClick={() => p.onLoadPreset(g.id)}>
                    Edit
                  </button>
                  <button className="mini-btn" title="Rename" onClick={() => p.onRenamePreset(g.id)}>
                    ✎
                  </button>
                  <button className="mini-btn" title="Download as file" onClick={() => p.onExportPreset(g.id)}>
                    ⤓
                  </button>
                  <button className="mini-btn danger" title="Delete" onClick={() => p.onDeletePreset(g.id)}>
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </aside>
  );
}
