import { uploadExtension, MAX_UPLOAD_CONCURRENCY } from '@agent-edit/shared';
import { create } from 'zustand';
import { ApiError } from '../api/client';
import {
  cancelUpload,
  completeUpload,
  getUpload,
  initUpload,
  refreshMedia,
  signParts,
} from '../api/media';
import { queryClient } from '../api/query-client';
import { fingerprintFile } from './fingerprint';
import { confirmedBytes, partLength, pendingParts, type PartPlan } from './parts';

export type UploadPhase =
  'queued' | 'preparing' | 'uploading' | 'retrying' | 'paused' | 'finishing' | 'done' | 'failed';

export interface UploadItem {
  id: string;
  projectId: string;
  mediaId: string | null;
  name: string;
  size: number;
  phase: UploadPhase;
  uploadedBytes: number;
  bytesPerSecond: number;
  /** Bytes that storage already held when this session started: proof the upload resumed. */
  resumedBytes: number;
  error: string | null;
}

interface UploadStore {
  items: Record<string, UploadItem>;
}

export const useUploads = create<UploadStore>(() => ({ items: {} }));

function patch(id: string, fields: Partial<UploadItem>) {
  useUploads.setState((state) => {
    const item = state.items[id];
    return item ? { items: { ...state.items, [id]: { ...item, ...fields } } } : state;
  });
}

const SIGN_BATCH = 16;
const MAX_PART_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 30_000;
const MAX_COMPLETE_ROUNDS = 3;
const UI_UPDATE_MS = 150;
const SPEED_SMOOTHING = 0.25;
/** The media list takes over from here, and a stale "Uploaded" could contradict a later failure. */
const DONE_ROW_LINGER_MS = 4000;

class HttpError extends Error {
  constructor(readonly status: number) {
    super(status === 0 ? 'Network connection lost' : `Storage responded with ${status}`);
  }
}

class Stopped extends Error {}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    // Coming back online ends the wait early rather than sitting out the backoff.
    window.addEventListener('online', done);
    signal.addEventListener('abort', done);
  });
}

/** XMLHttpRequest, because fetch cannot report upload progress. */
function putPart(
  url: string,
  body: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new HttpError(xhr.status));
    xhr.onerror = () => reject(new HttpError(0));
    xhr.ontimeout = () => reject(new HttpError(0));
    const abort = () => xhr.abort();
    xhr.onabort = () => reject(new Stopped());
    signal.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    xhr.send(body);
  });
}

class UploadTask {
  private controller = new AbortController();
  private urls = new Map<number, string>();
  private inflight = new Map<number, number>();
  private finishedBytes = 0;
  private lastUiUpdate = 0;
  private speedSampleAt = 0;
  private speedSampleBytes = 0;
  private speed = 0;

  constructor(
    readonly id: string,
    private readonly projectId: string,
    private readonly file: File,
  ) {}

  private get item(): UploadItem | undefined {
    return useUploads.getState().items[this.id];
  }

  private publishProgress(force = false) {
    const now = performance.now();
    if (!force && now - this.lastUiUpdate < UI_UPDATE_MS) return;
    this.lastUiUpdate = now;
    let total = this.finishedBytes;
    for (const loaded of this.inflight.values()) total += loaded;
    if (this.speedSampleAt > 0 && now - this.speedSampleAt >= 500) {
      const instant = ((total - this.speedSampleBytes) * 1000) / (now - this.speedSampleAt);
      this.speed =
        this.speed === 0 ? instant : this.speed + SPEED_SMOOTHING * (instant - this.speed);
      this.speedSampleAt = now;
      this.speedSampleBytes = total;
    } else if (this.speedSampleAt === 0) {
      this.speedSampleAt = now;
      this.speedSampleBytes = total;
    }
    patch(this.id, { uploadedBytes: total, bytesPerSecond: Math.max(0, this.speed) });
  }

  private async urlFor(mediaId: string, partNumber: number, pending: number[]): Promise<string> {
    const cached = this.urls.get(partNumber);
    if (cached) {
      this.urls.delete(partNumber);
      return cached;
    }
    const batch = [partNumber, ...pending.filter((n) => !this.urls.has(n))].slice(0, SIGN_BATCH);
    const { urls } = await signParts(this.projectId, mediaId, batch);
    for (const { partNumber: n, url } of urls) this.urls.set(n, url);
    const url = this.urls.get(partNumber);
    if (!url) throw new Error(`Storage did not sign part ${partNumber}`);
    this.urls.delete(partNumber);
    return url;
  }

