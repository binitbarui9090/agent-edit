import { UPLOAD_CONTENT_TYPES, frameRateLabel } from '@agent-edit/shared';
import type { ProjectMediaSummary } from '@agent-edit/validation';
import { Download, Plus, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useCreateProject, useProjects } from '../api/projects';
import { useRecentRenders } from '../api/renders';
import { Button, ButtonLink } from '../components/Button';
import { FormError } from '../components/Field';
import { FormatFrame } from '../components/FormatFrame';
import { DEFAULT_SETTINGS } from '../components/SettingsFields';
import { errorMessage } from '../lib/form-errors';
import { formatAbsoluteTime, formatBytes, formatRelativeTime } from '../lib/format';
import { enqueueUploads } from '../uploads/store';
import { projectNameFromFile, requestAutoPlace, settingsForFile } from '../uploads/start';
import styles from './DashboardPage.module.css';

const ACCEPT = Object.keys(UPLOAD_CONTENT_TYPES)
  .map((extension) => `.${extension}`)
  .join(',');

function footageSummary({ total, processing, uploading, failed }: ProjectMediaSummary): string {
  if (total === 0) return 'None';
  const clips = `${total} ${total === 1 ? 'clip' : 'clips'}`;
  const state = [
    uploading > 0 && `${uploading} uploading`,
    processing > 0 && `${processing} processing`,
    failed > 0 && `${failed} failed`,
  ].filter(Boolean);
  return state.length > 0 ? `${clips} · ${state.join(', ')}` : clips;
}

export function DashboardPage() {
  const query = useProjects();
  const exports = useRecentRenders();
  const projects = query.data?.pages.flatMap((page) => page.items) ?? [];
  const navigate = useNavigate();
  const create = useCreateProject();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [starting, setStarting] = useState(false);

  /** One drop is the whole setup: a project shaped like the footage, and straight into the editor. */
  async function startFrom(files: File[]) {
    const first = files[0];
    if (!first || starting) return;
    setStarting(true);
    const settings = await settingsForFile(first, DEFAULT_SETTINGS);
    create.mutate(
      { name: projectNameFromFile(first), settings },
      {
        onSuccess: (project) => {
          enqueueUploads(project.id, files);
          requestAutoPlace(project.id);
          void navigate(`/projects/${project.id}/edit`);
        },
        onSettled: () => setStarting(false),
      },
    );
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void startFrom(Array.from(event.dataTransfer.files));
  }

  return (
    <div
      className={styles.page}
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
      <title>Projects · Agent Edit</title>
      <section className={styles.projects}>
        <header className={styles.header}>
          <h1 className={styles.title}>Projects</h1>
          <ButtonLink to="/projects/new" variant="secondary">
            <Plus size={14} aria-hidden="true" />
            New project
          </ButtonLink>
        </header>

        <FormError message={errorMessage(query.error ?? create.error)} />

        <button
          type="button"
          className={styles.start}
          data-dragging={dragging}
          disabled={starting}
          onClick={() => input.current?.click()}
        >
          <span className={styles.startIcon} aria-hidden="true">
            <Upload size={18} strokeWidth={1.75} />
          </span>
          <span className={styles.startText}>
            <span className={styles.startTitle}>
              {starting ? 'Setting up your project…' : 'Drop a video to start editing'}
            </span>
            <span className={styles.startHint}>
              Or click to choose one. The project takes its name and shape from the file.
            </span>
          </span>
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          aria-label="Start from a video file"
          onChange={(event) => {
            void startFrom(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />

        {query.isSuccess && projects.length === 0 && (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No projects yet</p>
            <p>A project holds your footage, its timelines and every edit made to them.</p>
          </div>
        )}

        {projects.length > 0 && (
          <ul className={styles.grid} aria-label="Projects">
            {projects.map((project) => (
              <li key={project.id} className={styles.card}>
                <Link to={`/projects/${project.id}`} className={styles.cardLink}>
                  <span className={styles.poster}>
                    {project.media.posterUrl ? (
                      <img src={project.media.posterUrl} alt="" loading="lazy" />
                    ) : (
                      <FormatFrame aspect={project.settings.aspectRatio} />
                    )}
                  </span>
                  <span className={styles.name}>{project.name}</span>
                </Link>
                <p className={styles.meta}>{footageSummary(project.media)}</p>
                <p className={styles.meta}>
                  <span className={styles.data}>
                    {project.settings.width} × {project.settings.height} ·{' '}
                    {frameRateLabel(project.settings.frameRate)} fps
                  </span>
                  <time dateTime={project.updatedAt} title={formatAbsoluteTime(project.updatedAt)}>
                    {formatRelativeTime(project.updatedAt)}
                  </time>
                </p>
              </li>
            ))}
          </ul>
        )}

        {query.hasNextPage && (
          <Button
            className={styles.more}
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </section>

      <aside className={styles.side} aria-label="Export history">
        <h2 className={styles.sideTitle}>Exports</h2>
        <FormError message={errorMessage(exports.error)} />
        {exports.isSuccess && exports.data.items.length === 0 && (
          <p className={styles.sideEmpty}>Finished exports appear here.</p>
        )}
        <ul className={styles.exports}>
          {exports.data?.items.map((job) => (
            <li key={job.id} className={styles.export}>
              <span className={styles.exportName}>{job.projectName}</span>
              <span className={styles.exportMeta}>
                {job.timelineName} · {formatRelativeTime(job.createdAt)}
              </span>
              {job.status === 'done' && job.downloadUrl ? (
                <a className={styles.exportLink} href={job.downloadUrl} download>
                  <Download size={12} aria-hidden="true" />
                  Download
                  {job.outputSize !== null && ` (${formatBytes(job.outputSize)})`}
                </a>
              ) : (
                <span className={styles.exportMeta} data-status={job.status}>
                  {job.status === 'running'
                    ? `Rendering ${Math.round(job.progress * 100)}%`
                    : job.status === 'queued'
                      ? 'Waiting'
                      : job.status === 'failed'
                        ? 'Failed'
                        : 'Cancelled'}
                </span>
              )}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
