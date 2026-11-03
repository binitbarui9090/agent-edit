import { captionsToSrt } from '@agent-edit/timeline-engine';
import {
  createRenderRequestSchema,
  projectIdParamsSchema,
  renderParamsSchema,
  timelineParamsSchema,
} from '@agent-edit/validation';
import type { FastifyInstance } from 'fastify';
import { currentUser } from '../../plugins/auth.js';
import type { TimelineService } from '../timelines/service.js';
import type { RenderService } from './service.js';

export async function renderRoutes(
  app: FastifyInstance,
  { renders, timelines }: { renders: RenderService; timelines: TimelineService },
) {
  app.addHook('preHandler', app.requireUser);

  app.post('/:id/timelines/:timelineId/renders', async (req, reply) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    const input = createRenderRequestSchema.parse(req.body);
    const job = await renders.create(currentUser(req)._id, id, timelineId, input);
    return reply.status(201).send(job);
  });

  app.get('/:id/timelines/:timelineId/captions.srt', async (req, reply) => {
    const { id, timelineId } = timelineParamsSchema.parse(req.params);
    const timeline = await timelines.get(currentUser(req)._id, id, timelineId);
    return reply
      .header('content-type', 'application/x-subrip; charset=utf-8')
      .header('content-disposition', 'attachment; filename="captions.srt"')
      .send(captionsToSrt(timeline));
  });

  app.get('/:id/renders', async (req) => {
    const { id } = projectIdParamsSchema.parse(req.params);
    return { items: await renders.listForProject(currentUser(req)._id, id) };
  });

  app.get('/:id/renders/:renderId', async (req) => {
    const { id, renderId } = renderParamsSchema.parse(req.params);
    return renders.get(currentUser(req)._id, id, renderId);
  });

  app.post('/:id/renders/:renderId/cancel', async (req) => {
    const { id, renderId } = renderParamsSchema.parse(req.params);
    return renders.cancel(currentUser(req)._id, id, renderId);
  });

  app.post('/:id/renders/:renderId/retry', async (req) => {
    const { id, renderId } = renderParamsSchema.parse(req.params);
    return renders.retry(currentUser(req)._id, id, renderId);
  });
}

export async function recentRendersRoutes(
  app: FastifyInstance,
  { renders }: { renders: RenderService },
) {
  app.addHook('preHandler', app.requireUser);
  app.get('/', async (req) => ({ items: await renders.listRecent(currentUser(req)._id) }));
}
