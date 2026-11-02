import {
  type AnalysisJobDoc,
  type Database,
  type MediaDoc,
  type MediaQueues,
  type Storage,
  newJobDoc,
  originalKey,
  publishEvent,
} from '@agent-edit/infra';
import {
  PROCESSING_STEPS,
  UPLOAD_CONTENT_TYPES,
  newId,
  partCountFor,
  partSizeFor,
  uploadExtension,
} from '@agent-edit/shared';
import type {
  InitUploadRequest,
  MediaAsset,
  MediaList,
  MediaPlayback,
  UpdateMediaRequest,
  UploadState,
} from '@agent-edit/validation';
import type { Redis } from 'ioredis';
import type { Filter } from 'mongodb';
import { AppError } from '../../errors.js';
import type { ProjectService } from '../projects/service.js';

const DUPLICATE_KEY = 11000;

export interface MediaServiceDeps {
  database: Database;
  storage: Storage;
  queues: MediaQueues;
  redis: Redis;
  projects: ProjectService;
  maxUploadBytes: number;
}

export class MediaService {
  private readonly database: Database;
  private readonly storage: Storage;
  private readonly queues: MediaQueues;
  private readonly redis: Redis;
  private readonly projects: ProjectService;
  private readonly maxUploadBytes: number;

  constructor(deps: MediaServiceDeps) {
    this.database = deps.database;
    this.storage = deps.storage;
    this.queues = deps.queues;
    this.redis = deps.redis;
    this.projects = deps.projects;
    this.maxUploadBytes = deps.maxUploadBytes;
  }

  private async loadJobs(mediaIds: string[]): Promise<Map<string, AnalysisJobDoc[]>> {
    const jobs = await this.database.analysisJobs.find({ mediaId: { $in: mediaIds } }).toArray();
    const byMedia = new Map<string, AnalysisJobDoc[]>();
    for (const job of jobs) byMedia.set(job.mediaId, [...(byMedia.get(job.mediaId) ?? []), job]);
    return byMedia;
  }

