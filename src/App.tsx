import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  reconnectEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
} from '@xyflow/react';
import ShaderNodeView from './components/ShaderNode';
import ContextMenu, { type MenuItem, type MenuState } from './components/ContextMenu';
import SettingsDialog from './components/SettingsDialog';
import MediaPool from './components/MediaPool';
import Viewer from './components/Viewer';
import Toolbox from './components/Toolbox';
import { WebGLPipeline, type Op } from './gl/pipeline';
import { loadSettings, saveSettings, type Settings, type ViewerLayout } from './settings';
import {
  ALL_MEDIA,
  LOOSE,
  folderGroups,
  folderLabel,
  folderOptions,
  imagesInFolder,
  isImageFile,
  naturalCompare,
  uniqueFolderName,
} from './media';
import { defaultParams, getDef, resolveCurves, type NodeDef } from './nodes/registry';
import { curveTable } from './nodes/curves';
import { parseCube } from './nodes/lut';
import {
  isSourceKind,
  type CurvePoint,
  type HandleSide,
  type LutData,
  type MediaItem,
  type Params,
  type ShaderData,
  type ShaderNode,
} from './types';

const starter: ShaderNode[] = [
  { id: 'input', type: 'shader', position: { x: 40, y: 140 }, data: { label: 'Image Input', kind: 'input' } },
  { id: 'exposure', type: 'shader', position: { x: 300, y: 120 }, data: { label: 'Exposure', kind: 'exposure', params: defaultParams('exposure') } },
  { id: 'output', type: 'shader', position: { x: 560, y: 140 }, data: { label: 'Output', kind: 'output' } },
];

const starterEdges: Edge[] = [
  { id: 'e1', source: 'input', target: 'exposure' },
  { id: 'e2', source: 'exposure', target: 'output' },
];

/** Longest edge (px) of the GPU thumbnails drawn on top of nodes. */
const PREVIEW_SIZE = 256;
/** Longest edge (px) of grid tiles in the viewer. */
const GRID_SIZE = 1024;
/** Images decoded in parallel when importing a folder. */
const DECODE_CONCURRENCY = 6;

/** crypto.randomUUID only exists on https/localhost; fall back for LAN access over http. */
const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const closeMenus = () => document.querySelectorAll('header details[open]').forEach((d) => d.removeAttribute('open'));

/** Turn a node into a GPU operation (parameters merged with defaults, curve table, LUT). */
function buildOp(n: ShaderNode, luts: Map<string, LutData>): Op {
  const kind = n.data.kind;
  const params = { ...defaultParams(kind), ...n.data.params };
  const rows = resolveCurves(kind, n.data.curves);
  const curve = rows.length ? { ...curveTable(rows), rows: rows.length } : undefined;
  const lut = getDef(kind)?.lut ? luts.get(n.id) ?? null : undefined;
  return {
    kind,
    params,
    curve,
    lut,
    sig: `${kind}${JSON.stringify(params)}${curve?.key ?? ''}${lut?.id ?? ''}`,
  };
}

/** Walk upstream from a node to its source (Image Input / Folder Input). Ops are in processing order. */
function traceChain(
  nodeId: string,
  nodes: ShaderNode[],
  edges: Edge[],
  luts: Map<string, LutData>,
): { ops: Op[]; source: ShaderNode | null } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(edges.map((e) => [e.target, e.source]));
  const chain: ShaderNode[] = [];
  const seen = new Set<string>();
  let id: string | undefined = nodeId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const n = byId.get(id);
    if (!n) break;
    chain.unshift(n);
    if (isSourceKind(n.data.kind)) return { ops: chain.map((c) => buildOp(c, luts)), source: n };
    id = incoming.get(id);
  }
  return { ops: [], source: null };
}

/** Images a source node feeds into the graph. */
function batchFor(source: ShaderNode | null, media: MediaItem[], active: MediaItem | null): MediaItem[] {
  if (!source) return [];
  if (source.data.kind === 'input') return active ? [active] : [];
  return imagesInFolder(media, source.data.folder ?? ALL_MEDIA);
}

/** Which image of a batch to show in single view / node previews. */
const focusFor = (batch: MediaItem[], active: MediaItem | null) =>
  batch.find((m) => m.id === active?.id) ?? batch.find((m) => m.visible) ?? batch[0] ?? null;

