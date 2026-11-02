import { createProjectRequestSchema, type ProjectSettings } from '@agent-edit/validation';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useCreateProject } from '../api/projects';
import { Button } from '../components/Button';
import { Field, FormError } from '../components/Field';
import { DEFAULT_SETTINGS, SettingsFields } from '../components/SettingsFields';
import {
  apiFieldErrors,
  errorMessage,
  withoutField,
  zodFieldErrors,
  type FieldErrors,
} from '../lib/form-errors';
import styles from './ProjectForms.module.css';

export function NewProjectPage() {
  const navigate = useNavigate();
  const create = useCreateProject();
  const [name, setName] = useState('');
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const errors = { ...apiFieldErrors(create.error), ...clientErrors };

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createProjectRequestSchema.safeParse({ name, settings });
    if (!parsed.success) {
      setClientErrors(zodFieldErrors(parsed.error));
      return;
    }
    setClientErrors({});
    create.mutate(parsed.data, {
      onSuccess: (project) => void navigate(`/projects/${project.id}`, { replace: true }),
    });
  }

  return (
    <div className={styles.page}>
      <title>New project · Agent Edit</title>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/">Projects</Link>
        <span aria-hidden="true">/</span>
        <span>New</span>
      </nav>
      <h1 className={styles.title}>New project</h1>
      <form className={styles.form} onSubmit={submit} noValidate>
        <FormError message={errorMessage(create.error)} />
        <Field
          label="Name"
          autoFocus
          value={name}
          error={errors.name}
          onChange={(e) => {
            setName(e.target.value);
            setClientErrors(withoutField(clientErrors, 'name'));
            create.reset();
          }}
        />
        <SettingsFields value={settings} onChange={setSettings} />
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create project'}
          </Button>
          <Link to="/" className={styles.cancel}>
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
