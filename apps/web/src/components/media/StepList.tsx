import { STEP_LABELS } from '@agent-edit/shared';
import type { AnalysisJob } from '@agent-edit/validation';
import styles from './StepList.module.css';

function stepText(job: AnalysisJob): string {
  switch (job.status) {
    case 'running':
      return `${Math.round(job.progress * 100)}%`;
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'n/a';
    case 'queued':
      return job.error ? 'Retrying' : 'Queued';
  }
}

/** Every value comes from the worker. A running step only moves when FFmpeg reports progress. */
export function StepList({ jobs }: { jobs: AnalysisJob[] }) {
  return (
    <ul className={styles.steps}>
      {jobs.map((job) => (
        <li key={job.step} className={styles.step} data-status={job.status} title={job.error ?? ''}>
          <span className={styles.label}>{STEP_LABELS[job.step]}</span>
          <span className={styles.value}>{stepText(job)}</span>
          {job.status === 'running' && (
            <span className={styles.track} aria-hidden="true">
              <span className={styles.fill} style={{ transform: `scaleX(${job.progress})` }} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
