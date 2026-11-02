import { frameRateLabel, ticksToSeconds } from '@agent-edit/shared';
import type { MediaAsset } from '@agent-edit/validation';
import { useEffect, useRef } from 'react';
import { usePlayback } from '../../api/media';
import { errorMessage } from '../../lib/form-errors';
import { formatBytes, formatDuration } from '../../lib/format';
import { Button } from '../Button';
import { FormError } from '../Field';
import { Waveform } from './Waveform';
import styles from './PreviewDialog.module.css';

export function PreviewDialog({ asset, onClose }: { asset: MediaAsset; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const playback = usePlayback(asset.projectId, asset.id);
  const probe = asset.probe;

  useEffect(() => {
    // No close() in cleanup: it fires onClose, and unmounting already removes the modal.
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  const data = playback.data;
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      onClose={onClose}
      aria-label={`Preview ${asset.name}`}
    >
      <header className={styles.header}>
        <h2 className={styles.title}>{asset.name}</h2>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </header>
      <FormError message={errorMessage(playback.error)} />
      <div
        className={styles.stage}
        style={probe ? { aspectRatio: `${probe.width} / ${probe.height}` } : undefined}
      >
        {data?.proxyUrl && (
          <video
            className={styles.video}
            src={data.proxyUrl}
            poster={data.thumbnailUrls[1]}
            controls
            playsInline
            preload="metadata"
          />
        )}
      </div>
      {data?.waveform && <Waveform url={data.waveform.url} />}
      {probe && (
        <dl className={styles.facts}>
          <div>
            <dt>Duration</dt>
            <dd>{formatDuration(ticksToSeconds(probe.duration))}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              {probe.width} × {probe.height} · {frameRateLabel(probe.frameRate)} fps
              {probe.isVariableFrameRate ? ' (variable)' : ''}
            </dd>
          </div>
          <div>
            <dt>Codecs</dt>
            <dd>
              {probe.videoCodec}
              {probe.audioCodec ? ` / ${probe.audioCodec}` : ' / no audio'}
            </dd>
          </div>
          <div>
            <dt>File</dt>
            <dd>{formatBytes(asset.size)}</dd>
          </div>
        </dl>
      )}
      <p className={styles.note}>Playing the 720p editing proxy. The original stays untouched.</p>
    </dialog>
  );
}
