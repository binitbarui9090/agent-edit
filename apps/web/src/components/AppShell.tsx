import type { User } from '@agent-edit/validation';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useLogout } from '../api/auth';
import { errorMessage } from '../lib/form-errors';
import { Button } from './Button';
import styles from './AppShell.module.css';

export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const logout = useLogout();
  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <Link to="/" className={styles.brand}>
          <span className={styles.mark} aria-hidden="true" />
          Agent Edit
        </Link>
        <div className={styles.account}>
          {logout.isError && <span className={styles.error}>{errorMessage(logout.error)}</span>}
          <span className={styles.user} title={user.email}>
            {user.displayName}
          </span>
          <Button variant="ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
          </Button>
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
