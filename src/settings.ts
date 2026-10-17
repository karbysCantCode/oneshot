export type PreviewMode = 'split' | 'background' | 'hidden';
export type ViewerLayout = 'single' | 'grid';
/** Workspace: images processed by the graph being edited. Library: each image uses its own saved graph. */
export type ViewSource = 'workspace' | 'library';

export type Settings = {
  /** Where the final Output image is shown. */
  previewMode: PreviewMode;
  /** One image at a time, or a grid of every displayed image in the batch. */
  viewerLayout: ViewerLayout;
  viewSource: ViewSource;
  /** Minimum width of a grid tile in pixels. */
  gridTileSize: number;
  /** How much to darken the image when it is shown behind the nodes (0–0.9). */
  backgroundDim: number;
  /** Show image thumbnails on top of each node. */
  nodePreviews: boolean;
  /** Wire thickness in pixels. */
  wireWidth: number;
  /** Size of the procedural canvas (graphs with no image input). */
  canvasWidth: number;
  canvasHeight: number;
};

export const defaultSettings: Settings = {
  previewMode: 'split',
  viewerLayout: 'single',
  viewSource: 'workspace',
  gridTileSize: 220,
  backgroundDim: 0.45,
  nodePreviews: true,
  wireWidth: 3,
  canvasWidth: 1920,
  canvasHeight: 1080,
};

const KEY = 'nodegl.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaultSettings, ...JSON.parse(raw) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable (private mode etc.) – settings just won't persist */
  }
}
