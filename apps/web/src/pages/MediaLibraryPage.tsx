import { UPLOAD_CONTENT_TYPES } from '@agent-edit/shared';
import type { MediaAsset } from '@agent-edit/validation';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useOutletContext } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { useMedia } from '../api/media';
import { Button } from '../components/Button';
import { FormError } from '../components/Field';
import { Pending } from '../components/Pending';
import { MediaRow } from '../components/media/MediaRow';
import { PreviewDialog } from '../components/media/PreviewDialog';
import { UploadList } from '../components/media/UploadList';
import { errorMessage } from '../lib/form-errors';
import { enqueueUploads, useUploads } from '../uploads/store';
import type { ProjectOutletContext } from './ProjectPage';
import styles from './MediaLibraryPage.module.css';

const ACCEPT = Object.keys(UPLOAD_CONTENT_TYPES)
  .map((extension) => `.${extension}`)
  .join(',');
const ALL = '__all__';

export function MediaLibraryPage() {
  const { project, live } = useOutletContext<ProjectOutletContext>();
  const query = useMedia(project.id, live);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [folder, setFolder] = useState(ALL);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const activeMediaIds = useUploads(
    useShallow((state) =>
      Object.values(state.items)
        .filter((item) => item.mediaId && !['done', 'failed'].includes(item.phase))
        .map((item) => item.mediaId as string),
    ),
  );

  const assets: MediaAsset[] = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const folders = useMemo(
    () => [...new Set(assets.flatMap((a) => (a.folder ? [a.folder] : [])))].sort(),
    [assets],
  );
  const visible = folder === ALL ? assets : assets.filter((a) => a.folder === folder);
  const preview = assets.find((asset) => asset.id === previewId);

  function addFiles(files: FileList | null) {
    if (files && files.length > 0) enqueueUploads(project.id, Array.from(files));
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  return (
    <div className={styles.page}>
      <div
        className={styles.drop}
        data-dragging={dragging}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <span className={styles.dropText}>Drop video files here, or</span>
        <Button variant="primary" onClick={() => input.current?.click()}>
          Choose files
        </Button>
        <span className={styles.dropHint}>
          MP4, MOV, MKV, WebM. Large files resume if interrupted.
        </span>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className={styles.fileInput}
          aria-label="Choose video files"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      <UploadList projectId={project.id} />

      <div className={styles.toolbar}>
        <h2 className={styles.heading}>
          Media
          {query.isSuccess && <span className={styles.count}>{assets.length}</span>}
        </h2>
        {folders.length > 0 && (
          <label className={styles.filter}>
            <span>Folder</span>
            <select value={folder} onChange={(event) => setFolder(event.target.value)}>
              <option value={ALL}>All</option>
              {folders.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className={styles.live} data-live={live} role="status">
          {live ? 'Live updates' : 'Reconnecting, polling for updates'}
        </span>
      </div>

      <FormError message={errorMessage(query.error)} />

      {query.isSuccess && assets.length === 0 && (
        <p className={styles.empty}>No footage yet. Uploaded files appear here as they process.</p>
      )}

      <ul className={styles.list} aria-label="Media">
        {visible.map((asset) => (
          <MediaRow
            key={asset.id}
            asset={asset}
            folders={folders}
            activeUpload={activeMediaIds.includes(asset.id)}
            onPreview={() => setPreviewId(asset.id)}
          />
        ))}
      </ul>

      {query.hasNextPage && (
        <Button
          className={styles.more}
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}

      {preview && <PreviewDialog asset={preview} onClose={() => setPreviewId(null)} />}

      <div className={styles.pending}>
        <Pending
          title="Not built yet"
          items={[{ name: 'Render and export', phase: 5, detail: 'Final video output.' }]}
        />
      </div>
    </div>
  );
}
