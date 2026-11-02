import { randomUUID } from 'node:crypto';
import {
  publishEvent,
  type Database,
  type EditTransactionDoc,
  type TimelineDoc,
} from '@agent-edit/infra';
import { newId } from '@agent-edit/shared';
import {
  TimelineError,
  applyOperations,
  createDefaultTracks,
  timelineDuration,
  type MediaLookup,
} from '@agent-edit/timeline-engine';
import type {
  HistoryEntry,
  ProjectSettings,
  Timeline,
  TimelineOperation,
  TimelineSummary,
  TimelineVersion,
  TransactionSource,
} from '@agent-edit/validation';
import type { Redis } from 'ioredis';
import type { Filter } from 'mongodb';
import { AppError } from '../../errors.js';
import type { ProjectService } from '../projects/service.js';

const DUPLICATE_KEY = 11000;
const HISTORY_DEPTH = 200;
const MAX_REVISION_RETRIES = 1;

export interface CommitResult {
  timeline: Timeline;
  transactionId: string;
  replayed: boolean;
}

export interface CommitInput {
  baseRevision: number;
  idempotencyKey: string;
  ops: TimelineOperation[];
  summary?: string | undefined;
  source: TransactionSource;
  author: { userId: string; agentRunId?: string | null; model?: string | null };
}

