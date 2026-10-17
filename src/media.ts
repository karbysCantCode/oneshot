import type { FolderOption, MediaItem } from './types';

/** Folder key meaning "every image in the Media Pool". */
export const ALL_MEDIA = '*';
/** Folder key for images imported individually (not from a folder). */
export const LOOSE = '';

export const folderLabel = (key: string) =>
  key === ALL_MEDIA ? 'All media' : key === LOOSE ? 'Loose images' : key;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

/** Accept image files; skip hidden files such as macOS "._photo.jpg" resource forks. */
export const isImageFile = (f: File) =>
  !f.name.startsWith('.') && (f.type.startsWith('image/') || IMAGE_EXT.test(f.name));

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** "IMG_2.jpg" sorts before "IMG_10.jpg". */
export const naturalCompare = (a: string, b: string) => collator.compare(a, b);

export function folderGroups(media: MediaItem[]) {
  const map = new Map<string, MediaItem[]>();
  for (const m of media) {
    const list = map.get(m.folder);
    if (list) list.push(m);
    else map.set(m.folder, [m]);
  }
  return [...map].map(([key, items]) => ({ key, items }));
}

export function folderOptions(media: MediaItem[]): FolderOption[] {
  return [
    { key: ALL_MEDIA, label: folderLabel(ALL_MEDIA), count: media.length },
    ...folderGroups(media).map((g) => ({ key: g.key, label: folderLabel(g.key), count: g.items.length })),
  ];
}

/** Avoid clashes when two folders with the same name are imported. */
export function uniqueFolderName(name: string, media: MediaItem[]) {
  const used = new Set(media.map((m) => m.folder));
  if (!used.has(name)) return name;
  let i = 2;
  while (used.has(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}

/** Images in a folder (or all media). */
export const imagesInFolder = (media: MediaItem[], folder: string) =>
  folder === ALL_MEDIA ? media : media.filter((m) => m.folder === folder);

/* ---------------- drag & drop ---------------- */

export type DroppedFile = { file: File; /** Path relative to the dropped item, e.g. "Shoot/day1/IMG_1.jpg" ('' folder part = loose file). */ path: string };

/** Read every file from a drop, recursing into dropped folders (Chrome, Edge, Firefox, Safari). */
export async function readDropped(dt: DataTransfer): Promise<DroppedFile[]> {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  // Fallback: no entry API – plain files only.
  if (!entries.some((e) => e)) return Array.from(dt.files ?? []).map((file) => ({ file, path: file.name }));

  const out: DroppedFile[] = [];
  const fileOf = (e: FileSystemFileEntry) => new Promise<File | null>((res) => e.file(res, () => res(null)));
  const readAll = async (dir: FileSystemDirectoryEntry) => {
    const reader = dir.createReader();
    const all: FileSystemEntry[] = [];
    // readEntries returns results in batches – keep reading until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      all.push(...batch);
    }
    return all;
  };
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const f = await fileOf(entry as FileSystemFileEntry);
      if (f) out.push({ file: f, path: prefix + f.name });
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry as FileSystemDirectoryEntry)) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  // Entries must be taken synchronously from the event; walking can be async.
  for (const e of entries) if (e) await walk(e, '');
  return out;
}
