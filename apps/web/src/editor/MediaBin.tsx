import { ticksToSeconds } from '@agent-edit/shared';
import { createMediaClip, firstTrackOfType, timelineDuration } from '@agent-edit/timeline-engine';
import type { MediaAsset } from '@agent-edit/validation';
import { Link } from 'react-router';
import { formatDuration } from '../lib/format';
import { Button } from '../components/Button';
import { commitEdit, selectClips, useEditor } from './store';
import { MEDIA_DRAG_TYPE } from './TimelineView';
import styles from './MediaBin.module.css';

export function MediaBin({
  projectId,
  assets,
}: {
  projectId: string;
  assets: readonly MediaAsset[];
}) {
  function append(asset: MediaAsset) {
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

  const usable = assets.filter((asset) => asset.status === 'ready' && asset.probe);
  const waiting = assets.length - usable.length;

  return (
    <section className={styles.bin} aria-label="Media bin">
      <h2 className={styles.title}>Media</h2>
      {usable.length === 0 && (
        <p className={styles.empty}>
          No ready footage. <Link to={`/projects/${projectId}`}>Upload some</Link>.
        </p>
      )}
      <ul className={styles.list}>
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
            </div>
            <div className={styles.info}>
              <span className={styles.name} title={asset.name}>
                {asset.name}
              </span>
              <span className={styles.meta}>
                {formatDuration(ticksToSeconds(asset.probe!.duration))}
              </span>
            </div>
            <Button
              variant="ghost"
              aria-label={`Add ${asset.name} to timeline`}
              onClick={() => append(asset)}
            >
              Add
            </Button>
          </li>
        ))}
      </ul>
      {waiting > 0 && <p className={styles.empty}>{waiting} still processing or uploading.</p>}
    </section>
  );
}
