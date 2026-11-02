import { updateProjectRequestSchema, type Project } from '@agent-edit/validation';
import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { useProjectEvents } from '../api/events';
import { useDeleteProject, useProject, useUpdateProject } from '../api/projects';
import { Button } from '../components/Button';
import { Field, FormError } from '../components/Field';
import { SettingsFields } from '../components/SettingsFields';
import {
  apiFieldErrors,
  errorMessage,
  withoutField,
  zodFieldErrors,
  type FieldErrors,
} from '../lib/form-errors';
import { NotFoundPage } from './NotFoundPage';
import styles from './ProjectForms.module.css';

export interface ProjectOutletContext {
  project: Project;
  live: boolean;
}

export function ProjectLayout() {
  const { id = '' } = useParams();
  const query = useProject(id);

  if (query.isPending) return null;
  if (query.isError) {
    return <NotFoundPage title="Project not found" detail={errorMessage(query.error)} />;
  }
  return <ProjectFrame key={query.data.id} project={query.data} />;
}

function ProjectFrame({ project }: { project: Project }) {
  const live = useProjectEvents(project.id);
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab;

  return (
    <div className={styles.page}>
      <title>{`${project.name} · Agent Edit`}</title>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/">Projects</Link>
        <span aria-hidden="true">/</span>
        <span>{project.name}</span>
      </nav>
      <h1 className={styles.title}>{project.name}</h1>
      <nav className={styles.tabs} aria-label="Project">
        <NavLink end to={`/projects/${project.id}`} className={tabClass}>
          Media
        </NavLink>
        <Link to={`/projects/${project.id}/edit`} className={styles.tab}>
          Editor
        </Link>
        <NavLink to={`/projects/${project.id}/settings`} className={tabClass}>
          Settings
        </NavLink>
      </nav>
      <Outlet context={{ project, live } satisfies ProjectOutletContext} />
    </div>
  );
}

export function ProjectSettingsPage() {
  const { project } = useOutletContext<ProjectOutletContext>();
  const update = useUpdateProject(project.id);
  const [name, setName] = useState(project.name);
  const [settings, setSettings] = useState(project.settings);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const errors = { ...apiFieldErrors(update.error), ...clientErrors };

  const dirty =
    name !== project.name || JSON.stringify(settings) !== JSON.stringify(project.settings);

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = updateProjectRequestSchema.safeParse({ name, settings });
    if (!parsed.success) {
      setClientErrors(zodFieldErrors(parsed.error));
      return;
    }
    setClientErrors({});
    update.mutate(parsed.data, {
      onSuccess: (saved) => {
        setName(saved.name);
        setSettings(saved.settings);
      },
    });
  }

  return (
    <div>
      <form className={styles.form} onSubmit={submit} noValidate>
        <FormError message={errorMessage(update.error)} />
        <Field
          label="Name"
          value={name}
          error={errors.name}
          onChange={(e) => {
            setName(e.target.value);
            setClientErrors(withoutField(clientErrors, 'name'));
            update.reset();
          }}
        />
        <SettingsFields value={settings} onChange={setSettings} />
        <p className={styles.dangerText}>
          These settings apply when a timeline is created. An existing timeline keeps its format.
        </p>
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
          {!dirty && update.isSuccess && (
            <span className={styles.saved} role="status">
              Saved
            </span>
          )}
        </div>
      </form>
      <DeleteProject id={project.id} />
    </div>
  );
}

function DeleteProject({ id }: { id: string }) {
  const navigate = useNavigate();
  const remove = useDeleteProject(id);
  const [confirming, setConfirming] = useState(false);

  return (
    <section className={styles.danger}>
      <h2 className={styles.dangerTitle}>Delete project</h2>
      <p className={styles.dangerText}>
        Removes this project and its footage. Stored files are permanently deleted within about an
        hour.
      </p>
      <FormError message={errorMessage(remove.error)} />
      <div className={styles.actions}>
        {confirming ? (
          <>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => void navigate('/', { replace: true }),
                })
              }
            >
              {remove.isPending ? 'Deleting…' : 'Confirm delete'}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep project
            </Button>
          </>
        ) : (
          <Button onClick={() => setConfirming(true)}>Delete project</Button>
        )}
      </div>
    </section>
  );
}
