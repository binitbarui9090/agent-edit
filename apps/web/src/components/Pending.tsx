import styles from './Pending.module.css';

export interface PendingItem {
  name: string;
  phase: number;
  detail: string;
}

/** States plainly which capabilities do not exist yet, instead of showing controls that do nothing. */
export function Pending({ title, items }: { title: string; items: PendingItem[] }) {
  return (
    <section className={styles.pending} aria-label={title}>
      <h2 className={styles.title}>{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item.name} className={styles.item}>
            <div className={styles.head}>
              <span>{item.name}</span>
              <span className={styles.phase}>Phase {item.phase}</span>
            </div>
            <p className={styles.detail}>{item.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
