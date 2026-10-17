import type { Edge } from '@xyflow/react';
import type { CurvePoint, Params, Ramp, ShaderData, ShaderNode, Socket } from '../types';
import { curveTable } from './curves';
import { defSockets, defaultParams, getDef, resolveCurves } from './registry';

/* =====================================================================
 *  Graph utilities
 *  - Sockets & handle ids:  "in:<socketId>" / "out:<socketId>"
 *  - Flattening: expands compound (group) nodes and removes bypassed nodes,
 *    producing a plain DAG of shader nodes.
 *  - Planning: the ordered list of GPU steps needed for one output.
 * ===================================================================== */

export const inHandle = (id: string) => `in:${id}`;
export const outHandle = (id: string) => `out:${id}`;
const parseHandle = (h: string | null | undefined) => (h ? h.replace(/^(in|out):/, '') : null);

/** Sockets of a node (definition-based, or stored in data for group kinds). */
export function socketsOf(n: { data: ShaderData }): { inputs: Socket[]; outputs: Socket[] } {
  const d = n.data;
  if (d.kind === 'group') return { inputs: d.group?.inputs ?? [], outputs: d.group?.outputs ?? [] };
  if (d.kind === 'groupIn') return { inputs: [], outputs: d.sockets ?? [] };
  if (d.kind === 'groupOut') return { inputs: d.sockets ?? [], outputs: [] };
  return defSockets(d.kind);
}

export const DEFAULT_RAMP: Ramp = {
  interp: 'linear',
  stops: [
    { pos: 0, color: '#000000', alpha: 1 },
    { pos: 1, color: '#ffffff', alpha: 1 },
  ],
};

/** Strip runtime-only fields from a node (for saving / storing inside groups). */
export function cleanNode(n: ShaderNode): ShaderNode {
  const d = n.data;
  const data: ShaderData = {
    label: d.label,
    kind: d.kind,
    params: d.params,
    curves: d.curves,
    ramp: d.ramp,
    lutName: d.lutName,
    showPreview: d.showPreview,
    bypass: d.bypass,
    folder: d.folder,
    sockets: d.sockets,
    group: d.group ? { ...d.group, nodes: d.group.nodes.map(cleanNode), edges: d.group.edges.map(cleanEdge) } : undefined,
  };
  (Object.keys(data) as (keyof ShaderData)[]).forEach((k) => data[k] === undefined && delete data[k]);
  return { id: n.id, type: 'shader', position: n.position, data };
}

export const cleanEdge = (e: Edge): Edge => ({
  id: e.id,
  source: e.source,
  target: e.target,
  sourceHandle: e.sourceHandle ?? null,
  targetHandle: e.targetHandle ?? null,
});

/**
 * Upgrade nodes/edges from older projects: Exposure `value`, missing handle ids,
 * missing inline defaults. Recurses into groups.
 */
export function migrateGraph(nodes: ShaderNode[], edges: Edge[]): { nodes: ShaderNode[]; edges: Edge[] } {
  const ns = nodes.map((n) => {
    const data = { ...n.data };
    if (data.kind === 'exposure' && data.value !== undefined && data.params?.stops === undefined) {
      data.params = { ...data.params, stops: data.value };
    }
    delete data.value;
    if (data.group) data.group = { ...data.group, ...migrateGraph(data.group.nodes, data.group.edges) };
    return { ...n, type: 'shader' as const, data };
  });
  const byId = new Map(ns.map((n) => [n.id, n]));
  const es = edges
    .map((e) => {
      const s = byId.get(e.source);
      const t = byId.get(e.target);
      if (!s || !t) return null;
      const so = socketsOf(s).outputs;
      const ti = socketsOf(t).inputs;
      const sh = e.sourceHandle ?? (so[0] ? outHandle(so[0].id) : null);
      const th = e.targetHandle ?? (ti[0] ? inHandle(ti[0].id) : null);
      if (!sh || !th) return null;
      return { ...e, sourceHandle: sh, targetHandle: th };
    })
    .filter((e): e is NonNullable<typeof e> => !!e);
  return { nodes: ns, edges: es };
}

/* ---------------- flattening ---------------- */

