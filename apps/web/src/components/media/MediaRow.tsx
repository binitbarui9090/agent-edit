import { STEP_LABELS, frameRateLabel, ticksToSeconds } from '@agent-edit/shared';
import { updateMediaRequestSchema, type MediaAsset } from '@agent-edit/validation';
import { useState, type FormEvent } from 'react';
import { useDeleteMedia, useDiscardUpload, useRetryMedia, useUpdateMedia } from '../../api/media';
import { errorMessage, zodFieldErrors, type FieldErrors } from '../../lib/form-errors';
import { formatBytes, formatDuration } from '../../lib/format';
import { Button } from '../Button';
import { Field, FormError } from '../Field';
import { StepList } from './StepList';
import styles from './MediaRow.module.css';

function EditForm({
  asset,
  folders,
  onDone,
}: {
  asset: MediaAsset;
  folders: string[];
  onDone: () => void;
}) {
  const update = useUpdateMedia(asset.projectId, asset.id);
  const [name, setName] = useState(asset.name);
  const [folder, setFolder] = useState(asset.folder ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const listId = `folders-${asset.id}`;

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = updateMediaRequestSchema.safeParse({ name, folder: folder.trim() || null });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    update.mutate(parsed.data, { onSuccess: onDone });
  }

  return (
    <form className={styles.edit} onSubmit={submit} noValidate>
      <FormError message={errorMessage(update.error)} />
      <div className={styles.editFields}>
        <Field
          label="Name"
          value={name}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <Field
          label="Folder"
          value={folder}
          list={listId}
          error={errors.folder}
          hint="Leave empty for no folder."
          onChange={(e) => setFolder(e.target.value)}
        />
        <datalist id={listId}>
          {folders.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </div>
      <div className={styles.editActions}>
        <Button type="submit" variant="primary" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function MediaRow({
  asset,
  folders,
  activeUpload,
  onPreview,
}: {
  asset: MediaAsset;
  folders: string[];
  activeUpload: boolean;
  onPreview: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm-delete'>('view');
  const remove = useDeleteMedia(asset.projectId, asset.id);
  const retry = useRetryMedia(asset.projectId, asset.id);
  const discard = useDiscardUpload(asset.projectId, asset.id);

  const probe = asset.probe;
  const canPreview = asset.jobs.some((job) => job.step === 'proxy' && job.status === 'done');
  const failedJobs = asset.jobs.filter((job) => job.status === 'failed');
  const showSteps = asset.status === 'processing' || failedJobs.length > 0;
  const actionError = remove.error ?? retry.error ?? discard.error;

  return (
    <li className={styles.row} data-status={asset.status}>
      <div className={styles.thumb}>
        {asset.posterUrl ? (
          <img src={asset.posterUrl} alt="" loading="lazy" />
        ) : (
          <span className={styles.noThumb} aria-hidden="true" />
        )}
      </div>

      <div className={styles.body}>
        <div className={styles.titleLine}>
          {canPreview ? (
            <button
              type="button"
              className={styles.name}
              onClick={onPreview}
              aria-label={`Preview ${asset.name}`}
            >
              {asset.name}
            </button>
          ) : (
            <span className={styles.nameStatic}>{asset.name}</span>
          )}
          {asset.folder && <span className={styles.folder}>{asset.folder}</span>}
        </div>

        <p className={styles.meta}>
          {probe && (
            <>
              <span>{formatDuration(ticksToSeconds(probe.duration))}</span>
              <span>
                {probe.width} × {probe.height}
              </span>
              <span>{frameRateLabel(probe.frameRate)} fps</span>
            </>
          )}
          <span>{formatBytes(asset.size)}</span>
          {!probe && asset.status === 'processing' && <span>Reading metadata</span>}
        </p>

        {asset.status === 'uploading' && !activeUpload && (
          <p className={styles.incomplete}>
            Upload incomplete. Choose the same file again to resume from where it stopped.
          </p>
        )}
        {showSteps && <StepList jobs={asset.jobs} />}
        {asset.error && <p className={styles.error}>{asset.error}</p>}
        {!asset.error &&
          failedJobs.map((job) => (
            <p key={job.step} className={styles.error}>
              {STEP_LABELS[job.step]} failed: {job.error}
            </p>
          ))}
        <FormError message={errorMessage(actionError)} />
        {mode === 'edit' && (
          <EditForm asset={asset} folders={folders} onDone={() => setMode('view')} />
        )}
      </div>

      <div className={styles.side}>
        <span className={styles.status}>
          {asset.status === 'ready' ? 'Ready' : asset.status === 'failed' ? 'Failed' : ''}
          {asset.status === 'processing' ? 'Processing' : ''}
          {asset.status === 'uploading' ? (activeUpload ? 'Uploading' : 'Incomplete') : ''}
        </span>
        {!(asset.status === 'uploading' && activeUpload) && (
          <span className={styles.actions}>
            {mode === 'confirm-delete' ? (
              <>
                <Button
                  variant="danger"
                  disabled={remove.isPending}
                  aria-label={`Confirm delete ${asset.name}`}
                  onClick={() => remove.mutate()}
                >
                  Confirm delete
                </Button>
                <Button variant="ghost" onClick={() => setMode('view')}>
                  Keep
                </Button>
              </>
            ) : asset.status === 'uploading' ? (
              <Button
                variant="ghost"
                disabled={discard.isPending}
                aria-label={`Discard ${asset.name}`}
                onClick={() => discard.mutate()}
              >
                Discard
              </Button>
            ) : (
              <>
                {failedJobs.length > 0 && (
                  <Button
                    variant="ghost"
                    disabled={retry.isPending}
                    aria-label={`Retry ${asset.name}`}
                    onClick={() => retry.mutate()}
                  >
                    Retry
                  </Button>
                )}
                <Button
                  variant="ghost"
                  aria-label={`Edit ${asset.name}`}
                  onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Delete ${asset.name}`}
                  onClick={() => setMode('confirm-delete')}
                >
                  Delete
                </Button>
              </>
            )}
          </span>
        )}
      </div>
    </li>
  );
}
