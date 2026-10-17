import type { Edge } from '@xyflow/react';
import { cleanEdge, cleanNode, migrateGraph } from './nodes/graph';
import builtinPack from './looks/builtin-looks.json';
import type { GraphPreset, ShaderNode } from './types';

/** Saved node graphs ("Library"), persisted in the browser's localStorage. */
const KEY = 'nodegl.graphs.v1';

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const BUILTIN_FLAG = 'nodegl.builtins.v1';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Looks shipped with the app (src/looks/builtin-looks.json). Stable ids so they are never duplicated. */
export function builtinPresets(): GraphPreset[] {
  return graphsInFile(builtinPack as unknown).map((g) => {
    const m = migrateGraph(g.nodes, g.edges);
    return {
      id: `builtin-${slug(g.name ?? 'look')}`,
      name: g.name ?? 'Look',
      description: g.description,
      created: 0,
      builtin: true,
      nodes: m.nodes.map(cleanNode),
      edges: m.edges.map(cleanEdge),
      luts: g.luts ?? {},
    };
  });
}

/** Built-in looks missing from a list (deleted by the user). */
export const missingBuiltins = (list: GraphPreset[]) => {
  const have = new Set(list.map((p) => p.id));
  return builtinPresets().filter((b) => !have.has(b.id));
};

/**
 * The Library. On the very first run the built-in looks are unpacked into it;
 * after that they behave like any saved graph (rename, delete, restore from the Library tab).
 */
export function loadPresets(): GraphPreset[] {
  let list: GraphPreset[] = [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as GraphPreset[]) : [];
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    list = [];
  }
  try {
    if (!localStorage.getItem(BUILTIN_FLAG)) {
      list = [...missingBuiltins(list), ...list];
      localStorage.setItem(BUILTIN_FLAG, '1');
      savePresets(list);
    }
  } catch {
    /* storage unavailable: show the built-ins for this session only */
    if (!list.length) list = builtinPresets();
  }
  return list;
}

/** Returns an error message if the browser refused to store the library (quota). */
export function savePresets(list: GraphPreset[]): string | null {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return null;
  } catch {
    return 'Browser storage is full – the library could not be saved (large .cube LUTs use a lot of space). Export the project instead.';
  }
}

export function makePreset(
  name: string,
  nodes: ShaderNode[],
  edges: Edge[],
  luts: Record<string, { name: string; text: string }>,
  description?: string,
): GraphPreset {
  const p: GraphPreset = { id: uid(), name, created: Date.now(), nodes: nodes.map(cleanNode), edges: edges.map(cleanEdge), luts };
  if (description) p.description = description;
  return p;
}

/**
 * Graphs in an imported file. Accepts a single graph ({ nodes, edges, … }),
 * a pack ({ nodegl: 'graph-pack', graphs: [...] }) or a plain array of graphs.
 */
export function graphsInFile(json: unknown): { name?: string; description?: string; nodes: ShaderNode[]; edges: Edge[]; luts?: Record<string, { name: string; text: string }> }[] {
  const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as { graphs?: unknown[] }).graphs) ? (json as { graphs: unknown[] }).graphs : [json];
  return list.filter(
    (g): g is { nodes: ShaderNode[]; edges: Edge[] } =>
      !!g && typeof g === 'object' && Array.isArray((g as { nodes?: unknown }).nodes) && Array.isArray((g as { edges?: unknown }).edges),
  );
}
