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
  type ReactFlowInstance,
  SelectionMode,
} from '@xyflow/react';
import ShaderNodeView from './components/ShaderNode';
import ContextMenu, { type MenuItem, type MenuState } from './components/ContextMenu';
import SettingsDialog from './components/SettingsDialog';
import MediaPool from './components/MediaPool';
import Viewer, { type ViewItem } from './components/Viewer';
import Toolbox from './components/Toolbox';
import ImageGraphPanel from './components/ImageGraphPanel';
import Splitter from './components/Splitter';
import ExportDialog from './components/ExportDialog';
import { WebGLPipeline, type RenderItem } from './gl/pipeline';
import { LAYOUT_LIMITS, defaultSettings, loadSettings, saveSettings, type Settings, type ViewerLayout, type ViewSource } from './settings';
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
  type DroppedFile,
} from './media';
import {
  ZIP_MAX_BYTES,
  downloadBlob,
  encodeCanvas,
  exportName,
  loadExportOptions,
  makeZip,
  saveExportOptions,
  type ExportOptions,
  type ExportScope,
} from './export';
import { NODE_DEFS, defaultParams, getDef, type NodeDef } from './nodes/registry';
import {
  DEFAULT_RAMP,
  cleanEdge,
  cleanNode,
  flatten,
  inHandle,
  makeGroup,
  migrateGraph,
  outHandle,
  outputPlan,
  previewPlan,
  socketsOf,
  ungroup,
  type FlatGraph,
  type Plan,
} from './nodes/graph';
import { parseCube } from './nodes/lut';
import { graphsInFile, loadPresets, makePreset, missingBuiltins, savePresets } from './library';
import {
  deleteImages,
  getImage,
  loadMediaMeta,
  loadWorkspace,
  putImage,
  requestPersistence,
  saveMediaMeta,
  saveWorkspace,
} from './persist';
import type {
  CurvePoint,
  GraphPreset,
  HandleSide,
  LutData,
  MediaItem,
  Params,
  Ramp,
  ShaderNode,
} from './types';

/* ---------------- constants & helpers ---------------- */

const starter: ShaderNode[] = [
  { id: 'input', type: 'shader', position: { x: 40, y: 140 }, data: { label: 'Image Input', kind: 'input', params: defaultParams('input') } },
  { id: 'exposure', type: 'shader', position: { x: 300, y: 120 }, data: { label: 'Exposure', kind: 'exposure', params: defaultParams('exposure') } },
  { id: 'output', type: 'shader', position: { x: 560, y: 140 }, data: { label: 'Output', kind: 'output' } },
];

const starterEdges: Edge[] = [
  { id: 'e1', source: 'input', sourceHandle: outHandle('image'), target: 'exposure', targetHandle: inHandle('image') },
  { id: 'e2', source: 'exposure', sourceHandle: outHandle('image'), target: 'output', targetHandle: inHandle('image') },
];

/** "Original" graph for images without an assigned saved graph (Library view). */
const IDENTITY_FLAT = flatten(
  [
    { id: 'i', type: 'shader', position: { x: 0, y: 0 }, data: { kind: 'input', label: 'Image Input' } },
    { id: 'o', type: 'shader', position: { x: 0, y: 0 }, data: { kind: 'output', label: 'Output' } },
  ],
  [{ id: 'e', source: 'i', sourceHandle: outHandle('image'), target: 'o', targetHandle: inHandle('image') }],
);
const IDENTITY_PLAN = outputPlan(IDENTITY_FLAT);

/** Longest edge (px) of the GPU thumbnails drawn on top of nodes. */
const PREVIEW_SIZE = 256;
/** Longest edge (px) of grid tiles in the viewer. */
const GRID_SIZE = 1024;
/** Images decoded in parallel when importing a folder. */
const DECODE_CONCURRENCY = 6;
const CANVAS_ID = '__canvas';

/** crypto.randomUUID only exists on https/localhost; fall back for LAN access over http. */
const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const closeMenus = () => document.querySelectorAll('header details[open]').forEach((d) => d.removeAttribute('open'));

const download = (data: unknown, name: string) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

const toRenderItem = (m: MediaItem): RenderItem => ({ id: m.id, image: m.image, width: m.image.naturalWidth, height: m.image.naturalHeight });

/** A row in the viewer: media image or the procedural canvas. */
type Entry = { view: ViewItem; render: RenderItem; media?: MediaItem };

const loadImage = (file: File, folder: string) =>
  new Promise<MediaItem | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve({ id: uid(), name: file.name, url, image, folder, visible: true, blob: file });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });

/** Decode an image restored from the previous session. */
const decodeStored = (blob: Blob, meta: Pick<MediaItem, 'id' | 'name' | 'folder' | 'visible' | 'graph'>) =>
  new Promise<MediaItem | null>((resolve) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve({ ...meta, url, image, blob });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });

/** Workspace graph from the previous session (or the starter graph). */
function initialWorkspace() {
  const saved = loadWorkspace();
  if (saved) {
    try {
      const g = migrateGraph(saved.nodes, saved.edges);
      if (g.nodes.length) return { ...g, luts: parseLuts(saved.luts).map };
    } catch {
      /* fall through to the starter graph */
    }
  }
  return { nodes: starter, edges: starterEdges, luts: new Map<string, LutData>() };
}

/** All node ids in a graph, including inside groups. */
const allNodeIds = (nodes: ShaderNode[], out = new Set<string>()) => {
  for (const n of nodes) {
    out.add(n.id);
    if (n.data.group) allNodeIds(n.data.group.nodes, out);
  }
  return out;
};

const parseLuts = (luts: Record<string, { name: string; text: string }> | undefined) => {
  const map = new Map<string, LutData>();
  const failed: string[] = [];
  for (const [id, entry] of Object.entries(luts ?? {})) {
    try {
      map.set(id, parseCube(entry.text, entry.name));
    } catch {
      failed.push(entry.name);
    }
  }
  return { map, failed };
};

const lutIdMap = (luts: Map<string, LutData>) => new Map([...luts].map(([k, v]) => [k, v.id]));

/** Editing stack for compound nodes: the outer graph levels above the one being edited. */
type Frame = { groupId: string; label: string; nodes: ShaderNode[]; edges: Edge[] };

type RenderJob = { canvas: HTMLCanvasElement; plan: Plan | null; item: RenderItem | null; maxSize: number; luts: Map<string, LutData> };

