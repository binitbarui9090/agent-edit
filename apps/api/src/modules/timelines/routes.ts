import {
  createVersionRequestSchema,
  editTransactionRequestSchema,
  projectIdParamsSchema,
  timelineParamsSchema,
  undoRedoRequestSchema,
  versionParamsSchema,
} from '@agent-edit/validation';
import type { FastifyInstance } from 'fastify';
import { currentUser } from '../../plugins/auth.js';
import type { TimelineService } from './service.js';

/** A large AI plan on a long timeline is thousands of operations. */
const TRANSACTION_BODY_LIMIT = 16 * 1024 * 1024;

export async function timelineRoutes(
  app: FastifyInstance,
  { timelines }: { timelines: TimelineService },
) {
  app.addHook('preHandler', app.requireUser);

  app.get('/:id/timelines', async (req) => {
    const { id } = projectIdParamsSchema.parse(req.params);
    return { items: await timelines.list(currentUser(req)._id, id) };
  });

  app.get('/:id/timelines/main', async (req) => {
    const { id } = projectIdParamsSchema.parse(req.params);
    return timelines.ensureMain(currentUser(req)._id, id);
  });

  app.get('/:id/timelines/:timelineId', async (req) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    return timelines.get(currentUser(req)._id, id, timelineId);
  });

  app.delete('/:id/timelines/:timelineId', async (req, reply) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    await timelines.remove(currentUser(req)._id, id, timelineId);
    return reply.status(204).send();
  });

  app.post(
    '/:id/timelines/:timelineId/transactions',
    { bodyLimit: TRANSACTION_BODY_LIMIT },
    async (req) => {
      const { id, timelineId } = timelineParamsSchema.parse(req.params);
      const input = editTransactionRequestSchema.parse(req.body);
      const userId = currentUser(req)._id;
      return timelines.commit(userId, id, timelineId, {
        ...input,
        source: 'manual',
        author: { userId },
      });
    },
  );

  app.post('/:id/timelines/:timelineId/undo', async (req) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    const { baseRevision } = undoRedoRequestSchema.parse(req.body);
    return timelines.undo(currentUser(req)._id, id, timelineId, baseRevision);
  });

  app.post('/:id/timelines/:timelineId/redo', async (req) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    const { baseRevision } = undoRedoRequestSchema.parse(req.body);
    return timelines.redo(currentUser(req)._id, id, timelineId, baseRevision);
  });

  app.get('/:id/timelines/:timelineId/history', async (req) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    return { items: await timelines.history(currentUser(req)._id, id, timelineId) };
  });

  app.get('/:id/timelines/:timelineId/versions', async (req) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    return { items: await timelines.listVersions(currentUser(req)._id, id, timelineId) };
  });

  app.post('/:id/timelines/:timelineId/versions', async (req, reply) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    const { name } = createVersionRequestSchema.parse(req.body);
    const version = await timelines.createVersion(currentUser(req)._id, id, timelineId, name);
    return reply.status(201).send(version);
  });

  app.post('/:id/timelines/:timelineId/versions/:versionId/restore', async (req) => {
    const { id, timelineId, versionId } = versionParamsSchema.parse(req.params);
    const { baseRevision } = undoRedoRequestSchema.parse(req.body);
    return timelines.restoreVersion(currentUser(req)._id, id, timelineId, versionId, baseRevision);
  });
}
