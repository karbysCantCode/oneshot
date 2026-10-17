import { useEffect, useMemo, useState } from 'react';
import { canEncode, defaultExportOptions, type ExportFormat, type ExportOptions, type ExportScope } from '../export';

type Props = {
  initial: ExportOptions;
  /** Number of images per scope. */
  counts: Record<ExportScope, number>;
  /** Describes what is rendered (Workspace graph / per-image Library graphs). */
  sourceLabel: string;
  busy: boolean;
  onExport: (o: ExportOptions) => void;
  onClose: () => void;
};

const scopes: { value: ExportScope; label: string }[] = [
  { value: 'current', label: 'Current image' },
  { value: 'shown', label: 'Images shown in the viewer' },
  { value: 'batch', label: 'Every image in the batch' },
];

export default function ExportDialog({ initial, counts, sourceLabel, busy, onExport, onClose }: Props) {
  const [o, setO] = useState<ExportOptions>(initial);
  const set = <K extends keyof ExportOptions>(k: K, v: ExportOptions[K]) => setO((p) => ({ ...p, [k]: v }));
  const webp = useMemo(() => canEncode('webp'), []);
  const count = counts[o.scope];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={() => !busy && onClose()}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Export images</h2>
          <button className="icon-btn" onClick={onClose} disabled={busy} title="Close">
            ✕
          </button>
        </div>
        <small className="hint">Renders with {sourceLabel} on the GPU at the chosen size.</small>

        <section>
          <h4>Images</h4>
          {scopes.map((s) => (
            <label key={s.value} className={`radio-row ${counts[s.value] ? '' : 'disabled'}`}>
              <input type="radio" name="scope" disabled={!counts[s.value]} checked={o.scope === s.value} onChange={() => set('scope', s.value)} />
              <span>
                <b>{s.label}</b>
                <small>
                  {counts[s.value]} image{counts[s.value] === 1 ? '' : 's'}
                </small>
              </span>
            </label>
          ))}
        </section>

        <section>
          <h4>Format</h4>
          <div className="seg">
            {(['jpeg', 'png', 'webp'] as ExportFormat[]).map((f) => (
              <button key={f} className={o.format === f ? 'on' : ''} disabled={f === 'webp' && !webp} title={f === 'webp' && !webp ? 'This browser cannot encode WebP' : ''} onClick={() => set('format', f)}>
                {f === 'jpeg' ? 'JPEG' : f.toUpperCase()}
              </button>
            ))}
          </div>
          {o.format !== 'png' && (
            <label className="slider-row">
              Quality
              <input type="range" min={1} max={100} value={o.quality} onChange={(e) => set('quality', Number(e.target.value))} />
              <b>{o.quality}</b>
            </label>
          )}
          {o.format === 'png' && <small className="hint">Lossless 8-bit PNG (keeps transparency).</small>}
        </section>

        <section>
          <h4>Size</h4>
          <label className="check-row">
            <input type="checkbox" checked={o.maxSize === 0} onChange={(e) => set('maxSize', e.target.checked ? 0 : 2048)} />
            Full resolution
          </label>
          {o.maxSize > 0 && (
            <div className="size-row">
              Long edge
              <input type="number" min={16} max={16384} value={o.maxSize} onChange={(e) => set('maxSize', Math.max(16, Math.round(Number(e.target.value) || 16)))} />
              px
            </div>
          )}
        </section>

        <section>
          <h4>File names</h4>
          <div className="size-row">
            Suffix
            <input type="text" value={o.suffix} placeholder="(none)" onChange={(e) => set('suffix', e.target.value)} />
            <small className="hint">IMG_001{o.suffix}.{o.format === 'jpeg' ? 'jpg' : o.format}</small>
          </div>
          {count > 1 && (
            <>
              <label className="radio-row">
                <input type="radio" name="pack" checked={o.packaging === 'zip'} onChange={() => set('packaging', 'zip')} />
                <span>
                  <b>One ZIP file</b>
                </span>
              </label>
              <label className="radio-row">
                <input type="radio" name="pack" checked={o.packaging === 'files'} onChange={() => set('packaging', 'files')} />
                <span>
                  <b>Separate downloads</b>
                  <small>The browser may ask to allow multiple downloads</small>
                </span>
              </label>
            </>
          )}
        </section>

        <div className="modal-foot">
          <button onClick={() => setO({ ...defaultExportOptions, scope: o.scope })} disabled={busy}>
            Defaults
          </button>
          <button className="primary" disabled={busy || !count} onClick={() => onExport(o)}>
            {busy ? 'Exporting…' : `Export ${count} image${count === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
