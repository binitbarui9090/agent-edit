import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { createVersion, getHistory, getVersions, restoreVersion } from '../api/timelines';
import { Button } from '../components/Button';
import { Field, FormError } from '../components/Field';
import { errorMessage } from '../lib/form-errors';
import { formatAbsoluteTime, formatRelativeTime } from '../lib/format';
import { adoptTimeline, flushEdits, useEditor } from './store';
import styles from './HistoryPanel.module.css';

const SOURCE_LABELS: Record<string, string> = {
  manual: 'You',
  ai: 'Agent',
  undo: 'Undo',
  redo: 'Redo',
  restore: 'Restore',
};

export function HistoryPanel({ projectId, timelineId }: { projectId: string; timelineId: string }) {
  const client = useQueryClient();
  const revision = useEditor((state) => state.timeline?.revision);
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ['history', timelineId, revision],
    queryFn: () => getHistory(projectId, timelineId),
  });
  const versions = useQuery({
    queryKey: ['versions', timelineId, revision],
    queryFn: () => getVersions(projectId, timelineId),
  });

  const save = useMutation({
    mutationFn: async (versionName: string) => {
      await flushEdits();
      return createVersion(projectId, timelineId, versionName);
    },
    onSuccess: () => {
      setName('');
      return client.invalidateQueries({ queryKey: ['versions', timelineId] });
    },
  });

  const restore = useMutation({
    mutationFn: async (versionId: string) => {
      const current = await flushEdits();
      if (!current) throw new Error('The timeline is not loaded');
      return restoreVersion(projectId, timelineId, versionId, current.revision);
    },
    onSuccess: ({ timeline }) => {
      setConfirming(null);
      adoptTimeline(timeline);
      return client.invalidateQueries({ queryKey: ['versions', timelineId] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed) save.mutate(trimmed);
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <h3 className={styles.title}>Versions</h3>
        <form className={styles.save} onSubmit={submit}>
          <Field
            label="Save current state as"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" disabled={!name.trim() || save.isPending}>
            Save version
          </Button>
        </form>
        <FormError message={errorMessage(save.error ?? restore.error ?? versions.error)} />
        <ul className={styles.list} aria-label="Versions">
          {versions.data?.items.map((version) => (
            <li key={version.id} className={styles.entry}>
              <div className={styles.entryText}>
                <span className={styles.summary}>{version.name}</span>
                <time className={styles.time} title={formatAbsoluteTime(version.createdAt)}>
                  {formatRelativeTime(version.createdAt)}
                </time>
              </div>
              {confirming === version.id ? (
                <span className={styles.actions}>
                  <Button
                    variant="danger"
                    disabled={restore.isPending}
                    aria-label={`Confirm restore ${version.name}`}
                    onClick={() => restore.mutate(version.id)}
                  >
                    Restore
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(null)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button
                  variant="ghost"
                  aria-label={`Restore ${version.name}`}
                  onClick={() => setConfirming(version.id)}
                >
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ul>
        {versions.data?.items.length === 0 && <p className={styles.empty}>No saved versions.</p>}
      </section>

      <section className={styles.section}>
        <h3 className={styles.title}>History</h3>
        <FormError message={errorMessage(history.error)} />
        <ul className={styles.list} aria-label="Edit history">
          {history.data?.items.map((entry) => (
            <li key={entry.id} className={styles.entry} data-source={entry.source}>
              <span className={styles.badge}>{SOURCE_LABELS[entry.source] ?? entry.source}</span>
              <div className={styles.entryText}>
                <span className={styles.summary}>{entry.summary}</span>
                <time className={styles.time} title={formatAbsoluteTime(entry.createdAt)}>
                  {formatRelativeTime(entry.createdAt)} · {entry.operationCount}{' '}
                  {entry.operationCount === 1 ? 'operation' : 'operations'}
                  {entry.author.model ? ` · ${entry.author.model}` : ''}
                </time>
              </div>
            </li>
          ))}
        </ul>
        {history.data?.items.length === 0 && <p className={styles.empty}>No edits yet.</p>}
      </section>
    </div>
  );
}
