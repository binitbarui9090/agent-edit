import { Link } from 'react-router';
import styles from './ProjectForms.module.css';

export function NotFoundPage({
  title = 'Page not found',
  detail,
}: {
  title?: string;
  detail?: string | null;
}) {
  return (
    <div className={styles.page}>
      <title>{`${title} · Agent Edit`}</title>
      <h1 className={styles.title}>{title}</h1>
      {detail && <p className={styles.dangerText}>{detail}</p>}
      <p>
        <Link to="/">Back to projects</Link>
      </p>
    </div>
  );
}
