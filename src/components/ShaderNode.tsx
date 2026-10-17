import { useCallback, type MouseEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ALL_MEDIA, folderLabel } from '../media';
import { getDef } from '../nodes/registry';
import type { HandleSide, ShaderNode } from '../types';
import Controls from './params/Controls';

export default function ShaderNodeView({ id, data, selected }: NodeProps<ShaderNode>) {
  const def = getDef(data.kind);
  const hasInput = data.kind !== 'input' && data.kind !== 'folder';
  const hasOutput = data.kind !== 'output';
  const previewOn = !!data.previewsEnabled && data.showPreview !== false;

  const { registerPreview, onHandleClick } = data;

  // Callback ref: tells App which <canvas> to draw this node's GPU result into.
  const previewRef = useCallback(
    (el: HTMLCanvasElement | null) => registerPreview?.(id, el),
    [id, registerPreview],
  );

  const handleClick = (side: HandleSide) => (e: MouseEvent) => {
    e.stopPropagation();
    onHandleClick?.(id, side, e.clientX, e.clientY);
  };

  // Folder Input: make sure the saved folder appears even if it isn't loaded yet.
  const folder = data.folder ?? ALL_MEDIA;
  const options = data.folderOptions ?? [];
  const folderMissing = data.kind === 'folder' && !options.some((o) => o.key === folder);

  return (
    <div
      className={`shader-node kind-${data.kind} cat-${(def?.category ?? 'Utility').split(' ')[0].toLowerCase()} ${selected ? 'selected' : ''}`}
      style={{ width: def?.width ?? 190 }}
    >
      {hasInput && (
        <Handle
          type="target"
          position={Position.Left}
          title="Click for connection options, drag to connect"
          onClick={handleClick('target')}
        />
      )}

      {previewOn && (
        <div className="node-preview">
          {data.hasImage ? <canvas ref={previewRef} /> : <span>No image</span>}
        </div>
      )}

      <div className="node-title" title={def?.description}>
        <span>{data.label}</span>
        <span className="title-tools">
          {data.kind === 'folder' && <span className="badge">×{data.batchCount ?? 0}</span>}
          {data.previewsEnabled && (
            <button
              className="nodrag preview-toggle"
              title={previewOn ? 'Hide preview' : 'Show preview'}
              onClick={(e) => {
                e.stopPropagation();
                data.onTogglePreview?.(id);
              }}
            >
              {previewOn ? '◉' : '○'}
            </button>
          )}
        </span>
      </div>

      <div className="node-body">
        {data.kind === 'input' && <span>Active image</span>}
        {data.kind === 'output' && <span>Viewer output</span>}
        {!def && <span className="warn">Unknown node type “{data.kind}”</span>}

        {data.kind === 'folder' && (
          <div className="folder-ctl nodrag nowheel">
            <select
              className="nodrag nowheel"
              value={folder}
              onChange={(e) => data.onFolderChange?.(id, e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {folderMissing && <option value={folder}>{folderLabel(folder)} (not loaded)</option>}
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label} ({o.count})
                </option>
              ))}
            </select>
            <button
              className="nodrag"
              onClick={(e) => {
                e.stopPropagation();
                data.onPickFolder?.(id);
              }}
            >
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
                params: data.params ?? {},
                curves: data.curves,
                lut: data.lut,
                lutName: data.lutName,
                set: (patch) => data.onParams?.(id, patch),
                setCurve: (channel, points) => data.onCurve?.(id, channel, points),
                loadLut: (file) => data.onLoadLut?.(id, file),
                clearLut: () => data.onClearLut?.(id),
              }}
            />
          </div>
        )}
        {def && !def.controls.length && def.glsl && <span>{def.description}</span>}
      </div>

      {hasOutput && (
        <Handle
          type="source"
          position={Position.Right}
          title="Click for connection options, drag to connect"
          onClick={handleClick('source')}
        />
      )}
    </div>
  );
}