export type Ref = { node: string; out: number };

export type FlatNode = {
  id: string;
  /** Id of the original node (for LUT lookup). */
  rawId: string;
  kind: string;
  params: Params;
  curvePoints?: { points: CurvePoint[]; periodic: boolean }[];
  ramp?: Ramp;
  folder?: string;
};

export type FlatGraph = {
  /** Real shader/source nodes by flattened id ("group/inner" for nodes inside groups). */
  nodes: Map<string, FlatNode>;
  /** Resolve what actually produces output socket `outId` of any node (handles groups and bypass). */
  resolveOutput: (id: string, outId: string) => Ref | null;
  /** Resolve the producer feeding input socket `inId` of any node. */
  resolveInput: (id: string, inId: string) => Ref | null;
  /** Output socket ids of a flattened node. */
  outputsOf: (id: string) => Socket[];
  inputsOf: (id: string) => Socket[];
  /** Flattened id of the first top-level Output node. */
  outputId: string | null;
};

type Entry = { node: ShaderNode; parent: string | null };

/**
 * Expand groups and bypassed nodes into a plain DAG.
 * `overrides` patches params of top-level nodes (Library per-image parameters).
 */
export function flatten(nodes: ShaderNode[], edges: Edge[], overrides?: Record<string, Params>): FlatGraph {
  const all = new Map<string, Entry>();
  const incoming = new Map<string, { source: string; out: string }>();
  const groupIO = new Map<string, { in?: string; out?: string }>();

  const collect = (ns: ShaderNode[], es: Edge[], prefix: string, parent: string | null) => {
    for (const n of ns) {
      const full = prefix + n.id;
      all.set(full, { node: n, parent });
      if (n.data.kind === 'groupIn' && parent) groupIO.set(parent, { ...groupIO.get(parent), in: full });
      if (n.data.kind === 'groupOut' && parent) groupIO.set(parent, { ...groupIO.get(parent), out: full });
      if (n.data.kind === 'group' && n.data.group) collect(n.data.group.nodes, n.data.group.edges, `${full}/`, full);
    }
    for (const e of es) {
      const t = parseHandle(e.targetHandle);
      const s = parseHandle(e.sourceHandle);
      if (t === null || s === null) continue;
      incoming.set(`${prefix + e.target}|${t}`, { source: prefix + e.source, out: s });
    }
  };
  collect(nodes, edges, '', null);

  const sockets = (id: string) => {
    const e = all.get(id);
    return e ? socketsOf(e.node) : { inputs: [], outputs: [] };
  };

  const resolveOutput = (id: string, outId: string, depth = 0): Ref | null => {
    if (depth > 128) return null;
    const entry = all.get(id);
    if (!entry) return null;
    const d = entry.node.data;
    const next = (key: string) => {
      const src = incoming.get(key);
      return src ? resolveOutput(src.source, src.out, depth + 1) : null;
    };
    if (d.kind === 'groupIn') return entry.parent ? next(`${entry.parent}|${outId}`) : null;
    if (d.kind === 'groupOut') return null;
    const { inputs, outputs } = socketsOf(entry.node);
    if (d.bypass) {
      // Pass through the first connected input of the same type (else the first connected input).
      const outType = outputs.find((o) => o.id === outId)?.type ?? 'color';
      const connected = inputs.filter((s) => incoming.has(`${id}|${s.id}`));
      const pick = connected.find((s) => s.type === outType) ?? connected[0];
      return pick ? next(`${id}|${pick.id}`) : null;
    }
    if (d.kind === 'group') {
      const io = groupIO.get(id);
      return io?.out ? next(`${io.out}|${outId}`) : null;
    }
    if (!getDef(d.kind)) return null;
    const out = outputs.findIndex((o) => o.id === outId);
    return { node: id, out: Math.max(0, out) };
  };

  const resolveInput = (id: string, inId: string): Ref | null => {
    const src = incoming.get(`${id}|${inId}`);
    return src ? resolveOutput(src.source, src.out) : null;
  };

  const flat = new Map<string, FlatNode>();
  for (const [id, { node, parent }] of all) {
    const d = node.data;
    if (d.kind === 'group' || d.kind === 'groupIn' || d.kind === 'groupOut' || d.bypass || !getDef(d.kind)) continue;
    const params: Params = { ...defaultParams(d.kind), ...d.params, ...(parent === null ? overrides?.[id] : undefined) };
    const rows = resolveCurves(d.kind, d.curves);
    flat.set(id, {
      id,
      rawId: node.id,
      kind: d.kind,
      params,
      curvePoints: rows.length ? rows : undefined,
      ramp: getDef(d.kind)?.ramp ? d.ramp ?? DEFAULT_RAMP : undefined,
      folder: d.kind === 'folder' ? d.folder : undefined,
    });
  }

  const out = nodes.find((n) => n.data.kind === 'output');
  return {
    nodes: flat,
    resolveOutput: (id, outId) => resolveOutput(id, outId),
    resolveInput,
    outputsOf: (id) => sockets(id).outputs,
    inputsOf: (id) => sockets(id).inputs,
    outputId: out ? out.id : null,
  };
}

