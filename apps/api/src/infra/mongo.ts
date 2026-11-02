import type { AspectRatio, FrameRate } from '@agent-edit/shared';
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

export interface Database {
  client: MongoClient;
  db: Db;
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  projects: Collection<ProjectDoc>;
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
  };
  await ensureIndexes(database);
  return database;
}

async function ensureIndexes({ users, sessions, projects }: Database): Promise<void> {
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ userId: 1 }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    projects.createIndex({ ownerId: 1, deletedAt: 1, updatedAt: -1, _id: -1 }),
  ]);
}
