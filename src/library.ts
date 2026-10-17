import type { Edge } from '@xyflow/react';
import { cleanEdge, cleanNode } from './nodes/graph';
import type { GraphPreset, ShaderNode } from './types';

/** Saved node graphs ("Library"), persisted in the browser's localStorage. */
const KEY = 'nodegl.graphs.v1';

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function loadPresets(): GraphPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as GraphPreset[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
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
