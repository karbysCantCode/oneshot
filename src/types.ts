import type { Edge, Node } from '@xyflow/react';

/** Node type id – see src/nodes/registry.ts for every available kind. */
export type ShaderKind = string;
export type HandleSide = 'target' | 'source';

/** Socket data types. Floats are stored on the GPU as (v, v, v, 1); conversions are implicit. */
export type SocketType = 'color' | 'float';

export type Socket = {
  id: string;
  label: string;
  type: SocketType;
  /** Value used when the input is not connected: number (float) or '#rrggbb' (colour). */
  default?: number | string;
  /** No inline value editor (e.g. image inputs – unconnected means "nothing"). */
  hideValue?: boolean;
  min?: number;
  max?: number;
  step?: number;
};

/** Nodes that start a chain from media. */
export const isSourceKind = (k: ShaderKind) => k === 'input' || k === 'folder';

export type FolderOption = { key: string; label: string; count: number };
export type MediaOption = { id: string; name: string };

export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;

/** Curve control point, both axes 0–1. */
export type CurvePoint = [number, number];
/** Curve points per channel id (e.g. master, r, g, b). */
export type Curves = Record<string, CurvePoint[]>;

export type RampStop = { pos: number; color: string; alpha: number };
export type Ramp = { stops: RampStop[]; interp: 'linear' | 'ease' | 'constant' };

/** A parsed .cube 3D LUT. Kept in memory and embedded in saved projects as text. */
export type LutData = {
  id: string;
  name: string;
  size: number;
  /** RGBA float data, size³ entries, red changing fastest. */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** Original file text (saved with the project). */
  text: string;
};

/** Contents of a compound (group) node. */
export type GroupDef = {
  nodes: ShaderNode[];
  edges: Edge[];
  inputs: Socket[];
  outputs: Socket[];
};

export type ShaderData = {
  label: string;
  kind: ShaderKind;
  /** Node parameters, including inline input values (`in_<socket>`). Missing keys use defaults. */
  params?: Params;
  /** Curve points (Curves / Hue Curves nodes). */
  curves?: Curves;
  /** Colour Ramp stops. */
  ramp?: Ramp;
  /** File name of the loaded 3D LUT (LUT node). */
  lutName?: string;
  /** Per-node preview toggle. */
  showPreview?: boolean;
  /** Bypass: the node passes its input straight through. */
  bypass?: boolean;
  /** Folder Input: which Media Pool folder to batch-process. */
  folder?: string;
  /** Compound node contents. */
  group?: GroupDef;
  /** Group Input (outputs) / Group Output (inputs) sockets. */
  sockets?: Socket[];
  /** Legacy (v1–v3 projects): Exposure value, migrated to params.stops on load. */
  value?: number;

  /* ---- runtime-only fields, injected by App and stripped when saving ---- */
  previewsEnabled?: boolean;
  hasImage?: boolean;
  batchCount?: number;
  folderOptions?: FolderOption[];
  mediaOptions?: MediaOption[];
  connected?: string[];
  lut?: LutData | null;
  onParams?: (id: string, patch: Params) => void;
  onCurve?: (id: string, channel: string, points: CurvePoint[]) => void;
  onRamp?: (id: string, ramp: Ramp) => void;
  onLoadLut?: (id: string, file: File) => void;
  onClearLut?: (id: string) => void;
  onTogglePreview?: (id: string) => void;
  onToggleBypass?: (id: string) => void;
  onResetNode?: (id: string) => void;
  onRename?: (id: string, label: string) => void;
  onEnterGroup?: (id: string) => void;
  onHandleClick?: (id: string, side: HandleSide, socket: string, x: number, y: number) => void;
  registerPreview?: (id: string, canvas: HTMLCanvasElement | null) => void;
  onFolderChange?: (id: string, folder: string) => void;
  onPickFolder?: (id: string) => void;
};

export type ShaderNode = Node<ShaderData, 'shader'>;

/** Per-image graph assignment (Library mode). */
export type ImageGraph = {
  presetId: string;
  /** Overridden parameters of the graph's exposed input nodes, per node id. */
  overrides: Record<string, Params>;
};

export type MediaItem = {
  id: string;
  name: string;
  url: string;
  image: HTMLImageElement;
  /** Folder key ('' = imported individually). */
  folder: string;
  /** Shown in the viewer grid – the display selection. */
  visible: boolean;
  /** Saved graph applied to this image (Library mode). */
  graph?: ImageGraph;
  /** Original file data (kept so the image can be stored for the next session). */
  blob?: Blob;
};

/** A saved node graph (Library). */
export type GraphPreset = {
  id: string;
  name: string;
  created: number;
  nodes: ShaderNode[];
  edges: Edge[];
  luts: Record<string, { name: string; text: string }>;
  /** Optional short description shown in the Library. */
  description?: string;
  /** Shipped with the app (looks pack). */
  builtin?: boolean;
};
