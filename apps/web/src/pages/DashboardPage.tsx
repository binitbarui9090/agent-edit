import { frameRateLabel } from '@agent-edit/shared';
import { Link } from 'react-router';
import { useProjects } from '../api/projects';
import { Button, ButtonLink } from '../components/Button';
import { FormError } from '../components/Field';
import { FormatFrame } from '../components/FormatFrame';
import { Pending } from '../components/Pending';
import { errorMessage } from '../lib/form-errors';
import { formatAbsoluteTime, formatRelativeTime } from '../lib/format';
import styles from './DashboardPage.module.css';

export function DashboardPage() {
  const query = useProjects();
  const projects = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className={styles.page}>
      <title>Projects · Agent Edit</title>
      <section className={styles.projects}>
        <header className={styles.header}>
          <h1 className={styles.title}>Projects</h1>
          <ButtonLink to="/projects/new" variant="primary">
            New project
          </ButtonLink>
        </header>

        <FormError message={errorMessage(query.error)} />

        {query.isSuccess && projects.length === 0 && (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No projects yet</p>
            <p>A project holds your footage, its timelines and every edit made to them.</p>
          </div>
        )}

        {projects.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.frameCell}>
                  <span className={styles.srOnly}>Format</span>
                </th>
                <th scope="col">Name</th>
                <th scope="col" className={styles.optional}>
                  Resolution
                </th>
                <th scope="col" className={styles.optional}>
                  FPS
                </th>
                <th scope="col" className={styles.modified}>
                  Modified
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id} className={styles.row}>
                  <td className={styles.frameCell}>
                    <FormatFrame aspect={project.settings.aspectRatio} />
                  </td>
                  <td className={styles.name}>
                    <Link to={`/projects/${project.id}`}>{project.name}</Link>
                  </td>
                  <td className={`${styles.data} ${styles.optional}`}>
                    {project.settings.width} × {project.settings.height}
                  </td>
                  <td className={`${styles.data} ${styles.optional}`}>
                    {frameRateLabel(project.settings.frameRate)}
                  </td>
                  <td className={`${styles.data} ${styles.modified}`}>
                    <time
                      dateTime={project.updatedAt}
                      title={formatAbsoluteTime(project.updatedAt)}
                    >
                      {formatRelativeTime(project.updatedAt)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

      <aside className={styles.side}>
        <Pending
          title="Not built yet"
          items={[
            {
              name: 'Footage upload',
              phase: 2,
              detail: 'Resumable uploads, thumbnails and processing status.',
            },
            {
              name: 'Export history',
              phase: 5,
              detail: 'Listed here once rendering exists.',
            },
          ]}
        />
      </aside>
    </div>
  );
}
