import { useState } from 'react';
import type { Control, SelectOption } from '../../nodes/registry';
import { DEFAULT_RAMP } from '../../nodes/graph';
import type { CurvePoint, Curves, LutData, MediaOption, Params, Ramp } from '../../types';
import ColourWheel from './ColourWheel';
import CurveEditor from './CurveEditor';
import ColourRamp from './ColourRamp';

export type ControlContext = {
  params: Params;
  curves?: Curves;
  ramp?: Ramp;
  lut?: LutData | null;
  lutName?: string;
  mediaOptions?: MediaOption[];
  set: (patch: Params) => void;
  setCurve: (channel: string, points: CurvePoint[]) => void;
  setRamp: (ramp: Ramp) => void;
  loadLut: (file: File) => void;
  clearLut: () => void;
};

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

const fmt = (v: number, digits = 0, unit = '') => `${v.toFixed(digits)}${unit}`;

/** Slider over a soft range plus a free number box (values outside the slider range are allowed). */
export function NumberField({
  label,
  value,
  onChange,
  step = 0.01,
  softMin = 0,
  softMax = 1,
  reset,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  softMin?: number;
  softMax?: number;
  reset?: number;
}) {
  return (
    <label className="ctl-number nodrag nowheel" title="Double-click the slider to reset">
      <span>{label}</span>
      <input
        className="nodrag nowheel"
        type="range"
        min={Math.min(softMin, value)}
        max={Math.max(softMax, value)}
        step={step}
        value={value}
        onPointerDown={stop}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => reset !== undefined && onChange(reset)}
      />
      <input
        className="nodrag nowheel num"
        type="number"
        step={step}
        value={Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0}
        onPointerDown={stop}
        onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Options({ options }: { options: SelectOption[] }) {
  const groups = [...new Set(options.map((o) => o.group ?? ''))];
  if (groups.length === 1 && !groups[0]) {
    return (
      <>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </>
    );
  }
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {options
            .filter((o) => (o.group ?? '') === g)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

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

/** Media picker for Image Input nodes ('' = the current / batch image). */
export function MediaSelect({ value, options, onChange }: { value: string; options: MediaOption[]; onChange: (v: string) => void }) {
  const missing = value && !options.some((o) => o.id === value);
  return (
    <label className="ctl-select nodrag nowheel">
      <span>Image</span>
      <select className="nodrag nowheel" value={value} onPointerDown={stop} onChange={(e) => onChange(e.target.value)}>
        <option value="">Current image</option>
        {missing && <option value={value}>(missing image)</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
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
          case 'number':
            return (
              <NumberField
                key={c.key}
                label={c.label}
                value={Number(params[c.key] ?? c.default)}
                step={c.step}
                softMin={c.softMin}
                softMax={c.softMax}
                reset={c.default}
                onChange={(v) => set({ [c.key]: v })}
              />
            );
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
                  <Options options={c.options} />
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
          case 'media':
            return (
              <MediaSelect
                key={c.key}
                value={String(params[c.key] ?? '')}
                options={ctx.mediaOptions ?? []}
                onChange={(v) => set({ [c.key]: v })}
              />
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
          case 'ramp':
            return <ColourRamp key={idx} ramp={ctx.ramp ?? DEFAULT_RAMP} onChange={ctx.setRamp} />;
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
