import { UPLOAD_CONTENT_TYPES, ticksToSeconds } from '@agent-edit/shared';
import { createMediaClip, firstTrackOfType, timelineDuration } from '@agent-edit/timeline-engine';
import type { MediaAsset } from '@agent-edit/validation';
import { LoaderCircle, Plus, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { IconButton } from '../components/Button';
import { formatDuration } from '../lib/format';
import { enqueueUploads, useUploads } from '../uploads/store';
import { commitEdit, selectClips, useEditor } from './store';
import { MEDIA_DRAG_TYPE } from './TimelineView';
import styles from './MediaBin.module.css';

const ACCEPT = Object.keys(UPLOAD_CONTENT_TYPES)
  .map((extension) => `.${extension}`)
  .join(',');

/** Puts footage on the end of the main track. Shared with the empty timeline's call to action. */
export function appendToTimeline(asset: MediaAsset): void {
  const { timeline } = useEditor.getState();
  if (!timeline || !asset.probe) return;
  const track = firstTrackOfType(timeline, 'VIDEO');
  if (!track) return;
  const clip = createMediaClip(
    {
      sourceMediaId: asset.id,
      start: timelineDuration(timeline),
      sourceIn: 0,
      sourceOut: asset.probe.duration,
    },
    timeline.frameRate,
  );
  if (commitEdit([{ op: 'add_clip', trackId: track.id, clip }], `Add ${asset.name}`)) {
    selectClips([clip.id]);
  }
}

/** Footage is usable as soon as it plays. Analysis carries on and fills in the rest behind it. */
export function isEditable(asset: MediaAsset): boolean {
  if (!asset.probe || asset.status === 'failed' || asset.status === 'uploading') return false;
  return (
    asset.status === 'ready' ||
    asset.jobs.some((job) => job.step === 'proxy' && job.status === 'done')
  );
}

/** Where a file is up to, measured from real bytes or real analysis steps. */
function stateOf(
  asset: MediaAsset,
  uploaded: number | null,
): { label: string; share: number | null } {
  if (uploaded !== null) return { label: 'Uploading', share: uploaded };
  if (asset.status === 'failed') return { label: 'Failed', share: null };
  if (asset.status === 'uploading') return { label: 'Upload incomplete', share: null };
  const total = asset.jobs.length;
  if (total === 0) return { label: 'Processing', share: null };
  const done = asset.jobs.reduce(
    (sum, job) => sum + (job.status === 'done' ? 1 : job.status === 'running' ? job.progress : 0),
    0,
  );
  return { label: 'Processing', share: done / total };
}

export function MediaBin({
  projectId,
  assets,
}: {
  projectId: string;
  assets: readonly MediaAsset[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const uploads = useUploads(
    useShallow((state) =>
      Object.values(state.items).filter(
        (item) => item.projectId === projectId && item.phase !== 'done' && item.phase !== 'failed',
      ),
    ),
  );

  function addFiles(files: FileList | null) {
    if (files && files.length > 0) enqueueUploads(projectId, Array.from(files));
  }

  function onDrop(event: DragEvent) {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  const usable = assets.filter(isEditable);
  const others = assets.filter((asset) => !usable.includes(asset));
  const unlinked = uploads.filter(
    (item) => !item.mediaId || !assets.some((asset) => asset.id === item.mediaId),
  );

  return (
    <section
      className={styles.bin}
      aria-label="Media bin"
      data-dragging={dragging}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className={styles.header}>
        <h2 className={styles.title}>Media</h2>
        <IconButton
          icon={Upload}
          label="Import footage"
          tipSide="left"
          onClick={() => input.current?.click()}
        />
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          aria-label="Import footage files"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </header>

      <div className={styles.scroll}>
        {assets.length === 0 && unlinked.length === 0 && (
          <button type="button" className={styles.dropHint} onClick={() => input.current?.click()}>
            <Upload size={18} strokeWidth={1.5} aria-hidden="true" />
            <span>Drop video here or click to import</span>
          </button>
        )}
        <ul className={styles.grid}>
          {usable.map((asset) => (
            <li
              key={asset.id}
              className={styles.item}
              draggable
              data-testid="bin-item"
              onDragStart={(event) => {
                event.dataTransfer.setData(MEDIA_DRAG_TYPE, asset.id);
                event.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <div className={styles.thumb}>
                {asset.posterUrl && <img src={asset.posterUrl} alt="" draggable={false} />}
                <span className={styles.duration}>
                  {formatDuration(ticksToSeconds(asset.probe!.duration))}
                </span>
                {asset.status === 'processing' && (
                  <span className={styles.analysing}>
                    <LoaderCircle size={10} className={styles.spin} aria-hidden="true" />
                    Analysing
                  </span>
                )}
                <IconButton
                  icon={Plus}
                  className={styles.add}
                  label={`Add ${asset.name} to timeline`}
                  onClick={() => appendToTimeline(asset)}
                />
              </div>
              <span className={styles.name} title={asset.name}>
                {asset.name}
              </span>
            </li>
          ))}
          {others.map((asset) => {
            const upload = uploads.find((item) => item.mediaId === asset.id);
            const { label, share } = stateOf(
              asset,
              upload && upload.size > 0 ? upload.uploadedBytes / upload.size : null,
            );
            return (
              <li key={asset.id} className={styles.item} data-busy="true">
                <div className={styles.thumb}>
                  {asset.posterUrl && <img src={asset.posterUrl} alt="" draggable={false} />}
                  <div className={styles.progress}>
                    <span className={styles.progressLabel}>
                      {asset.status !== 'failed' && (
                        <LoaderCircle size={12} className={styles.spin} aria-hidden="true" />
                      )}
                      {label}
                      {share !== null && ` ${Math.round(share * 100)}%`}
                    </span>
                    {share !== null && (
                      <span className={styles.progressBar}>
                        <span style={{ transform: `scaleX(${share})` }} />
                      </span>
                    )}
                  </div>
                </div>
                <span className={styles.name} title={asset.name}>
                  {asset.name}
                </span>
              </li>
            );
          })}
          {unlinked.map((item) => (
            <li key={item.id} className={styles.item} data-busy="true">
              <div className={styles.thumb}>
                <div className={styles.progress}>
                  <span className={styles.progressLabel}>
                    <LoaderCircle size={12} className={styles.spin} aria-hidden="true" />
                    Preparing
                  </span>
                </div>
              </div>
              <span className={styles.name} title={item.name}>
                {item.name}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
