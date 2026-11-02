import { STEP_LABELS, ticksToSeconds } from '@agent-edit/shared';
import type { MediaAnalysis, MediaAsset } from '@agent-edit/validation';
import { useState } from 'react';
import { useOutletContext } from 'react-router';
import { useMediaAnalysis } from '../api/agent';
import { useMedia } from '../api/media';
import { FormError } from '../components/Field';
import { errorMessage } from '../lib/form-errors';
import { formatDuration } from '../lib/format';
import type { ProjectOutletContext } from './ProjectPage';
import styles from './AnalysisPage.module.css';

function time(ticks: number): string {
  return formatDuration(ticksToSeconds(ticks));
}

function ProviderTag({
  provider,
}: {
  provider: { id: string; model: string | null; isMock: boolean } | null;
}) {
  if (!provider) return null;
  if (provider.isMock) return <span className={styles.mock}>Demo data, not real analysis</span>;
  const name = provider.id === 'rules' ? 'Rule-based' : (provider.model ?? provider.id);
  return <span className={styles.provider}>{name}</span>;
}

function Moments({
  analysis,
  kind,
  title,
}: {
  analysis: MediaAnalysis;
  kind: string;
  title: string;
}) {
  const items = analysis.moments.filter((moment) => moment.kind === kind);
  if (items.length === 0) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>
        {title} <span className={styles.count}>{items.length}</span>
        <ProviderTag provider={items[0]!.provider} />
      </h3>
      <ul>
        {items.map((moment) => (
          <li key={`${moment.start}-${moment.end}`} className={styles.line}>
            <span className={styles.time}>
              {time(moment.start)}–{time(moment.end)}
            </span>
            <span>
              {moment.title}
              {moment.reason && <span className={styles.reason}>{moment.reason}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AssetAnalysis({ projectId, asset }: { projectId: string; asset: MediaAsset }) {
  const analysis = useMediaAnalysis(projectId, asset.id);
  const data = analysis.data;
  const silences = data?.moments.filter((moment) => moment.kind === 'silence') ?? [];
  const silenceTotal = silences.reduce(
    (sum, moment) => sum + ticksToSeconds(moment.end - moment.start),
    0,
  );
  const scenesWithSummary = data?.scenes.filter((scene) => scene.summary) ?? [];
  const analysisJobs = asset.jobs.filter((job) =>
    ['transcript', 'silence', 'scenes', 'speakers', 'visual', 'moments'].includes(job.step),
  );

  return (
    <div className={styles.detail}>
      <FormError message={errorMessage(analysis.error)} />
      <ul className={styles.jobs} aria-label="Analysis steps">
        {analysisJobs.map((job) => (
          <li key={job.step} className={styles.job} data-status={job.status}>
            <span className={styles.jobName}>{STEP_LABELS[job.step]}</span>
            <span className={styles.jobStatus}>
              {job.status === 'running' ? `${Math.round(job.progress * 100)}%` : job.status}
            </span>
            {(job.note ?? job.error) && (
              <span className={styles.reason}>{job.error ?? job.note}</span>
            )}
          </li>
        ))}
      </ul>

      {data && (
        <>
          <Moments analysis={data} kind="chapter" title="Chapters" />
          <Moments analysis={data} kind="highlight" title="Highlights" />
          <Moments analysis={data} kind="repeated_take" title="Repeated takes" />

          {silences.length > 0 && (
            <section className={styles.section}>
              <h3 className={styles.heading}>
                Pauses <span className={styles.count}>{silences.length}</span>
                <ProviderTag provider={silences[0]!.provider} />
              </h3>
              <p className={styles.reason}>{silenceTotal.toFixed(1)} seconds in total.</p>
            </section>
          )}

          {data.scenes.length > 0 && (
            <section className={styles.section}>
              <h3 className={styles.heading}>
                Scenes <span className={styles.count}>{data.scenes.length}</span>
                <ProviderTag provider={scenesWithSummary[0]?.provider ?? null} />
              </h3>
              {scenesWithSummary.length > 0 && (
                <ul>
                  {scenesWithSummary.map((scene) => (
                    <li key={scene.start} className={styles.line}>
                      <span className={styles.time}>{time(scene.start)}</span>
                      <span>{scene.summary}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className={styles.section}>
            <h3 className={styles.heading}>
              Transcript <span className={styles.count}>{data.segments.length}</span>
              <ProviderTag provider={data.segmentProvider} />
            </h3>
            {data.segments.length === 0 && <p className={styles.reason}>No transcript yet.</p>}
            <ul>
              {data.segments.map((segment) => (
                <li key={segment.start} className={styles.line}>
                  <span className={styles.time}>{time(segment.start)}</span>
                  <span>
                    {segment.speaker && <span className={styles.speaker}>{segment.speaker}</span>}
                    {segment.text}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

export function AnalysisPage() {
  const { project, live } = useOutletContext<ProjectOutletContext>();
  const media = useMedia(project.id, live);
  const assets = (media.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (asset) => asset.status !== 'uploading',
  );
  const [chosen, setChosen] = useState<string | null>(null);
  // Footage with speech first, since that is where there is the most to show.
  const selected =
    assets.find((asset) => asset.id === chosen) ??
    assets.find((asset) => asset.probe?.audioCodec) ??
    assets[0];

  return (
    <div className={styles.page}>
      <FormError message={errorMessage(media.error)} />
      {media.isSuccess && assets.length === 0 && (
        <p className={styles.reason}>Upload footage and its analysis appears here.</p>
      )}
      {assets.length > 0 && (
        <label className={styles.select}>
          <span>Footage</span>
          <select value={selected?.id ?? ''} onChange={(event) => setChosen(event.target.value)}>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && <AssetAnalysis key={selected.id} projectId={project.id} asset={selected} />}
    </div>
  );
}