/** Strip runtime-only callbacks/flags before saving a project. */
const serializeNode = (n: ShaderNode) => ({
  id: n.id,
  type: n.type,
  position: n.position,
  data: {
    label: n.data.label,
    kind: n.data.kind,
    params: n.data.params,
    curves: n.data.curves,
    lutName: n.data.lutName,
    showPreview: n.data.showPreview,
    folder: n.data.folder,
  } satisfies ShaderData,
});

/** Upgrade nodes from older project files. */
const migrateNode = (n: ShaderNode): ShaderNode => {
  const data = { ...n.data };
  if (data.kind === 'exposure' && data.value !== undefined && data.params?.stops === undefined) {
    data.params = { ...data.params, stops: data.value };
  }
  delete data.value;
  return { ...n, type: 'shader', data };
};

const loadImage = (file: File, folder: string) =>
  new Promise<MediaItem | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve({ id: uid(), name: file.name, url, image, folder, visible: true });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });

type RenderJob = { canvas: HTMLCanvasElement; item: MediaItem | null; ops: Op[] | null; maxSize: number };

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<ShaderNode>(starter);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(starterEdges);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [luts, setLuts] = useState<Map<string, LutData>>(new Map());
  const [status, setStatus] = useState('Import an image or folder to begin');
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const active = useMemo(() => media.find((m) => m.id === activeId) ?? null, [media, activeId]);

  const gpu = useRef<WebGLPipeline | null>(null);
  const viewerCanvases = useRef(new Map<string, HTMLCanvasElement>());
  const previewCanvases = useRef(new Map<string, HTMLCanvasElement>());
  const rendered = useRef(new WeakMap<HTMLCanvasElement, string>());
  const renderGen = useRef(0);
  const rafId = useRef(0);
  const reconnectOk = useRef(true);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const folderTargetNode = useRef<string | null>(null);

  // Latest state for stable callbacks and the render loop.
  const live = useRef({ nodes, edges, media, active, settings, luts });
  live.current = { nodes, edges, media, active, settings, luts };

  const nodeTypes = useMemo(() => ({ shader: ShaderNodeView }), []);

  useEffect(() => saveSettings(settings), [settings]);

  /* ---------- WebGL setup ---------- */
  useEffect(() => {
    if (gpu.current) return;
    try {
      gpu.current = new WebGLPipeline();
      setStatus(
        gpu.current.floatTargets
          ? 'WebGL 2 ready (16-bit float pipeline) – import an image or folder'
          : 'WebGL 2 ready (8-bit fallback: no float render targets on this GPU) – import an image or folder',
      );
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, []);

  // Close menu-bar dropdowns when clicking elsewhere.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      document.querySelectorAll('header details[open]').forEach((d) => {
        if (!d.contains(e.target as globalThis.Node)) d.removeAttribute('open');
      });
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, []);

  /* ---------- GPU render loop ---------- */
  // Renders the viewer, grid tiles and node previews in small time-sliced chunks so large batches stay responsive.
  const scheduleRender = useCallback(() => {
    const gen = ++renderGen.current;
    cancelAnimationFrame(rafId.current);

    rafId.current = requestAnimationFrame(() => {
      const { nodes: ns, edges: es, media: ms, active: act, settings: st, luts: lt } = live.current;
      const jobs: RenderJob[] = [];

      const out = ns.find((n) => n.data.kind === 'output');
      const outInfo = out ? traceChain(out.id, ns, es, lt) : { ops: [], source: null };
      const outOps = outInfo.source ? outInfo.ops : null;
      const outBatch = batchFor(outInfo.source, ms, act);
      const current = focusFor(outBatch, act);
      const viewerOn = st.previewMode !== 'hidden';

      const single = viewerCanvases.current.get('single');
      if (viewerOn && st.viewerLayout === 'single' && single) {
        jobs.push({ canvas: single, item: current, ops: outOps, maxSize: Infinity });
      }

      if (st.nodePreviews) {
        for (const n of ns) {
          const canvas = previewCanvases.current.get(n.id);
          if (!canvas) continue;
          const info = traceChain(n.id, ns, es, lt);
          const item = focusFor(batchFor(info.source, ms, act), act);
          jobs.push({ canvas, item, ops: info.source ? info.ops : null, maxSize: PREVIEW_SIZE });
        }
      }

      if (viewerOn && st.viewerLayout === 'grid') {
        for (const m of outBatch) {
          if (!m.visible) continue;
          const canvas = viewerCanvases.current.get(`tile:${m.id}`);
          if (canvas) jobs.push({ canvas, item: m, ops: outOps, maxSize: GRID_SIZE });
        }
      }

      let i = 0;
      const step = () => {
        if (gen !== renderGen.current) return; // superseded by a newer render
        const g = gpu.current;
        const t0 = performance.now();
        while (i < jobs.length && performance.now() - t0 < 12) {
          const { canvas, item, ops, maxSize } = jobs[i++];
          if (!g || !item || !ops) {
            if (rendered.current.get(canvas) !== 'empty') {
              canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
              rendered.current.set(canvas, 'empty');
            }
            continue;
          }
          // Skip canvases whose image + node chain haven't changed.
          const sig = `${item.id}|${maxSize}|${ops.map((o) => o.sig).join('>')}`;
          if (rendered.current.get(canvas) === sig) continue;
          const key = g.source(item.id, item.image, maxSize);
          g.render(key, ops);
          g.present(canvas);
          rendered.current.set(canvas, sig);
        }
        if (i < jobs.length) rafId.current = requestAnimationFrame(step);
      };
      step();
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(rafId.current), []);

  const registerViewerCanvas = useCallback(
    (key: string, el: HTMLCanvasElement | null) => {
      if (el) {
        viewerCanvases.current.set(key, el);
        scheduleRender();
      } else {
        viewerCanvases.current.delete(key);
      }
    },
    [scheduleRender],
  );

  const registerPreview = useCallback(
    (id: string, el: HTMLCanvasElement | null) => {
      if (el) {
        previewCanvases.current.set(id, el);
        scheduleRender();
      } else {
        previewCanvases.current.delete(id);
      }
    },
    [scheduleRender],
  );

  // Only re-render when graph content changes (not when nodes are dragged).
  const graphKey = useMemo(
    () =>
      JSON.stringify({
        n: nodes.map((n) => [n.id, n.data.kind, n.data.params, n.data.curves, n.data.showPreview, n.data.folder]),
        e: edges.map((e) => [e.source, e.target]),
      }),
    [nodes, edges],
  );

  useEffect(scheduleRender, [
    graphKey,
    media,
    active,
    luts,
    settings.viewerLayout,
    settings.previewMode,
    settings.nodePreviews,
    scheduleRender,
  ]);

  /* ---------- derived graph info for the UI ---------- */
  const derived = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const incoming = new Map(edges.map((e) => [e.target, e.source]));
    // Source node for each node (cheap walk, no op building).
    const sourceOf = (id: string) => {
      const seen = new Set<string>();
      let cur: string | undefined = id;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const n = byId.get(cur);
        if (!n) return null;
        if (isSourceKind(n.data.kind)) return n;
        cur = incoming.get(cur);
      }
      return null;
    };
    const out = nodes.find((n) => n.data.kind === 'output');
    const outSource = out ? sourceOf(out.id) : null;
    const batch = batchFor(outSource, media, active);
    const perNode = new Map<string, { hasImage: boolean; count: number }>();
    for (const n of nodes) {
      const b = batchFor(sourceOf(n.id), media, active);
      perNode.set(n.id, { hasImage: b.length > 0, count: b.length });
    }
    return { connected: !!outSource, batch, current: focusFor(batch, active), perNode };
  }, [nodes, edges, media, active]);

  const folderOpts = useMemo(() => folderOptions(media), [media]);

  /* ---------- node callbacks (stable) ---------- */
  const updateParams = useCallback(
    (id: string, patch: Params) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n))),
    [setNodes],
  );

  const updateCurve = useCallback(
    (id: string, channel: string, points: CurvePoint[]) =>
      setNodes((ns) =>
        ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, curves: { ...n.data.curves, [channel]: points } } } : n)),
      ),
    [setNodes],
  );

  const loadLut = useCallback(
    (id: string, file: File) => {
      file
        .text()
        .then((text) => {
          const lut = parseCube(text, file.name);
          setLuts((m) => new Map(m).set(id, lut));
          setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, lutName: file.name } } : n)));
          setStatus(`Loaded LUT ${file.name} (${lut.size}³)`);
        })
        .catch((e: Error) => setStatus(`Could not load ${file.name}: ${e.message}`));
    },
    [setNodes],
  );

  const clearLut = useCallback(
    (id: string) => {
      setLuts((m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      });
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, lutName: undefined } } : n)));
    },
    [setNodes],
  );

  const togglePreview = useCallback(
    (id: string) =>
      setNodes((ns) =>
        ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, showPreview: n.data.showPreview === false } } : n)),
      ),
    [setNodes],
  );

  const setNodeFolder = useCallback(
    (id: string, folder: string) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, folder } } : n))),
    [setNodes],
  );

  const pickFolder = useCallback((nodeId: string | null) => {
    folderTargetNode.current = nodeId;
    folderInput.current?.click();
  }, []);

  const removeEdges = useCallback((ids: string[]) => setEdges((es) => es.filter((e) => !ids.includes(e.id))), [setEdges]);

  const labelOf = useCallback((id: string) => live.current.nodes.find((n) => n.id === id)?.data.label ?? id, []);

  const onHandleClick = useCallback(
    (nodeId: string, side: HandleSide, x: number, y: number) => {
      const es = live.current.edges;
      const linked = es.filter((e) => (side === 'target' ? e.target === nodeId : e.source === nodeId));
      const items: MenuItem[] = linked.length
        ? linked.map((e) => ({
            label: side === 'target' ? `Disconnect from ${labelOf(e.source)}` : `Disconnect from ${labelOf(e.target)}`,
            danger: true,
            onSelect: () => removeEdges([e.id]),
          }))
        : [{ label: 'Not connected – drag from this socket to connect', disabled: true }];
      if (linked.length > 1) {
        items.push('separator', {
          label: `Disconnect all (${linked.length})`,
          danger: true,
          onSelect: () => removeEdges(linked.map((e) => e.id)),
        });
      }
      setMenu({ x, y, title: `${labelOf(nodeId)} · ${side === 'target' ? 'Input' : 'Output'} socket`, items });
    },
    [labelOf, removeEdges],
  );

  const onEdgeMenu = useCallback(
    (e: ReactMouseEvent, edge: Edge) => {
      e.preventDefault();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        title: `${labelOf(edge.source)} → ${labelOf(edge.target)}`,
        items: [{ label: 'Disconnect wire', danger: true, onSelect: () => removeEdges([edge.id]) }],
      });
    },
    [labelOf, removeEdges],
  );

  const wiredNodes = useMemo(
    () =>
      nodes.map((n) => {
        const info = derived.perNode.get(n.id);
        return {
          ...n,
          data: {
            ...n.data,
            previewsEnabled: settings.nodePreviews,
            hasImage: !!info?.hasImage,
            batchCount: info?.count ?? 0,
            folderOptions: folderOpts,
            lut: luts.get(n.id) ?? null,
            onParams: updateParams,
            onCurve: updateCurve,
            onLoadLut: loadLut,
            onClearLut: clearLut,
            onTogglePreview: togglePreview,
            onHandleClick,
            registerPreview,
            onFolderChange: setNodeFolder,
            onPickFolder: pickFolder,
          },
        };
      }),
    [
      nodes,
      derived,
      settings.nodePreviews,
      folderOpts,
      luts,
      updateParams,
      updateCurve,
      loadLut,
      clearLut,
      togglePreview,
      onHandleClick,
      registerPreview,
      setNodeFolder,
      pickFolder,
    ],
  );

  /* ---------- connections ---------- */
  // Prevent self-links and cycles.
  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (c.source === c.target) return false;
    const incoming = new Map(live.current.edges.map((e) => [e.target, e.source]));
    const seen = new Set<string>();
    let id: string | undefined = c.source;
    while (id && !seen.has(id)) {
      if (id === c.target) return false;
      seen.add(id);
      id = incoming.get(id);
    }
    return true;
  }, []);

  // Each input socket takes one wire: a new connection replaces the old one.
  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge(c, es.filter((e) => e.target !== c.target))),
    [setEdges],
  );

  // Drag a wire end to another socket to move it, or drop it on empty space to disconnect.
  const onReconnectStart = useCallback(() => {
    reconnectOk.current = false;
  }, []);

  const onReconnect = useCallback(
    (oldEdge: Edge, c: Connection) => {
      reconnectOk.current = true;
      setEdges((es) => reconnectEdge(oldEdge, c, es.filter((e) => e.id === oldEdge.id || e.target !== c.target)));
    },
    [setEdges],
  );

  const onReconnectEnd = useCallback(
    (_: MouseEvent | TouchEvent, edge: Edge) => {
      if (!reconnectOk.current) setEdges((es) => es.filter((e) => e.id !== edge.id));
      reconnectOk.current = true;
    },
    [setEdges],
  );

  /* ---------- media ---------- */
  const selectImage = useCallback((id: string) => {
    const m = live.current.media.find((x) => x.id === id);
    if (!m) return;
    setActiveId(id);
    setStatus(`${m.name} • ${m.image.naturalWidth}×${m.image.naturalHeight}`);
  }, []);

  const toggleVisible = useCallback(
    (id: string) => setMedia((ms) => ms.map((m) => (m.id === id ? { ...m, visible: !m.visible } : m))),
    [],
  );

  const setVisible = useCallback((ids: string[], visible: boolean) => {
    const set = new Set(ids);
    setMedia((ms) => ms.map((m) => (set.has(m.id) ? { ...m, visible } : m)));
  }, []);

  /**
   * Point a Folder Input node at a folder. Uses the given node, else a selected/existing Folder Input,
   * else creates one and moves the Image Input's wires onto it.
   */
  const assignFolder = useCallback(
    (folder: string, nodeId: string | null) => {
      const ns = live.current.nodes;
      const targetId =
        nodeId ??
        ns.find((n) => n.selected && n.data.kind === 'folder')?.id ??
        ns.find((n) => n.data.kind === 'folder')?.id;

      if (targetId) {
        setNodeFolder(targetId, folder);
        return;
      }

      const input = ns.find((n) => n.data.kind === 'input');
      const id = uid();
      setNodes((all) => [
        ...all,
        {
          id,
          type: 'shader',
          position: input ? { x: input.position.x, y: input.position.y + 240 } : { x: 40, y: 320 },
          data: { kind: 'folder', label: 'Folder Input', folder },
        },
      ]);
      if (input) setEdges((es) => es.map((e) => (e.source === input.id ? { ...e, id: `e-${uid()}`, source: id } : e)));
    },
    [setNodes, setEdges, setNodeFolder],
  );

  const importFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []).filter(isImageFile);
    if (!files.length) return;
    const items = (await Promise.all(files.map((f) => loadImage(f, LOOSE)))).filter((m): m is MediaItem => !!m);
    if (!items.length) {
      setStatus('Could not decode the selected images');
      return;
    }
    setMedia((m) => [...m, ...items]);
    const last = items[items.length - 1];
    setActiveId(last.id);
    setStatus(`${last.name} • ${last.image.naturalWidth}×${last.image.naturalHeight}`);
  };

  const importFolder = async (list: FileList | null) => {
    const targetNode = folderTargetNode.current;
    folderTargetNode.current = null;

    const files = Array.from(list ?? [])
      .filter(isImageFile)
      .sort((a, b) => naturalCompare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name));
    if (!files.length) {
      setStatus('No images found in that folder');
      return;
    }

    const root = (files[0].webkitRelativePath || '').split('/')[0] || 'Folder';
    const folder = uniqueFolderName(root, live.current.media);

    // Decode with limited concurrency, reporting progress.
    const results: (MediaItem | null)[] = new Array(files.length).fill(null);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        results[i] = await loadImage(files[i], folder);
        done++;
        if (done % 5 === 0 || done === files.length) setStatus(`Loading “${root}” ${done}/${files.length}…`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DECODE_CONCURRENCY, files.length) }, worker));

    const items = results.filter((m): m is MediaItem => !!m);
    const failed = files.length - items.length;
    if (!items.length) {
      setStatus(`No images in “${root}” could be decoded by this browser`);
      return;
    }

    setMedia((m) => [...m, ...items]);
    setActiveId(items[0].id);
    assignFolder(folder, targetNode);
    if (items.length > 1) setSettings((s) => ({ ...s, viewerLayout: 'grid' }));
    setStatus(`${folderLabel(folder)} • ${items.length} images${failed ? ` (${failed} could not be decoded)` : ''}`);
  };

  const stepImage = (dir: 1 | -1) => {
    const shown = derived.batch.filter((m) => m.visible);
    const pool = shown.length ? shown : derived.batch;
    if (!pool.length) return;
    const i = pool.findIndex((m) => m.id === derived.current?.id);
    selectImage(pool[(i + dir + pool.length) % pool.length].id);
  };

  const setLayout = (viewerLayout: ViewerLayout) => setSettings((s) => ({ ...s, viewerLayout }));

  /* ---------- graph editing ---------- */
  const addNode = (def: NodeDef) => {
    const groups = folderGroups(media);
    setNodes((ns) => [
      ...ns,
      {
        id: uid(),
        type: 'shader',
        position: { x: 220 + Math.random() * 180, y: 80 + Math.random() * 200 },
        data: {
          kind: def.kind,
          label: def.label,
          params: defaultParams(def.kind),
          folder: def.kind === 'folder' ? groups[groups.length - 1]?.key ?? ALL_MEDIA : undefined,
        },
      },
    ]);
  };

  const deleteSelected = () => {
    const gone = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    setNodes((ns) => ns.filter((n) => !n.selected));
    setEdges((es) => es.filter((e) => !e.selected && !gone.has(e.source) && !gone.has(e.target)));
  };

  /* ---------- project files ---------- */
  const save = () => {
    const lutTexts: Record<string, { name: string; text: string }> = {};
    for (const n of nodes) {
      const lut = luts.get(n.id);
      if (lut) lutTexts[n.id] = { name: lut.name, text: lut.text };
    }
    const project = { version: 4, nodes: nodes.map(serializeNode), edges, luts: lutTexts };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nodegl-project.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const load = (file: File) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const p = JSON.parse(String(r.result));
        const loaded = new Map<string, LutData>();
        const failed: string[] = [];
        for (const [id, entry] of Object.entries((p.luts ?? {}) as Record<string, { name: string; text: string }>)) {
          try {
            loaded.set(id, parseCube(entry.text, entry.name));
          } catch {
            failed.push(entry.name);
          }
        }
        setNodes((p.nodes as ShaderNode[]).map(migrateNode));
        setEdges(p.edges);
        setLuts(loaded);
        setStatus(failed.length ? `Project loaded – could not read LUT(s): ${failed.join(', ')}` : 'Project loaded');
      } catch {
        setStatus('Could not read project');
      }
    };
    r.readAsText(file);
  };

  const menuAction = (fn: () => void) => () => {
    fn();
    closeMenus();
  };

  const centerStyle = {
    '--wire-width': `${settings.wireWidth}px`,
    '--bg-dim': settings.backgroundDim,
  } as CSSProperties;

  const check = (on: boolean) => (on ? '✓ ' : '');

  return (
    <div className="app">
      {/* Shared hidden folder picker (Media Pool, File menu and Folder Input nodes). */}
      <input
        ref={(el) => {
          folderInput.current = el;
          el?.setAttribute('webkitdirectory', '');
        }}
        hidden
        type="file"
        multiple
        onChange={(e) => {
          void importFolder(e.target.files);
          e.target.value = '';
        }}
      />

      <header>
        <strong>NodeGL</strong>
        <nav>
          <details>
            <summary>File</summary>
            <div>
              <label>
                Import images…
                <input
                  hidden
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => {
                    void importFiles(e.target.files);
                    e.target.value = '';
                    closeMenus();
                  }}
                />
              </label>
              <button onClick={menuAction(() => pickFolder(null))}>Import folder…</button>
              <hr />
              <button onClick={menuAction(save)}>Save project</button>
              <label>
                Open project…
                <input
                  hidden
                  type="file"
                  accept="application/json"
                  onChange={(e) => {
                    if (e.target.files?.[0]) load(e.target.files[0]);
                    e.target.value = '';
                    closeMenus();
                  }}
                />
              </label>
            </div>
          </details>
          <details>
            <summary>Edit</summary>
            <div>
              <button onClick={menuAction(deleteSelected)}>Delete selected</button>
              <button onClick={menuAction(() => setEdges([]))}>Disconnect all wires</button>
              <hr />
              <button onClick={menuAction(() => setVisible(media.map((m) => m.id), true))}>Show all images</button>
              <button onClick={menuAction(() => setVisible(media.map((m) => m.id), false))}>Hide all images</button>
              <hr />
              <button
                onClick={menuAction(() => {
                  setNodes(starter);
                  setEdges(starterEdges);
                  setLuts(new Map());
                })}
              >
                Reset graph
              </button>
            </div>
          </details>
          <details>
            <summary>Window</summary>
            <div>
              <button onClick={menuAction(() => setSettings((s) => ({ ...s, previewMode: 'split' })))}>
                {check(settings.previewMode === 'split')}Viewer panel
              </button>
              <button onClick={menuAction(() => setSettings((s) => ({ ...s, previewMode: 'background' })))}>
                {check(settings.previewMode === 'background')}Output behind nodes
              </button>
              <button onClick={menuAction(() => setSettings((s) => ({ ...s, previewMode: 'hidden' })))}>
                {check(settings.previewMode === 'hidden')}Hide viewer
              </button>
              <hr />
              <button onClick={menuAction(() => setLayout('single'))}>{check(settings.viewerLayout === 'single')}Single image view</button>
              <button onClick={menuAction(() => setLayout('grid'))}>{check(settings.viewerLayout === 'grid')}Grid view</button>
              <hr />
              <button onClick={menuAction(() => setSettings((s) => ({ ...s, nodePreviews: !s.nodePreviews })))}>
                {check(settings.nodePreviews)}Node previews
              </button>
              <hr />
              <button onClick={menuAction(() => document.documentElement.requestFullscreen())}>Fullscreen</button>
              <button onClick={menuAction(() => setShowSettings(true))}>Settings…</button>
            </div>
          </details>
          <details>
            <summary>Help</summary>
            <div className="help">
              <p>
                <b>Nodes:</b> Toolbox → Tone and Colour. Double-click any slider to reset it. Curves: click to add a point, drag, double-click a
                point to delete.
              </p>
              <p>
                <b>Colour:</b> images are processed in linear light (16-bit float where supported) and encoded to sRGB for display.
              </p>
              <p>
                <b>Batch:</b> import a folder (Media Pool “+ Folder” or File → Import folder…). A Folder Input node processes every image in
                it through the same graph. Auto nodes adapt to each image.
              </p>
              <p>
                <b>Display:</b> switch Single / Grid in the viewer bar. Tick images in the Media Pool (or use Show all / Hide all) to choose
                what the grid shows.
              </p>
              <p>
                <b>Wires:</b> drag between sockets to connect. Click a socket or wire to disconnect, or drag a wire end into empty space.
              </p>
            </div>
          </details>
        </nav>
        <span className="status">{status}</span>
        <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
      </header>

      <main>
        <MediaPool
          media={media}
          activeId={activeId}
          onSelect={selectImage}
          onToggleVisible={toggleVisible}
          onSetVisible={setVisible}
          onUseFolder={(folder) => {
            assignFolder(folder, null);
            setStatus(`${folderLabel(folder)} is now the Folder Input batch`);
          }}
          onImportFiles={(list) => void importFiles(list)}
          onImportFolder={() => pickFolder(null)}
        />

        <section className={`center view-${settings.previewMode}`} style={centerStyle}>
          {settings.previewMode !== 'hidden' && (
            <Viewer
              layout={settings.viewerLayout}
              onLayout={setLayout}
              batch={derived.batch}
              current={derived.current}
              connected={derived.connected}
              hasMedia={media.length > 0}
              tileSize={settings.gridTileSize}
              onSelect={selectImage}
              onStep={stepImage}
              onToggleVisible={toggleVisible}
              onSetVisible={setVisible}
              registerCanvas={registerViewerCanvas}
            />
          )}
          <div className="graph">
            <ReactFlow
              nodes={wiredNodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onReconnect={onReconnect}
              onReconnectStart={onReconnectStart}
              onReconnectEnd={onReconnectEnd}
              isValidConnection={isValidConnection}
              onEdgeClick={onEdgeMenu}
              onEdgeContextMenu={onEdgeMenu}
              onPaneClick={() => setMenu(null)}
              nodeTypes={nodeTypes}
              connectOnClick={false}
              connectionRadius={36}
              colorMode="dark"
              minZoom={0.2}
              fitView
              deleteKeyCode={['Backspace', 'Delete']}
            >
              <Background color="#4a5266" gap={18} />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
        </section>

        <Toolbox onAdd={addNode} />
      </main>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {showSettings && <SettingsDialog settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
