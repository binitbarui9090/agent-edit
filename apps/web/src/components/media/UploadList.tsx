import { useShallow } from 'zustand/react/shallow';
import { formatBytes } from '../../lib/format';
import {
  cancelUploadItem,
  dismissUpload,
  pauseUpload,
  resumeUpload,
  useUploads,
  type UploadItem,
} from '../../uploads/store';
import { Button } from '../Button';
import styles from './UploadList.module.css';

function phaseText(item: UploadItem): string {
  switch (item.phase) {
    case 'queued':
      return 'Waiting';
    case 'preparing':
      return 'Preparing';
    case 'uploading':
      return item.bytesPerSecond > 0 ? `${formatBytes(item.bytesPerSecond)}/s` : 'Uploading';
    case 'retrying':
      return navigator.onLine ? 'Connection problem, retrying' : 'Offline, waiting to reconnect';
    case 'paused':
      return 'Paused';
    case 'finishing':
      return 'Verifying';
    case 'done':
      return 'Uploaded';
    case 'failed':
      return item.error ?? 'Upload failed';
  }
}

function UploadRow({ item }: { item: UploadItem }) {
  const percent = item.size > 0 ? Math.min(100, (item.uploadedBytes / item.size) * 100) : 0;
  const stoppable = ['queued', 'preparing', 'uploading', 'retrying'].includes(item.phase);
  return (
    <li className={styles.row} data-phase={item.phase}>
      <div className={styles.head}>
        <span className={styles.name}>{item.name}</span>
        <span className={styles.status} role="status">
          {phaseText(item)}
        </span>
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={`Upload of ${item.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span className={styles.fill} style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
      <div className={styles.foot}>
        <span className={styles.bytes}>
          {formatBytes(item.uploadedBytes)} of {formatBytes(item.size)}
          {item.resumedBytes > 0 && ` · resumed from ${formatBytes(item.resumedBytes)}`}
        </span>
        <span className={styles.actions}>
          {stoppable && item.phase !== 'queued' && (
            <Button variant="ghost" onClick={() => pauseUpload(item.id)}>
              Pause
            </Button>
          )}
          {(item.phase === 'paused' || (item.phase === 'failed' && item.mediaId)) && (
            <Button variant="ghost" onClick={() => resumeUpload(item.id)}>
              Resume
            </Button>
          )}
          {item.phase !== 'done' && item.phase !== 'finishing' && item.mediaId !== null && (
            <Button variant="ghost" onClick={() => void cancelUploadItem(item.id)}>
              Cancel
            </Button>
          )}
          {(item.phase === 'done' || (item.phase === 'failed' && !item.mediaId)) && (
            <Button variant="ghost" onClick={() => dismissUpload(item.id)}>
              Dismiss
            </Button>
          )}
        </span>
      </div>
    </li>
  );
}

export function UploadList({ projectId }: { projectId: string }) {
  const items = useUploads(
    useShallow((state) => Object.values(state.items).filter((i) => i.projectId === projectId)),
  );
  if (items.length === 0) return null;
  return (
    <ul className={styles.list} aria-label="Uploads">
      {items.map((item) => (
        <UploadRow key={item.id} item={item} />
      ))}
    </ul>
  );
}
