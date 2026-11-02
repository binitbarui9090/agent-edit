import {
  initUploadRequestSchema,
  listMediaQuerySchema,
  mediaParamsSchema,
  projectIdParamsSchema,
  signPartsRequestSchema,
  updateMediaRequestSchema,
} from '@agent-edit/validation';
import type { FastifyInstance } from 'fastify';
import { currentUser } from '../../plugins/auth.js';
import type { MediaService } from './service.js';

export async function mediaRoutes(app: FastifyInstance, { media }: { media: MediaService }) {
  app.addHook('preHandler', app.requireUser);

  app.post('/:id/uploads', async (req, reply) => {
    const { id } = projectIdParamsSchema.parse(req.params);
    const input = initUploadRequestSchema.parse(req.body);
    const state = await media.initUpload(currentUser(req)._id, id, input);
    return reply.status(state.resumed ? 200 : 201).send(state);
  });

  app.get('/:id/uploads/:mediaId', async (req) => {
    const { id, mediaId } = mediaParamsSchema.parse(req.params);
    return media.getUpload(currentUser(req)._id, id, mediaId);
  });

  app.post('/:id/uploads/:mediaId/parts', async (req) => {
    const { id, mediaId } = mediaParamsSchema.parse(req.params);
    const { partNumbers } = signPartsRequestSchema.parse(req.body);
    return media.signParts(currentUser(req)._id, id, mediaId, partNumbers);
  });

  app.post('/:id/uploads/:mediaId/complete', async (req) => {
    const { id, mediaId } = mediaParamsSchema.parse(req.params);
    return media.completeUpload(currentUser(req)._id, id, mediaId);
  });

  app.delete('/:id/uploads/:mediaId', async (req, reply) => {
    const { id, mediaId } = mediaParamsSchema.parse(req.params);
    await media.cancelUpload(currentUser(req)._id, id, mediaId);
    return reply.status(204).send();
  });

  app.get('/:id/media', async (req) => {
    const { id } = projectIdParamsSchema.parse(req.params);
    const { limit, cursor } = listMediaQuerySchema.parse(req.query);
    return media.list(currentUser(req)._id, id, limit, cursor);
  });

  app.get('/:id/media/:mediaId', async (req) => {
    const { id, mediaId } = mediaParamsSchema.parse(req.params);
    return media.getPlayback(currentUser(req)._id, id, mediaId);
  });

  app.patch('/:id/media/:mediaId', async (req) => {
    const { id, mediaId } = mediaParamsSchema.parse(req.params);
    const input = updateMediaRequestSchema.parse(req.body);
    return media.update(currentUser(req)._id, id, mediaId, input);
  });

  app.delete('/:id/media/:mediaId', async (req, reply) => {
    const { id, mediaId } = mediaParamsSchema.parse(req.params);
    await media.remove(currentUser(req)._id, id, mediaId);
    return reply.status(204).send();
  });

  app.post('/:id/media/:mediaId/retry', async (req) => {
    const { id, mediaId } = mediaParamsSchema.parse(req.params);
    return media.retry(currentUser(req)._id, id, mediaId);
  });
}
