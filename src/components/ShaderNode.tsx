import { useCallback, useState, type MouseEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ALL_MEDIA, folderLabel } from '../media';
import { MATH_OPS, getDef } from '../nodes/registry';
import { inHandle, outHandle, socketsOf } from '../nodes/graph';
import type { HandleSide, ShaderNode, Socket } from '../types';
import Controls, { NumberField } from './params/Controls';

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** Inline SVG icons (font-independent, render the same on every platform). */
const BypassIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M1 8 H4 C5 8 5 4 6.5 4 H11" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M8.5 1.8 L11 4 L8.5 6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="6.5" cy="8.5" r="1.6" fill="currentColor" />
  </svg>
);
const ResetIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.6 4.2 A4 4 0 1 1 2 7" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M1.2 1.6 L2.7 4.4 L5.6 3.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
const EditGroupIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M1.5 4.5 V1.5 H4.5 M7.5 1.5 H10.5 V4.5 M10.5 7.5 V10.5 H7.5 M4.5 10.5 H1.5 V7.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export default function ShaderNodeView({ id, data, selected }: NodeProps<ShaderNode>) {
  const def = getDef(data.kind);
  const { inputs, outputs } = socketsOf({ data });
  const previewOn = !!data.previewsEnabled && data.showPreview !== false;
  const connected = new Set(data.connected ?? []);
  const params = data.params ?? {};
  const [renaming, setRenaming] = useState(false);
  /** Node has values that can be reset (parameters, inline inputs, curves, ramp). */
  const resettable = !!def && (def.controls.some((c) => c.type !== 'note' && c.type !== 'lut') || inputs.some((s) => !s.hideValue));

  const { registerPreview, onHandleClick } = data;

  // Callback ref: tells App which <canvas> to draw this node's GPU result into.
  const previewRef = useCallback(
    (el: HTMLCanvasElement | null) => registerPreview?.(id, el),
    [id, registerPreview],
  );

  const handleClick = (side: HandleSide, socket: string) => (e: MouseEvent) => {
    e.stopPropagation();
    onHandleClick?.(id, side, socket, e.clientX, e.clientY);
  };

  // Math: dim inputs the operation doesn't use.
  const mathUses = data.kind === 'math' ? MATH_OPS.find((o) => o.value === params.op)?.uses ?? 2 : 99;

  // Folder Input: make sure the saved folder appears even if it isn't loaded yet.
  const folder = data.folder ?? ALL_MEDIA;
  const folderOpts = data.folderOptions ?? [];
  const folderMissing = data.kind === 'folder' && !folderOpts.some((o) => o.key === folder);
  const category = data.kind === 'group' || data.kind === 'groupIn' || data.kind === 'groupOut' ? 'group' : (def?.category ?? 'Utility').split(' ')[0].toLowerCase();

  const inlineValue = (s: Socket) => {
    const key = `in_${s.id}`;
    if (s.type === 'float') {
      const v = Number(params[key] ?? s.default ?? 0);
      return (
        <NumberField
          label={s.label}
          value={v}
          step={s.step ?? 0.01}
          softMin={s.min ?? 0}
          softMax={s.max ?? 1}
          reset={typeof s.default === 'number' ? s.default : 0}
          onChange={(x) => data.onParams?.(id, { [key]: x })}
        />
      );
    }
    return (
      <label className="ctl-color nodrag">
        <span>{s.label}</span>
        <input
          type="color"
          value={String(params[key] ?? s.default ?? '#808080')}
          onPointerDown={stop}
          onChange={(e) => data.onParams?.(id, { [key]: e.target.value })}
        />
      </label>
    );
  };

  return (
    <div
      className={`shader-node kind-${data.kind} cat-${category} ${selected ? 'selected' : ''} ${data.bypass ? 'bypassed' : ''}`}
      style={{ width: def?.width ?? (data.kind === 'group' ? 200 : 190) }}
    >
      {previewOn && (
        <div className="node-preview">
          {data.hasImage ? <canvas ref={previewRef} /> : <span>No image</span>}
        </div>
      )}

      <div className="node-title" title={def?.description}>
        {renaming ? (
          <input
            className="nodrag rename"
            autoFocus
            defaultValue={data.label}
            onPointerDown={stop}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v) data.onRename?.(id, v);
              setRenaming(false);
            }}
          />
        ) : (
          <span className="label" onDoubleClick={(e) => (stop(e), setRenaming(true))} title="Double-click to rename">
            {data.label}
          </span>
        )}
        <span className="title-tools">
          {data.kind === 'folder' && <span className="badge">×{data.batchCount ?? 0}</span>}
          {data.kind === 'group' && (
            <button className="nodrag tool-btn" title="Edit group contents (Tab)" onClick={(e) => (stop(e), data.onEnterGroup?.(id))}>
              <EditGroupIcon />
            </button>
          )}
          {resettable && (
            <button className="nodrag tool-btn" title="Reset all values to defaults" onClick={(e) => (stop(e), data.onResetNode?.(id))}>
              <ResetIcon />
            </button>
          )}
          {data.kind !== 'groupIn' && data.kind !== 'groupOut' && data.kind !== 'output' && (
            <button
              className={`nodrag tool-btn bypass ${data.bypass ? 'on' : ''}`}
              title={data.bypass ? 'Bypassed – click to enable (M)' : 'Bypass: pass input straight through (M)'}
              onClick={(e) => (stop(e), data.onToggleBypass?.(id))}
            >
              <BypassIcon />
            </button>
          )}
          {data.previewsEnabled && (
            <button
              className="nodrag tool-btn"
              title={previewOn ? 'Hide preview' : 'Show preview'}
              onClick={(e) => (stop(e), data.onTogglePreview?.(id))}
            >
              {previewOn ? '◉' : '○'}
            </button>
          )}
        </span>
      </div>

      {outputs.map((s) => (
        <div key={s.id} className="socket-row out">
          <span>{s.label}</span>
          <Handle
            type="source"
            position={Position.Right}
            id={outHandle(s.id)}
            className={`sock-${s.type}`}
            title={`${s.label} (${s.type === 'float' ? 'value' : 'colour'}) – click for options, drag to connect`}
            onClick={handleClick('source', s.id)}
          />
        </div>
      ))}

      <div className="node-body">
        {data.kind === 'output' && <span>Viewer output</span>}
        {data.kind === 'group' && <span>{(data.group?.nodes.length ?? 2) - 2} nodes inside · Tab to edit</span>}
        {(data.kind === 'groupIn' || data.kind === 'groupOut') && <span>{data.kind === 'groupIn' ? 'Values entering the group' : 'Values leaving the group'}</span>}
        {data.bypass && <span className="bypass-note">Bypassed</span>}
        {!def && <span className="warn">Unknown node type “{data.kind}”</span>}

        {data.kind === 'folder' && (
          <div className="folder-ctl nodrag nowheel">
            <select
              className="nodrag nowheel"
              value={folder}
              onChange={(e) => data.onFolderChange?.(id, e.target.value)}
              onPointerDown={stop}
            >
              {folderMissing && <option value={folder}>{folderLabel(folder)} (not loaded)</option>}
              {folderOpts.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label} ({o.count})
                </option>
              ))}
            </select>
            <button className="nodrag" onClick={(e) => (stop(e), data.onPickFolder?.(id))}>
              Load folder…
            </button>
            <small>{data.batchCount ?? 0} images processed as a batch</small>
          </div>
        )}

        {def && def.controls.length > 0 && (
          <div className="controls">
            <Controls
              controls={def.controls}
              ctx={{
                params,
                curves: data.curves,
                ramp: data.ramp,
                lut: data.lut,
                lutName: data.lutName,
                mediaOptions: data.mediaOptions,
                set: (patch) => data.onParams?.(id, patch),
                setCurve: (channel, points) => data.onCurve?.(id, channel, points),
                setRamp: (ramp) => data.onRamp?.(id, ramp),
                loadLut: (file) => data.onLoadLut?.(id, file),
                clearLut: () => data.onClearLut?.(id),
              }}
            />
          </div>
        )}
        {def && !def.controls.length && def.glsl && !inputs.some((s) => !s.hideValue) && <span>{def.description}</span>}
      </div>

      {inputs.map((s, i) => {
        const isConnected = connected.has(inHandle(s.id));
        return (
          <div key={s.id} className={`socket-row in ${i >= mathUses ? 'unused' : ''}`}>
            <Handle
              type="target"
              position={Position.Left}
              id={inHandle(s.id)}
              className={`sock-${s.type}`}
              title={`${s.label} (${s.type === 'float' ? 'value' : 'colour'}) – click for options, drag to connect`}
              onClick={handleClick('target', s.id)}
            />
            {isConnected || s.hideValue ? <span>{s.label}</span> : inlineValue(s)}
          </div>
        );
      })}
    </div>
  );
}
