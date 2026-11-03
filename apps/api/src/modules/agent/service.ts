import { buildShortOperations, compilePlan } from '@agent-edit/ai-engine';
import {
  loadAgentContext,
  publishEvent,
  type AgentRunDoc,
  type Database,
  type MediaQueues,
} from '@agent-edit/infra';
import { newId } from '@agent-edit/shared';
import type { AgentRun, Timeline } from '@agent-edit/validation';
import type { Redis } from 'ioredis';
import { AppError } from '../../errors.js';
import type { ProjectService } from '../projects/service.js';
import type { TimelineService } from '../timelines/service.js';

function toRun(doc: AgentRunDoc): AgentRun {
  return {
    id: doc._id,
    timelineId: doc.timelineId,
    instruction: doc.instruction,
    status: doc.status,
    stage: doc.stage,
    baseRevision: doc.baseRevision,
    summary: doc.plan?.summary ?? null,
    steps: doc.steps,
    ops: doc.ops,
    shorts: doc.shorts,
    warnings: doc.warnings,
    provider: doc.provider,
    error: doc.error,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export interface AgentServiceDeps {
  database: Database;
  redis: Redis;
  queues: MediaQueues;
  projects: ProjectService;
  timelines: TimelineService;
  maxActivePerUser: number;
}

/**
 * Proposals and their approval. The worker only ever writes a proposal. This is the single place one
 * becomes an edit, and it goes through the same validated transaction as any manual change.
 */
export class AgentService {
  private readonly database: Database;
  private readonly redis: Redis;
  private readonly queues: MediaQueues;
  private readonly projects: ProjectService;
  private readonly timelines: TimelineService;
  private readonly maxActivePerUser: number;

  constructor(deps: AgentServiceDeps) {
    this.maxActivePerUser = deps.maxActivePerUser;
    this.database = deps.database;
    this.redis = deps.redis;
    this.queues = deps.queues;
    this.projects = deps.projects;
    this.timelines = deps.timelines;
  }

  private notify(doc: Pick<AgentRunDoc, 'projectId' | 'timelineId' | '_id'>) {
    return publishEvent(this.redis, {
      type: 'agent.changed',
      projectId: doc.projectId,
      timelineId: doc.timelineId,
      runId: doc._id,
    });
  }

  async create(
    ownerId: string,
    projectId: string,
    timelineId: string,
    instruction: string,
  ): Promise<AgentRun> {
    const timeline = await this.timelines.get(ownerId, projectId, timelineId);
    const active = await this.database.agentRuns.countDocuments({
      ownerId,
      status: { $in: ['queued', 'planning'] },
    });
    if (active >= this.maxActivePerUser) {
      throw new AppError('rate_limited', 'The agent is still working on your earlier requests');
    }
    const now = new Date();
    const doc: AgentRunDoc = {
      _id: newId('run'),
      projectId,
      timelineId,
      ownerId,
      instruction,
      status: 'queued',
      stage: 'Waiting for a worker',
      baseRevision: timeline.revision,
      plan: null,
      steps: [],
      ops: [],
      shorts: [],
      warnings: [],
      provider: null,
      error: null,
      appliedTransactionId: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.database.agentRuns.insertOne(doc);
    await this.queues.enqueueAgent(doc._id);
    await this.notify(doc);
    return toRun(doc);
  }

  async list(ownerId: string, projectId: string, timelineId: string): Promise<AgentRun[]> {
    await this.timelines.get(ownerId, projectId, timelineId);
    const docs = await this.database.agentRuns
      .find({ timelineId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    return docs.map(toRun);
  }

  private async find(ownerId: string, projectId: string, timelineId: string, runId: string) {
    await this.projects.assertOwned(ownerId, projectId);
    const doc = await this.database.agentRuns.findOne({
      _id: runId,
      timelineId,
      projectId,
      ownerId,
    });
    if (!doc) throw new AppError('not_found', 'Agent run not found');
    return doc;
  }

  async get(ownerId: string, projectId: string, timelineId: string, runId: string) {
    return toRun(await this.find(ownerId, projectId, timelineId, runId));
  }

  async reject(ownerId: string, projectId: string, timelineId: string, runId: string) {
    const doc = await this.find(ownerId, projectId, timelineId, runId);
    if (doc.status !== 'proposed')
      throw new AppError('conflict', 'This plan is not awaiting review');
    await this.database.agentRuns.updateOne(
      { _id: runId, status: 'proposed' },
      { $set: { status: 'rejected', updatedAt: new Date() } },
    );
    await this.notify(doc);
    return toRun({ ...doc, status: 'rejected' });
  }

  /**
   * Recompiles against the timeline as it is now, because it may have moved since the plan was made.
   * If a step that was fine no longer applies, the run becomes stale and the user is told. It never
   * overwrites newer edits.
   */
  async apply(
    ownerId: string,
    projectId: string,
    timelineId: string,
    runId: string,
    baseRevision: number,
    enabledSteps: readonly number[],
  ): Promise<{ run: AgentRun; timeline: Timeline; createdTimelineIds: string[] }> {
    const doc = await this.find(ownerId, projectId, timelineId, runId);
    if (doc.status !== 'proposed' || !doc.plan) {
      throw new AppError('conflict', 'This plan is not awaiting review');
    }
    const timeline = await this.timelines.get(ownerId, projectId, timelineId);
    if (timeline.revision !== baseRevision) {
      throw new AppError('revision_conflict', 'The timeline changed since this edit was made', {
        revision: timeline.revision,
      });
    }

    const context = await loadAgentContext(this.database, timeline);
    const compiled = compilePlan(
      doc.plan,
      timeline,
      context.compile,
      context.media,
      new Set(enabledSteps),
    );

    // Compiling does not look at pictures, so framing measured when planning carries over.
    compiled.shorts = compiled.shorts.map((short) => {
      const known = doc.shorts.find(
        (other) => other.sourceMediaId === short.sourceMediaId && other.sourceIn === short.sourceIn,
      );
      return known
        ? { ...short, framing: known.framing, framingSource: known.framingSource }
        : short;
    });

    const newlyBroken = compiled.steps.filter(
      (step) => step.error && enabledSteps.includes(step.index) && !doc.steps[step.index]?.error,
    );
    if (newlyBroken.length > 0) {
      const message = `The timeline changed and ${newlyBroken.length} step${newlyBroken.length === 1 ? '' : 's'} no longer apply. Ask the agent again.`;
      await this.database.agentRuns.updateOne(
        { _id: runId },
        { $set: { status: 'stale', error: message, updatedAt: new Date() } },
      );
      await this.notify(doc);
      throw new AppError('conflict', message);
    }
    if (compiled.ops.length === 0 && compiled.shorts.length === 0) {
      throw new AppError('conflict', 'Nothing in the selected steps would change the timeline');
    }

    const author = {
      userId: ownerId,
      agentRunId: runId,
      model: doc.provider?.model ?? doc.provider?.id ?? null,
    };
    let current = timeline;
    let appliedTransactionId: string | null = null;
    if (compiled.ops.length > 0) {
      // A restore point before any significant AI edit, on top of undo.
      await this.timelines.createVersion(
        ownerId,
        projectId,
        timelineId,
        `Before agent: ${doc.instruction.slice(0, 80)}`,
        'pre_ai',
      );
      const result = await this.timelines.commit(ownerId, projectId, timelineId, {
        baseRevision,
        idempotencyKey: `agent:${runId}`,
        ops: compiled.ops,
        summary: doc.plan.summary.slice(0, 500),
        source: 'ai',
        author,
      });
      current = result.timeline;
      appliedTransactionId = result.transactionId;
    }

    const createdTimelineIds = await this.createShorts(
      ownerId,
      projectId,
      timeline,
      compiled.shorts,
      author,
      runId,
      context,
    );

    const now = new Date();
    const applied: Partial<AgentRunDoc> = {
      status: 'applied',
      appliedTransactionId,
      steps: compiled.steps,
      ops: compiled.ops,
      shorts: compiled.shorts,
      updatedAt: now,
    };
    await this.database.agentRuns.updateOne({ _id: runId }, { $set: applied });
    await this.notify(doc);
    return {
      run: toRun({ ...doc, ...applied }),
      timeline: current,
      createdTimelineIds,
    };
  }

  /** Each Short is an ordinary timeline of its own, editable with no link back to this one. */
  private async createShorts(
    ownerId: string,
    projectId: string,
    timeline: Timeline,
    shorts: AgentRunDoc['shorts'],
    author: { userId: string; agentRunId: string; model: string | null },
    runId: string,
    context: Awaited<ReturnType<typeof loadAgentContext>>,
  ): Promise<string[]> {
    const created: string[] = [];
    for (const [index, short] of shorts.entries()) {
      const source = context.compile.library.get(short.sourceMediaId);
      if (!source) continue;
      const doc = await this.timelines.create(ownerId, projectId, short.name, {
        width: 1080,
        height: 1920,
        frameRate: timeline.frameRate,
      });
      await this.timelines.commit(ownerId, projectId, doc._id, {
        baseRevision: 0,
        idempotencyKey: `agent:${runId}:short:${index}`,
        ops: buildShortOperations(short, doc, source),
        summary: `Created from: ${short.reason}`.slice(0, 500),
        source: 'ai',
        author,
      });
      created.push(doc._id);
    }
    return created;
  }
}
