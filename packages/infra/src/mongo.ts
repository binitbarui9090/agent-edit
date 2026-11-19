import type { AspectRatio, FrameRate, ProcessingStep, UploadExtension } from '@agent-edit/shared';
import type {
  AgentImpact,
  AgentPlan,
  AgentRunContext,
  AgentRunStatus,
  CompiledPlanStep,
  JobStatus,
  MediaProbe,
  MediaStatus,
  RenderPreset,
  RenderStatus,
  ShortProposal,
  TimelineOperation,
  TimelineState,
  TimelineTrack,
  TransactionSource,
} from '@agent-edit/validation';
import { MongoClient, type Collection, type Db } from 'mongodb';

export interface UserDoc {
  _id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDoc {
  _id: string;
  tokenHash: string;
  userId: string;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface ProjectDoc {
  _id: string;
  ownerId: string;
  name: string;
  settings: { aspectRatio: AspectRatio; width: number; height: number; frameRate: FrameRate };
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface MediaStorageKeys {
  originalKey: string;
  proxyKey: string | null;
  audioKey: string | null;
  waveformKey: string | null;
  waveformPeaksPerSecond: number | null;
  thumbnailKeys: string[];
  posterKey: string | null;
}

export interface MediaDoc {
  _id: string;
  projectId: string;
  ownerId: string;
  name: string;
  folder: string | null;
  status: MediaStatus;
  size: number;
  contentType: string;
  extension: UploadExtension;
  fingerprint: string;
  /** Null once the multipart upload has been completed. */
  upload: { s3UploadId: string; partSize: number; partCount: number } | null;
  storage: MediaStorageKeys;
  probe: MediaProbe | null;
  error: string | null;
  /** Bumped on each manual retry, so re-enqueued jobs get fresh BullMQ ids. */
  generation: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AnalysisJobDoc {
  _id: string;
  projectId: string;
  mediaId: string;
  step: ProcessingStep;
  status: JobStatus;
  progress: number;
  attempts: number;
  error: string | null;
  provider: { id: string; isMock: boolean };
  /** Why a step was skipped or what it left out, in words a user can act on. */
  note: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

interface ProviderRef {
  id: string;
  model: string | null;
  isMock: boolean;
}

export interface TranscriptSegmentDoc {
  _id: string;
  mediaId: string;
  projectId: string;
  start: number;
  end: number;
  text: string;
  speaker: string | null;
  words: Array<{ w: string; s: number; e: number }>;
  provider: ProviderRef;
}

export interface SceneDoc {
  _id: string;
  mediaId: string;
  projectId: string;
  start: number;
  end: number;
  summary: string | null;
  provider: ProviderRef | null;
}

export type MomentKind = 'silence' | 'repeated_take' | 'chapter' | 'highlight';

export interface MomentDoc {
  _id: string;
  mediaId: string;
  projectId: string;
  kind: MomentKind;
  start: number;
  end: number;
  score: number;
  title: string | null;
  reason: string | null;
  provider: ProviderRef;
}

export interface AgentRunDoc {
  _id: string;
  projectId: string;
  timelineId: string;
  ownerId: string;
  instruction: string;
  status: AgentRunStatus;
  stage: string | null;
  baseRevision: number;
  plan: AgentPlan | null;
  steps: CompiledPlanStep[];
  ops: TimelineOperation[];
  shorts: ShortProposal[];
  warnings: string[];
  /** Absent on runs from before these were recorded. */
  impact?: AgentImpact | null;
  context?: AgentRunContext | null;
  editorial?: Array<{ mediaId: string; start: number; end: number }>;
  provider: ProviderRef | null;
  error: string | null;
  appliedTransactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenderJobDoc {
  _id: string;
  projectId: string;
  ownerId: string;
  timelineId: string;
  timelineName: string;
  /** The exact edit being rendered, so later changes cannot alter a job already started. */
  revision: number;
  snapshot: TimelineState;
  preset: RenderPreset;
  burnCaptions: boolean;
  width: number;
  height: number;
  status: RenderStatus;
  progress: number;
  attempts: number;
  error: string | null;
  outputKey: string | null;
  outputSize: number | null;
  captionsKey: string | null;
  logKey: string | null;
  durationTicks: number;
  generation: number;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface TimelineDoc {
  _id: string;
  projectId: string;
  ownerId: string;
  kind: 'main' | 'short';
  name: string;
  revision: number;
  frameRate: FrameRate;
  width: number;
  height: number;
  tracks: TimelineTrack[];
  /** Transaction ids. Each entry's inverseOps is what undo (or redo) applies next. */
  undoStack: string[];
  redoStack: string[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface EditTransactionDoc {
  _id: string;
  timelineId: string;
  projectId: string;
  /** The revision this transaction produces. Unique per timeline, so it also acts as the lock. */
  revision: number;
  idempotencyKey: string;
  source: TransactionSource;
  summary: string;
  author: { userId: string; agentRunId: string | null; model: string | null };
  ops: TimelineOperation[];
  inverseOps: TimelineOperation[];
  createdAt: Date;
}

export interface TimelineVersionDoc {
  _id: string;
  timelineId: string;
  projectId: string;
  name: string;
  revision: number;
  trigger: 'manual' | 'pre_ai' | 'pre_restore';
  tracks: TimelineTrack[];
  createdBy: string;
  createdAt: Date;
}

export interface Database {
  client: MongoClient;
  db: Db;
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  projects: Collection<ProjectDoc>;
  media: Collection<MediaDoc>;
  analysisJobs: Collection<AnalysisJobDoc>;
  timelines: Collection<TimelineDoc>;
  transactions: Collection<EditTransactionDoc>;
  versions: Collection<TimelineVersionDoc>;
  segments: Collection<TranscriptSegmentDoc>;
  scenes: Collection<SceneDoc>;
  moments: Collection<MomentDoc>;
  agentRuns: Collection<AgentRunDoc>;
  renders: Collection<RenderJobDoc>;
}

export async function connectMongo(url: string, dbName: string): Promise<Database> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(dbName);
  const database: Database = {
    client,
    db,
    users: db.collection('users'),
    sessions: db.collection('sessions'),
    projects: db.collection('projects'),
    media: db.collection('media'),
    analysisJobs: db.collection('analysis_jobs'),
    timelines: db.collection('timelines'),
    transactions: db.collection('edit_transactions'),
    versions: db.collection('timeline_versions'),
    segments: db.collection('transcript_segments'),
    scenes: db.collection('scenes'),
    moments: db.collection('moments'),
    agentRuns: db.collection('agent_runs'),
    renders: db.collection('render_jobs'),
  };
  await ensureIndexes(database);
  return database;
}

async function ensureIndexes({
  users,
  sessions,
  projects,
  media,
  analysisJobs,
  timelines,
  transactions,
  versions,
  segments,
  scenes,
  moments,
  agentRuns,
  renders,
}: Database): Promise<void> {
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ userId: 1 }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    projects.createIndex({ ownerId: 1, deletedAt: 1, updatedAt: -1, _id: -1 }),
    media.createIndex({ projectId: 1, deletedAt: 1, createdAt: -1, _id: -1 }),
    media.createIndex({ deletedAt: 1 }),
    media.createIndex({ status: 1, updatedAt: 1 }),
    // Two tabs starting the same file must converge on one upload, not race into two.
    media.createIndex(
      { projectId: 1, fingerprint: 1 },
      { unique: true, partialFilterExpression: { status: 'uploading', deletedAt: null } },
    ),
    analysisJobs.createIndex({ mediaId: 1, step: 1 }, { unique: true }),
    analysisJobs.createIndex({ status: 1, updatedAt: 1 }),
    timelines.createIndex({ projectId: 1, deletedAt: 1, updatedAt: -1 }),
    timelines.createIndex({ 'tracks.clips.sourceMediaId': 1 }),
    // One main timeline per project, however many requests race to create it.
    timelines.createIndex(
      { projectId: 1 },
      { unique: true, partialFilterExpression: { kind: 'main', deletedAt: null } },
    ),
    transactions.createIndex({ timelineId: 1, revision: 1 }, { unique: true }),
    transactions.createIndex({ timelineId: 1, idempotencyKey: 1 }, { unique: true }),
    versions.createIndex({ timelineId: 1, createdAt: -1 }),
    segments.createIndex({ mediaId: 1, start: 1 }),
    scenes.createIndex({ mediaId: 1, start: 1 }),
    moments.createIndex({ mediaId: 1, kind: 1, start: 1 }),
    agentRuns.createIndex({ timelineId: 1, createdAt: -1 }),
    renders.createIndex({ projectId: 1, createdAt: -1 }),
    renders.createIndex({ ownerId: 1, createdAt: -1 }),
    renders.createIndex({ ownerId: 1, status: 1 }),
    agentRuns.createIndex({ ownerId: 1, status: 1 }),
    media.createIndex({ ownerId: 1, deletedAt: 1 }),
  ]);
}