  private async toAsset(doc: MediaDoc, jobs: AnalysisJobDoc[]): Promise<MediaAsset> {
    const order = (job: AnalysisJobDoc) => PROCESSING_STEPS.indexOf(job.step);
    return {
      id: doc._id,
      projectId: doc.projectId,
      name: doc.name,
      folder: doc.folder,
      status: doc.status,
      size: doc.size,
      error: doc.error,
      probe: doc.probe,
      jobs: [...jobs]
        .sort((a, b) => order(a) - order(b))
        .map(({ step, status, progress, error }) => ({ step, status, progress, error })),
      posterUrl: doc.storage.posterKey ? await this.storage.signRead(doc.storage.posterKey) : null,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  private async assetFor(doc: MediaDoc): Promise<MediaAsset> {
    const jobs = await this.loadJobs([doc._id]);
    return this.toAsset(doc, jobs.get(doc._id) ?? []);
  }

  private async findOwned(ownerId: string, projectId: string, mediaId: string): Promise<MediaDoc> {
    const doc = await this.database.media.findOne({
      _id: mediaId,
      projectId,
      ownerId,
      deletedAt: null,
    });
    if (!doc) throw new AppError('not_found', 'Media not found');
    return doc;
  }

  private async touchProject(projectId: string): Promise<void> {
    await this.database.projects.updateOne({ _id: projectId }, { $set: { updatedAt: new Date() } });
  }

  private async uploadState(doc: MediaDoc, resumed: boolean): Promise<UploadState> {
    const upload = doc.upload;
    if (!upload) throw new AppError('conflict', 'This upload has already finished');
    const parts = await this.storage.listParts(doc.storage.originalKey, upload.s3UploadId);
    return {
      media: await this.assetFor(doc),
      partSize: upload.partSize,
      partCount: upload.partCount,
      uploadedParts: (parts ?? []).map(({ partNumber, size }) => ({ partNumber, size })),
      resumed,
    };
  }

  async initUpload(
    ownerId: string,
    projectId: string,
    input: InitUploadRequest,
  ): Promise<UploadState> {
    await this.projects.assertOwned(ownerId, projectId);

    const extension = uploadExtension(input.name);
    if (!extension) {
      throw new AppError('unsupported_media', 'Supported formats are MP4, MOV, MKV and WebM');
    }
    if (input.size > this.maxUploadBytes) {
      throw new AppError('file_too_large', 'This file is larger than the upload limit');
    }

    const existing = await this.database.media.findOne({
      projectId,
      fingerprint: input.fingerprint,
      status: 'uploading',
      deletedAt: null,
    });
    if (existing) return this.uploadState(existing, true);

    const now = new Date();
    const mediaId = newId('med');
    const key = originalKey(projectId, mediaId);
    const contentType = UPLOAD_CONTENT_TYPES[extension];
    const partSize = partSizeFor(input.size);
    const s3UploadId = await this.storage.createMultipart(key, contentType);
    const doc: MediaDoc = {
      _id: mediaId,
      projectId,
      ownerId,
      name: input.name,
      folder: null,
      status: 'uploading',
      size: input.size,
      contentType,
      extension,
      fingerprint: input.fingerprint,
      upload: { s3UploadId, partSize, partCount: partCountFor(input.size, partSize) },
      storage: {
        originalKey: key,
        proxyKey: null,
        audioKey: null,
        waveformKey: null,
        waveformPeaksPerSecond: null,
        thumbnailKeys: [],
        posterKey: null,
      },
      probe: null,
      error: null,
      generation: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    try {
      await this.database.media.insertOne(doc);
    } catch (err) {
      await this.storage.abortMultipart(key, s3UploadId);
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
      // Another tab started this exact file first. Join that upload.
      const winner = await this.database.media.findOne({
        projectId,
        fingerprint: input.fingerprint,
        status: 'uploading',
        deletedAt: null,
      });
      if (!winner) throw err;
      return this.uploadState(winner, true);
    }
    await this.touchProject(projectId);
    await publishEvent(this.redis, { type: 'media.changed', projectId, mediaId });
    return this.uploadState(doc, false);
  }

  private async findUploading(ownerId: string, projectId: string, mediaId: string) {
    const doc = await this.findOwned(ownerId, projectId, mediaId);
    if (doc.status !== 'uploading' || !doc.upload) {
      throw new AppError('conflict', 'This upload has already finished');
    }
    return { doc, upload: doc.upload };
  }

  async getUpload(ownerId: string, projectId: string, mediaId: string): Promise<UploadState> {
    const { doc } = await this.findUploading(ownerId, projectId, mediaId);
    return this.uploadState(doc, true);
  }

  async signParts(ownerId: string, projectId: string, mediaId: string, partNumbers: number[]) {
    const { doc, upload } = await this.findUploading(ownerId, projectId, mediaId);
    const invalid = partNumbers.find((n) => n > upload.partCount);
    if (invalid !== undefined) {
      throw new AppError('validation_failed', `Part ${invalid} is out of range`);
    }
    const urls = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.signPart(doc.storage.originalKey, upload.s3UploadId, partNumber),
      })),
    );
    // Marks the upload as active, so the stale-upload sweep leaves it alone.
    await this.database.media.updateOne({ _id: mediaId }, { $set: { updatedAt: new Date() } });
    return { urls };
  }

  /**
   * Safe to repeat. Parts and sizes come from storage rather than the client, and each step tolerates
   * the previous attempt having got further: a crash after the storage call just re-enters here,
   * finds the upload gone and the object present, and carries on.
   */
  async completeUpload(ownerId: string, projectId: string, mediaId: string): Promise<MediaAsset> {
    const doc = await this.findOwned(ownerId, projectId, mediaId);
    if (doc.status !== 'uploading' || !doc.upload) return this.assetFor(doc);
    const { upload } = doc;
    const key = doc.storage.originalKey;

    const parts = await this.storage.listParts(key, upload.s3UploadId);
    if (parts) {
      const byNumber = new Map(parts.map((part) => [part.partNumber, part]));
      const missing: number[] = [];
      for (let n = 1; n <= upload.partCount; n++) {
        const expected =
          n < upload.partCount ? upload.partSize : doc.size - upload.partSize * (n - 1);
        if (byNumber.get(n)?.size !== expected) missing.push(n);
      }
      if (missing.length > 0) {
        throw new AppError(
          'upload_incomplete',
          `${missing.length} of ${upload.partCount} parts are missing or the wrong size`,
          { missingParts: missing.slice(0, 100) },
        );
      }
      await this.storage.completeMultipart(
        key,
        upload.s3UploadId,
        parts.filter((part) => part.partNumber <= upload.partCount),
      );
    }

    const storedSize = await this.storage.objectSize(key);
    if (storedSize !== doc.size) {
      throw new AppError('upload_incomplete', 'The stored file does not match the declared size');
    }

    const now = new Date();
    await this.database.analysisJobs.bulkWrite(
      PROCESSING_STEPS.map((step) => {
        const { _id, ...job } = newJobDoc(projectId, mediaId, step, now);
        return {
          updateOne: { filter: { _id }, update: { $setOnInsert: job }, upsert: true },
        };
      }),
    );
    // Enqueue before changing status: if Redis is down this throws and the client's retry lands here
    // again. Doing it the other way round would leave an asset "processing" with no job behind it.
    await this.queues.enqueue('probe', { mediaId, projectId }, doc.generation);
    const updated = await this.database.media.findOneAndUpdate(
      { _id: mediaId, status: 'uploading' },
      { $set: { status: 'processing', upload: null, updatedAt: now } },
      { returnDocument: 'after' },
    );
    await this.touchProject(projectId);
    await publishEvent(this.redis, { type: 'media.changed', projectId, mediaId });
    return this.assetFor(updated ?? (await this.findOwned(ownerId, projectId, mediaId)));
  }

  async cancelUpload(ownerId: string, projectId: string, mediaId: string): Promise<void> {
    const { doc, upload } = await this.findUploading(ownerId, projectId, mediaId);
    await this.storage.abortMultipart(doc.storage.originalKey, upload.s3UploadId);
    await this.database.media.deleteOne({ _id: mediaId, status: 'uploading' });
    await this.database.analysisJobs.deleteMany({ mediaId });
    await publishEvent(this.redis, { type: 'media.changed', projectId, mediaId });
  }

  async list(
    ownerId: string,
    projectId: string,
    limit: number,
    cursor?: string,
  ): Promise<MediaList> {
    await this.projects.assertOwned(ownerId, projectId);
    const filter: Filter<MediaDoc> = { projectId, deletedAt: null };
    if (cursor) {
      const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
      const createdAt = new Date(iso ?? '');
      if (!id || Number.isNaN(createdAt.getTime())) {
        throw new AppError('validation_failed', 'Invalid cursor');
      }
      filter.$or = [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: id } }];
    }
    const docs = await this.database.media
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const page = docs.slice(0, limit);
    const jobs = await this.loadJobs(page.map((doc) => doc._id));
    const last = page.at(-1);
    return {
      items: await Promise.all(page.map((doc) => this.toAsset(doc, jobs.get(doc._id) ?? []))),
      nextCursor:
        docs.length > limit && last
          ? Buffer.from(`${last.createdAt.toISOString()}|${last._id}`).toString('base64url')
          : null,
    };
  }

  async getPlayback(ownerId: string, projectId: string, mediaId: string): Promise<MediaPlayback> {
    const doc = await this.findOwned(ownerId, projectId, mediaId);
    const { proxyKey, waveformKey, waveformPeaksPerSecond, thumbnailKeys } = doc.storage;
    return {
      ...(await this.assetFor(doc)),
      proxyUrl: proxyKey ? await this.storage.signRead(proxyKey) : null,
      thumbnailUrls: await Promise.all(thumbnailKeys.map((key) => this.storage.signRead(key))),
      waveform:
        waveformKey && waveformPeaksPerSecond
          ? {
              url: await this.storage.signRead(waveformKey),
              peaksPerSecond: waveformPeaksPerSecond,
            }
          : null,
    };
  }

  async update(
    ownerId: string,
    projectId: string,
    mediaId: string,
    input: UpdateMediaRequest,
  ): Promise<MediaAsset> {
    const doc = await this.database.media.findOneAndUpdate(
      { _id: mediaId, projectId, ownerId, deletedAt: null },
      {
        $set: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.folder === undefined ? {} : { folder: input.folder }),
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );
    if (!doc) throw new AppError('not_found', 'Media not found');
    return this.assetFor(doc);
  }

  /** Soft delete: the sweep removes objects later, after any job still running has noticed. */
  async remove(ownerId: string, projectId: string, mediaId: string): Promise<void> {
    const doc = await this.findOwned(ownerId, projectId, mediaId);
    const used = await this.database.timelines.countDocuments(
      { projectId, deletedAt: null, 'tracks.clips.sourceMediaId': mediaId },
      { limit: 1 },
    );
    if (used > 0) {
      throw new AppError('in_use', 'This footage is used on a timeline. Remove its clips first.');
    }
    await this.database.media.updateOne({ _id: mediaId }, { $set: { deletedAt: new Date() } });
    if (doc.upload) {
      await this.storage.abortMultipart(doc.storage.originalKey, doc.upload.s3UploadId);
    }
    await this.touchProject(projectId);
    await publishEvent(this.redis, { type: 'media.changed', projectId, mediaId });
  }

  async retry(ownerId: string, projectId: string, mediaId: string): Promise<MediaAsset> {
    const doc = await this.findOwned(ownerId, projectId, mediaId);
    const jobs = await this.database.analysisJobs.find({ mediaId }).toArray();
    const failed = jobs.filter((job) => job.status === 'failed');
    if (failed.length === 0) throw new AppError('conflict', 'Nothing has failed');

    // Later steps need probe's result, so a failed probe restarts the whole pipeline.
    const probeFailed = failed.some((job) => job.step === 'probe');
    const resetSteps = probeFailed ? jobs.map((job) => job.step) : failed.map((job) => job.step);
    const generation = doc.generation + 1;
    const now = new Date();
    await this.database.analysisJobs.updateMany(
      { mediaId, step: { $in: resetSteps } },
      {
        $set: {
          status: 'queued',
          progress: 0,
          attempts: 0,
          error: null,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
        },
      },
    );
    const updated = await this.database.media.findOneAndUpdate(
      { _id: mediaId },
      { $set: { status: 'processing', error: null, generation, updatedAt: now } },
      { returnDocument: 'after' },
    );
    const data = { mediaId, projectId };
    for (const step of probeFailed ? (['probe'] as const) : resetSteps) {
      await this.queues.enqueue(step, data, generation);
    }
    await publishEvent(this.redis, { type: 'media.changed', projectId, mediaId });
    return this.assetFor(updated ?? doc);
  }
}
