import { projectEventChannel } from '@agent-edit/shared';
import type { ServerEvent } from '@agent-edit/validation';
import type { Redis } from 'ioredis';

/** Fire and forget: events only speed the UI up. MongoDB stays the source of truth. */
export async function publishEvent(redis: Redis, event: ServerEvent): Promise<void> {
  await redis.publish(projectEventChannel(event.projectId), JSON.stringify(event));
}
