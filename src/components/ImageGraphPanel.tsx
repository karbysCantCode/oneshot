import { exposedNodes } from '../nodes/graph';
import { defaultParams } from '../nodes/registry';
import type { GraphPreset, MediaItem, MediaOption, Params } from '../types';
import { MediaSelect, NumberField } from './params/Controls';

type Props = {
  item: MediaItem | null;
  presets: GraphPreset[];
  mediaOptions: MediaOption[];
  onAssign: (presetId: string) => void;
  onApplyToShown: () => void;
  onOverride: (nodeId: string, patch: Params) => void;
  onReset: () => void;
};

/**
 * Library view: the saved graph applied to the current image, and that graph's
 * "straggling" input nodes (Value, RGB Colour, Image Input) as per-image parameters.
 */
export default function ImageGraphPanel({ item, presets, mediaOptions, onAssign, onApplyToShown, onOverride, onReset }: Props) {
  if (!item) return <div className="graph-panel muted">Select an image to assign a saved graph.</div>;
  const preset = presets.find((p) => p.id === item.graph?.presetId);
  const exposed = preset ? exposedNodes(preset.nodes) : [];
  const overrides = item.graph?.overrides ?? {};
  const paramsOf = (id: string): Params => {
    const n = preset!.nodes.find((x) => x.id === id)!;
    return { ...defaultParams(n.data.kind), ...n.data.params, ...overrides[id] };
  };

  return (
    <div className="graph-panel">
      <div className="graph-panel-head">
        <b className="ellipsis" title={item.name}>{item.name}</b>
        <select value={preset?.id ?? ''} onChange={(e) => onAssign(e.target.value)} title="Saved graph applied to this image">
          <option value="">No graph (original)</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {item.graph && !preset && <option value={item.graph.presetId}>(deleted graph)</option>}
        </select>
        <button className="bar-btn" disabled={!preset} onClick={onApplyToShown} title="Use this graph and these parameters for every image shown">
          Apply to all shown
        </button>
        <button className="bar-btn" disabled={!preset || !Object.keys(overrides).length} onClick={onReset} title="Reset this image's parameters to the graph's values">
          Reset
        </button>
      </div>
      {!presets.length && <small className="hint">Save a graph in Toolbox → Library first.</small>}
      {preset && !exposed.length && (
        <small className="hint">This graph has no Value, RGB Colour or Image Input nodes, so it has no per-image parameters.</small>
      )}
      {preset && exposed.length > 0 && (
        <div className="graph-params">
          {exposed.map((n) => {
            const p = paramsOf(n.id);
            if (n.data.kind === 'value')
              return (
                <NumberField
                  key={n.id}
                  label={n.data.label}
                  value={Number(p.value)}
                  step={0.01}
                  softMin={Math.min(0, Number(p.value))}
                  softMax={Math.max(1, Number(p.value))}
                  reset={Number(n.data.params?.value ?? 0.5)}
                  onChange={(v) => onOverride(n.id, { value: v })}
                />
              );
            if (n.data.kind === 'rgb')
              return (
                <label key={n.id} className="ctl-color">
                  <span>{n.data.label}</span>
                  <input type="color" value={String(p.color)} onChange={(e) => onOverride(n.id, { color: e.target.value })} />
                </label>
              );
            return (
              <div key={n.id} className="param-media">
                <span>{n.data.label}</span>
                <MediaSelect value={String(p.media ?? '')} options={mediaOptions} onChange={(v) => onOverride(n.id, { media: v })} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
