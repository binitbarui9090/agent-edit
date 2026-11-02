import { updateProjectRequestSchema, type Project } from '@agent-edit/validation';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDeleteProject, useProject, useUpdateProject } from '../api/projects';
import { Button } from '../components/Button';
import { Field, FormError } from '../components/Field';
import { Pending } from '../components/Pending';
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

export function ProjectPage() {
  const { id = '' } = useParams();
  const query = useProject(id);

  if (query.isPending) return null;
  if (query.isError) {
    return <NotFoundPage title="Project not found" detail={errorMessage(query.error)} />;
  }
  // Remount when the id changes, so the form cannot show another project's edits.
  return <ProjectEditor key={query.data.id} project={query.data} />;
}

function ProjectEditor({ project }: { project: Project }) {
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
    <div className={styles.page}>
      <title>{`${project.name} · Agent Edit`}</title>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/">Projects</Link>
        <span aria-hidden="true">/</span>
        <span>{project.name}</span>
      </nav>
      <h1 className={styles.title}>{project.name}</h1>

      <div className={styles.layout}>
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

        <div className={styles.side}>
          <Pending
            title="Not built yet"
            items={[
              { name: 'Media library', phase: 2, detail: 'Upload and organise footage.' },
              { name: 'Timeline editor', phase: 3, detail: 'Multi-track editing and playback.' },
              { name: 'AI analysis and agent', phase: 4, detail: 'Transcripts and edit plans.' },
              { name: 'Render and export', phase: 5, detail: 'Final video output.' },
            ]}
          />
        </div>
      </div>
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
      <p className={styles.dangerText}>Removes this project from your account.</p>
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
