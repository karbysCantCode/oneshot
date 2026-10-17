import { useEffect } from 'react';
import { defaultSettings, type PreviewMode, type Settings, type ViewerLayout } from '../settings';

type Props = { settings: Settings; onChange: (s: Settings) => void; onClose: () => void };

const modes: { value: PreviewMode; label: string; hint: string }[] = [
  { value: 'split', label: 'Viewer panel', hint: 'Output image in its own panel above the nodes' },
  { value: 'background', label: 'Behind nodes', hint: 'Output image fills the node workspace background' },
  { value: 'hidden', label: 'Off', hint: 'No large viewer; use node previews only' },
];

const layouts: { value: ViewerLayout; label: string; hint: string }[] = [
  { value: 'single', label: 'Single image', hint: 'One image at a time, step with ◀ ▶' },
  { value: 'grid', label: 'Grid', hint: 'Every image selected for display in the batch' },
];

export default function SettingsDialog({ settings, onChange, onClose }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <section>
          <h4>Output display</h4>
          {modes.map((m) => (
            <label key={m.value} className="radio-row">
              <input
                type="radio"
                name="previewMode"
                checked={settings.previewMode === m.value}
                onChange={() => set('previewMode', m.value)}
              />
              <span>
                <b>{m.label}</b>
                <small>{m.hint}</small>
              </span>
            </label>
          ))}
          {settings.previewMode === 'background' && (
            <label className="slider-row">
              Background dim
              <input
                type="range"
                min={0}
                max={0.9}
                step={0.05}
                value={settings.backgroundDim}
                onChange={(e) => set('backgroundDim', Number(e.target.value))}
              />
              <b>{Math.round(settings.backgroundDim * 100)}%</b>
            </label>
          )}
        </section>

        <section>
          <h4>Viewer layout</h4>
          {layouts.map((l) => (
            <label key={l.value} className="radio-row">
              <input
                type="radio"
                name="viewerLayout"
                checked={settings.viewerLayout === l.value}
                onChange={() => set('viewerLayout', l.value)}
              />
              <span>
                <b>{l.label}</b>
                <small>{l.hint}</small>
              </span>
            </label>
          ))}
          <label className="slider-row">
            Grid tile size
            <input
              type="range"
              min={120}
              max={480}
              step={20}
              value={settings.gridTileSize}
              onChange={(e) => set('gridTileSize', Number(e.target.value))}
            />
            <b>{settings.gridTileSize}px</b>
          </label>
        </section>

        <section>
          <h4>Nodes</h4>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.nodePreviews}
              onChange={(e) => set('nodePreviews', e.target.checked)}
            />
            Show image previews on top of nodes
          </label>
        </section>

        <section>
          <h4>Wires</h4>
          <label className="slider-row">
            Thickness
            <input
              type="range"
              min={1}
              max={8}
              step={0.5}
              value={settings.wireWidth}
              onChange={(e) => set('wireWidth', Number(e.target.value))}
            />
            <b>{settings.wireWidth}px</b>
          </label>
        </section>

        <div className="modal-foot">
          <button onClick={() => onChange(defaultSettings)}>Reset to defaults</button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
