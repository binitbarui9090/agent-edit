import type { Database, ProjectDoc, Storage } from '@agent-edit/infra';
import { newId } from '@agent-edit/shared';
import type {
  CreateProjectRequest,
  Project,
  ProjectList,
  ProjectMediaSummary,
  UpdateProjectRequest,
} from '@agent-edit/validation';
import type { Filter } from 'mongodb';
import { AppError } from '../../errors.js';

const EMPTY_MEDIA: ProjectMediaSummary = {
  total: 0,
  ready: 0,
  processing: 0,
  uploading: 0,
  failed: 0,
  posterUrl: null,
};

function toProject(doc: ProjectDoc, media: ProjectMediaSummary = EMPTY_MEDIA): Project {
  return {
    id: doc._id,
    name: doc.name,
    settings: doc.settings,
    media,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function encodeCursor(doc: ProjectDoc): string {
  return Buffer.from(`${doc.updatedAt.toISOString()}|${doc._id}`).toString('base64url');
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const updatedAt = new Date(iso ?? '');
  if (!id || Number.isNaN(updatedAt.getTime())) {
    throw new AppError('validation_failed', 'Invalid cursor');
  }
  return { updatedAt, id };
}

/** Every query is scoped by ownerId, so another user's project is simply not found. */
export class ProjectService {
  constructor(
    private readonly database: Database,
    private readonly storage: Storage,
  ) {}

  private scope(ownerId: string, id: string): Filter<ProjectDoc> {
    return { _id: id, ownerId, deletedAt: null };
  }

  private async mediaSummaries(projectIds: string[]): Promise<Map<string, ProjectMediaSummary>> {
    const count = (status: string) => ({ $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } });
    const rows = await this.database.media
      .aggregate<{
        _id: string;
        total: number;
        ready: number;
        processing: number;
        uploading: number;
        failed: number;
        posterKey: string | null;
      }>([
        { $match: { projectId: { $in: projectIds }, deletedAt: null } },
        {
          $group: {
            _id: '$projectId',
            total: { $sum: 1 },
            ready: count('ready'),
            processing: count('processing'),
            uploading: count('uploading'),
            failed: count('failed'),
            posterKey: { $min: '$storage.posterKey' },
          },
        },
      ])
      .toArray();
    const summaries = new Map<string, ProjectMediaSummary>();
    await Promise.all(
      rows.map(async ({ _id, posterKey, ...counts }) => {
        const posterUrl = posterKey ? await this.storage.signRead(posterKey) : null;
        summaries.set(_id, { ...counts, posterUrl });
      }),
    );
    return summaries;
  }

  /** Confirms ownership for other modules, using the same not-found rule as every project read. */
  async assertOwned(ownerId: string, id: string): Promise<void> {
    const count = await this.database.projects.countDocuments(this.scope(ownerId, id), {
      limit: 1,
    });
    if (count === 0) throw new AppError('not_found', 'Project not found');
  }

  async create(ownerId: string, input: CreateProjectRequest): Promise<Project> {
    const now = new Date();
    const doc: ProjectDoc = {
      _id: newId('prj'),
      ownerId,
      name: input.name,
      settings: input.settings,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.database.projects.insertOne(doc);
    return toProject(doc);
  }

  async list(ownerId: string, limit: number, cursor?: string): Promise<ProjectList> {
    const filter: Filter<ProjectDoc> = { ownerId, deletedAt: null };
    if (cursor) {
      const { updatedAt, id } = decodeCursor(cursor);
      filter.$or = [{ updatedAt: { $lt: updatedAt } }, { updatedAt, _id: { $lt: id } }];
    }
    const docs = await this.database.projects
      .find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const page = docs.slice(0, limit);
    const last = page.at(-1);
    const summaries = await this.mediaSummaries(page.map((doc) => doc._id));
    return {
      items: page.map((doc) => toProject(doc, summaries.get(doc._id))),
      nextCursor: docs.length > limit && last ? encodeCursor(last) : null,
    };
  }

  async get(ownerId: string, id: string): Promise<Project> {
    const doc = await this.database.projects.findOne(this.scope(ownerId, id));
    if (!doc) throw new AppError('not_found', 'Project not found');
    const summaries = await this.mediaSummaries([doc._id]);
    return toProject(doc, summaries.get(doc._id));
  }

  async update(ownerId: string, id: string, input: UpdateProjectRequest): Promise<Project> {
    const doc = await this.database.projects.findOneAndUpdate(
      this.scope(ownerId, id),
      {
        $set: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.settings === undefined ? {} : { settings: input.settings }),
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );
    if (!doc) throw new AppError('not_found', 'Project not found');
    const summaries = await this.mediaSummaries([doc._id]);
    return toProject(doc, summaries.get(doc._id));
  }

  /** Soft delete. The worker's sweep later removes the media objects and their records. */
  async remove(ownerId: string, id: string): Promise<void> {
    const now = new Date();
    const result = await this.database.projects.updateOne(this.scope(ownerId, id), {
      $set: { deletedAt: now },
    });
    if (result.matchedCount === 0) throw new AppError('not_found', 'Project not found');
    await this.database.media.updateMany(
      { projectId: id, deletedAt: null },
      { $set: { deletedAt: now } },
    );
  }
}