/* ---------------- planning ---------------- */

export type Step = {
  id: string;
  rawId: string;
  kind: string;
  params: Params;
  inputs: (Ref | null)[];
  /** Output indices actually consumed. */
  outs: number[];
  curve?: { key: string; data: Float32Array; rows: number };
  ramp?: Ramp;
  folder?: string;
  sig: string;
};

export type Plan = {
  steps: Step[];
  target: Ref | null;
  /** Folder of the first Folder Input reached (defines the batch). */
  folder?: string;
  /** An Image Input uses the current (batch) image. */
  usesCurrent: boolean;
  /** Specific Media Pool images used by Image Inputs. */
  mediaIds: string[];
  sig: string;
};

/** Ordered GPU steps needed to compute `target`. */
export function buildPlan(g: FlatGraph, target: Ref | null, lutIds?: Map<string, string>): Plan {
  const steps: Step[] = [];
  const index = new Map<string, Step>();
  const sigs = new Map<string, string>();
  let folder: string | undefined;
  let usesCurrent = false;
  const mediaIds = new Set<string>();

  const visit = (id: string, stack: Set<string>): string => {
    const known = sigs.get(id);
    if (known !== undefined) return known;
    if (stack.has(id)) return 'cycle';
    stack.add(id);
    const fn = g.nodes.get(id)!;
    const inputs = g.inputsOf(id).map((s) => {
      const r = g.resolveInput(id, s.id);
      return r && g.nodes.has(r.node) ? r : null;
    });
    const inSigs = inputs.map((r) => (r ? `${visit(r.node, stack)}#${r.out}` : '-'));
    stack.delete(id);

    const curve = fn.curvePoints ? { ...curveTable(fn.curvePoints), rows: fn.curvePoints.length } : undefined;
    if (fn.kind === 'folder' && folder === undefined) folder = fn.folder ?? '*';
    if (fn.kind === 'input') {
      const m = String(fn.params.media ?? '');
      if (m) mediaIds.add(m);
      else usesCurrent = true;
    }
    const sig = `${fn.kind}${JSON.stringify(fn.params)}${curve?.key ?? ''}${fn.ramp ? JSON.stringify(fn.ramp) : ''}${lutIds?.get(fn.rawId) ?? ''}${fn.folder ?? ''}(${inSigs.join(',')})`;
    const step: Step = { id, rawId: fn.rawId, kind: fn.kind, params: fn.params, inputs, outs: [], curve, ramp: fn.ramp, folder: fn.folder, sig };
    steps.push(step);
    index.set(id, step);
    sigs.set(id, sig);
    return sig;
  };

  let sig = 'none';
  if (target && g.nodes.has(target.node)) {
    sig = `${visit(target.node, new Set())}#${target.out}`;
    // Record which outputs are consumed.
    const use = (r: Ref | null) => {
      if (!r) return;
      const s = index.get(r.node);
      if (s && !s.outs.includes(r.out)) s.outs.push(r.out);
    };
    for (const s of steps) s.inputs.forEach(use);
    use(target);
  }
  return { steps, target: target && g.nodes.has(target.node) ? target : null, folder, usesCurrent, mediaIds: [...mediaIds], sig };
}

