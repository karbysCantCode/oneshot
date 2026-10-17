import type { Node } from '@xyflow/react';

/** Node type id – see src/nodes/registry.ts for every available kind. */
export type ShaderKind = string;
export type HandleSide = 'target' | 'source';

/** Nodes that start a chain (no input socket). */
export const isSourceKind = (k: ShaderKind) => k === 'input' || k === 'folder';

export type FolderOption = { key: string; label: string; count: number };

export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;

/** Curve control point, both axes 0–1. */
export type CurvePoint = [number, number];
/** Curve points per channel id (e.g. master, r, g, b). */
export type Curves = Record<string, CurvePoint[]>;

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

export type ShaderData = {
  label: string;
  kind: ShaderKind;
  /** Node parameters (saved with the project). Missing keys use the node's defaults. */
  params?: Params;
  /** Curve points (Curves / Hue Curves nodes). */
  curves?: Curves;
  /** File name of the loaded 3D LUT (LUT node). */
  lutName?: string;
  /** Per-node preview toggle. */
  showPreview?: boolean;
  /** Folder Input: which Media Pool folder to batch-process. */
  folder?: string;
  /** Legacy (v1–v3 projects): Exposure value, migrated to params.stops on load. */
  value?: number;

  /* ---- runtime-only fields, injected by App and stripped when saving ---- */
  previewsEnabled?: boolean;
  hasImage?: boolean;
  batchCount?: number;
  folderOptions?: FolderOption[];
  lut?: LutData | null;
  onParams?: (id: string, patch: Params) => void;
  onCurve?: (id: string, channel: string, points: CurvePoint[]) => void;
  onLoadLut?: (id: string, file: File) => void;
  onClearLut?: (id: string) => void;
  onTogglePreview?: (id: string) => void;
  onHandleClick?: (id: string, side: HandleSide, x: number, y: number) => void;
  registerPreview?: (id: string, canvas: HTMLCanvasElement | null) => void;
  onFolderChange?: (id: string, folder: string) => void;
  onPickFolder?: (id: string) => void;
};

export type ShaderNode = Node<ShaderData, 'shader'>;

export type MediaItem = {
  id: string;
  name: string;
  url: string;
  image: HTMLImageElement;
  /** Folder key ('' = imported individually). */
  folder: string;
  /** Shown in the viewer grid – the display selection. */
  visible: boolean;
};