export default function App() {
  const [initial] = useState(initialWorkspace);
  const [nodes, setNodes, onNodesChange] = useNodesState<ShaderNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [stack, setStack] = useState<Frame[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [luts, setLuts] = useState<Map<string, LutData>>(initial.luts);
  const [presets, setPresets] = useState<GraphPreset[]>(loadPresets);
  const [status, setStatus] = useState('Import an image or folder to begin');
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showExport, setShowExport] = useState(false);
  /** Workspace: left-drag draws a selection box instead of panning. */
  const [boxSelect, setBoxSelect] = useState(false);
  /** Last mass delete, for Undo (Ctrl/⌘+Z). */
  const [undoDelete, setUndoDelete] = useState<{ nodes: ShaderNode[]; edges: Edge[]; luts: Map<string, LutData>; count: number } | null>(null);
  /** True while the pointer was last used in the node workspace (scopes Ctrl/⌘+A and Delete). */
  const graphActive = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [exportOpts, setExportOpts] = useState<ExportOptions>(loadExportOptions);

  const active = useMemo(() => media.find((m) => m.id === activeId) ?? null, [media, activeId]);

  const gpu = useRef<WebGLPipeline | null>(null);
  const rf = useRef<ReactFlowInstance<ShaderNode, Edge> | null>(null);
  const graphDiv = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  const dragBase = useRef(0);
  const viewerCanvases = useRef(new Map<string, HTMLCanvasElement>());
  const previewCanvases = useRef(new Map<string, HTMLCanvasElement>());
  const rendered = useRef(new WeakMap<HTMLCanvasElement, string>());
  const renderGen = useRef(0);
  const rafId = useRef(0);
  const reconnectOk = useRef(true);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const folderTargetNode = useRef<string | null>(null);
  const libraryFlats = useRef(new Map<string, FlatGraph>());

  // Parsed LUTs of saved graphs.
  const presetLuts = useMemo(() => new Map(presets.map((p) => [p.id, parseLuts(p.luts).map])), [presets]);
  useEffect(() => libraryFlats.current.clear(), [presets]);

  // Latest state for stable callbacks and the render loop.
  const live = useRef({ nodes, edges, stack, media, active, settings, luts, presets, presetLuts });
  live.current = { nodes, edges, stack, media, active, settings, luts, presets, presetLuts };

  const nodeTypes = useMemo(() => ({ shader: ShaderNodeView }), []);

  useEffect(() => saveSettings(settings), [settings]);

  /* ---------- graph levels (compound nodes) ---------- */

  /** The full graph: current level folded back into its parent groups. */
  const rootGraph = useCallback((): { nodes: ShaderNode[]; edges: Edge[] } => {
    const { nodes: ns, edges: es, stack: st } = live.current;
    let curN = ns;
    let curE = es;
    for (let i = st.length - 1; i >= 0; i--) {
      const f = st[i];
      const innerN = curN.map(cleanNode);
      const innerE = curE.map(cleanEdge);
      curN = f.nodes.map((n) =>
        n.id === f.groupId && n.data.group ? { ...n, data: { ...n.data, group: { ...n.data.group, nodes: innerN, edges: innerE } } } : n,
      );
      curE = f.edges;
    }
    return { nodes: curN, edges: curE };
  }, []);

  const pathPrefix = (st: Frame[]) => st.map((f) => `${f.groupId}/`).join('');

  const fitSoon = () => setTimeout(() => rf.current?.fitView({ padding: 0.2, duration: 200 }), 30);

  const enterGroup = useCallback(
    (id: string) => {
      const { nodes: ns, edges: es } = live.current;
      const g = ns.find((n) => n.id === id);
      if (!g?.data.group) return;
      setStack((s) => [...s, { groupId: id, label: g.data.label, nodes: ns, edges: es }]);
      // Group Input / Output define the group's sockets – keep them.
      setNodes(g.data.group.nodes.map((n) => ({ ...n, selected: false, deletable: n.data.kind !== 'groupIn' && n.data.kind !== 'groupOut' })));
      setEdges(g.data.group.edges);
      setMenu(null);
      fitSoon();
    },
    [setNodes, setEdges],
  );

  /** Leave group levels until `depth` levels remain. */
  const exitTo = useCallback(
    (depth: number) => {
      const { stack: st } = live.current;
      if (depth >= st.length) return;
      let curN = live.current.nodes;
      let curE = live.current.edges;
      for (let i = st.length - 1; i >= depth; i--) {
        const f = st[i];
        const innerN = curN.map(cleanNode);
        const innerE = curE.map(cleanEdge);
        curN = f.nodes.map((n) =>
          n.id === f.groupId && n.data.group ? { ...n, data: { ...n.data, group: { ...n.data.group, nodes: innerN, edges: innerE } } } : n,
        );
        curE = f.edges;
      }
      setStack(st.slice(0, depth));
      setNodes(curN);
      setEdges(curE);
      fitSoon();
    },
    [setNodes, setEdges],
  );

  /* ---------- WebGL setup ---------- */
  useEffect(() => {
    if (gpu.current) return;
    try {
      gpu.current = new WebGLPipeline();
      const failed = gpu.current.warmUp(NODE_DEFS.map((d) => d.kind));
      setStatus(
        (gpu.current.floatTargets ? 'WebGL 2 ready (16-bit float pipeline)' : 'WebGL 2 ready (8-bit fallback: no float render targets on this GPU)') +
          (failed.length ? ` – shaders failed: ${failed.join(', ')} (see console)` : ' – import an image or folder'),
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

  /* ---------- batches ---------- */

  const canvasEntry = (st: Settings): Entry => ({
    view: { id: CANVAS_ID, name: `Procedural canvas ${st.canvasWidth}×${st.canvasHeight}`, visible: true },
    render: { id: CANVAS_ID, image: null, width: st.canvasWidth, height: st.canvasHeight },
  });
  const mediaEntry = (m: MediaItem, badge?: string): Entry => ({ view: { id: m.id, name: m.name, visible: m.visible, badge }, render: toRenderItem(m), media: m });

  /** Items a workspace plan processes. */
  const entriesFor = (plan: Plan, ms: MediaItem[], act: MediaItem | null, st: Settings): Entry[] => {
    if (!plan.target) return [];
    if (plan.folder !== undefined) return imagesInFolder(ms, plan.folder).map((m) => mediaEntry(m));
    if (plan.usesCurrent) return act ? [mediaEntry(act)] : [];
    if (plan.mediaIds.length) {
      const m = ms.find((x) => x.id === plan.mediaIds[0]);
      return m ? [mediaEntry(m)] : [];
    }
    return [canvasEntry(st)];
  };

  const focusFor = (batch: Entry[], act: MediaItem | null) =>
    batch.find((e) => e.view.id === act?.id) ?? batch.find((e) => e.view.visible) ?? batch[0] ?? null;

  /** Library: flattened saved graph for an image (with its per-image overrides). */
  const libraryPlan = (m: MediaItem): { plan: Plan; luts: Map<string, LutData> } => {
    const { presets: ps, presetLuts: pl } = live.current;
    const preset = m.graph && ps.find((p) => p.id === m.graph!.presetId);
    if (!preset) return { plan: IDENTITY_PLAN, luts: new Map() };
    const lt = pl.get(preset.id) ?? new Map<string, LutData>();
    const key = `${preset.id}|${JSON.stringify(m.graph!.overrides)}`;
    let flat = libraryFlats.current.get(key);
    if (!flat) {
      flat = flatten(preset.nodes, preset.edges, m.graph!.overrides);
      libraryFlats.current.set(key, flat);
      if (libraryFlats.current.size > 256) libraryFlats.current.delete(libraryFlats.current.keys().next().value as string);
    }
    return { plan: outputPlan(flat, lutIdMap(lt)), luts: lt };
  };

  const presetName = useCallback((m: MediaItem) => live.current.presets.find((p) => p.id === m.graph?.presetId)?.name, []);

  /* ---------- GPU render loop ---------- */
  // Renders the viewer, grid tiles and node previews in time-sliced chunks so large batches stay responsive.
  const scheduleRender = useCallback(() => {
    const gen = ++renderGen.current;
    cancelAnimationFrame(rafId.current);

    rafId.current = requestAnimationFrame(() => {
      const { media: ms, active: act, settings: st, luts: lt, stack: stk } = live.current;
      const root = rootGraph();
      const flat = flatten(root.nodes, root.edges);
      const lutIds = lutIdMap(lt);
      const jobs: RenderJob[] = [];
      const viewerOn = st.previewMode !== 'hidden';

      if (viewerOn) {
        if (st.viewSource === 'workspace') {
          const plan = outputPlan(flat, lutIds);
          const batch = entriesFor(plan, ms, act, st);
          const current = focusFor(batch, act);
          const single = viewerCanvases.current.get('single');
          if (st.viewerLayout === 'single' && single) jobs.push({ canvas: single, plan, item: current?.render ?? null, maxSize: Infinity, luts: lt });
          if (st.viewerLayout === 'grid')
            for (const e of batch) {
              const canvas = e.view.visible && viewerCanvases.current.get(`tile:${e.view.id}`);
              if (canvas) jobs.push({ canvas, plan, item: e.render, maxSize: GRID_SIZE, luts: lt });
            }
        } else {
          const single = viewerCanvases.current.get('single');
          const cur = act ?? ms.find((m) => m.visible) ?? ms[0];
          if (st.viewerLayout === 'single' && single && cur) {
            const lp = libraryPlan(cur);
            jobs.push({ canvas: single, plan: lp.plan, item: toRenderItem(cur), maxSize: Infinity, luts: lp.luts });
          }
          if (st.viewerLayout === 'grid')
            for (const m of ms) {
              const canvas = m.visible && viewerCanvases.current.get(`tile:${m.id}`);
              if (!canvas) continue;
              const lp = libraryPlan(m);
              jobs.push({ canvas, plan: lp.plan, item: toRenderItem(m), maxSize: GRID_SIZE, luts: lp.luts });
            }
        }
      }

      if (st.nodePreviews) {
        const prefix = pathPrefix(stk);
        for (const [id, canvas] of previewCanvases.current) {
          const plan = previewPlan(flat, prefix + id, lutIds);
          const item = focusFor(entriesFor(plan, ms, act, st), act);
          jobs.push({ canvas, plan, item: item?.render ?? null, maxSize: PREVIEW_SIZE, luts: lt });
        }
      }

      const lookup = (id: string) => {
        const m = live.current.media.find((x) => x.id === id);
        return m ? toRenderItem(m) : null;
      };

      let i = 0;
      const step = () => {
        if (gen !== renderGen.current) return; // superseded by a newer render
        const g = gpu.current;
        const t0 = performance.now();
        while (i < jobs.length && performance.now() - t0 < 12) {
          const { canvas, plan, item, maxSize, luts: jl } = jobs[i++];
          if (!g || !item || !plan?.target) {
            if (rendered.current.get(canvas) !== 'empty') {
              canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
              rendered.current.set(canvas, 'empty');
            }
            continue;
          }
          // Skip canvases whose image + graph haven't changed.
          const sig = `${item.id}|${item.width}x${item.height}|${maxSize}|${plan.sig}`;
          if (rendered.current.get(canvas) === sig) continue;
          if (g.render(plan, { item, maxSize, media: lookup, luts: jl })) g.present(canvas);
          rendered.current.set(canvas, sig);
        }
        if (i < jobs.length) rafId.current = requestAnimationFrame(step);
      };
      step();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootGraph]);

  useEffect(() => () => cancelAnimationFrame(rafId.current), []);

  const registerViewerCanvas = useCallback(
    (key: string, el: HTMLCanvasElement | null) => {
      if (el) {
        viewerCanvases.current.set(key, el);
        scheduleRender();
      } else viewerCanvases.current.delete(key);
    },
    [scheduleRender],
  );

  const registerPreview = useCallback(
    (id: string, el: HTMLCanvasElement | null) => {
      if (el) {
        previewCanvases.current.set(id, el);
        scheduleRender();
      } else previewCanvases.current.delete(id);
    },
    [scheduleRender],
  );

  // Only re-render when graph content changes (not when nodes are dragged).
  const graphKey = useMemo(
    () =>
      JSON.stringify({
        n: nodes.map((n) => [n.id, n.data.kind, n.data.params, n.data.curves, n.data.ramp, n.data.bypass, n.data.showPreview, n.data.folder, n.data.group ? n.data.group.edges.length : 0]),
        e: edges.map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle]),
        s: stack.map((f) => f.groupId),
      }),
    [nodes, edges, stack],
  );

  useEffect(scheduleRender, [
    graphKey,
    media,
    active,
    luts,
    presets,
    settings.viewerLayout,
    settings.previewMode,
    settings.nodePreviews,
    settings.viewSource,
    settings.canvasWidth,
    settings.canvasHeight,
    scheduleRender,
  ]);

  /* ---------- derived info for the UI ---------- */
  const derived = useMemo(() => {
    const root = rootGraph();
    const flat = flatten(root.nodes, root.edges);
    const prefix = pathPrefix(stack);
    const perNode = new Map<string, { hasImage: boolean; count: number }>();
    for (const n of nodes) {
      const b = entriesFor(previewPlan(flat, prefix + n.id), media, active, settings);
      perNode.set(n.id, { hasImage: b.length > 0, count: n.data.kind === 'folder' ? imagesInFolder(media, n.data.folder ?? ALL_MEDIA).length : b.length });
    }

    let batch: Entry[];
    let message: string | null = null;
    if (settings.viewSource === 'workspace') {
      const plan = outputPlan(flat);
      batch = entriesFor(plan, media, active, settings);
      if (!plan.target) message = media.length ? 'Output is not connected – connect an Image Input, Folder Input or texture to Output' : 'Import an image or folder, or connect a texture node to Output';
      else if (!batch.length) message = !media.length ? 'Import an image or folder to begin' : plan.usesCurrent ? 'Select an image in the Media Pool' : 'The connected input has no images';
    } else {
      batch = media.map((m) => mediaEntry(m, presetName(m)));
      if (!media.length) message = 'Import images, then apply saved graphs to them (Toolbox → Library)';
    }
    return { batch, current: focusFor(batch, active), message, perNode };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, stack, media, active, settings, presets, rootGraph, presetName]);

  const folderOpts = useMemo(() => folderOptions(media), [media]);
  const mediaOpts = useMemo(() => media.map((m) => ({ id: m.id, name: m.name })), [media]);

  /* ---------- node callbacks (stable) ---------- */
  const patchNode = useCallback(
    (id: string, fn: (d: ShaderNode['data']) => Partial<ShaderNode['data']>) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...fn(n.data) } } : n))),
    [setNodes],
  );

  const updateParams = useCallback((id: string, patch: Params) => patchNode(id, (d) => ({ params: { ...d.params, ...patch } })), [patchNode]);
  const updateCurve = useCallback(
    (id: string, channel: string, points: CurvePoint[]) => patchNode(id, (d) => ({ curves: { ...d.curves, [channel]: points } })),
    [patchNode],
  );
  const updateRamp = useCallback((id: string, ramp: Ramp) => patchNode(id, () => ({ ramp })), [patchNode]);
  const toggleBypass = useCallback((id: string) => patchNode(id, (d) => ({ bypass: !d.bypass })), [patchNode]);
  /** Reset a node's values (parameters, inline inputs, curves, ramp) to defaults. Keeps name, wires, LUT file, folder and bypass. */
  const resetData = (d: ShaderNode['data']): Partial<ShaderNode['data']> => ({
    params: defaultParams(d.kind),
    curves: undefined,
    ramp: getDef(d.kind)?.ramp ? structuredClone(DEFAULT_RAMP) : undefined,
  });
  const resetNode = useCallback((id: string) => patchNode(id, resetData), [patchNode]);
  const renameNode = useCallback((id: string, label: string) => patchNode(id, () => ({ label })), [patchNode]);
  const togglePreview = useCallback((id: string) => patchNode(id, (d) => ({ showPreview: d.showPreview === false })), [patchNode]);
  const setNodeFolder = useCallback((id: string, folder: string) => patchNode(id, () => ({ folder })), [patchNode]);

  const loadLut = useCallback(
    (id: string, file: File) => {
      file
        .text()
        .then((text) => {
          const lut = parseCube(text, file.name);
          setLuts((m) => new Map(m).set(id, lut));
          patchNode(id, () => ({ lutName: file.name }));
          setStatus(`Loaded LUT ${file.name} (${lut.size}³)`);
        })
        .catch((e: Error) => setStatus(`Could not load ${file.name}: ${e.message}`));
    },
    [patchNode],
  );

  const clearLut = useCallback(
    (id: string) => {
      setLuts((m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      });
      patchNode(id, () => ({ lutName: undefined }));
    },
    [patchNode],
  );

  const pickFolder = useCallback((nodeId: string | null) => {
    folderTargetNode.current = nodeId;
    folderInput.current?.click();
  }, []);

  const removeEdges = useCallback((ids: string[]) => setEdges((es) => es.filter((e) => !ids.includes(e.id))), [setEdges]);

  const labelOf = useCallback((id: string) => live.current.nodes.find((n) => n.id === id)?.data.label ?? id, []);

  const onHandleClick = useCallback(
    (nodeId: string, side: HandleSide, socket: string, x: number, y: number) => {
      const es = live.current.edges;
      const linked = es.filter((e) =>
        side === 'target' ? e.target === nodeId && e.targetHandle === inHandle(socket) : e.source === nodeId && e.sourceHandle === outHandle(socket),
      );
      const items: MenuItem[] = linked.length
        ? linked.map((e) => ({
            label: side === 'target' ? `Disconnect from ${labelOf(e.source)}` : `Disconnect from ${labelOf(e.target)}`,
            danger: true,
            onSelect: () => removeEdges([e.id]),
          }))
        : [{ label: 'Not connected – drag from this socket to connect', disabled: true }];
      if (linked.length > 1) {
        items.push('separator', { label: `Disconnect all (${linked.length})`, danger: true, onSelect: () => removeEdges(linked.map((e) => e.id)) });
      }
      setMenu({ x, y, title: `${labelOf(nodeId)} · ${socket}`, items });
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

  /* ---------- grouping ---------- */
  const groupSelected = useCallback(() => {
    const { nodes: ns, edges: es } = live.current;
    const ids = ns.filter((n) => n.selected).map((n) => n.id);
    const r = makeGroup(ns, es, ids);
    if (!r) {
      setStatus('Select one or more nodes (not Output) to group');
      return;
    }
    setNodes(r.nodes);
    setEdges(r.edges);
    setStatus('Grouped – press Tab (or the edit button) to open the group, Ctrl/⌘+Shift+G to ungroup');
  }, [setNodes, setEdges]);

  const ungroupSelected = useCallback(() => {
    let { nodes: ns, edges: es } = live.current;
    const groups = ns.filter((n) => n.selected && n.data.kind === 'group');
    if (!groups.length) {
      setStatus('Select a group node to ungroup');
      return;
    }
    for (const g of groups) {
      const r = ungroup(ns, es, g.id);
      if (r) ({ nodes: ns, edges: es } = r);
    }
    setNodes(ns);
    setEdges(es);
  }, [setNodes, setEdges]);

  const resetNodes = useCallback(
    (which: 'selected' | 'all') => {
      const target = live.current.nodes.filter((n) => (which === 'all' || n.selected) && getDef(n.data.kind));
      if (!target.length) {
        setStatus(which === 'all' ? 'No nodes to reset' : 'Select nodes to reset');
        return;
      }
      if (which === 'all' && !window.confirm(`Reset the values of all ${target.length} nodes on this level to their defaults?`)) return;
      const ids = new Set(target.map((n) => n.id));
      setNodes((all) => all.map((n) => (ids.has(n.id) ? { ...n, data: { ...n.data, ...resetData(n.data) } } : n)));
      setStatus(`Reset ${target.length} node${target.length === 1 ? '' : 's'} to default values`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setNodes],
  );

  const toggleBypassSelected = useCallback(() => {
    const sel = live.current.nodes.filter((n) => n.selected && n.data.kind !== 'output' && n.data.kind !== 'groupIn' && n.data.kind !== 'groupOut');
    if (!sel.length) return;
    const on = !sel.every((n) => n.data.bypass);
    const ids = new Set(sel.map((n) => n.id));
    setNodes((all) => all.map((n) => (ids.has(n.id) ? { ...n, data: { ...n.data, bypass: on } } : n)));
  }, [setNodes]);

  /* ---------- mass selection & delete ---------- */
  /** Group Input / Output define a group's sockets and can't be deleted. */
  const deletable = (n: ShaderNode) => n.data.kind !== 'groupIn' && n.data.kind !== 'groupOut';

  /** Delete nodes (by id) and selected wires, keeping one step of undo. */
  const deleteNodes = useCallback(
    (ids: Set<string>, alsoSelectedEdges = true) => {
      const { nodes: ns, edges: es, luts: lt } = live.current;
      let gone = new Set(ns.filter((n) => ids.has(n.id) && deletable(n)).map((n) => n.id));
      // Mass deletes keep the Output node (delete it on its own if you really mean to).
      const keptOutput = gone.size > 1 && ns.some((n) => gone.has(n.id) && n.data.kind === 'output');
      if (keptOutput) gone = new Set([...gone].filter((id) => ns.find((n) => n.id === id)?.data.kind !== 'output'));
      const keptEdges = es.filter((e) => !(alsoSelectedEdges && e.selected) && !gone.has(e.source) && !gone.has(e.target));
      const wires = es.length - keptEdges.length;
      if (!gone.size && !wires) {
        setStatus('Nothing selected to delete');
        return;
      }
      setUndoDelete({ nodes: ns, edges: es, luts: lt, count: gone.size });
      setNodes(ns.filter((n) => !gone.has(n.id)));
      setEdges(keptEdges);
      if ([...gone].some((id) => lt.has(id)))
        setLuts((m) => {
          const next = new Map(m);
          gone.forEach((id) => next.delete(id));
          return next;
        });
      setMenu(null);
      setStatus(
        `Deleted ${gone.size} node${gone.size === 1 ? '' : 's'}${wires ? ` and ${wires} wire${wires === 1 ? '' : 's'}` : ''}${keptOutput ? ' (Output kept)' : ''} – Ctrl/⌘+Z to undo`,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setNodes, setEdges],
  );

  const deleteSelected = useCallback(
    () => deleteNodes(new Set(live.current.nodes.filter((n) => n.selected).map((n) => n.id))),
    [deleteNodes],
  );

  /** Delete every node on this level except Output (and a group's Input/Output). */
  const clearWorkspace = () => {
    const ids = new Set(live.current.nodes.filter((n) => n.data.kind !== 'output').map((n) => n.id));
    if (!ids.size) return setStatus('The workspace is already empty');
    if (!window.confirm(`Delete all ${ids.size} nodes${stack.length ? ' in this group' : ''}? (Output is kept · Ctrl/⌘+Z undoes)`)) return;
    deleteNodes(ids);
  };

  const undoLastDelete = useCallback(() => {
    if (!undoDelete) return;
    setNodes(undoDelete.nodes.map((n) => ({ ...n, selected: false })));
    setEdges(undoDelete.edges);
    setLuts(undoDelete.luts);
    setStatus(`Restored ${undoDelete.count} deleted node${undoDelete.count === 1 ? '' : 's'}`);
    setUndoDelete(null);
  }, [undoDelete, setNodes, setEdges]);

  // Moving to another graph level makes the snapshot meaningless.
  useEffect(() => setUndoDelete(null), [stack.length]);

  const selectNodes = useCallback(
    (fn: (n: ShaderNode) => boolean) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: fn(n) })));
      setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)));
    },
    [setNodes, setEdges],
  );
  const selectAll = useCallback(() => selectNodes(() => true), [selectNodes]);
  const selectNone = useCallback(() => selectNodes(() => false), [selectNodes]);
  const invertSelection = () => selectNodes((n) => !n.selected);
  const selectBypassed = () => selectNodes((n) => !!n.data.bypass);
  /** Nodes not connected (directly or indirectly) to Output – safe to clean up. */
  const selectUnused = () => {
    const { nodes: ns, edges: es } = live.current;
    const used = new Set<string>();
    const stackIds = ns.filter((n) => n.data.kind === 'output' || n.data.kind === 'groupOut').map((n) => n.id);
    while (stackIds.length) {
      const id = stackIds.pop()!;
      if (used.has(id)) continue;
      used.add(id);
      es.filter((e) => e.target === id).forEach((e) => stackIds.push(e.source));
    }
    const unused = ns.filter((n) => !used.has(n.id) && deletable(n));
    selectNodes((n) => unused.some((u) => u.id === n.id));
    setStatus(unused.length ? `Selected ${unused.length} node${unused.length === 1 ? '' : 's'} not connected to Output` : 'Every node feeds the Output');
  };

  const selectedCount = nodes.filter((n) => n.selected).length;
  const selectedEdgeCount = edges.filter((e) => e.selected).length;

  // Remember whether the node workspace was the last place the pointer was used.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      graphActive.current = !!graphDiv.current?.contains(e.target as globalThis.Node);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);

  // Keyboard: Ctrl/⌘+G group · Ctrl/⌘+Shift+G ungroup · Tab enter/exit group · M bypass
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const inGraph = graphActive.current;
      if (inGraph && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        deleteSelected();
      } else if (inGraph && mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        if (e.shiftKey) selectNone();
        else selectAll();
      } else if (inGraph && e.key === 'Escape') {
        selectNone();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && undoDelete) {
        e.preventDefault();
        undoLastDelete();
      } else if (inGraph && !mod && !e.altKey && e.key.toLowerCase() === 'b') {
        setBoxSelect((v) => !v);
      } else if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey || e.altKey) ungroupSelected();
        else groupSelected();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const sel = live.current.nodes.filter((n) => n.selected);
        if (sel.length === 1 && sel[0].data.kind === 'group') enterGroup(sel[0].id);
        else if (live.current.stack.length) exitTo(live.current.stack.length - 1);
      } else if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setShowExport(true);
      } else if (!mod && !e.altKey && e.key.toLowerCase() === 'm') {
        toggleBypassSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [groupSelected, ungroupSelected, enterGroup, exitTo, toggleBypassSelected, deleteSelected, selectAll, selectNone, undoDelete, undoLastDelete]);

  const onNodeMenu = useCallback(
    (e: ReactMouseEvent, node: ShaderNode) => {
      e.preventDefault();
      const selCount = live.current.nodes.filter((n) => n.selected || n.id === node.id).length;
      const items: MenuItem[] = [];
      if (node.data.kind === 'group') items.push({ label: 'Edit group (Tab)', onSelect: () => enterGroup(node.id) });
      if (!['output', 'groupIn', 'groupOut'].includes(node.data.kind))
        items.push({ label: node.data.bypass ? 'Enable (un-bypass) (M)' : 'Bypass (M)', onSelect: () => toggleBypass(node.id) });
      if (getDef(node.data.kind)) items.push({ label: 'Reset values to defaults', onSelect: () => resetNode(node.id) });
      items.push({
        label: 'Rename…',
        onSelect: () => {
          const v = window.prompt('Node name', node.data.label);
          if (v?.trim()) renameNode(node.id, v.trim());
        },
      });
      items.push('separator');
      items.push({
        label: `Group ${selCount > 1 ? `${selCount} nodes` : 'node'} (Ctrl/⌘+G)`,
        onSelect: () => {
          setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, selected: true } : n)));
          setTimeout(groupSelected, 0);
        },
      });
      if (node.data.kind === 'group')
        items.push({
          label: 'Ungroup (Ctrl/⌘+Shift+G)',
          onSelect: () => {
            const r = ungroup(live.current.nodes, live.current.edges, node.id);
            if (r) {
              setNodes(r.nodes);
              setEdges(r.edges);
            }
          },
        });
      items.push('separator', {
        label: selCount > 1 && node.selected ? `Delete ${selCount} nodes` : 'Delete',
        danger: true,
        onSelect: () => {
          const sel = live.current.nodes.filter((n) => n.selected).map((n) => n.id);
          deleteNodes(new Set(sel.includes(node.id) ? sel : [node.id]), false);
        },
      });
      setMenu({ x: e.clientX, y: e.clientY, title: node.data.label, items });
    },
    [enterGroup, toggleBypass, resetNode, renameNode, groupSelected, deleteNodes, setNodes, setEdges],
  );

  /* ---------- nodes & edges passed to React Flow ---------- */
  const connectedByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of edges) if (e.targetHandle) m.set(e.target, [...(m.get(e.target) ?? []), e.targetHandle]);
    return m;
  }, [edges]);

  const wiredNodes = useMemo(
    (): ShaderNode[] =>
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
            mediaOptions: mediaOpts,
            connected: connectedByNode.get(n.id),
            lut: luts.get(n.id) ?? null,
            onParams: updateParams,
            onCurve: updateCurve,
            onRamp: updateRamp,
            onLoadLut: loadLut,
            onClearLut: clearLut,
            onTogglePreview: togglePreview,
            onToggleBypass: toggleBypass,
            onResetNode: resetNode,
            onRename: renameNode,
            onEnterGroup: enterGroup,
            onHandleClick,
            registerPreview,
            onFolderChange: setNodeFolder,
            onPickFolder: pickFolder,
          },
        };
      }),
    [nodes, derived, settings.nodePreviews, folderOpts, mediaOpts, connectedByNode, luts, updateParams, updateCurve, updateRamp, loadLut, clearLut, togglePreview, toggleBypass, resetNode, renameNode, enterGroup, onHandleClick, registerPreview, setNodeFolder, pickFolder],
  );

  // Colour wires by the type of value they carry.
  const wiredEdges = useMemo((): Edge[] => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges.map((e) => {
      const s = byId.get(e.source);
      const sock = s ? socketsOf(s).outputs.find((o) => outHandle(o.id) === e.sourceHandle) : undefined;
      return { ...e, className: `wire-${sock?.type ?? 'color'}` };
    });
  }, [nodes, edges]);

  /* ---------- connections ---------- */
  // Prevent self-links and cycles (a node may not feed anything upstream of itself).
  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (c.source === c.target) return false;
    const upstream = new Map<string, string[]>();
    for (const e of live.current.edges) upstream.set(e.target, [...(upstream.get(e.target) ?? []), e.source]);
    const seen = new Set<string>();
    const stackIds = [c.source];
    while (stackIds.length) {
      const id = stackIds.pop()!;
      if (id === c.target) return false;
      if (seen.has(id)) continue;
      seen.add(id);
      stackIds.push(...(upstream.get(id) ?? []));
    }
    return true;
  }, []);

  // Each input socket takes one wire: a new connection replaces the old one.
  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge({ ...c, id: `e-${uid()}` }, es.filter((e) => !(e.target === c.target && e.targetHandle === c.targetHandle)))),
    [setEdges],
  );

  // Drag a wire end to another socket to move it, or drop it on empty space to disconnect.
  const onReconnectStart = useCallback(() => {
    reconnectOk.current = false;
  }, []);

  const onReconnect = useCallback(
    (oldEdge: Edge, c: Connection) => {
      reconnectOk.current = true;
      setEdges((es) =>
        reconnectEdge(oldEdge, c, es.filter((e) => e.id === oldEdge.id || !(e.target === c.target && e.targetHandle === c.targetHandle))),
      );
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

  /** Remove images from the Media Pool (and the stored session). */
  const deleteMedia = useCallback((ids: string[]) => {
    const gone = new Set(ids);
    const ms = live.current.media;
    const removed = ms.filter((m) => gone.has(m.id));
    if (!removed.length) return;
    for (const m of removed) {
      URL.revokeObjectURL(m.url);
      gpu.current?.forget(m.id);
    }
    const remaining = ms.filter((m) => !gone.has(m.id));
    setMedia(remaining);
    setActiveId((a) => (a && gone.has(a) ? remaining[0]?.id ?? null : a));
    setStatus(`Removed ${removed.length} image${removed.length === 1 ? '' : 's'} from the Media Pool`);
  }, []);

  /* ---------- session retention ---------- */
  const restored = useRef(false);
  const stored = useRef(new Set<string>());

  // Restore the previous session's images (IndexedDB) on start-up.
  useEffect(() => {
    let cancelled = false;
    const { items: meta, activeId: savedActive } = loadMediaMeta();
    if (!meta.length) {
      restored.current = true;
      return;
    }
    setStatus(`Restoring ${meta.length} image${meta.length === 1 ? '' : 's'} from the last session…`);
    (async () => {
      const out: (MediaItem | null)[] = new Array(meta.length).fill(null);
      let next = 0;
      const worker = async () => {
        while (next < meta.length) {
          const i = next++;
          try {
            const blob = await getImage(meta[i].id);
            if (blob && !cancelled) out[i] = await decodeStored(blob, meta[i]);
          } catch {
            /* missing / unreadable – skip */
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(DECODE_CONCURRENCY, meta.length) }, worker));
      const items = out.filter((m): m is MediaItem => !!m);
      if (cancelled) {
        items.forEach((m) => URL.revokeObjectURL(m.url));
        return;
      }
      items.forEach((m) => stored.current.add(m.id));
      restored.current = true;
      setMedia((cur) => [...items, ...cur]); // keep anything imported while restoring
      setActiveId((a) => a ?? (items.some((m) => m.id === savedActive) ? savedActive : items[0]?.id ?? null));
      const lost = meta.length - items.length;
      setStatus(`Restored ${items.length} image${items.length === 1 ? '' : 's'}${lost ? ` (${lost} could not be restored)` : ''}`);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the stored session in sync with the Media Pool.
  useEffect(() => {
    if (!restored.current) return;
    saveMediaMeta(
      media.map((m) => ({ id: m.id, name: m.name, folder: m.folder, visible: m.visible, graph: m.graph })),
      activeId,
    );
    const ids = new Set(media.map((m) => m.id));
    const toAdd = media.filter((m) => m.blob && !stored.current.has(m.id));
    const toDelete = [...stored.current].filter((id) => !ids.has(id));
    if (!toAdd.length && !toDelete.length) return;
    toAdd.forEach((m) => stored.current.add(m.id));
    toDelete.forEach((id) => stored.current.delete(id));
    if (toAdd.length) requestPersistence();
    void (async () => {
      try {
        for (const m of toAdd) await putImage(m.id, m.blob!);
        if (toDelete.length) await deleteImages(toDelete);
      } catch {
        setStatus('Browser storage is full or unavailable – some images will not be kept after a refresh');
      }
    })();
  }, [media, activeId]);

  const toggleVisible = useCallback((id: string) => setMedia((ms) => ms.map((m) => (m.id === id ? { ...m, visible: !m.visible } : m))), []);

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
      const targetId = nodeId ?? ns.find((n) => n.selected && n.data.kind === 'folder')?.id ?? ns.find((n) => n.data.kind === 'folder')?.id;
      if (targetId) {
        setNodeFolder(targetId, folder);
        return;
      }
      const input = ns.find((n) => n.data.kind === 'input' && !n.data.params?.media);
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

  const importFiles = async (list: FileList | File[] | null) => {
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

  const importFolder = (list: FileList | null) => {
    const targetNode = folderTargetNode.current;
    folderTargetNode.current = null;
    const files = Array.from(list ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    return importFolderFiles(files, targetNode);
  };

  /** Import one folder's files (paths start with the folder name; sub-folders are included). */
  const importFolderFiles = async (dropped: DroppedFile[], targetNode: string | null) => {
    const sorted = dropped.filter((d) => isImageFile(d.file)).sort((a, b) => naturalCompare(a.path, b.path));
    const files = sorted.map((d) => d.file);
    if (!files.length) {
      setStatus('No images found in that folder');
      return;
    }

    const root = sorted[0].path.split('/')[0] || 'Folder';
    const folder = uniqueFolderName(root, live.current.media);

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
    if (live.current.settings.viewSource === 'workspace') assignFolder(folder, targetNode);
    if (items.length > 1) setSettings((s) => ({ ...s, viewerLayout: 'grid' }));
    setStatus(`${folderLabel(folder)} • ${items.length} images${failed ? ` (${failed} could not be decoded)` : ''}`);
  };

  /** Drag & drop onto the Media Pool: loose files and/or whole folders. */
  const importDropped = async (dropped: DroppedFile[]) => {
    const loose = dropped.filter((d) => !d.path.includes('/'));
    const byFolder = new Map<string, DroppedFile[]>();
    for (const d of dropped) {
      if (!d.path.includes('/')) continue;
      const root = d.path.split('/')[0];
      byFolder.set(root, [...(byFolder.get(root) ?? []), d]);
    }
    if (loose.length) {
      await importFiles(loose.map((d) => d.file));
    }
    for (const files of byFolder.values()) await importFolderFiles(files, null);
    if (!dropped.some((d) => isImageFile(d.file))) setStatus('No images in the dropped files');
  };

  // Dropping files outside the Media Pool must not navigate the browser away from the app.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  /* ---------- export ---------- */
  /** Images the export would include, per scope, for the current view. */
  const exportSets = (): Record<ExportScope, Entry[]> => {
    const batch = derived.batch;
    const shown = batch.filter((e) => e.view.visible);
    return { current: derived.current ? [derived.current] : [], shown: shown.length ? shown : batch, batch };
  };

  const runExport = async (opts: ExportOptions) => {
    const g = gpu.current;
    if (!g) return;
    setExportOpts(opts);
    saveExportOptions(opts);
    const entries = exportSets()[opts.scope];
    if (!entries.length) return;
    setExporting(true);
    try {
      const st = live.current.settings;
      const root = rootGraph();
      const lutIds = lutIdMap(live.current.luts);
      const workspacePlan = outputPlan(flatten(root.nodes, root.edges), lutIds);
      const lookup = (id: string) => {
        const m = live.current.media.find((x) => x.id === id);
        return m ? toRenderItem(m) : null;
      };
      const used = new Set<string>();
      const files: { name: string; blob: Blob }[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        setStatus(`Exporting ${i + 1}/${entries.length}: ${e.view.name}…`);
        const { plan, luts: lt } =
          st.viewSource === 'library' && e.media ? libraryPlan(e.media) : { plan: workspacePlan, luts: live.current.luts };
        if (!g.render(plan, { item: e.render, maxSize: opts.maxSize || Infinity, media: lookup, luts: lt })) continue;
        // toBlob copies the canvas immediately, so later renders can't change this image.
        const blob = await encodeCanvas(g.canvas, opts.format, opts.quality);
        files.push({ name: exportName(e.media ? e.view.name : 'procedural', opts.suffix, opts.format, used), blob });
      }
      scheduleRender(); // the export used the shared GPU canvas
      if (!files.length) {
        setStatus('Nothing to export – is the Output connected?');
        return;
      }
      const total = files.reduce((n, f) => n + f.blob.size, 0);
      const mb = (total / 1048576).toFixed(1);
      if (files.length === 1) downloadBlob(files[0].blob, files[0].name);
      else if (opts.packaging === 'zip' && total < ZIP_MAX_BYTES) {
        setStatus(`Packaging ${files.length} images…`);
        downloadBlob(await makeZip(files), `oneshot-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`);
      } else {
        for (const f of files) {
          downloadBlob(f.blob, f.name);
          await new Promise((r) => setTimeout(r, 250)); // let the browser start each download
        }
      }
      setStatus(`Exported ${files.length} image${files.length === 1 ? '' : 's'} (${mb} MB)${opts.packaging === 'zip' && files.length > 1 && total >= ZIP_MAX_BYTES ? ' as separate files (too large for one ZIP)' : ''}`);
      setShowExport(false);
    } catch (err) {
      setStatus(`Export failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  const stepImage = (dir: 1 | -1) => {
    const shown = derived.batch.filter((e) => e.view.visible);
    const pool = shown.length ? shown : derived.batch;
    if (!pool.length) return;
    const i = pool.findIndex((e) => e.view.id === derived.current?.view.id);
    selectImage(pool[(i + dir + pool.length) % pool.length].view.id);
  };

  const setLayout = (viewerLayout: ViewerLayout) => setSettings((s) => ({ ...s, viewerLayout }));
  const setSource = (viewSource: ViewSource) => setSettings((s) => ({ ...s, viewSource }));

  /* ---------- library (saved graphs) ---------- */
  const commitPresets = (next: GraphPreset[]) => {
    setPresets(next);
    const err = savePresets(next);
    if (err) setStatus(err);
  };

  const lutTextsFor = (ns: ShaderNode[], lt: Map<string, LutData>) => {
    const ids = allNodeIds(ns);
    const out: Record<string, { name: string; text: string }> = {};
    for (const [id, lut] of lt) if (ids.has(id)) out[id] = { name: lut.name, text: lut.text };
    return out;
  };

  // Autosave the workspace graph (debounced) so it survives a refresh.
  const wsWarned = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      const root = rootGraph();
      const ok = saveWorkspace({ nodes: root.nodes.map(cleanNode), edges: root.edges.map(cleanEdge), luts: lutTextsFor(root.nodes, luts) });
      if (!ok && !wsWarned.current) {
        wsWarned.current = true;
        setStatus('Browser storage is full – the workspace graph will not be kept after a refresh');
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, stack, luts]);

  const savePreset = () => {
    const name = window.prompt('Name for this graph', `Graph ${presets.length + 1}`);
    if (!name?.trim()) return;
    const root = rootGraph();
    if (!root.nodes.some((n) => n.data.kind === 'output')) {
      setStatus('The graph needs an Output node to be saved');
      return;
    }
    const p = makePreset(name.trim(), root.nodes, root.edges, lutTextsFor(root.nodes, luts));
    commitPresets([...presets, p]);
    setStatus(`Saved “${p.name}” to the Library`);
  };

  const loadPresetIntoWorkspace = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p || !window.confirm(`Replace the current graph with “${p.name}”?`)) return;
    const g = migrateGraph(p.nodes, p.edges);
    setStack([]);
    setNodes(g.nodes);
    setEdges(g.edges);
    setLuts(parseLuts(p.luts).map);
    setSource('workspace');
    fitSoon();
    setStatus(`Editing “${p.name}” – save again to update the Library`);
  };

  /**
   * Add a saved graph's nodes to the current workspace level so they can be seen and tweaked.
   * The look is appended after the current graph: whatever fed Output now feeds the look's
   * Image Input sockets, and the look's result goes to Output. Nodes arrive selected (Ctrl/⌘+G groups them).
   */
  const insertPresetIntoWorkspace = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    const g = migrateGraph(p.nodes, p.edges);
    const { nodes: ns, edges: es } = live.current;
    const remap = new Map(g.nodes.map((n) => [n.id, uid()]));

    const out = ns.find((n) => n.data.kind === 'output');
    const feeding = out ? es.find((e) => e.target === out.id) : undefined;
    const pOut = g.nodes.find((n) => n.data.kind === 'output');
    const pOutEdge = pOut ? g.edges.find((e) => e.target === pOut.id) : undefined;
    // The look's "current image" inputs are replaced by the workspace chain (when there is one).
    const replaced = new Set(feeding ? g.nodes.filter((n) => n.data.kind === 'input' && !n.data.params?.media).map((n) => n.id) : []);
    const keep = g.nodes.filter((n) => n.data.kind !== 'output' && !replaced.has(n.id));
    if (!keep.length) {
      setStatus(`“${p.name}” has no nodes to insert`);
      return;
    }

    // Place below the existing nodes.
    const minX = Math.min(...keep.map((n) => n.position.x));
    const minY = Math.min(...keep.map((n) => n.position.y));
    const left = ns.length ? Math.min(...ns.map((n) => n.position.x)) : 0;
    const top = ns.length ? Math.max(...ns.map((n) => n.position.y)) + 360 : 0;
    const added: ShaderNode[] = keep.map((n) => ({
      ...n,
      id: remap.get(n.id)!,
      selected: true,
      position: { x: n.position.x - minX + left, y: n.position.y - minY + top },
    }));

    const newEdges: Edge[] = [];
    for (const e of g.edges) {
      if (pOut && e.target === pOut.id) continue;
      if (replaced.has(e.source)) {
        newEdges.push({ id: `e-${uid()}`, source: feeding!.source, sourceHandle: feeding!.sourceHandle, target: remap.get(e.target)!, targetHandle: e.targetHandle });
      } else if (!replaced.has(e.target)) {
        newEdges.push({ ...e, id: `e-${uid()}`, source: remap.get(e.source)!, target: remap.get(e.target)! });
      }
    }
    let kept = es;
    if (out && pOutEdge && !replaced.has(pOutEdge.source)) {
      kept = es.filter((e) => e.target !== out.id);
      newEdges.push({ id: `e-${uid()}`, source: remap.get(pOutEdge.source)!, sourceHandle: pOutEdge.sourceHandle, target: out.id, targetHandle: inHandle('image') });
    }

    setNodes([...ns.map((n) => ({ ...n, selected: false })), ...added]);
    setEdges([...kept, ...newEdges]);
    const lt = parseLuts(p.luts).map;
    if (lt.size)
      setLuts((m) => {
        const next = new Map(m);
        for (const [k, v] of lt) next.set(remap.get(k) ?? k, v);
        return next;
      });
    setSource('workspace');
    fitSoon();
    setStatus(`Inserted “${p.name}” (${added.length} nodes) – connected after your graph. Ctrl/⌘+G groups the selected nodes.`);
  };

  const restoreBuiltins = () => {
    const missing = missingBuiltins(presets);
    commitPresets([...missing, ...presets]);
    setStatus(`Restored ${missing.length} built-in look${missing.length === 1 ? '' : 's'}`);
  };

  const shownMediaIds = () => {
    const ms = live.current.media;
    const shown = ms.filter((m) => m.visible);
    return new Set((shown.length ? shown : ms).map((m) => m.id));
  };

  const applyPresetToShown = (presetId: string) => {
    const ids = shownMediaIds();
    setMedia((ms) => ms.map((m) => (ids.has(m.id) ? { ...m, graph: { presetId, overrides: m.graph?.presetId === presetId ? m.graph.overrides : {} } } : m)));
    setSource('library');
    const p = presets.find((x) => x.id === presetId);
    setStatus(`Applied “${p?.name}” to ${ids.size} image${ids.size === 1 ? '' : 's'}`);
  };

  const renamePreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    const name = p && window.prompt('Rename graph', p.name);
    if (name?.trim()) commitPresets(presets.map((x) => (x.id === id ? { ...x, name: name.trim() } : x)));
  };

  const deletePreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p || !window.confirm(`Delete “${p.name}” from the Library?`)) return;
    commitPresets(presets.filter((x) => x.id !== id));
    setMedia((ms) => ms.map((m) => (m.graph?.presetId === id ? { ...m, graph: undefined } : m)));
  };

  const exportPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (p) download({ oneshot: 'graph', version: 10, ...p, builtin: undefined }, `${p.name.replace(/[^\w\- ]+/g, '_')}.oneshot-graph.json`);
  };

  /** Import graph files: single graphs, packs ({ graphs: [...] }) or several files at once. */
  const importPresets = async (files: File[]) => {
    const added: GraphPreset[] = [];
    const failed: string[] = [];
    for (const file of files) {
      try {
        const graphs = graphsInFile(JSON.parse(await file.text()));
        if (!graphs.length) throw new Error('no graphs');
        for (const j of graphs) {
          const g = migrateGraph(j.nodes, j.edges);
          added.push(makePreset(j.name ?? file.name.replace(/\.((nodegl|oneshot)-(graph|pack)\.)?json$/i, ''), g.nodes, g.edges, j.luts ?? {}, j.description, j.collection));
        }
      } catch {
        failed.push(file.name);
      }
    }
    if (added.length) commitPresets([...live.current.presets, ...added]);
    setStatus(
      (added.length ? `Imported ${added.length} graph${added.length === 1 ? '' : 's'} into the Library` : 'Nothing imported') +
        (failed.length ? ` – could not read: ${failed.join(', ')}` : ''),
    );
  };

  const missingCount = useMemo(() => missingBuiltins(presets).length, [presets]);

  const libraryItem = settings.viewSource === 'library' ? derived.current?.media ?? null : null;

  const setItemGraph = (itemId: string, presetId: string) =>
    setMedia((ms) => ms.map((m) => (m.id === itemId ? { ...m, graph: presetId ? { presetId, overrides: {} } : undefined } : m)));

  const overrideParam = (itemId: string, nodeId: string, patch: Params) =>
    setMedia((ms) =>
      ms.map((m) =>
        m.id === itemId && m.graph
          ? { ...m, graph: { ...m.graph, overrides: { ...m.graph.overrides, [nodeId]: { ...m.graph.overrides[nodeId], ...patch } } } }
          : m,
      ),
    );

  const applyItemGraphToShown = (itemId: string) => {
    const src = live.current.media.find((m) => m.id === itemId)?.graph;
    if (!src) return;
    const ids = shownMediaIds();
    setMedia((ms) => ms.map((m) => (ids.has(m.id) ? { ...m, graph: { presetId: src.presetId, overrides: structuredClone(src.overrides) } } : m)));
    setStatus(`Applied to ${ids.size} image${ids.size === 1 ? '' : 's'}`);
  };

  /* ---------- graph editing ---------- */
  const addNode = (def: NodeDef) => {
    const groups = folderGroups(media);
    const r = graphDiv.current?.getBoundingClientRect();
    const centre = r && rf.current ? rf.current.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 300, y: 150 };
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      {
        id: uid(),
        type: 'shader',
        selected: true,
        position: { x: centre.x - 95 + (Math.random() - 0.5) * 60, y: centre.y - 60 + (Math.random() - 0.5) * 60 },
        data: {
          kind: def.kind,
          label: def.label,
          params: defaultParams(def.kind),
          ramp: def.ramp ? structuredClone(DEFAULT_RAMP) : undefined,
          folder: def.kind === 'folder' ? groups[groups.length - 1]?.key ?? ALL_MEDIA : undefined,
        },
      },
    ]);
  };

  /* ---------- project files ---------- */
  const save = () => {
    const root = rootGraph();
    download(
      { version: 5, nodes: root.nodes.map(cleanNode), edges: root.edges.map(cleanEdge), luts: lutTextsFor(root.nodes, luts) },
      'oneshot-project.json',
    );
  };

  const load = (file: File) => {
    file
      .text()
      .then((text) => {
        const p = JSON.parse(text);
        const { map, failed } = parseLuts(p.luts);
        const g = migrateGraph(p.nodes as ShaderNode[], p.edges as Edge[]);
        setStack([]);
        setNodes(g.nodes);
        setEdges(g.edges);
        setLuts(map);
        fitSoon();
        setStatus(failed.length ? `Project loaded – could not read LUT(s): ${failed.join(', ')}` : 'Project loaded');
      })
      .catch(() => setStatus('Could not read project'));
  };

  /* ---------- resizable panels ---------- */
  const clampTo = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
  const resizeMedia = {
    onStart: () => (dragBase.current = live.current.settings.mediaWidth),
    onDrag: (d: number) => setSettings((s) => ({ ...s, mediaWidth: Math.round(clampTo(dragBase.current + d, LAYOUT_LIMITS.mediaWidth)) })),
    onReset: () => setSettings((s) => ({ ...s, mediaWidth: defaultSettings.mediaWidth })),
  };
  const resizeToolbox = {
    onStart: () => (dragBase.current = live.current.settings.toolboxWidth),
    onDrag: (d: number) => setSettings((s) => ({ ...s, toolboxWidth: Math.round(clampTo(dragBase.current - d, LAYOUT_LIMITS.toolboxWidth)) })),
    onReset: () => setSettings((s) => ({ ...s, toolboxWidth: defaultSettings.toolboxWidth })),
  };
  const resizeViewer = {
    onStart: () => (dragBase.current = live.current.settings.viewerSplit),
    onDrag: (d: number) => {
      // Height shared by viewer + graph (minus viewer bar and splitter).
      const h = (centerRef.current?.clientHeight ?? 600) - 34 - 6;
      setSettings((s) => ({ ...s, viewerSplit: clampTo(dragBase.current + d / Math.max(h, 1), LAYOUT_LIMITS.viewerSplit) }));
    },
    onReset: () => setSettings((s) => ({ ...s, viewerSplit: defaultSettings.viewerSplit })),
  };
  const resetLayout = () =>
    setSettings((s) => ({ ...s, mediaWidth: defaultSettings.mediaWidth, toolboxWidth: defaultSettings.toolboxWidth, viewerSplit: defaultSettings.viewerSplit }));

  const menuAction = (fn: () => void) => () => {
    fn();
    closeMenus();
  };

  const centerStyle = {
    '--wire-width': `${settings.wireWidth}px`,
    '--bg-dim': settings.backgroundDim,
    '--viewer-split-f': settings.viewerSplit.toFixed(4),
  } as CSSProperties;
  const mainStyle = { '--media-w': `${settings.mediaWidth}px`, '--tool-w': `${settings.toolboxWidth}px` } as CSSProperties;
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
        <strong className="brand">
          <img src="/logo.svg" alt="" width={18} height={18} />
          OneShot
        </strong>
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
              <hr />
              <button onClick={menuAction(savePreset)}>Save graph to Library…</button>
              <hr />
              <button disabled={!derived.batch.length} onClick={menuAction(() => setShowExport(true))}>
                Export images… (Ctrl/⌘+E)
              </button>
            </div>
          </details>
          <details>
            <summary>Edit</summary>
            <div>
              <button disabled={!undoDelete} onClick={menuAction(undoLastDelete)}>
                Undo delete (Ctrl/⌘+Z)
              </button>
              <hr />
              <button onClick={menuAction(selectAll)}>Select all nodes (Ctrl/⌘+A)</button>
              <button onClick={menuAction(invertSelection)}>Invert selection</button>
              <button onClick={menuAction(selectUnused)}>Select unused nodes</button>
              <button onClick={menuAction(selectBypassed)}>Select bypassed nodes</button>
              <button onClick={menuAction(selectNone)}>Select none (Esc)</button>
              <hr />
              <button disabled={!selectedCount && !selectedEdgeCount} onClick={menuAction(deleteSelected)}>
                Delete selected{selectedCount ? ` (${selectedCount})` : ''} (Delete)
              </button>
              <button onClick={menuAction(clearWorkspace)}>Delete all nodes…</button>
              <button onClick={menuAction(toggleBypassSelected)}>Bypass selected (M)</button>
              <button onClick={menuAction(() => resetNodes('selected'))}>Reset selected nodes to defaults</button>
              <button onClick={menuAction(() => resetNodes('all'))}>Reset all nodes to defaults…</button>
              <button onClick={menuAction(() => setEdges([]))}>Disconnect all wires</button>
              <hr />
              <button onClick={menuAction(groupSelected)}>Group selected (Ctrl/⌘+G)</button>
              <button onClick={menuAction(ungroupSelected)}>Ungroup (Ctrl/⌘+Shift+G)</button>
              <button disabled={!stack.length} onClick={menuAction(() => exitTo(stack.length - 1))}>
                Exit group (Tab)
              </button>
              <hr />
              <button onClick={menuAction(() => setVisible(media.map((m) => m.id), true))}>Show all images</button>
              <button onClick={menuAction(() => setVisible(media.map((m) => m.id), false))}>Hide all images</button>
              <hr />
              <button
                onClick={menuAction(() => {
                  setStack([]);
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
              <button onClick={menuAction(() => setSettings((s) => ({ ...s, previewMode: 'split' })))}>{check(settings.previewMode === 'split')}Viewer panel</button>
              <button onClick={menuAction(() => setSettings((s) => ({ ...s, previewMode: 'background' })))}>
                {check(settings.previewMode === 'background')}Output behind nodes
              </button>
              <button onClick={menuAction(() => setSettings((s) => ({ ...s, previewMode: 'hidden' })))}>{check(settings.previewMode === 'hidden')}Hide viewer</button>
              <hr />
              <button onClick={menuAction(() => setSource('workspace'))}>{check(settings.viewSource === 'workspace')}Workspace view</button>
              <button onClick={menuAction(() => setSource('library'))}>{check(settings.viewSource === 'library')}Library view (per-image graphs)</button>
              <hr />
              <button onClick={menuAction(() => setLayout('single'))}>{check(settings.viewerLayout === 'single')}Single image view</button>
              <button onClick={menuAction(() => setLayout('grid'))}>{check(settings.viewerLayout === 'grid')}Grid view</button>
              <hr />
              <button onClick={menuAction(() => setSettings((s) => ({ ...s, nodePreviews: !s.nodePreviews })))}>{check(settings.nodePreviews)}Node previews</button>
              <hr />
              <button onClick={menuAction(resetLayout)}>Reset panel sizes</button>
              <button onClick={menuAction(() => document.documentElement.requestFullscreen())}>Fullscreen</button>
              <button onClick={menuAction(() => setShowSettings(true))}>Settings…</button>
            </div>
          </details>
          <details>
            <summary>Help</summary>
            <div className="help">
              <p>
                <b>Sockets:</b> yellow = colour, grey = value. Values and colours convert automatically (colour → value uses luminance).
                Unconnected inputs can be edited on the node.
              </p>
              <p>
                <b>Wires:</b> drag between sockets. Click a socket or wire to disconnect, or drag a wire end into empty space.
              </p>
              <p>
                <b>Bypass:</b> the bypass button in a node’s title (or M) passes its input straight through.
              </p>
              <p>
                <b>Compound nodes:</b> select nodes, Ctrl/⌘+G. Tab or the edit button opens a group, Tab again exits. Ctrl/⌘+Shift+G ungroups.
              </p>
              <p>
                <b>Library:</b> save graphs (Toolbox → Library), apply them to images, and vary each image’s Value / RGB Colour / Image Input
                nodes under the image in Library view.
              </p>
              <p>
                <b>Procedural:</b> texture nodes work without an image – the canvas size is in Settings.
              </p>
              <p>
                <b>Masks:</b> Circle / Ellipse / Rectangle / Polygon Mask output a per-pixel value – connect it to Mix → Factor (or any value
                input). X/Y are fractions of the image width/height; sizes and feather are fractions of the image height.
              </p>
              <p>
                <b>Import:</b> drag images or whole folders onto the Media Pool.
              </p>
              <p>
                <b>Media Pool:</b> click / Ctrl-click / Shift-click to select images, Select all, then Delete (or the bin). Images,
                the Library and the workspace graph are kept in this browser across refreshes.
              </p>
              <p>
                <b>Selecting & deleting nodes:</b> Shift-drag (or turn on Box select / B) to draw a selection box, Ctrl/⌘-click to add,
                Ctrl/⌘+A for all. Delete / Backspace or the selection bar deletes; Edit → Delete all nodes clears the workspace;
                Ctrl/⌘+Z undoes the last delete.
              </p>
              <p>
                <b>Library:</b> Insert adds a look’s nodes after your graph so you can tweak them; Edit replaces the graph.
              </p>
              <p>
                <b>Reset:</b> the reset button in a node’s title restores its default values (Edit menu: selected / all nodes).
              </p>
              <p>
                <b>Export:</b> Export… in the viewer bar (Ctrl/⌘+E) saves processed images as JPEG / PNG / WebP, singly or as a ZIP.
              </p>
              <p>
                <b>Viewer:</b> wheel or pinch to zoom, drag to pan, double-click for 100% ↔ Fit. Keys (click the image first): F fit, 1
                actual pixels, + / − zoom, arrows pan.
              </p>
              <p>
                <b>Layout:</b> drag the dividers between panels to resize them; double-click a divider to reset.
              </p>
            </div>
          </details>
        </nav>
        <span className="status">{status}</span>
        <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
      </header>

      <main style={mainStyle}>
        <MediaPool
          media={media}
          activeId={activeId}
          graphName={presetName}
          onSelect={selectImage}
          onToggleVisible={toggleVisible}
          onSetVisible={setVisible}
          onUseFolder={(folder) => {
            assignFolder(folder, null);
            setSource('workspace');
            setStatus(`${folderLabel(folder)} is now the Folder Input batch`);
          }}
          onImportFiles={(list) => void importFiles(list)}
          onImportFolder={() => pickFolder(null)}
          onDropFiles={(files) => void importDropped(files)}
          onDelete={deleteMedia}
        />

        <Splitter axis="x" title="Drag to resize the Media Pool · double-click to reset" {...resizeMedia} />

        <section ref={centerRef} className={`center view-${settings.previewMode}`} style={centerStyle}>
          {settings.previewMode !== 'hidden' && (
            <Viewer
              layout={settings.viewerLayout}
              onLayout={setLayout}
              source={settings.viewSource}
              onSource={setSource}
              batch={derived.batch.map((e) => e.view)}
              current={derived.current?.view ?? null}
              message={derived.message}
              tileSize={settings.gridTileSize}
              onSelect={selectImage}
              onStep={stepImage}
              onToggleVisible={toggleVisible}
              onSetVisible={setVisible}
              registerCanvas={registerViewerCanvas}
              onExport={() => setShowExport(true)}
              background={settings.previewMode === 'background'}
              canExport={derived.batch.length > 0 && !exporting}
              footer={
                settings.viewSource === 'library' && media.length > 0 ? (
                  <ImageGraphPanel
                    item={libraryItem}
                    presets={presets}
                    mediaOptions={mediaOpts}
                    onAssign={(pid) => libraryItem && setItemGraph(libraryItem.id, pid)}
                    onApplyToShown={() => libraryItem && applyItemGraphToShown(libraryItem.id)}
                    onOverride={(nodeId, patch) => libraryItem && overrideParam(libraryItem.id, nodeId, patch)}
                    onReset={() =>
                      libraryItem && setMedia((ms) => ms.map((m) => (m.id === libraryItem.id && m.graph ? { ...m, graph: { ...m.graph, overrides: {} } } : m)))
                    }
                  />
                ) : undefined
              }
            />
          )}
          {settings.previewMode === 'split' && <Splitter axis="y" title="Drag to resize the viewer · double-click to reset" {...resizeViewer} />}
          <div className="graph" ref={graphDiv}>
            {stack.length > 0 && (
              <div className="breadcrumb">
                <button onClick={() => exitTo(0)}>Root</button>
                {stack.map((f, i) => (
                  <span key={f.groupId}>
                    ›{' '}
                    {i < stack.length - 1 ? <button onClick={() => exitTo(i + 1)}>{f.label}</button> : <b>{f.label}</b>}
                  </span>
                ))}
                <button className="bar-btn" onClick={() => exitTo(stack.length - 1)}>
                  Exit group (Tab)
                </button>
              </div>
            )}
            <div className="graph-tools">
              <button
                className={boxSelect ? 'on' : ''}
                onClick={() => setBoxSelect((v) => !v)}
                title={boxSelect ? 'Box select ON: drag to select · middle/right-drag to pan (B)' : 'Box select OFF: drag to pan · Shift-drag to select (B)'}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                  <rect x="1.5" y="1.5" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.2 1.6" />
                </svg>
                Box select
              </button>
              <button onClick={selectAll} title="Select all nodes (Ctrl/⌘+A)">
                All
              </button>
              <button onClick={selectUnused} title="Select nodes that don't feed the Output">
                Unused
              </button>
              {undoDelete && (
                <button onClick={undoLastDelete} title="Undo the last delete (Ctrl/⌘+Z)">
                  ↶ Undo delete
                </button>
              )}
            </div>
            {(selectedCount > 0 || selectedEdgeCount > 0) && (
              <div className="selection-bar">
                <span>
                  {selectedCount} node{selectedCount === 1 ? '' : 's'}
                  {selectedEdgeCount ? ` · ${selectedEdgeCount} wire${selectedEdgeCount === 1 ? '' : 's'}` : ''} selected
                </span>
                {selectedCount > 0 && (
                  <>
                    <button onClick={toggleBypassSelected} title="Bypass / enable (M)">
                      Bypass
                    </button>
                    <button onClick={() => resetNodes('selected')} title="Reset values to defaults">
                      Reset
                    </button>
                    <button onClick={groupSelected} title="Group into a compound node (Ctrl/⌘+G)">
                      Group
                    </button>
                  </>
                )}
                <button className="danger" onClick={deleteSelected} title="Delete selected (Delete / Backspace)">
                  Delete
                </button>
                <button onClick={selectNone} title="Clear selection (Esc)">
                  ✕
                </button>
              </div>
            )}
            <ReactFlow
              nodes={wiredNodes}
              edges={wiredEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onReconnect={onReconnect}
              onReconnectStart={onReconnectStart}
              onReconnectEnd={onReconnectEnd}
              isValidConnection={isValidConnection}
              onEdgeClick={onEdgeMenu}
              onEdgeContextMenu={onEdgeMenu}
              onNodeContextMenu={onNodeMenu}
              onPaneClick={() => setMenu(null)}
              onInit={(inst) => (rf.current = inst)}
              nodeTypes={nodeTypes}
              connectOnClick={false}
              connectionRadius={30}
              colorMode="dark"
              minZoom={0.15}
              fitView
              deleteKeyCode={null}
              selectionOnDrag={boxSelect}
              panOnDrag={boxSelect ? [1, 2] : true}
              selectionMode={SelectionMode.Partial}
              selectionKeyCode="Shift"
              multiSelectionKeyCode={['Meta', 'Control']}
            >
              <Background color="#4a5266" gap={18} />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
        </section>

        <Splitter axis="x" title="Drag to resize the Toolbox · double-click to reset" {...resizeToolbox} />

        <Toolbox
          onAdd={addNode}
          presets={presets}
          onSavePreset={savePreset}
          onLoadPreset={loadPresetIntoWorkspace}
          onInsertPreset={insertPresetIntoWorkspace}
          missingBuiltins={missingCount}
          onRestoreBuiltins={restoreBuiltins}
          onApplyPreset={applyPresetToShown}
          onRenamePreset={renamePreset}
          onDeletePreset={deletePreset}
          onExportPreset={exportPreset}
          onImportPreset={(files) => void importPresets(files)}
        />
      </main>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {showSettings && <SettingsDialog settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />}
      {showExport && (() => {
        const sets = exportSets();
        return (
          <ExportDialog
            initial={exportOpts}
            counts={{ current: sets.current.length, shown: sets.shown.length, batch: sets.batch.length }}
            sourceLabel={settings.viewSource === 'library' ? 'each image’s Library graph' : 'the Workspace graph'}
            busy={exporting}
            onExport={(o) => void runExport(o)}
            onClose={() => setShowExport(false)}
          />
        );
      })()}
    </div>
  );
}
