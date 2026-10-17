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
