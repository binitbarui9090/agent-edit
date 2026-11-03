import { timelineCaptions } from '@agent-edit/timeline-engine';
import { RENDER_PRESETS, type RenderJob, type RenderPreset } from '@agent-edit/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { cancelRender, createRender, rendersKey, retryRender, useRenders } from '../api/renders';
import { getTimeline } from '../api/timelines';
import { Button } from '../components/Button';
import { FormError } from '../components/Field';
import { errorMessage } from '../lib/form-errors';
import { formatBytes, formatDuration, formatRelativeTime } from '../lib/format';
import { adoptTimeline, clearPreview, flushEdits, useEditor } from './store';
import styles from './ExportPanel.module.css';

const STATUS_TEXT: Record<RenderJob['status'], string> = {
  queued: 'Waiting',
  running: 'Rendering',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function RenderRow({ job, projectId }: { job: RenderJob; projectId: string }) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: rendersKey(projectId) });
  const cancel = useMutation({
    mutationFn: () => cancelRender(projectId, job.id),
    onSettled: refresh,
  });
  const retry = useMutation({
    mutationFn: () => retryRender(projectId, job.id),
    onSettled: refresh,
  });
  const active = job.status === 'queued' || job.status === 'running';

  return (
    <li className={styles.job} data-status={job.status} data-testid="render-job">
      <div className={styles.head}>
        <span className={styles.name}>{job.timelineName}</span>
        <span className={styles.status} role="status">
          {STATUS_TEXT[job.status]}
          {job.status === 'running' && ` ${Math.round(job.progress * 100)}%`}
        </span>
      </div>
      <p className={styles.meta}>
        {job.width} × {job.height} · {formatDuration(job.durationSeconds)}
        {job.outputSize !== null && ` · ${formatBytes(job.outputSize)}`} ·{' '}
        {formatRelativeTime(job.createdAt)}
      </p>
      {active && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label={`Export of ${job.timelineName}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(job.progress * 100)}
        >
          <span className={styles.fill} style={{ transform: `scaleX(${job.progress})` }} />
        </div>
      )}
      {job.error && <p className={styles.error}>{job.error}</p>}
      <FormError message={errorMessage(cancel.error ?? retry.error)} />
      <div className={styles.actions}>
        {job.downloadUrl && (
          <a className={styles.download} href={job.downloadUrl} download>
            Download video
          </a>
        )}
        {job.captionsUrl && (
          <a className={styles.link} href={job.captionsUrl} download>
            Captions (SRT)
          </a>
        )}
        {job.logUrl && (
          <a className={styles.link} href={job.logUrl} target="_blank" rel="noreferrer">
            Log
          </a>
        )}
        {active && (
          <Button variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <Button variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate()}>
            Retry
          </Button>
        )}
      </div>
    </li>
  );
}

export function ExportPanel({ projectId, timelineId }: { projectId: string; timelineId: string }) {
  const client = useQueryClient();
  const renders = useRenders(projectId);
  const timeline = useEditor((state) => state.timeline);
  const [preset, setPreset] = useState<RenderPreset>('source');
  const [burnCaptions, setBurnCaptions] = useState(true);
  const hasCaptions = timeline ? timelineCaptions(timeline).length > 0 : false;

  const start = useMutation({
    mutationFn: async () => {
      // Exports what is confirmed on the server, so a preview or unsent edit cannot slip through.
      clearPreview();
      const current = await flushEdits();
      if (!current) throw new Error('The timeline is not loaded');
      const options = { preset, burnCaptions: hasCaptions && burnCaptions };
      try {
        return await createRender(projectId, timelineId, {
          ...options,
          baseRevision: current.revision,
        });
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'revision_conflict')) throw err;
        const latest = await getTimeline(projectId, timelineId);
        adoptTimeline(latest);
        return createRender(projectId, timelineId, { ...options, baseRevision: latest.revision });
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey: rendersKey(projectId) }),
  });

  const empty = timeline ? timeline.tracks.every((track) => track.clips.length === 0) : true;

  return (
    <div className={styles.panel}>
      <section className={styles.form}>
        <label className={styles.field}>
          <span>Format</span>
          <select
            value={preset}
            onChange={(event) => setPreset(event.target.value as RenderPreset)}
          >
            {(Object.keys(RENDER_PRESETS) as RenderPreset[]).map((key) => (
              <option key={key} value={key}>
                {key === 'source' && timeline
                  ? `Timeline size (${timeline.width} × ${timeline.height})`
                  : RENDER_PRESETS[key].label}
              </option>
            ))}
          </select>
        </label>
        {hasCaptions && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={burnCaptions}
              onChange={(event) => setBurnCaptions(event.target.checked)}
            />
            <span>Burn captions into the picture</span>
          </label>
        )}
        <p className={styles.note}>
          Renders from your original footage in the background. H.264 and AAC in an MP4. You can
          keep editing: later changes do not affect an export already started.
        </p>
        <Button
          variant="primary"
          disabled={empty || start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending ? 'Starting…' : 'Export video'}
        </Button>
        {empty && <p className={styles.note}>Add something to the timeline first.</p>}
        {hasCaptions && (
          <a
            className={styles.link}
            href={`/api/v1/projects/${projectId}/timelines/${timelineId}/captions.srt`}
            download
          >
            Download captions as SRT
          </a>
        )}
        <FormError message={errorMessage(start.error ?? renders.error)} />
      </section>

      <section>
        <h3 className={styles.title}>Exports</h3>
        {renders.data?.items.length === 0 && <p className={styles.empty}>Nothing exported yet.</p>}
        <ul aria-label="Exports">
          {renders.data?.items.map((job) => (
            <RenderRow key={job.id} job={job} projectId={projectId} />
          ))}
        </ul>
      </section>
    </div>
  );
}