  private async sendPart(
    mediaId: string,
    partNumber: number,
    plan: PartPlan,
    pending: number[],
  ): Promise<void> {
    const { signal } = this.controller;
    const start = plan.partSize * (partNumber - 1);
    const length = partLength(partNumber, plan);
    // A slice is a reference, so a multi-gigabyte file never enters memory.
    const body = this.file.slice(start, start + length);

    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new Stopped();
      try {
        const url = await this.urlFor(mediaId, partNumber, pending);
        await putPart(url, body, signal, (loaded) => {
          this.inflight.set(partNumber, loaded);
          this.publishProgress();
        });
        this.inflight.delete(partNumber);
        this.finishedBytes += length;
        this.publishProgress(true);
        if (this.item?.phase === 'retrying') patch(this.id, { phase: 'uploading', error: null });
        return;
      } catch (err) {
        this.inflight.delete(partNumber);
        if (err instanceof Stopped || signal.aborted) throw new Stopped();
        const status =
          err instanceof HttpError ? err.status : err instanceof ApiError ? err.status : -1;
        const retryable =
          status === 0 || status === 403 || status === 408 || status === 429 || status >= 500;
        // Being offline is not this part's fault, so it does not count against the limit.
        const offline = !navigator.onLine;
        if (!retryable || (!offline && attempt >= MAX_PART_ATTEMPTS)) throw err;
        patch(this.id, { phase: 'retrying', error: (err as Error).message });
        this.publishProgress(true);
        await wait(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt), signal);
      }
    }
  }

  private async sendAll(mediaId: string, plan: PartPlan): Promise<void> {
    const pending = pendingParts(plan);
    const queue = [...pending];
    const runner = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        await this.sendPart(mediaId, next, plan, queue);
      }
    };
    await Promise.all(Array.from({ length: MAX_UPLOAD_CONCURRENCY }, runner));
  }

  async run(): Promise<void> {
    try {
      let mediaId = this.item?.mediaId ?? null;
      patch(this.id, { phase: 'preparing', error: null });
      const state = mediaId
        ? await getUpload(this.projectId, mediaId)
        : await initUpload(this.projectId, {
            name: this.file.name,
            size: this.file.size,
            fingerprint: await fingerprintFile(this.file),
          });
      mediaId = state.media.id;
      void refreshMedia(queryClient, this.projectId);

      let plan: PartPlan = { ...state, size: this.file.size };
      const alreadyStored = confirmedBytes(plan);
      this.finishedBytes = alreadyStored;
      patch(this.id, {
        mediaId,
        phase: 'uploading',
        uploadedBytes: alreadyStored,
        // Only a fresh start counts as resuming. After a pause this session sent those bytes.
        ...(this.item?.mediaId ? {} : { resumedBytes: state.resumed ? alreadyStored : 0 }),
      });

      for (let round = 0; ; round++) {
        await this.sendAll(mediaId, plan);
        if (this.controller.signal.aborted) return;
        patch(this.id, { phase: 'finishing', uploadedBytes: this.file.size, bytesPerSecond: 0 });
        try {
          await completeUpload(this.projectId, mediaId);
          break;
        } catch (err) {
          // Storage is the authority on which parts arrived. Send whatever it says is missing.
          const incomplete = err instanceof ApiError && err.code === 'upload_incomplete';
          if (!incomplete || round + 1 >= MAX_COMPLETE_ROUNDS) throw err;
          plan = { ...(await getUpload(this.projectId, mediaId)), size: this.file.size };
          this.finishedBytes = confirmedBytes(plan);
          patch(this.id, { phase: 'uploading' });
        }
      }
      patch(this.id, { phase: 'done', error: null });
      setTimeout(() => dismissUpload(this.id), DONE_ROW_LINGER_MS);
      await refreshMedia(queryClient, this.projectId);
    } catch (err) {
      if (err instanceof Stopped || this.controller.signal.aborted) return;
      patch(this.id, {
        phase: 'failed',
        error: err instanceof Error ? err.message : 'Upload failed',
        bytesPerSecond: 0,
      });
    }
  }

  stop() {
    this.controller.abort();
  }
}

const tasks = new Map<string, { task: UploadTask; file: File }>();
let running: UploadTask | null = null;

/** One file at a time: its parts already run in parallel, and browsers cap connections per host. */
function pump() {
  if (running) return;
  const next = Object.values(useUploads.getState().items).find((i) => i.phase === 'queued');
  if (!next) return;
  const entry = tasks.get(next.id);
  if (!entry) return;
  const task = new UploadTask(next.id, next.projectId, entry.file);
  entry.task = task;
  running = task;
  void task.run().finally(() => {
    if (running === task) running = null;
    pump();
  });
}

function stopRunning(id: string) {
  const entry = tasks.get(id);
  entry?.task.stop();
  if (entry && running === entry.task) running = null;
}

export function enqueueUploads(projectId: string, files: Iterable<File>) {
  const added: Record<string, UploadItem> = {};
  for (const file of files) {
    const id = crypto.randomUUID();
    const supported = uploadExtension(file.name) !== null;
    added[id] = {
      id,
      projectId,
      mediaId: null,
      name: file.name,
      size: file.size,
      phase: supported ? 'queued' : 'failed',
      uploadedBytes: 0,
      bytesPerSecond: 0,
      resumedBytes: 0,
      error: supported ? null : 'Supported formats are MP4, MOV, MKV and WebM',
    };
    if (supported) tasks.set(id, { task: new UploadTask(id, projectId, file), file });
  }
  useUploads.setState((state) => ({ items: { ...state.items, ...added } }));
  pump();
}

export function pauseUpload(id: string) {
  stopRunning(id);
  patch(id, { phase: 'paused', bytesPerSecond: 0 });
  pump();
}

export function resumeUpload(id: string) {
  patch(id, { phase: 'queued', error: null });
  pump();
}

export async function cancelUploadItem(id: string) {
  const item = useUploads.getState().items[id];
  stopRunning(id);
  dismissUpload(id);
  pump();
  if (item?.mediaId) {
    await cancelUpload(item.projectId, item.mediaId);
    await refreshMedia(queryClient, item.projectId);
  }
}

export function dismissUpload(id: string) {
  tasks.delete(id);
  useUploads.setState((state) => {
    const { [id]: _removed, ...items } = state.items;
    return { items };
  });
}

const ACTIVE: ReadonlySet<UploadPhase> = new Set([
  'queued',
  'preparing',
  'uploading',
  'retrying',
  'finishing',
]);

export function hasActiveUploads(): boolean {
  return Object.values(useUploads.getState().items).some((item) => ACTIVE.has(item.phase));
}

window.addEventListener('beforeunload', (event) => {
  if (hasActiveUploads()) event.preventDefault();
});
