import type { AspectRatio, FrameRate, ProcessingStep, UploadExtension } from '@agent-edit/shared';
import type {
  JobStatus,
  MediaProbe,
  MediaStatus,
  TimelineOperation,
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
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
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
  ]);
}
