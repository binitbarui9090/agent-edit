import {
  publishEvent,
  type Database,
  type MediaQueues,
  type RenderJobDoc,
  type Storage,
} from '@agent-edit/infra';
import { newId, ticksToSeconds } from '@agent-edit/shared';
import { timelineDuration } from '@agent-edit/timeline-engine';
import {
  RENDER_PRESETS,
  type RenderJob,
  type RenderPreset,
  type RenderStatus,
} from '@agent-edit/validation';
import type { Redis } from 'ioredis';
import { AppError } from '../../errors.js';
import type { ProjectService } from '../projects/service.js';
import type { TimelineService } from '../timelines/service.js';

export interface RenderServiceDeps {
  database: Database;
  redis: Redis;
  queues: MediaQueues;
  storage: Storage;
  projects: ProjectService;
  timelines: TimelineService;
}

function evenSize(width: number, height: number) {
  return { width: width + (width % 2), height: height + (height % 2) };
}

/** Starting and tracking renders. The rendering itself only ever happens in a worker. */
export class RenderService {
  private readonly database: Database;
  private readonly redis: Redis;
  private readonly queues: MediaQueues;
  private readonly storage: Storage;
  private readonly projects: ProjectService;
  private readonly timelines: TimelineService;

  constructor(deps: RenderServiceDeps) {
    this.database = deps.database;
    this.redis = deps.redis;
    this.queues = deps.queues;
    this.storage = deps.storage;
    this.projects = deps.projects;
    this.timelines = deps.timelines;
  }

  private async toJob(doc: RenderJobDoc): Promise<RenderJob> {
    const name = `${doc.timelineName} ${doc.width}x${doc.height}`;
    return {
      id: doc._id,
      projectId: doc.projectId,
      timelineId: doc.timelineId,
      timelineName: doc.timelineName,
      revision: doc.revision,
      preset: doc.preset,
      burnCaptions: doc.burnCaptions,
      width: doc.width,
      height: doc.height,
      status: doc.status,
      progress: doc.progress,
      error: doc.error,
      durationSeconds: ticksToSeconds(doc.durationTicks),
      outputSize: doc.outputSize,
      downloadUrl: doc.outputKey
        ? await this.storage.signDownload(doc.outputKey, `${name}.mp4`)
        : null,
      captionsUrl: doc.captionsKey
        ? await this.storage.signDownload(doc.captionsKey, `${name}.srt`)
        : null,
      logUrl: doc.logKey ? await this.storage.signRead(doc.logKey) : null,
      createdAt: doc.createdAt.toISOString(),
      finishedAt: doc.finishedAt?.toISOString() ?? null,
    };
  }

  private notify(doc: RenderJobDoc, status: RenderStatus) {
    return publishEvent(this.redis, {
      type: 'render.changed',
      projectId: doc.projectId,
      renderId: doc._id,
      status,
      progress: doc.progress,
    });
  }

  async create(
    ownerId: string,
    projectId: string,
    timelineId: string,
    options: { preset: RenderPreset; burnCaptions: boolean; baseRevision: number },
  ): Promise<RenderJob> {
    const timeline = await this.timelines.get(ownerId, projectId, timelineId);
    if (timeline.revision !== options.baseRevision) {
      throw new AppError('revision_conflict', 'The timeline changed since this edit was made', {
        revision: timeline.revision,
      });
    }
    const duration = timelineDuration(timeline);
    if (duration === 0) throw new AppError('conflict', 'This timeline is empty');

    const preset = RENDER_PRESETS[options.preset];
    const size = evenSize(preset.width ?? timeline.width, preset.height ?? timeline.height);
    const now = new Date();
    const doc: RenderJobDoc = {
      _id: newId('rnd'),
      projectId,
      ownerId,
      timelineId,
      timelineName: timeline.name,
      revision: timeline.revision,
      snapshot: {
        frameRate: timeline.frameRate,
        width: timeline.width,
        height: timeline.height,
        tracks: timeline.tracks,
      },
      preset: options.preset,
      burnCaptions: options.burnCaptions,
      ...size,
      status: 'queued',
      progress: 0,
      attempts: 0,
      error: null,
      outputKey: null,
      outputSize: null,
      captionsKey: null,
      logKey: null,
      durationTicks: duration,
      generation: 0,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await this.database.renders.insertOne(doc);
    await this.queues.enqueueRender(doc._id, doc.generation);
    await this.notify(doc, 'queued');
    return this.toJob(doc);
  }

  async listForProject(ownerId: string, projectId: string): Promise<RenderJob[]> {
    await this.projects.assertOwned(ownerId, projectId);
    const docs = await this.database.renders
      .find({ projectId })
      .project<RenderJobDoc>({ snapshot: 0 })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    return Promise.all(docs.map((doc) => this.toJob(doc)));
  }

  async listRecent(
    ownerId: string,
    limit = 10,
  ): Promise<Array<RenderJob & { projectName: string }>> {
    const docs = await this.database.renders
      .find({ ownerId })
      .project<RenderJobDoc>({ snapshot: 0 })
      .sort({ createdAt: -1 })
      .limit(limit * 3)
      .toArray();
    const projects = await this.database.projects
      .find({ _id: { $in: docs.map((doc) => doc.projectId) }, deletedAt: null })
      .project<{ _id: string; name: string }>({ name: 1 })
      .toArray();
    const names = new Map(projects.map((project) => [project._id, project.name]));
    const visible = docs.filter((doc) => names.has(doc.projectId)).slice(0, limit);
    return Promise.all(
      visible.map(async (doc) => ({
        ...(await this.toJob(doc)),
        projectName: names.get(doc.projectId) ?? '',
      })),
    );
  }

  private async find(ownerId: string, projectId: string, renderId: string): Promise<RenderJobDoc> {
    await this.projects.assertOwned(ownerId, projectId);
    const doc = await this.database.renders.findOne({ _id: renderId, projectId, ownerId });
    if (!doc) throw new AppError('not_found', 'Export not found');
    return doc;
  }

  async get(ownerId: string, projectId: string, renderId: string) {
    return this.toJob(await this.find(ownerId, projectId, renderId));
  }

  /** The worker notices within seconds and stops FFmpeg. */
  async cancel(ownerId: string, projectId: string, renderId: string) {
    const doc = await this.find(ownerId, projectId, renderId);
    if (doc.status !== 'queued' && doc.status !== 'running') {
      throw new AppError('conflict', 'This export has already finished');
    }
    const now = new Date();
    const updated = await this.database.renders.findOneAndUpdate(
      { _id: renderId, status: { $in: ['queued', 'running'] } },
      { $set: { status: 'cancelled', updatedAt: now, finishedAt: now } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new AppError('conflict', 'This export has already finished');
    await this.notify(updated, 'cancelled');
    return this.toJob(updated);
  }

  async retry(ownerId: string, projectId: string, renderId: string) {
    const doc = await this.find(ownerId, projectId, renderId);
    if (doc.status !== 'failed' && doc.status !== 'cancelled') {
      throw new AppError('conflict', 'Only a failed or cancelled export can be retried');
    }
    const generation = doc.generation + 1;
    const updated = await this.database.renders.findOneAndUpdate(
      { _id: renderId, generation: doc.generation },
      {
        $set: {
          status: 'queued',
          progress: 0,
          error: null,
          generation,
          updatedAt: new Date(),
          finishedAt: null,
        },
      },
      { returnDocument: 'after' },
    );
    if (!updated) throw new AppError('conflict', 'This export changed. Try again.');
    await this.queues.enqueueRender(renderId, generation);
    await this.notify(updated, 'queued');
    return this.toJob(updated);
  }
}
