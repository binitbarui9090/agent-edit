import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaDoc, Storage } from '@agent-edit/infra';

/** Spare room needed beyond the source: outputs and encoder scratch for the other steps. */
const FREE_SPACE_MARGIN = 2;

/**
 * Keeps one local read-only copy of a source per asset, so four steps on a multi-gigabyte file do not
 * download it four times. The copy lives until the asset's pipeline is finished.
 */
export class SourceCache {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly pins = new Map<string, number>();

  constructor(
    private readonly storage: Storage,
    private readonly workDir: string,
  ) {}

  private directory(mediaId: string): string {
    return join(this.workDir, mediaId);
  }

  acquire(media: MediaDoc, signal?: AbortSignal): Promise<string> {
    const running = this.inflight.get(media._id);
    if (running) return running;
    const task = this.download(media, signal).finally(() => this.inflight.delete(media._id));
    this.inflight.set(media._id, task);
    return task;
  }

  private async download(media: MediaDoc, signal?: AbortSignal): Promise<string> {
    const directory = this.directory(media._id);
    const source = join(directory, 'source');
    await mkdir(directory, { recursive: true });

    const existing = await stat(source).catch(() => null);
    if (existing?.size === media.size) return source;

    const { bavail, bsize } = await statfs(directory);
    if (bavail * bsize < media.size * FREE_SPACE_MARGIN) {
      throw new Error('Not enough free disk space in the work directory');
    }

    const partial = `${source}.${randomBytes(4).toString('hex')}.part`;
    try {
      await this.storage.downloadToFile(media.storage.originalKey, partial, signal);
      const { size } = await stat(partial);
      if (size !== media.size) throw new Error(`Downloaded ${size} of ${media.size} bytes`);
      // Read-only: a bug in a later step cannot alter what the outputs are derived from.
      await chmod(partial, 0o400);
      await rename(partial, source);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    return source;
  }

  /** A scratch directory for one step, removed by the caller. */
  async scratch(mediaId: string, step: string): Promise<string> {
    const directory = this.directory(mediaId);
    await mkdir(directory, { recursive: true });
    return mkdtemp(join(directory, `${step}-`));
  }

  /** Keeps a source through a render, even if its analysis finishes and tries to release it. */
  pin(mediaId: string): void {
    this.pins.set(mediaId, (this.pins.get(mediaId) ?? 0) + 1);
  }

  async unpin(mediaId: string): Promise<void> {
    const count = (this.pins.get(mediaId) ?? 1) - 1;
    if (count > 0) {
      this.pins.set(mediaId, count);
      return;
    }
    this.pins.delete(mediaId);
    await rm(this.directory(mediaId), { recursive: true, force: true });
  }

  async release(mediaId: string): Promise<void> {
    if (this.pins.has(mediaId)) return;
    await rm(this.directory(mediaId), { recursive: true, force: true });
  }
}
