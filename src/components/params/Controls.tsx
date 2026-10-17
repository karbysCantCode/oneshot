import { useState } from 'react';
import type { Control } from '../../nodes/registry';
import type { CurvePoint, Curves, LutData, Params } from '../../types';
import ColourWheel from './ColourWheel';
import CurveEditor from './CurveEditor';

export type ControlContext = {
  params: Params;
  curves?: Curves;
  lut?: LutData | null;
  lutName?: string;
  set: (patch: Params) => void;
  setCurve: (channel: string, points: CurvePoint[]) => void;
  loadLut: (file: File) => void;
  clearLut: () => void;
};

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

const fmt = (v: number, digits = 0, unit = '') => `${v.toFixed(digits)}${unit}`;

function Tabs({ tabs, ctx }: { tabs: { label: string; controls: Control[] }[]; ctx: ControlContext }) {
  const [i, setI] = useState(0);
  return (
    <div className="ctl-tabs">
      <div className="tab-row">
        {tabs.map((t, k) => (
          <button key={t.label} className={k === i ? 'on' : ''} onPointerDown={stop} onClick={() => setI(k)}>
            {t.label}
          </button>
        ))}
      </div>
      <Controls controls={tabs[i].controls} ctx={ctx} />
    </div>
  );
}

/** Renders a node's parameter controls from its registry definition. */
export default function Controls({ controls, ctx }: { controls: Control[]; ctx: ControlContext }) {
  const { params, set } = ctx;
  return (
    <>
      {controls.map((c, idx) => {
        switch (c.type) {
          case 'slider': {
            const v = Number(params[c.key] ?? c.default);
            return (
              <label key={c.key} className="ctl-slider nodrag nowheel" title="Double-click to reset">
                <span>{c.label}</span>
                <input
                  className="nodrag nowheel"
                  type="range"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={v}
                  onPointerDown={stop}
                  onChange={(e) => set({ [c.key]: Number(e.target.value) })}
                  onDoubleClick={() => set({ [c.key]: c.default })}
                />
                <b>{fmt(v, c.digits, c.unit)}</b>
              </label>
            );
          }
          case 'select':
            return (
              <label key={c.key} className="ctl-select nodrag nowheel">
                <span>{c.label}</span>
                <select
                  className="nodrag nowheel"
                  value={String(params[c.key] ?? c.default)}
                  onPointerDown={stop}
                  onChange={(e) => set({ [c.key]: e.target.value })}
                >
                  {c.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          case 'check':
            return (
              <label key={c.key} className="ctl-check nodrag">
                <input
                  type="checkbox"
                  checked={Boolean(params[c.key] ?? c.default)}
                  onPointerDown={stop}
                  onChange={(e) => set({ [c.key]: e.target.checked })}
                />
                {c.label}
              </label>
            );
          case 'color':
            return (
              <label key={c.key} className="ctl-color nodrag">
                <span>{c.label}</span>
                <input
                  type="color"
                  value={String(params[c.key] ?? c.default)}
                  onPointerDown={stop}
                  onChange={(e) => set({ [c.key]: e.target.value })}
                />
              </label>
            );
          case 'wheel':
            return (
              <ColourWheel
                key={c.key}
                label={c.label}
                masterLabel={c.masterLabel}
                x={Number(params[`${c.key}X`] ?? 0)}
                y={Number(params[`${c.key}Y`] ?? 0)}
                master={Number(params[`${c.key}M`] ?? 0)}
                onChange={(x, y, m) => set({ [`${c.key}X`]: x, [`${c.key}Y`]: y, [`${c.key}M`]: m })}
              />
            );
          case 'curves':
            return <CurveEditor key={idx} channels={c.channels} curves={ctx.curves} onChange={ctx.setCurve} />;
          case 'lut':
            return (
              <div key={idx} className="ctl-lut nodrag">
                <div className="lut-name" title={ctx.lutName}>
                  {ctx.lut ? `${ctx.lut.name} (${ctx.lut.size}³)` : ctx.lutName ? `${ctx.lutName} – not loaded` : 'No LUT loaded'}
                </div>
                <div className="lut-buttons">
                  <label className="mini-btn" onPointerDown={stop}>
                    Load .cube…
                    <input
                      hidden
                      type="file"
                      accept=".cube,.CUBE"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) ctx.loadLut(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {ctx.lut && (
                    <button className="mini-btn" onPointerDown={stop} onClick={ctx.clearLut}>
                      Clear
                    </button>
                  )}
                </div>
              </div>
            );
          case 'tabs':
            return <Tabs key={idx} tabs={c.tabs} ctx={ctx} />;
          case 'note':
            return (
              <small key={idx} className="ctl-note">
                {c.text}
              </small>
            );
        }
      })}
    </>
  );
}