function toTimeline(doc: TimelineDoc): Timeline {
  return {
    id: doc._id,
    projectId: doc.projectId,
    kind: doc.kind,
    name: doc.name,
    revision: doc.revision,
    frameRate: doc.frameRate,
    width: doc.width,
    height: doc.height,
    tracks: doc.tracks,
    canUndo: doc.undoStack.length > 0,
    canRedo: doc.redoStack.length > 0,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toSummary(doc: TimelineDoc): TimelineSummary {
  return {
    id: doc._id,
    kind: doc.kind,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    duration: timelineDuration(doc),
    clipCount: doc.tracks.reduce((sum, track) => sum + track.clips.length, 0),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toHistory(doc: EditTransactionDoc): HistoryEntry {
  return {
    id: doc._id,
    revision: doc.revision,
    source: doc.source,
    summary: doc.summary,
    operationCount: doc.ops.length,
    author: doc.author,
    createdAt: doc.createdAt.toISOString(),
  };
}

function defaultSummary(ops: readonly TimelineOperation[]): string {
  const names = [...new Set(ops.map((op) => op.op.replaceAll('_', ' ')))];
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
}

/** The new stacks after a transaction. Pure, so a crash recovery reaches the identical result. */
function nextStacks(doc: TimelineDoc, txn: EditTransactionDoc) {
  const cap = (stack: string[]) => stack.slice(-HISTORY_DEPTH);
  switch (txn.source) {
    case 'undo':
      return {
        undoStack: doc.undoStack.slice(0, -1),
        redoStack: cap([...doc.redoStack, txn._id]),
      };
    case 'redo':
      return {
        undoStack: cap([...doc.undoStack, txn._id]),
        redoStack: doc.redoStack.slice(0, -1),
      };
    default:
      return { undoStack: cap([...doc.undoStack, txn._id]), redoStack: [] };
  }
}

export interface TimelineServiceDeps {
  database: Database;
  redis: Redis;
  projects: ProjectService;
}

/**
 * The controlled path for every timeline change. Nothing else writes to tracks, including the agent.
 *
 * A commit inserts the transaction first (unique on revision, so it doubles as the lock) and then
 * moves the document with a compare-and-set. A crash between the two is repaired on the next read,
 * which is safe because replaying operations is deterministic.
 */
export class TimelineService {
  private readonly database: Database;
  private readonly redis: Redis;
  private readonly projects: ProjectService;

  constructor(deps: TimelineServiceDeps) {
    this.database = deps.database;
    this.redis = deps.redis;
    this.projects = deps.projects;
  }

  private scope(projectId: string, timelineId: string): Filter<TimelineDoc> {
    return { _id: timelineId, projectId, deletedAt: null };
  }

  /** Applies any transaction a crash left behind, bringing the document up to date. */
  private async rollForward(doc: TimelineDoc): Promise<TimelineDoc> {
    const pending = await this.database.transactions
      .find({ timelineId: doc._id, revision: { $gt: doc.revision } })
      .sort({ revision: 1 })
      .toArray();
    let current = doc;
    for (const txn of pending) {
      const { state } = applyOperations(current, txn.ops);
      const fields = {
        tracks: state.tracks,
        revision: txn.revision,
        updatedAt: txn.createdAt,
        ...nextStacks(current, txn),
      };
      await this.database.timelines.updateOne(
        { _id: current._id, revision: current.revision },
        { $set: fields },
      );
      current = { ...current, ...fields };
    }
    return current;
  }

  private async load(ownerId: string, projectId: string, timelineId: string): Promise<TimelineDoc> {
    await this.projects.assertOwned(ownerId, projectId);
    const doc = await this.database.timelines.findOne(this.scope(projectId, timelineId));
    if (!doc) throw new AppError('not_found', 'Timeline not found');
    return this.rollForward(doc);
  }

  private async mediaLookup(projectId: string): Promise<MediaLookup> {
    const media = await this.database.media
      .find(
        { projectId, deletedAt: null, probe: { $ne: null } },
        { projection: { 'probe.duration': 1 } },
      )
      .toArray();
    const durations = new Map(media.map((doc) => [doc._id, doc.probe?.duration ?? 0]));
    return (id) => {
      const duration = durations.get(id);
      return duration === undefined ? undefined : { duration };
    };
  }

  private async createDoc(
    ownerId: string,
    projectId: string,
    kind: 'main' | 'short',
    name: string,
    settings: Pick<ProjectSettings, 'width' | 'height' | 'frameRate'>,
  ): Promise<TimelineDoc> {
    const now = new Date();
    const doc: TimelineDoc = {
      _id: newId('tln'),
      projectId,
      ownerId,
      kind,
      name,
      revision: 0,
      frameRate: settings.frameRate,
      width: settings.width,
      height: settings.height,
      tracks: createDefaultTracks(),
      undoStack: [],
      redoStack: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.database.timelines.insertOne(doc);
    return doc;
  }

  /** The main timeline is created on first use, and every racing request gets the same one. */
  async ensureMain(ownerId: string, projectId: string): Promise<Timeline> {
    const project = await this.projects.get(ownerId, projectId);
    const existing = await this.database.timelines.findOne({
      projectId,
      kind: 'main',
      deletedAt: null,
    });
    if (existing) return toTimeline(await this.rollForward(existing));
    try {
      return toTimeline(
        await this.createDoc(ownerId, projectId, 'main', 'Main edit', project.settings),
      );
    } catch (err) {
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
      const winner = await this.database.timelines.findOne({
        projectId,
        kind: 'main',
        deletedAt: null,
      });
      if (!winner) throw err;
      return toTimeline(winner);
    }
  }

  async list(ownerId: string, projectId: string): Promise<TimelineSummary[]> {
    await this.ensureMain(ownerId, projectId);
    const docs = await this.database.timelines
      .find({ projectId, deletedAt: null })
      .sort({ kind: 1, createdAt: 1 })
      .toArray();
    return docs.map(toSummary);
  }

  async get(ownerId: string, projectId: string, timelineId: string): Promise<Timeline> {
    return toTimeline(await this.load(ownerId, projectId, timelineId));
  }

  /** For independent timelines such as Shorts. */
  async create(
    ownerId: string,
    projectId: string,
    name: string,
    settings: Pick<ProjectSettings, 'width' | 'height' | 'frameRate'>,
  ): Promise<TimelineDoc> {
    await this.projects.assertOwned(ownerId, projectId);
    return this.createDoc(ownerId, projectId, 'short', name, settings);
  }

  async remove(ownerId: string, projectId: string, timelineId: string): Promise<void> {
    const doc = await this.load(ownerId, projectId, timelineId);
    if (doc.kind === 'main') {
      throw new AppError('conflict', 'The main timeline cannot be deleted');
    }
    await this.database.timelines.updateOne(
      { _id: timelineId },
      { $set: { deletedAt: new Date() } },
    );
  }

  async commit(
    ownerId: string,
    projectId: string,
    timelineId: string,
    input: CommitInput,
  ): Promise<CommitResult> {
    const doc = await this.load(ownerId, projectId, timelineId);
    return this.commitTo(doc, input);
  }

  private async replay(doc: TimelineDoc, idempotencyKey: string): Promise<CommitResult | null> {
    const previous = await this.database.transactions.findOne({
      timelineId: doc._id,
      idempotencyKey,
    });
    if (!previous) return null;
    const fresh = await this.database.timelines.findOne({ _id: doc._id });
    return {
      timeline: toTimeline(await this.rollForward(fresh ?? doc)),
      transactionId: previous._id,
      replayed: true,
    };
  }

  private async commitTo(doc: TimelineDoc, input: CommitInput, attempt = 0): Promise<CommitResult> {
    const replayed = await this.replay(doc, input.idempotencyKey);
    if (replayed) return replayed;

    if (input.baseRevision !== doc.revision) {
      throw new AppError('revision_conflict', 'The timeline changed since this edit was made', {
        revision: doc.revision,
      });
    }

    let state;
    let inverse: TimelineOperation[];
    try {
      const media = await this.mediaLookup(doc.projectId);
      ({ state, inverse } = applyOperations(doc, input.ops, media));
    } catch (err) {
      if (err instanceof TimelineError) {
        throw new AppError('invalid_edit', err.message, { reason: err.code, opIndex: err.opIndex });
      }
      throw err;
    }

    const now = new Date();
    const txn: EditTransactionDoc = {
      _id: newId('txn'),
      timelineId: doc._id,
      projectId: doc.projectId,
      revision: doc.revision + 1,
      idempotencyKey: input.idempotencyKey,
      source: input.source,
      summary: input.summary?.trim() || defaultSummary(input.ops),
      author: {
        userId: input.author.userId,
        agentRunId: input.author.agentRunId ?? null,
        model: input.author.model ?? null,
      },
      ops: input.ops,
      inverseOps: inverse,
      createdAt: now,
    };

    try {
      await this.database.transactions.insertOne(txn);
    } catch (err) {
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
      // Lost a race: either the same request retried, or another edit took this revision.
      const raced = await this.replay(doc, input.idempotencyKey);
      if (raced) return raced;
      if (attempt >= MAX_REVISION_RETRIES) {
        throw new AppError('revision_conflict', 'The timeline changed since this edit was made');
      }
      const latest = await this.database.timelines.findOne({ _id: doc._id });
      return this.commitTo(await this.rollForward(latest ?? doc), input, attempt + 1);
    }

    const updated = await this.database.timelines.findOneAndUpdate(
      { _id: doc._id, revision: doc.revision },
      {
        $set: {
          tracks: state.tracks,
          revision: txn.revision,
          updatedAt: now,
          ...nextStacks(doc, txn),
        },
      },
      { returnDocument: 'after' },
    );
    const current = updated ?? (await this.rollForward(doc));
    await this.database.projects.updateOne({ _id: doc.projectId }, { $set: { updatedAt: now } });
    await publishEvent(this.redis, {
      type: 'timeline.changed',
      projectId: doc.projectId,
      timelineId: doc._id,
      revision: current.revision,
    });
    return { timeline: toTimeline(current), transactionId: txn._id, replayed: false };
  }

  private async stepHistory(
    ownerId: string,
    projectId: string,
    timelineId: string,
    baseRevision: number,
    direction: 'undo' | 'redo',
  ) {
    const doc = await this.load(ownerId, projectId, timelineId);
    // Tied to the revision alone, and checked first: after the first attempt the stack has moved, so
    // a retry has to be recognised before anything is read from it.
    const idempotencyKey = `${direction}:${baseRevision}`;
    const replayed = await this.replay(doc, idempotencyKey);
    if (replayed) return replayed;

    const stack = direction === 'undo' ? doc.undoStack : doc.redoStack;
    const targetId = stack.at(-1);
    if (!targetId) throw new AppError('conflict', `Nothing to ${direction}`);
    const target = await this.database.transactions.findOne({ _id: targetId });
    if (!target) throw new AppError('conflict', `Nothing to ${direction}`);
    const label = target.summary.replace(/^(Undo|Redo): /, '');
    return this.commitTo(doc, {
      baseRevision,
      idempotencyKey,
      ops: target.inverseOps,
      summary: `${direction === 'undo' ? 'Undo' : 'Redo'}: ${label}`,
      source: direction,
      author: { userId: ownerId },
    });
  }

  undo(ownerId: string, projectId: string, timelineId: string, baseRevision: number) {
    return this.stepHistory(ownerId, projectId, timelineId, baseRevision, 'undo');
  }

  redo(ownerId: string, projectId: string, timelineId: string, baseRevision: number) {
    return this.stepHistory(ownerId, projectId, timelineId, baseRevision, 'redo');
  }

  async history(
    ownerId: string,
    projectId: string,
    timelineId: string,
    limit = 100,
  ): Promise<HistoryEntry[]> {
    await this.load(ownerId, projectId, timelineId);
    const docs = await this.database.transactions
      .find({ timelineId })
      .sort({ revision: -1 })
      .limit(limit)
      .toArray();
    return docs.map(toHistory);
  }

  async createVersion(
    ownerId: string,
    projectId: string,
    timelineId: string,
    name: string,
    trigger: 'manual' | 'pre_ai' | 'pre_restore' = 'manual',
  ): Promise<TimelineVersion> {
    const doc = await this.load(ownerId, projectId, timelineId);
    const now = new Date();
    const version = {
      _id: newId('ver'),
      timelineId,
      projectId,
      name,
      revision: doc.revision,
      trigger,
      tracks: doc.tracks,
      createdBy: ownerId,
      createdAt: now,
    };
    await this.database.versions.insertOne(version);
    return {
      id: version._id,
      name,
      revision: version.revision,
      trigger,
      createdAt: now.toISOString(),
    };
  }

  async listVersions(
    ownerId: string,
    projectId: string,
    timelineId: string,
  ): Promise<TimelineVersion[]> {
    await this.load(ownerId, projectId, timelineId);
    const docs = await this.database.versions
      .find({ timelineId }, { projection: { tracks: 0 } })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return docs.map((doc) => ({
      id: doc._id,
      name: doc.name,
      revision: doc.revision,
      trigger: doc.trigger,
      createdAt: doc.createdAt.toISOString(),
    }));
  }

  /**
   * Restoring is an ordinary transaction built from primitives, so it is logged, attributed and
   * undoable like any other edit. The current state is saved first, so nothing can be lost.
   */
  async restoreVersion(
    ownerId: string,
    projectId: string,
    timelineId: string,
    versionId: string,
    baseRevision: number,
  ) {
    const doc = await this.load(ownerId, projectId, timelineId);
    const version = await this.database.versions.findOne({ _id: versionId, timelineId });
    if (!version) throw new AppError('not_found', 'Version not found');
    if (doc.revision !== baseRevision) {
      throw new AppError('revision_conflict', 'The timeline changed since this edit was made', {
        revision: doc.revision,
      });
    }
    await this.createVersion(
      ownerId,
      projectId,
      timelineId,
      `Before restoring "${version.name}"`,
      'pre_restore',
    );

    const ops: TimelineOperation[] = [];
    for (const track of doc.tracks) {
      if (track.locked) ops.push({ op: 'update_track', trackId: track.id, locked: false });
    }
    for (const track of doc.tracks) {
      for (const clip of track.clips) ops.push({ op: 'remove_clip', clipId: clip.id });
    }
    for (const track of version.tracks) {
      for (const clip of track.clips) {
        ops.push(
          clip.kind === 'caption'
            ? { op: 'add_caption', trackId: track.id, clip }
            : { op: 'add_clip', trackId: track.id, clip },
        );
      }
      ops.push({
        op: 'update_track',
        trackId: track.id,
        locked: track.locked,
        muted: track.muted,
        volume: track.volume,
      });
    }
    return this.commitTo(doc, {
      baseRevision,
      idempotencyKey: `restore:${baseRevision}:${versionId}:${randomUUID().slice(0, 8)}`,
      ops,
      summary: `Restored version "${version.name}"`,
      source: 'restore',
      author: { userId: ownerId },
    });
  }
}