/** Plan for the graph's Output node. */
export function outputPlan(g: FlatGraph, lutIds?: Map<string, string>): Plan {
  const target = g.outputId ? g.resolveInput(g.outputId, 'image') : null;
  return buildPlan(g, target, lutIds);
}

/** Plan for previewing a node (by flattened id): its first output, or what feeds a sink. */
export function previewPlan(g: FlatGraph, id: string, lutIds?: Map<string, string>): Plan {
  const outs = g.outputsOf(id);
  const target = outs.length ? g.resolveOutput(id, outs[0].id) : (() => {
    const ins = g.inputsOf(id);
    return ins.length ? g.resolveInput(id, ins[0].id) : null;
  })();
  return buildPlan(g, target, lutIds);
}

/* ---------------- groups ---------------- */

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const NON_GROUPABLE = new Set(['output', 'groupIn', 'groupOut']);

/** Collapse the given nodes into a compound node. Returns null if nothing can be grouped. */
export function makeGroup(nodes: ShaderNode[], edges: Edge[], ids: string[], name = 'Group'): { nodes: ShaderNode[]; edges: Edge[]; groupId: string } | null {
  const sel = new Set(ids.filter((id) => {
    const n = nodes.find((x) => x.id === id);
    return n && !NON_GROUPABLE.has(n.data.kind);
  }));
  if (!sel.size) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inner = nodes.filter((n) => sel.has(n.id)).map((n) => ({ ...cleanNode(n), selected: false }));

  const xs = inner.map((n) => n.position.x);
  const ys = inner.map((n) => n.position.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const cy = (minY + maxY) / 2;

  const groupId = uid();
  const ginId = uid();
  const goutId = uid();
  const inputs: Socket[] = [];
  const outputs: Socket[] = [];
  const inKey = new Map<string, string>();
  const outKey = new Map<string, string>();
  const innerEdges: Edge[] = [];
  const outerEdges: Edge[] = [];

  const sockOf = (nodeId: string, handle: string | null | undefined, side: 'in' | 'out') => {
    const n = byId.get(nodeId);
    const id = parseHandle(handle);
    const list = n ? (side === 'in' ? socketsOf(n).inputs : socketsOf(n).outputs) : [];
    return list.find((s) => s.id === id) ?? list[0];
  };

  for (const e of edges) {
    const sIn = sel.has(e.source);
    const tIn = sel.has(e.target);
    if (sIn && tIn) innerEdges.push(cleanEdge(e));
    else if (!sIn && tIn) {
      const key = `${e.source}|${e.sourceHandle}`;
      let gid = inKey.get(key);
      if (!gid) {
        gid = `i${inputs.length}`;
        inKey.set(key, gid);
        const ts = sockOf(e.target, e.targetHandle, 'in');
        inputs.push({ id: gid, label: ts?.label ?? 'Input', type: ts?.type ?? 'color', hideValue: true });
        outerEdges.push({ id: uid(), source: e.source, sourceHandle: e.sourceHandle, target: groupId, targetHandle: inHandle(gid) });
      }
      innerEdges.push({ id: uid(), source: ginId, sourceHandle: outHandle(gid), target: e.target, targetHandle: e.targetHandle });
    } else if (sIn && !tIn) {
      const key = `${e.source}|${e.sourceHandle}`;
      let gid = outKey.get(key);
      if (!gid) {
        gid = `o${outputs.length}`;
        outKey.set(key, gid);
        const ss = sockOf(e.source, e.sourceHandle, 'out');
        outputs.push({ id: gid, label: ss?.label ?? 'Output', type: ss?.type ?? 'color', hideValue: true });
        innerEdges.push({ id: uid(), source: e.source, sourceHandle: e.sourceHandle, target: goutId, targetHandle: inHandle(gid) });
      }
      outerEdges.push({ id: uid(), source: groupId, sourceHandle: outHandle(gid), target: e.target, targetHandle: e.targetHandle });
    } else outerEdges.push(e);
  }

  const gin: ShaderNode = { id: ginId, type: 'shader', position: { x: minX - 280, y: cy }, data: { kind: 'groupIn', label: 'Group Input', sockets: inputs } };
  const gout: ShaderNode = { id: goutId, type: 'shader', position: { x: maxX + 300, y: cy }, data: { kind: 'groupOut', label: 'Group Output', sockets: outputs } };
  const group: ShaderNode = {
    id: groupId,
    type: 'shader',
    position: { x: (minX + maxX) / 2, y: cy },
    selected: true,
    data: { kind: 'group', label: name, group: { nodes: [gin, ...inner, gout], edges: innerEdges, inputs, outputs } },
  };
  return { nodes: [...nodes.filter((n) => !sel.has(n.id)).map((n) => ({ ...n, selected: false })), group], edges: outerEdges, groupId };
}

/** Expand a compound node back into its nodes. */
export function ungroup(nodes: ShaderNode[], edges: Edge[], groupId: string): { nodes: ShaderNode[]; edges: Edge[] } | null {
  const g = nodes.find((n) => n.id === groupId);
  const def = g?.data.group;
  if (!g || !def) return null;
  const gin = def.nodes.find((n) => n.data.kind === 'groupIn');
  const gout = def.nodes.find((n) => n.data.kind === 'groupOut');
  const innerReal = def.nodes.filter((n) => n !== gin && n !== gout);

  // Fresh ids where they would clash with existing nodes.
  const existing = new Set(nodes.map((n) => n.id));
  const remap = new Map<string, string>();
  for (const n of innerReal) remap.set(n.id, existing.has(n.id) ? uid() : n.id);

  const xs = innerReal.map((n) => n.position.x);
  const ys = innerReal.map((n) => n.position.y);
  const dx = g.position.x - (Math.min(...xs) + Math.max(...xs)) / 2;
  const dy = g.position.y - (Math.min(...ys) + Math.max(...ys)) / 2;
  const added = innerReal.map((n) => ({ ...n, id: remap.get(n.id)!, position: { x: n.position.x + dx, y: n.position.y + dy }, selected: true }));

  const result: Edge[] = edges.filter((e) => e.source !== groupId && e.target !== groupId);
  for (const e of def.edges) {
    const fromIn = gin && e.source === gin.id;
    const toOut = gout && e.target === gout.id;
    if (fromIn && toOut) {
      // Straight pass-through inside the group.
      const sock = parseHandle(e.sourceHandle);
      const outSock = parseHandle(e.targetHandle);
      for (const a of edges.filter((x) => x.target === groupId && parseHandle(x.targetHandle) === sock))
        for (const b of edges.filter((x) => x.source === groupId && parseHandle(x.sourceHandle) === outSock))
          result.push({ id: uid(), source: a.source, sourceHandle: a.sourceHandle, target: b.target, targetHandle: b.targetHandle });
    } else if (fromIn) {
      const sock = parseHandle(e.sourceHandle);
      for (const a of edges.filter((x) => x.target === groupId && parseHandle(x.targetHandle) === sock))
        result.push({ id: uid(), source: a.source, sourceHandle: a.sourceHandle, target: remap.get(e.target)!, targetHandle: e.targetHandle });
    } else if (toOut) {
      const sock = parseHandle(e.targetHandle);
      for (const b of edges.filter((x) => x.source === groupId && parseHandle(x.sourceHandle) === sock))
        result.push({ id: uid(), source: remap.get(e.source)!, sourceHandle: e.sourceHandle, target: b.target, targetHandle: b.targetHandle });
    } else {
      result.push({ ...e, id: uid(), source: remap.get(e.source)!, target: remap.get(e.target)! });
    }
  }
  return { nodes: [...nodes.filter((n) => n.id !== groupId).map((n) => ({ ...n, selected: false })), ...added], edges: result };
}

/* ---------------- library helpers ---------------- */

/** Nodes of a saved graph that can be varied per image ("straggling" inputs): Value, RGB, Image Input. */
export const EXPOSED_KINDS = new Set(['value', 'rgb', 'input']);
export const exposedNodes = (nodes: ShaderNode[]) => nodes.filter((n) => EXPOSED_KINDS.has(n.data.kind));
