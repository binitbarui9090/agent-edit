import { newId } from '@agent-edit/shared';
import type {
  CreateProjectRequest,
  Project,
  ProjectList,
  UpdateProjectRequest,
} from '@agent-edit/validation';
import type { Filter } from 'mongodb';
import { AppError } from '../../errors.js';
import type { Database, ProjectDoc } from '../../infra/mongo.js';

function toProject(doc: ProjectDoc): Project {
  return {
    id: doc._id,
    name: doc.name,
    settings: doc.settings,
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
  constructor(private readonly database: Database) {}

  private scope(ownerId: string, id: string): Filter<ProjectDoc> {
    return { _id: id, ownerId, deletedAt: null };
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
    return {
      items: page.map(toProject),
      nextCursor: docs.length > limit && last ? encodeCursor(last) : null,
    };
  }

  async get(ownerId: string, id: string): Promise<Project> {
    const doc = await this.database.projects.findOne(this.scope(ownerId, id));
    if (!doc) throw new AppError('not_found', 'Project not found');
    return toProject(doc);
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
    return toProject(doc);
  }

  /** Soft delete. Purging media from object storage arrives with media ownership in Phase 2. */
  async remove(ownerId: string, id: string): Promise<void> {
    const result = await this.database.projects.updateOne(this.scope(ownerId, id), {
      $set: { deletedAt: new Date() },
    });
    if (result.matchedCount === 0) throw new AppError('not_found', 'Project not found');
  }
}
