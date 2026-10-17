/* =====================================================================
 *  Session retention
 *  - Image files: IndexedDB (binary blobs, large quota).
 *  - Media Pool metadata (names, folders, display ticks, Library graph
 *    assignments) and the workspace graph: localStorage (small JSON).
 *  Everything stays on this computer, in this browser profile.
 * ===================================================================== */
import type { Edge } from '@xyflow/react';
import type { ImageGraph, ShaderNode } from './types';

const DB = 'nodegl';
const STORE = 'images';
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const putImage = (id: string, blob: Blob) => run('readwrite', (s) => s.put(blob, id));
export const getImage = (id: string) => run<Blob>('readonly', (s) => s.get(id) as IDBRequest<Blob>);
export const deleteImages = (ids: string[]) =>
  run('readwrite', (s) => {
    ids.forEach((id) => s.delete(id));
  });
export const clearImages = () => run('readwrite', (s) => s.clear());

let persistAsked = false;
/** Ask the browser not to evict our storage under pressure (best effort, no prompt in most browsers). */
export function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  void navigator.storage?.persist?.().catch(() => undefined);
}

/* ---------------- media metadata ---------------- */

export type MediaMeta = { id: string; name: string; folder: string; visible: boolean; graph?: ImageGraph };
const MEDIA_KEY = 'nodegl.media.v1';

export function loadMediaMeta(): { items: MediaMeta[]; activeId: string | null } {
  try {
    const j = JSON.parse(localStorage.getItem(MEDIA_KEY) ?? 'null');
    if (j && Array.isArray(j.items)) return { items: j.items, activeId: j.activeId ?? null };
  } catch {
    /* ignore */
  }
  return { items: [], activeId: null };
}

export function saveMediaMeta(items: MediaMeta[], activeId: string | null) {
  try {
    localStorage.setItem(MEDIA_KEY, JSON.stringify({ items, activeId }));
  } catch {
    /* ignore */
  }
}

/* ---------------- workspace graph ---------------- */

export type SavedWorkspace = { nodes: ShaderNode[]; edges: Edge[]; luts: Record<string, { name: string; text: string }> };
const WS_KEY = 'nodegl.workspace.v1';

export function loadWorkspace(): SavedWorkspace | null {
  try {
    const j = JSON.parse(localStorage.getItem(WS_KEY) ?? 'null');
    if (j && Array.isArray(j.nodes) && Array.isArray(j.edges)) return { nodes: j.nodes, edges: j.edges, luts: j.luts ?? {} };
  } catch {
    /* ignore */
  }
  return null;
}

/** Returns false if the browser refused (quota). */
export function saveWorkspace(w: SavedWorkspace): boolean {
  try {
    localStorage.setItem(WS_KEY, JSON.stringify({ version: 9, ...w }));
    return true;
  } catch {
    return false;
  }
}
