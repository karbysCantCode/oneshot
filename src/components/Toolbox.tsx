import { useState } from 'react';
import { CATEGORIES, NODE_DEFS, type NodeDef } from '../nodes/registry';

type Props = { onAdd: (def: NodeDef) => void };

export default function Toolbox({ onAdd }: Props) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const q = search.trim().toLowerCase();

  const matches = (d: NodeDef) =>
    !q || `${d.label} ${d.description} ${d.category} ${d.keywords ?? ''}`.toLowerCase().includes(q);

  return (
    <aside className="toolbox">
      <h3>Toolbox</h3>
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
                <button key={d.kind} className={`tool cat-${d.category.split(' ')[0].toLowerCase()}`} onClick={() => onAdd(d)}>
                  <b>{d.label}</b>
                  <small>{d.description}</small>
                </button>
              ))}
          </div>
        );
      })}
      {!NODE_DEFS.some(matches) && <p className="hint">No nodes match “{search}”.</p>}
    </aside>
  );
}
