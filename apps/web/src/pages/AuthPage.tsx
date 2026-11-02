import { loginRequestSchema, registerRequestSchema } from '@agent-edit/validation';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useLogin, useRegister } from '../api/auth';
import { Button } from '../components/Button';
import { Field, FormError } from '../components/Field';
import {
  apiFieldErrors,
  errorMessage,
  withoutField,
  zodFieldErrors,
  type FieldErrors,
} from '../lib/form-errors';
import styles from './AuthPage.module.css';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const isRegister = mode === 'register';
  const login = useLogin();
  const register = useRegister();
  const mutation = isRegister ? register : login;

  const [form, setForm] = useState({ email: '', displayName: '', password: '' });
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const errors = { ...apiFieldErrors(mutation.error), ...clientErrors };

  const bind = (key: keyof typeof form) => ({
    value: form[key],
    error: errors[key],
    onChange: (e: { target: { value: string } }) => {
      setForm({ ...form, [key]: e.target.value });
      setClientErrors(withoutField(clientErrors, key));
      mutation.reset();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    mutation.reset();
    if (isRegister) {
      const parsed = registerRequestSchema.safeParse(form);
      setClientErrors(parsed.success ? {} : zodFieldErrors(parsed.error));
      if (parsed.success) register.mutate(parsed.data);
    } else {
      const parsed = loginRequestSchema.safeParse({ email: form.email, password: form.password });
      setClientErrors(parsed.success ? {} : zodFieldErrors(parsed.error));
      if (parsed.success) login.mutate(parsed.data);
    }
  }

  const fieldLevelOnly = Object.keys(apiFieldErrors(mutation.error)).length > 0;

  return (
    <div className={styles.page}>
      <title>{isRegister ? 'Create account · Agent Edit' : 'Sign in · Agent Edit'}</title>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div>
          <p className={styles.brand}>Agent Edit</p>
          <h1 className={styles.title}>{isRegister ? 'Create your account' : 'Sign in'}</h1>
        </div>
        <FormError message={fieldLevelOnly ? null : errorMessage(mutation.error)} />
        <Field label="Email" type="email" autoComplete="email" autoFocus {...bind('email')} />
        {isRegister && <Field label="Name" autoComplete="name" {...bind('displayName')} />}
        <Field
          label="Password"
          type="password"
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          hint={isRegister ? 'At least 10 characters.' : undefined}
          {...bind('password')}
        />
        <Button type="submit" variant="primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Working…' : isRegister ? 'Create account' : 'Sign in'}
        </Button>
        <p className={styles.switch}>
          {isRegister ? 'Already have an account? ' : 'New to Agent Edit? '}
          <Link to={isRegister ? '/login' : '/register'}>
            {isRegister ? 'Sign in' : 'Create an account'}
          </Link>
        </p>
      </form>
    </div>
  );
}
