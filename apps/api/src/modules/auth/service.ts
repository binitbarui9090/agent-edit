import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@agent-edit/shared';
import type { LoginRequest, RegisterRequest, User } from '@agent-edit/validation';
import { AppError } from '../../errors.js';
import type { Database, UserDoc } from '@agent-edit/infra';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';

const DUPLICATE_KEY = 11000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toUser(doc: UserDoc): User {
  return {
    id: doc._id,
    email: doc.email,
    displayName: doc.displayName,
    createdAt: doc.createdAt.toISOString(),
  };
}

export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly sessionTtlMs: number,
  ) {}

  async register(input: RegisterRequest): Promise<UserDoc> {
    const now = new Date();
    const doc: UserDoc = {
      _id: newId('usr'),
      email: input.email,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.database.users.insertOne(doc);
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) {
        throw new AppError('email_taken', 'An account with this email already exists');
      }
      throw err;
    }
    return doc;
  }

  async login(input: LoginRequest): Promise<UserDoc> {
    const user = await this.database.users.findOne({ email: input.email });
    const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid) throw new AppError('invalid_credentials', 'Wrong email or password');
    return user;
  }

  /** Only the hash is stored, so a database leak does not yield usable session tokens. */
  async createSession(
    userId: string,
    userAgent: string | undefined,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    await this.database.sessions.insertOne({
      _id: newId('ses'),
      tokenHash: hashToken(token),
      userId,
      userAgent: userAgent?.slice(0, 300) ?? null,
      createdAt: now,
      expiresAt,
    });
    return { token, expiresAt };
  }

  async resolveSession(token: string): Promise<UserDoc | null> {
    const session = await this.database.sessions.findOne({
      tokenHash: hashToken(token),
      // TTL deletion can lag by a minute or more, so expiry is also enforced here.
      expiresAt: { $gt: new Date() },
    });
    if (!session) return null;
    return this.database.users.findOne({ _id: session.userId });
  }

  async revokeSession(token: string): Promise<void> {
    await this.database.sessions.deleteOne({ tokenHash: hashToken(token) });
  }
}
